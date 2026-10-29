# CAMPASS Phase 4 — Attendance — Technical Design (BACKEND ONLY)

> Scope: `apps/api` + `packages/db` + `packages/shared`. **No `apps/web`
> frontend** — per `roadmap.md` "Build strategy decision (Option A)", the UI for
> Phases 1–4 is a single deferred later pass. This design satisfies Phase 4's
> Definition of Done at the **API + test + DB-verification** level.
>
> Authoritative specs read for this design: `roadmap.md` (Phase 4 + phase
> completion gate + Option A note), `tenancy.md` (A2 checklist §8), `identity-rbac.md`
> (permission catalogue + authz engine), `superadmin-security.md` (AuditEvent v2 +
> `recordAuditEvent`), `architecture.md` §5 (module model), `database.md`
> (migration workflow). Existing code read: `schema.prisma`, `authz-engine.ts`,
> `audit.ts`, `module-system.ts`, `notifications.ts`, `faculty-assignment.ts`,
> `classes.ts`, the Phase 3 migration `20261028000000_phase3_classes`, the
> `catalogue-sync` meta-test, the `tenant-escape-setup` helper, and `seed.ts`.
>
> **This is a REVISION iteration.** A design review exists
> (`docs/phase4/design-review.json`, `design-review.md`): verdict CHANGES_REQUESTED,
> 2 HIGH + 5 MEDIUM + 6 NIT. Every HIGH and MEDIUM finding is resolved below; the
> NITs are addressed too. The point-by-point response to each finding is in §15.
> Source re-read for the revision: `modules.ts`, `module-system.integration.test.ts`,
> `modules.test.ts`, the `ScheduledClass` / `EnrollmentStatus` / `ScheduledClassStatus`
> / `DayOfWeek` definitions in `schema.prisma`.

---

## 1. Overview

Phase 4 records attendance against the Phase 3 scheduling substrate and runs a
controlled correction workflow. A faculty member opens an **attendance session**
for one of their assigned `ScheduledClass` occurrences on a date, the system loads
the section's enrolled students from `ClassEnrollment`, the faculty marks each
student (`PRESENT | ABSENT | LATE | EXCUSED`), submits, and then finalizes.
**Finalized records are immutable by construction** — the only way to change a
finalized record is an approved `AttendanceCorrection`, which rewrites the record
and preserves the before/after in an append-only history table. Students read
their own attendance; HOD/ADMIN read department/section reports and export
(audited); a configurable low-attendance threshold emits alerts through the
**existing** notification service. Attendance is **completely independent** of
GatePass/movement state — no table, FK, or code path couples them.

The design reuses every Phase 0–3 pattern verbatim: the A2 tenancy checklist
(`institutionId` + composite same-tenant FKs + ENABLE/FORCE RLS + nullif-guarded
fail-closed policies), the `withTenant(institutionId, tx)` execution helper as
`campass_app`, `recordAuditEvent(input, tx)` in the same transaction as the
mutation, the `requirePermission` / `requireModuleActive` guards, the catalogue
in `@campusgate/shared`, and the hand-authored migration workflow (diff → deploy →
status). The append-only history table copies the exact `schedule_revisions` /
`student_profile_history` / `audit_events` house style (INSERT-only RLS +
`REVOKE UPDATE, DELETE` + `BEFORE UPDATE OR DELETE` trigger).

**Technology stack (locked on approval):** TypeScript (ESM, `.js` import
specifiers), Fastify (route plugin per module), Prisma ORM against Supabase
Postgres (runtime via `campass_app` through the transaction pooler; DDL via the
privileged session-pooler `DIRECT_URL`), Zod for request validation in
`@campusgate/shared`, Vitest for tests. No new runtime dependency is introduced.

---

## 2. The four module-level decisions (summary; detailed below)

| Decision | Choice | Section |
|---|---|---|
| Module-dependency model | **Option (a)** — attendance declares NO gated-module deps on foundational data; only the `attendance` row itself must be ENTITLED→ACTIVE. Class/student/session existence validated at operation time. | §4 |
| Immutability + history | **Dedicated append-only `AttendanceRecordHistory` table** (not AuditEvent) for the finalized→corrected before/after snapshot; AuditEvent still written for the audit trail. | §6 |
| `canOnResource` approach | **Explicit in-handler `FacultyAssignment` ownership check** (a small exported `assertFacultyAssigned` service helper), NOT a fleshed-out generic `canOnResource`. Documented why. | §7 |
| Correction initiator policy | **Faculty may request** corrections (on their own marked sessions); **STUDENT may NOT** request in Phase 4 (read-only `attendance.view_own`). HOD/ADMIN review (approve/reject), HOD department-scoped. | §8 |

---

## 3. Schema — new models (`packages/db/prisma/schema.prisma`)

Four new tenant-owned tables. All follow the tenancy checklist (§9). Prisma models
are added to `schema.prisma`; the RLS, composite FKs, CHECK constraints, append-only
trigger, GRANT refresh, and catalogue seed live in the hand-authored migration (§10)
because Prisma does not model them.

### 3.1 Enums

```prisma
enum AttendanceSessionStatus {
  OPEN        // created; records being marked
  SUBMITTED   // faculty submitted; still correctable in place by the marker before finalize
  FINALIZED   // locked; records immutable except via an approved AttendanceCorrection
}

enum AttendanceStatus {
  PRESENT
  ABSENT
  LATE
  EXCUSED      // documented synonym for "approved leave"; see §3.5
}

enum AttendanceCorrectionReviewStatus {
  PENDING
  APPROVED
  REJECTED
}

enum AttendanceRecordHistoryChangeType {
  MARKED          // initial mark inside an OPEN/SUBMITTED session
  CORRECTED       // value changed by an APPROVED correction on a FINALIZED record
}
```

> `AttendanceStatus` is the **configurable-state set, documented not hardcoded**:
> the four values are the Phase 4 default vocabulary. Per-institution policy on what
> each state *means* for an attendance-rate computation (e.g. whether EXCUSED counts
> toward "present") is a settings concern (§3.5), not a schema change. Adding future
> states (e.g. `REMOTE`) is an additive enum migration in a later phase.

### 3.2 `AttendanceSession`

```prisma
model AttendanceSession {
  id               String                  @id @default(cuid())
  institutionId    String
  institution      Institution             @relation(fields: [institutionId], references: [id])
  scheduledClassId String
  scheduledClass   ScheduledClass          @relation(fields: [scheduledClassId], references: [id])
  academicTermId   String
  academicTerm     AcademicTerm            @relation(fields: [academicTermId], references: [id])
  date             DateTime                 // the calendar date (UTC midnight) the session covers
  status           AttendanceSessionStatus  @default(OPEN)
  markedByFacultyId String
  markedByFaculty  FacultyProfile          @relation(fields: [markedByFacultyId], references: [id])
  submissionDeadline DateTime?             // optional; informational (see §8 edge cases)
  submittedAt      DateTime?
  finalizedAt      DateTime?
  createdAt        DateTime                 @default(now())
  updatedAt        DateTime                 @updatedAt

  records          AttendanceRecord[]

  @@unique([scheduledClassId, date])       // one session per class occurrence per date
  @@unique([id, institutionId])            // anchors composite same-tenant FKs
  @@index([institutionId])
  @@index([institutionId, academicTermId, date])
  @@index([markedByFacultyId])
  @@index([scheduledClassId])
  @@map("attendance_sessions")
}
```

> The `scheduledClass` / `academicTerm` Prisma relations above are **informational**
> for the ORM; the authoritative same-tenant + term-integrity link is the hand-authored
> three-column FK `(institutionId, scheduledClassId, academicTermId) →
> scheduled_classes(institutionId, id, academicTermId)` (§3.2 above, §10e). A new
> `@@unique([institutionId, id, academicTermId])` is added to `model ScheduledClass`
> (Prisma needs the matching unique to express/allow the FK target); its DDL lands in
> the Phase 4 migration, NOT by editing the frozen Phase 3 dir.

```prisma
// (edit, model ScheduledClass): add alongside the existing @@unique([id, institutionId])
//   @@unique([institutionId, id, academicTermId])  // FK target for AttendanceSession term integrity
```

Composite same-tenant FKs (migration, §10): `(institutionId, markedByFacultyId) →
faculty_profiles(institutionId, id)` RESTRICT; plus the **three-column**
session↔class↔term FK described next.

**Term integrity enforced BY CONSTRUCTION (resolves MEDIUM-4).** `academicTermId` is
denormalized at create time from the `ScheduledClass` so date-range reports filter on
one indexed column. To guarantee it can never drift from the scheduled class's term
(a second write path, a future bulk tool), the session↔class link is a **single
three-column composite FK** instead of a two-column one:

```
(institutionId, scheduledClassId, academicTermId)
     → scheduled_classes(institutionId, id, academicTermId)
     ON DELETE RESTRICT ON UPDATE CASCADE
```

This requires a **new `(institutionId, id, academicTermId)` unique on
`scheduled_classes`**, added in the Phase 4 migration (§10e). `scheduled_classes`
already carries `@@unique([id, institutionId])`; adding
`@@unique([institutionId, id, academicTermId])` is additive (a superset key on an
immutable-in-practice column) and does not alter the frozen Phase 3 migration — the
new UNIQUE is created in the **Phase 4** migration dir, never by editing the Phase 3
dir. With this FK, Postgres **refuses** any `AttendanceSession` whose `academicTermId`
does not equal the referenced `ScheduledClass`'s term; no in-handler-only check carries
the invariant. (The in-handler denormalization still *sets* the value from the resolved
scheduled class; the FK is the backstop that makes a mismatch impossible.)

> `academic_terms` is still reachable transitively (the scheduled class's term is a
> real `academic_terms` row), so no separate `(institutionId, academicTermId) →
> academic_terms` FK is needed — the three-column FK to `scheduled_classes` already
> pins the term to a term the class legitimately uses. A redundant direct term FK is
> omitted to avoid two FKs asserting overlapping facts.

### 3.3 `AttendanceRecord`

```prisma
model AttendanceRecord {
  id                  String            @id @default(cuid())
  institutionId       String
  institution         Institution       @relation(fields: [institutionId], references: [id])
  attendanceSessionId String
  attendanceSession   AttendanceSession @relation(fields: [attendanceSessionId], references: [id])
  studentId           String
  student             StudentProfile    @relation(fields: [studentId], references: [id])
  status              AttendanceStatus
  markedAt            DateTime          @default(now())
  createdAt           DateTime          @default(now())
  updatedAt           DateTime          @updatedAt

  history             AttendanceRecordHistory[]
  corrections         AttendanceCorrection[]

  @@unique([attendanceSessionId, studentId])  // one record per student per session
  @@unique([id, institutionId])
  @@index([institutionId])
  @@index([institutionId, studentId])
  @@index([attendanceSessionId])
  @@map("attendance_records")
}
```

Composite same-tenant FKs: `(institutionId, attendanceSessionId) →
attendance_sessions(institutionId, id)` RESTRICT; `(institutionId, studentId) →
student_profiles(institutionId, id)` RESTRICT. The `studentId` FK is the shared
single-identity `StudentProfile` — **no attendance-local student copy** (roadmap
single-identity rule). Students are loaded for a session from the section's
`ClassEnrollment` where `status = ENROLLED` (§8), never duplicated.

> **`markedAt` is the ORIGINAL mark time and is immutable after the first mark**
> (resolves NIT-2). It is set when the record is first marked (seeded ABSENT at open,
> or updated by the marker while OPEN/SUBMITTED) and is **not** bumped when an approved
> correction rewrites `status` on a FINALIZED record (§8.2). The correction's *when/who*
> is tracked separately on the `AttendanceRecordHistory` `CORRECTED` row (`createdAt` +
> `correctionId` + `actorMembershipId`) and on `AttendanceCorrection.reviewedAt`, so the
> live row always shows a truthful original-mark timestamp.

### 3.4 `AttendanceCorrection`

```prisma
model AttendanceCorrection {
  id                 String                           @id @default(cuid())
  institutionId      String
  institution        Institution                      @relation(fields: [institutionId], references: [id])
  attendanceRecordId String
  attendanceRecord   AttendanceRecord                 @relation(fields: [attendanceRecordId], references: [id])
  requestedByUserId  String                           // actor id (no composite FK; see §6/NIT)
  reason             String                           // REQUIRED, min length enforced in Zod + CHECK
  requestedStatus    AttendanceStatus                 // the status the requester wants applied
  priorStatus        AttendanceStatus                 // snapshot of the record's status at request time
  reviewStatus       AttendanceCorrectionReviewStatus @default(PENDING)
  reviewedByUserId   String?
  reviewedAt         DateTime?
  reviewNote         String?
  createdAt          DateTime                         @default(now())
  updatedAt          DateTime                         @updatedAt

  @@unique([id, institutionId])
  @@index([institutionId])
  @@index([institutionId, reviewStatus])
  @@index([attendanceRecordId])
  @@map("attendance_corrections")
}
```

Composite same-tenant FK: `(institutionId, attendanceRecordId) →
attendance_records(institutionId, id)` RESTRICT. `requestedByUserId` /
`reviewedByUserId` are **recorded id columns with NO FK** — mirroring
`schedule_revisions.actorUserId` and `AuditEvent.actorUserId` (a platform/support
actor may have no in-tenant membership; the id is a record, not a relational
anchor). `AttendanceCorrection` is a **mutable** workflow row (PENDING → APPROVED/
REJECTED is the one legal in-place transition set; §8), so it gets the standard RLS
pair, NOT the append-only pair. Its immutable facts (the before/after of the record
it changed) live in `AttendanceRecordHistory` (§6), which is append-only.

### 3.5 Configurable status semantics (documented defaults, not hardcoded rules)

`InstitutionModule.settings` JSON for `moduleKey = "attendance"` carries the Phase 4
policy knobs, read at operation time (never compiled in):

```jsonc
{
  "presentStatuses": ["PRESENT", "LATE"],      // which statuses count toward the attendance rate numerator
  "lowAttendanceThresholdPercent": 75,          // alert when a student's rate drops below this
  "allowSelfCorrectionBeforeFinalize": true     // marker may edit SUBMITTED records in place before finalize
}
```

Defaults when `settings` is absent (documented, applied by a pure helper
`attendancePolicy(settings)` in `attendance-policy.ts`): `presentStatuses =
["PRESENT", "LATE"]`, `lowAttendanceThresholdPercent = 75`, `EXCUSED` is **excluded
from both numerator and denominator** of the rate (an approved-leave day is neither
present nor counted against the student). These are **defaults, not business law** —
an institution overrides them in module settings. The rate helper is pure and
unit-testable (§11).

### 3.6 `Institution` back-relations

Add to `model Institution`: `attendanceSessions AttendanceSession[]`,
`attendanceRecords AttendanceRecord[]`, `attendanceCorrections AttendanceCorrection[]`,
`attendanceRecordHistory AttendanceRecordHistory[]`. Add the obvious back-relations
to `ScheduledClass`, `AcademicTerm`, `FacultyProfile`, `StudentProfile` for the
new relation fields (Prisma requires both sides).

---

## 4. Module registration + the dependency-model decision

### 4.1 Registration (`packages/shared/src/modules.ts`)

`attendance` is **already present** in the `MODULES` array and
`MODULE_DEPENDENCIES` map (declared in Phase 0 as a future key):

```ts
attendance: ["student_management", "academic_sessions", "class_course"],
```

**No change to `modules.ts` is required** — the key and dependency edges already
exist. Phase 4 makes `attendance` *operational*: it builds the tables, routes, and
seeds the DEMO institution's `attendance` row to ACTIVE.

### 4.2 Dependency-model decision — **Option (a) (foundational-not-gated)**

**Decision: Option (a).** Attendance's *operational* routes are gated only on the
`attendance` module row itself being ACTIVE (`requireModuleActive("attendance")`).
The declared dependency edges in `MODULE_DEPENDENCIES` remain and are enforced **at
activation time** by the existing `module-system.ts` state machine when the tenant
admin activates `attendance` — but that check requires `student_management`,
`academic_sessions`, `class_course` to have **ACTIVE InstitutionModule rows**, which
foundational data does not get.

**Resolution consistent with the Phase 1/2/3 precedent:** SIS (`students.*`),
academics (`academics.*`), and classes (`classes.*`) are **foundational
institution-layer data, permission-gated ONLY, never `requireModuleActive`-gated**
(confirmed in `permissions.ts` comments and `classes.ts` / `admin.ts` route
headers: *"academics is foundational, not a gated module — Decision A"*). They have
no `InstitutionModule` rows. The live `missingDependencies` engine treats an **absent
row as UNMET** (`rowsByKey.get(dep)?.state !== "ACTIVE"`), so if `attendance`
declared those three as gated dependencies, **activation would be permanently
blocked** — exactly the Phase 3 design-review KNOWN ISSUE.

Option (a) resolves it cleanly: **drop the gated-module dependency semantics for
attendance's foundational prerequisites.** Concretely:

1. **Change `MODULE_DEPENDENCIES.attendance` to `[]`** in `modules.ts`. Attendance
   activates when its own row is ENTITLED (no unmet gated deps). This is the same
   stance Phase 1/2/3 took — foundational prerequisites are validated by **data
   existence at operation time**, not by a gated-module activation edge. (The
   `examinations` edge set, which references the same foundational keys, is a Phase
   8 concern and is **not touched** here; this change is scoped to `attendance`.)
2. **Validate prerequisites at operation time, in-handler** (§8): creating an
   `AttendanceSession` resolves the `ScheduledClass` (a `class_course`/Phase 3 row),
   its `ClassSection` → `AcademicTerm`/`AcademicSession` (Phase 1), and loads
   students from `ClassEnrollment` → `StudentProfile` (Phase 2). If any prerequisite
   row is missing/out-of-tenant/out-of-scope, the operation returns 404/409 — the
   real integrity guarantee, enforced by composite FKs + in-handler lookups, not by
   a module-activation edge.

**Why (a) over (b) (seed foundational modules as permanently-active rows):** (b)
would require inventing `InstitutionModule` rows for `student_management` /
`academic_sessions` / `class_course` purely to satisfy the engine, contradicting
the deliberate Phase 1/2/3 decision that those are *not* gated modules, and adding
seed/escape-suite surface for rows that gate nothing. (a) keeps one consistent rule
across every foundational phase and removes the known-issue trap entirely. **Chosen:
(a).**

#### 4.2.1 Emptying `attendance`'s edges is a TEST RE-ARCHITECTURE, not an expectation bump (resolves HIGH-1)

Setting `MODULE_DEPENDENCIES.attendance = []` is **not** a one-line expectation change.
`attendance` is the **exemplar module that proves the whole dependency state machine**
in `apps/api/src/services/__tests__/module-system.integration.test.ts`. Four assertions
are hard-wired to attendance's three declared edges and would silently collapse if the
edge set were emptied without rework:

| Test (`it(...)` name) | Current reliance on `attendance` edges | Required rework |
|---|---|---|
| `"missingDependencies lists absent/ENTITLED/SUSPENDED deps, excludes ACTIVE"` | expects `missingDependencies("attendance", rows)` = `["academic_sessions","class_course"]` | re-point the exemplar to **`examinations`** (`["academic_sessions","class_course","student_enrollment"]`); assert its missing set with one dep ACTIVE |
| `"activation is BLOCKED (DEPS_UNMET) until every declared dep is ACTIVE"` | seeds `attendance` + 3 deps, asserts `DEPS_UNMET → ["academic_sessions","class_course","student_management"]`, then activates the chain | re-point to **`examinations`** + its three deps (`academic_sessions`, `class_course`, `student_enrollment`); assert blocked-then-activated on that chain |
| `"affectedDependents returns ACTIVE + SUSPENDED dependents of a module"` | expects `affectedDependents("student_management", rows)` = `["attendance","fees"]` | **`fees`** remains the `student_management` dependent; re-seed the SUSPENDED dependent as **`fees`** alone (or use `examinations` on `academic_sessions`); assert the set without `attendance` |
| `"suspend warns ACTIVE+SUSPENDED dependents, and the audit row persists them as scalars"` | asserts `affectedDependents("student_management")` = `["attendance","fees"]` and the persisted audit metadata carries both | re-point onto a module whose dependents are stable under the new graph — suspend **`academic_sessions`** and assert its dependents `["examinations"]` (ACTIVE+SUSPENDED), persisted as scalars; OR keep `student_management` and assert `["fees"]` only |

The replacement module choices are deliberate and already in the graph (verified in
`modules.ts`): `examinations: ["academic_sessions","class_course","student_enrollment"]`
is the natural **multi-dependency** exemplar, and `fees: ["student_management"]` stays
the **single-dependency / reverse-edge** exemplar. Engine coverage is therefore
**preserved, not deleted** — the same four state-machine behaviors (missing-set
computation, blocked-until-ACTIVE, reverse-edge dependents, suspend-warning +
audit-scalar persistence) are still proven, just carried by a different module.

**Add a positive assertion of the new stance** so "foundational-not-gated" is *tested*,
not merely documented: in `modules.test.ts` (the pure meta-test, which today asserts
only acyclicity/known-keys and has **no** attendance-specific expectation) add:

```ts
it("attendance declares no gated-module dependencies (foundational-not-gated)", () => {
  expect(MODULE_DEPENDENCIES.attendance).toEqual([]);
});
it("examinations still declares its three foundational edges", () => {
  expect([...MODULE_DEPENDENCIES.examinations].sort()).toEqual(
    ["academic_sessions", "class_course", "student_enrollment"].sort(),
  );
});
```

The existing generic `modules.test.ts` assertions (acyclic, every value a known key,
an entry per key) stay green unchanged — emptying one edge list cannot break them.

### 4.3 Route gating

All **operational** attendance routes carry
`requireModuleActive("attendance")` **in addition to** `requirePermission(...)` —
matching the `campus_movement.*` precedent (`admin.ts` emergency routes), and unlike
the foundational `classes.*`/`students.*` routes. Attendance is a **gated module**
(roadmap + architecture §5), so this is correct and required by the DoD
("module-inactive rejection" test, §11).

### 4.4 DEMO seed (`packages/db/src/seed.ts`)

Add an idempotent upsert mirroring the `campus_movement` block: seed the DEMO
institution's `attendance` row `state = ACTIVE` (entitled + activated), plus a
sample `AttendanceSession` + a couple of `AttendanceRecord`s against the existing
demo `ScheduledClass`/section/enrollment so a fresh DB demonstrates the module. The
seed is keyed on the natural unique `@@unique([scheduledClassId, date])` so re-runs
never duplicate.

---

## 5. Permissions + audit keys + role mapping

### 5.1 `attendance.*` permission keys (`packages/shared/src/permissions.ts`)

Add these to the `PERMISSIONS` array (module `"attendance"`):

| Key | Description |
|---|---|
| `attendance.view` | Staff read of sessions/records/reports (HOD dept-scoped, ADMIN whole-tenant) |
| `attendance.mark` | Faculty opens a session, marks records, submits, finalizes — **assigned classes only** (record-level scope, §7) |
| `attendance.correct` | Review (approve/reject) a correction request |
| `attendance.export` | Export attendance (authorized + audited) |
| `attendance.view_own` | Student reads only their own attendance |

> Naming follows the `<module>.<action>` convention and the existing
> `students.view / .view_own`, `classes.view / .view_own` precedent. `attendance.mark`
> intentionally covers the full marking lifecycle (open/mark/submit/finalize) gated by
> one coarse permission; the **record-level** "only my assigned class" check (§7) is
> enforced in-handler, exactly as the catalogue convention item 6 ("Resource
> ownership / class / record-level scope") prescribes. **Who may *request* a
> correction** is a policy decision (§8), not a separate permission — requesting is
> part of `attendance.mark` (faculty) and reviewing is `attendance.correct`.

### 5.2 Role mapping (`ROLE_PERMISSIONS` in `permissions.ts`)

| Role | attendance.* permissions |
|---|---|
| `STUDENT` | `attendance.view_own` |
| `FACULTY` | `attendance.mark`, `attendance.view_own` |
| `HOD` | `attendance.view`, `attendance.correct`, `attendance.export` (department-scoped reads/reviews) |
| `ADMIN` | `attendance.view`, `attendance.correct`, `attendance.export` (whole-tenant) |
| `GUARD` | — (none; attendance is unrelated to gate duty) |
| `SUPER_ADMIN` | — (platform role; no tenant attendance permissions) |

Design notes on the mapping:

- **FACULTY** gets `attendance.mark` (the one new capability a faculty needs) plus
  `attendance.view_own` so a faculty can read their own marking history as "own"
  data. FACULTY does **not** get `attendance.view`/`.correct`/`.export` (those are
  HOD/ADMIN oversight actions). A faculty's record-level marking scope is enforced
  in-handler (§7), not by a broader permission.
- **HOD** reads/reviews/exports are narrowed to `departmentScope` via the same
  relation-filter pattern `classes.ts` uses (`classesDepartmentScopeFilter`); the
  attendance equivalent (`attendanceDepartmentScopeFilter`, §8) filters through
  `attendanceSession → scheduledClass → classSection → program.departmentId`.
- **ADMIN** is whole-tenant (no department scope), matching `classes.ts`.
- **FACULTY does NOT get `attendance.correct`** — a faculty *requests* a correction
  on their finalized session (part of `attendance.mark`), but the *reviewer* must be
  HOD/ADMIN. This enforces the roadmap "authorized review" separation (§8).

**Authoritative seed list — the exact nine new `(role, key)` pairs (resolves MEDIUM-1).**
The catalogue-sync meta-test enforces **exact set-equality** between `ROLE_PERMISSIONS`
(in `permissions.ts`) and the union of `role_permissions` seed rows across
`SEEDING_MIGRATION_DIRS`. The Phase 4 migration seed (§10j) must insert **precisely**
these nine pairs — no more, no fewer:

```
(STUDENT, attendance.view_own)
(FACULTY, attendance.mark)
(FACULTY, attendance.view_own)
(HOD,     attendance.view)
(HOD,     attendance.correct)
(HOD,     attendance.export)
(ADMIN,   attendance.view)
(ADMIN,   attendance.correct)
(ADMIN,   attendance.export)
```

**GUARD and SUPER_ADMIN receive ZERO attendance pairs** — a single stray or missing
pair fails the set-equality meta-test.

**Edit `permissions.ts` in lockstep with the migration seed:** add exactly the **five**
keys (`attendance.view`, `.mark`, `.correct`, `.export`, `.view_own`) to `PERMISSIONS`,
and add them to the **five** role arrays so `ROLE_PERMISSIONS` becomes:
`STUDENT += ["attendance.view_own"]`; `FACULTY += ["attendance.mark",
"attendance.view_own"]`; `HOD += ["attendance.view","attendance.correct",
"attendance.export"]`; `ADMIN += ["attendance.view","attendance.correct",
"attendance.export"]`; `GUARD`/`SUPER_ADMIN` **unchanged**. `FACULTY` today holds only
`["classes.view_own"]` (minimal template role) — the two new keys are appended, not
replaced. The `permissions.ts` arrays and the migration seed block are a matched pair;
editing one without the other fails the build.

### 5.3 `attendance.*` audit keys (`packages/shared/src/audit-actions.ts`)

Add to `AUDIT_ACTIONS` (module `"attendance"`), all past-tense like the Phase 3
`classes.*` keys:

| Key | When written |
|---|---|
| `attendance.session.opened` | AttendanceSession created (OPEN) |
| `attendance.records.marked` | Records marked/updated inside an OPEN/SUBMITTED session (one event per submit batch; resourceId = session) |
| `attendance.session.submitted` | Session OPEN → SUBMITTED |
| `attendance.session.finalized` | Session SUBMITTED → FINALIZED |
| `attendance.correction.requested` | Correction row created (PENDING) |
| `attendance.correction.approved` | Correction PENDING → APPROVED (record rewritten, history row written) |
| `attendance.correction.rejected` | Correction PENDING → REJECTED |
| `attendance.exported` | Export performed (resourceType = "AttendanceExport") |
| `attendance.low_attendance.alerted` | Low-attendance alert emitted (resourceId = student) |

**`actorRoleKey` source (resolves NIT-2).** `AuditInput.actorRoleKey` is a required
field. Attendance events snapshot it from **`request.auth.roles[0]`** (the caller's
primary resolved role), matching the `classes.ts` precedent. For a DENIED audit on the
faculty-scope path the actor still has a resolved role (e.g. `FACULTY`), so the field is
always populated.

No pg enum / no seeded rows for audit keys (the catalogue note in
`audit-actions.ts`): validation is purely in `recordAuditEvent` against
`AUDIT_ACTION_KEY_SET`, so adding these keys needs **no migration mirror** — only
the `audit-actions.ts` edit. Every mutation route writes its event via
`recordAuditEvent(input, tx)` inside the same `withTenant` transaction
(`superadmin-security.md` §6; `classes.ts` precedent). The catalogue-sync test does
**not** parse audit keys (only permissions + role pairs), so no catalogue-sync
concern arises from audit keys.

---

## 6. Immutability + audited correction + preserved history — the `AttendanceRecordHistory` decision

### 6.1 Decision: **dedicated append-only `AttendanceRecordHistory` table** (not AuditEvent)

```prisma
model AttendanceRecordHistory {
  id                 String                            @id @default(cuid())
  institutionId      String
  institution        Institution                       @relation(fields: [institutionId], references: [id])
  attendanceRecordId String
  attendanceRecord   AttendanceRecord                  @relation(fields: [attendanceRecordId], references: [id])
  changeType         AttendanceRecordHistoryChangeType
  previousStatus     AttendanceStatus?                 // null for the initial MARKED row
  newStatus          AttendanceStatus
  correctionId       String?                           // the AttendanceCorrection that drove a CORRECTED row
  actorUserId        String
  actorMembershipId  String?
  reason             String?
  metadata           Json?
  createdAt          DateTime                          @default(now())

  @@unique([id, institutionId])
  @@index([institutionId])
  @@index([institutionId, attendanceRecordId])
  @@index([attendanceRecordId])
  @@map("attendance_record_history")
}
```

Composite same-tenant FK: `(institutionId, attendanceRecordId) →
attendance_records(institutionId, id)` RESTRICT. `correctionId` is a recorded id
with no FK (mirrors the `schedule_revisions` metadata-id style). Append-only
(§6.2).

**`actorMembershipId` is populated in practice (resolves NIT-3).** The column is
typed `String?` to allow a null for any future **system-generated** history row, but on
both real write paths it is **non-null**: the `MARKED` rows written at open carry the
marking faculty's resolved `membershipId`, and the `CORRECTED` rows written at approve
carry the reviewer's `membershipId`. This keeps the who-trail at least as strong as the
`schedule_revisions` precedent it mirrors. `actorUserId` is always non-null.

**Why a dedicated history table, not AuditEvent (chosen, with reasoning):**

1. **AuditEvent is the actor/action trail; history is the domain before/after.**
   The roadmap explicitly asks for *"preserved before/after history"* of the
   finalized→corrected transition. `AuditEvent.metadata` is a deliberately minimal,
   secret-scrubbed, string-truncated JSON blob (`sanitizeMetadata` drops nested
   objects/arrays and truncates strings) — it is designed **not** to be a reliable
   structured domain-change store. Reconstructing a student's correction history by
   parsing audit metadata would be fragile.
2. **It mirrors the established Phase 1/2/3 pattern.** `schedule_revisions`,
   `student_profile_history`, and `academic_calendar_day_revisions` are all dedicated
   append-only domain-history tables with typed previous/new columns, written in the
   same transaction as the mutation, enforced immutable by INSERT-only RLS + REVOKE +
   trigger. `AttendanceRecordHistory` is the direct analogue — one more table in a
   proven family, not a new mechanism.
3. **Both are written.** A correction writes **both** an `AttendanceRecordHistory`
   row (the domain before/after, typed) **and** an `AuditEvent`
   (`attendance.correction.approved`, the who/when/result trail). They are
   complementary, not redundant: history answers "what was this record's value over
   time", audit answers "who changed what and when, across all modules".

### 6.2 Finalized-record immutability enforced BY CONSTRUCTION

Immutability is layered so no single bug can silently rewrite a finalized record:

1. **Application layer (primary path):** the only route that writes
   `AttendanceRecord.status` after finalize is the correction-approve handler (§8),
   which runs inside `withTenant` and, in one transaction: reads the record + its
   session (asserts `session.status = FINALIZED`), writes the
   `AttendanceRecordHistory` `CORRECTED` row (previous = current status, new =
   `correction.requestedStatus`), updates the record, flips the correction to
   APPROVED, and writes the AuditEvent. The mark/submit handlers **refuse** to write
   records once `session.status = FINALIZED` (guard returns 409
   `session finalized`). This is the business-state machine (architecture §7 "invalid
   states rejected server-side").
2. **`AttendanceRecordHistory` append-only (DB layer):** INSERT-only RLS policy +
   `REVOKE UPDATE, DELETE FROM campass_app` + `BEFORE UPDATE OR DELETE` trigger that
   `RAISE EXCEPTION` (binds every role incl. owner/postgres), identical to
   `schedule_revisions_append_only`. The record's *history* can never be rewritten or
   deleted, so the before/after trail is tamper-evident even against a buggy or
   privileged write path.
3. **`AttendanceRecord` itself stays mutable** (it is corrected in place), but every
   mutation to a FINALIZED-session record is forced through the approve path (1) which
   *must* write a history row first (same transaction). There is deliberately **no**
   route that updates a finalized record without the history write.

> Invariant ownership: the **application/service layer** owns "a finalized record
> changes only via an approved correction" (it is a cross-row state-machine rule the
> DB cannot express in a constraint). The **DB layer** owns "history is never
> rewritten" (trigger + REVOKE + RLS). This split mirrors Phase 3 (the service owns
> "faculty identity is immutable, reassignment ends + inserts"; the DB owns
> "schedule_revisions is append-only").

---

## 7. Faculty-scoped marking — the real record-level authz (`canOnResource` decision)

### 7.1 Decision: **explicit in-handler `FacultyAssignment` ownership check**, not a generic `canOnResource`

The authz engine's `canOnResource` is a documented FUTURE STUB in `authz-engine.ts`
(commented out, not exported). Phase 4 implements the real record-level check as an
**explicit in-handler ownership assertion** backed by a small exported service
helper `assertFacultyAssigned(...)` in `apps/api/src/services/attendance-authz.ts`,
**not** by fleshing out the generic `canOnResource`.

**Why in-handler, not `canOnResource` (documented):**

1. **Matches the live precedent.** The stub's own comment states GatePass's
   record-level enforcement *is* in-handler (`getHodInTenant` + `departmentId`
   filter, `getStudentInTenant` ownership), and `classes.ts` enforces HOD department
   scope with an in-handler relation-filter (`classesDepartmentScopeFilter`), not a
   generic engine call. Phase 4 follows the **established** pattern rather than
   introducing a second, generic mechanism mid-roadmap.
2. **The check needs a tenant-scoped DB read.** Verifying faculty assignment reads
   `FacultyAssignment` (ACTIVE, matching the section/subject) under RLS — it must run
   inside the request's `withTenant` transaction. `requirePermission`/`can` are pure,
   I/O-free predicates over the token (by design); forcing a DB round-trip into a
   generic `canOnResource` preHandler would either duplicate the `withTenant`
   transaction or read outside it. Doing the check inside the handler's existing
   `withTenant` transaction is correct and cheap (one indexed lookup), and keeps the
   engine's hot-path guards pure.
3. **The shim + legacy role claim stay intact.** This adds no change to
   `requirePermission`, `requireModuleActive`, the `resolvePermissions` resolver, or
   the legacy `role` claim — exactly as the brief requires. It is purely additive.

### 7.2 The check (`apps/api/src/services/attendance-authz.ts`)

```ts
// Pure-ish helper: takes a tx (withTenant client) + the resolved faculty + the
// target scheduled class, returns whether this faculty may mark it. ADMIN/HOD do
// NOT mark (they have no attendance.mark); only FACULTY reaches this path.
export async function resolveMarkingFaculty(
  tx: Prisma.TransactionClient,
  institutionId: string,
  userId: string,
): Promise<{ facultyId: string } | null> {
  const faculty = await tx.facultyProfile.findFirst({
    where: { userId, institutionId, status: "ACTIVE" },
    select: { id: true },
  });
  return faculty ? { facultyId: faculty.id } : null;
}

export async function assertFacultyAssigned(
  tx: Prisma.TransactionClient,
  institutionId: string,
  facultyId: string,
  scheduled: { classSectionId: string; subjectId: string; academicTermId: string; facultyId: string },
): Promise<boolean> {
  // Fast path: the scheduled class names this faculty directly (the Phase 3
  // ScheduledClass.facultyId is the assigned teacher for that slot).
  if (scheduled.facultyId === facultyId) return true;
  // General path: an ACTIVE FacultyAssignment for this faculty on the same
  // subject + section (or subject with section unset) in the same term.
  const assignment = await tx.facultyAssignment.findFirst({
    where: {
      institutionId,
      facultyId,
      subjectId: scheduled.subjectId,
      academicTermId: scheduled.academicTermId,
      status: "ACTIVE",
      OR: [{ classSectionId: scheduled.classSectionId }, { classSectionId: null }],
    },
    select: { id: true },
  });
  return assignment !== null;
}
```

### 7.3 How it wires into the mark path → 403 on an unassigned class

The `POST /api/attendance/sessions` (open) and marking/submit/finalize handlers,
inside `withTenant`:

1. Resolve the caller's `FacultyProfile` via `resolveMarkingFaculty`. If the caller
   has `attendance.mark` but has no ACTIVE faculty profile → **403**
   (`not a faculty member`).
2. Load the `ScheduledClass` by id, filtered `institutionId` (tenant) → if missing,
   **404**.
3. `assertFacultyAssigned(tx, institutionId, facultyId, scheduled)` → if `false`,
   write an `AuditEvent` with `result: DENIED` (action `attendance.session.opened`)
   and return **403** `not assigned to this class`. **This is the "faculty marks only
   assigned classes" guarantee** — a faculty posting a `scheduledClassId` they are
   not assigned to is rejected server-side, proven by the §11 test.

   **Deny-path audit commit semantics (resolves NIT-1).** `recordAuditEvent(input, tx)`
   writes inside the `withTenant` `$transaction`, which commits when the callback
   **returns normally** and rolls back on throw. The deny handler therefore writes the
   `DENIED` audit row and then **returns `reply.status(403).send(...)` by letting the
   `withTenant` callback return normally** — it does NOT `throw` the 403. A thrown 403
   would roll back the very audit meant to record the denial. This matches the GatePass
   DENIED-audit precedent (the deny branch records-then-returns inside the committed
   transaction). The same record-then-return rule applies to the "not a faculty member"
   403 in step 1 when it writes a DENIED audit.
4. For subsequent marking/submit/finalize on an existing session, re-assert that the
   caller is the session's `markedByFaculty` (the opener) OR still assigned — a
   faculty cannot mark another faculty's session.

> Record-level scope sits at authorization-decision item 6 (`identity-rbac.md` §6.3).
> It is **in addition to** item 5 (`requirePermission("attendance.mark")`) and item 4
> (`requireModuleActive("attendance")`): all three must pass.

---

## 8. Correction workflow + marking lifecycle + route list

### 8.1 Initiator policy (decided)

- **Faculty may request a correction** on a FINALIZED record of a session they marked
  (gated by `attendance.mark` + the §7 ownership check). This is the roadmap's
  "request → reason → review" flow initiated by the person who holds the facts.
- **Students may NOT request corrections in Phase 4.** `attendance.view_own` is
  read-only. (Student-initiated dispute requests are a clean future addition — a new
  `attendance.dispute` permission + allowing `requestedByUserId` to be a student —
  noted as deferred, not built, to keep Phase 4 scoped to the roadmap's explicit
  "faculty history + student dashboard + correction workflow".)
- **Reviewer:** HOD (department-scoped) or ADMIN (whole-tenant), gated by
  `attendance.correct`. A faculty **cannot** approve their own request (separation of
  duties): the approve/reject handlers require `attendance.correct`, which FACULTY
  does not hold.

`reason` is **required** (Zod `min(1)` + a NOT NULL + `char_length >= 1` CHECK in the
migration). A correction on a non-FINALIZED session is rejected (409) — before
finalize, the marker simply edits the record in place (if
`allowSelfCorrectionBeforeFinalize`, §3.5), no correction row needed.

**No-op correction rejected (resolves MEDIUM-2).** At request time the handler reads
the live `AttendanceRecord.status` as `priorStatus` and rejects a request whose
`requestedStatus == priorStatus` → **400 `no change requested`**. A correction must
record an actual before/after; a vacuous request never creates a row and never writes a
`CORRECTED` history row.

**One PENDING correction per record (resolves MEDIUM-2).** At most one `PENDING`
`AttendanceCorrection` may exist per `attendanceRecordId` at a time. Enforced by a
**partial unique index** in the migration (§10c):
`CREATE UNIQUE INDEX "attendance_corrections_one_pending"
ON "attendance_corrections" ("institutionId", "attendanceRecordId")
WHERE "reviewStatus" = 'PENDING';`. A second concurrent request on a record with an
open PENDING correction → **409 `a correction is already pending for this record`**.
This removes the ambiguity of two PENDING corrections racing the same record.

### 8.2 Apply semantics (approve)

Approve, in one `withTenant` transaction: assert reviewer scope (HOD dept filter);
load correction (PENDING) + its record + session (FINALIZED).

**Optimistic-concurrency re-check (resolves MEDIUM-2).** Approve re-reads the **live**
`AttendanceRecord.status` and compares it to the correction's snapshotted
`priorStatus`. If they differ (the record changed between request and approve), return
**409 `record changed since request`** — the stale correction must be rejected and a
fresh one filed. This guarantees the history row's `previousStatus` is truthful (it
equals the status that actually existed immediately before the correction applied) and
prevents a stale correction from clobbering a newer value. The one-PENDING-per-record
index (§8.1) means the common cause of drift (two concurrent corrections) cannot arise;
this re-check covers the residual window and any out-of-band change.

On success (live status == `priorStatus`): write `AttendanceRecordHistory` `CORRECTED`
(previous = live record status (== priorStatus), new = correction.requestedStatus,
correctionId, `actorUserId`, `actorMembershipId`); `update` the record **`status` only**
— **`markedAt` is NOT changed** (resolves NIT-2). `markedAt` is defined (§3.3) as the
**original mark time** and stays truthful for the live row; it is deliberately **not**
bumped on correction-apply. The *when* and *who* of the correction already live
authoritatively on the history row (`createdAt` + `correctionId` + `actorMembershipId`)
and on `AttendanceCorrection.reviewedAt` / `reviewedByUserId`, so nothing is lost by
leaving `markedAt` immutable after the first mark. Then flip correction → APPROVED
(`reviewedByUserId`, `reviewedAt`, `reviewNote`);
`recordAuditEvent("attendance.correction.approved", tx)`. Reject: flip → REJECTED +
audit `attendance.correction.rejected`, record untouched, **no** history row (nothing
changed).

### 8.3 Marking lifecycle state machine

```
(no session) --open--> OPEN --submit--> SUBMITTED --finalize--> FINALIZED
                        ^  \__mark/edit records__/       |
                        |         (in place)             |
                   mark/edit (if allowed, SUBMITTED)     |
                                                correction (approved) rewrites a record
```

- **open:** `POST /sessions` body is Zod-validated by `openAttendanceSessionSchema`:
  `{ scheduledClassId: string, date: ISO-date, submissionDeadline?: ISO-datetime }`.
  - **`date` is a REQUIRED request field** (resolves HIGH-2), coerced to **UTC
    midnight** (`z.coerce.date()` then truncated to `YYYY-MM-DDT00:00:00Z`). The
    session `date` is NOT derived — the faculty names the occurrence they are marking.
  - **Date must match the scheduled class's recurrence** (resolves HIGH-2). After
    loading the `ScheduledClass` (tenant-filtered) and passing the §7 ownership check,
    validate:
    - if `ScheduledClass.dayOfWeek` is set (recurring slot): require
      `date.getUTCDay()` to equal the slot's weekday. `DayOfWeek` enum order is
      `SUN(0) MON(1) TUE(2) WED(3) THU(4) FRI(5) SAT(6)`, matching JS `getUTCDay()`; a
      small `dayOfWeekToIndex()` map lives in `attendance-authz.ts`. Mismatch → **409
      `date does not match scheduled class`**.
    - else if `ScheduledClass.date` is set (one-off slot, `dayOfWeek` null): require
      the session `date` (UTC midnight) to equal `ScheduledClass.date` truncated to UTC
      midnight. Mismatch → **409 `date does not match scheduled class`**.
    - (A slot with both null is a Phase 3 data error and cannot occur for a published
      timetable; defensively → 409.)
  - **Reject a CANCELLED scheduled class** (resolves HIGH-2): if
    `ScheduledClass.status = CANCELLED`, → **409 `scheduled class cancelled`** (no
    session may be opened against a cancelled occurrence).
  - **Phase 1 calendar day-type (holiday/working) is NOT consulted in Phase 4**
    (resolves HIGH-2): opening a session on a calendar holiday is allowed; cross-checking
    the academic calendar day type is documented as a **later refinement** (§13), not
    built here, to avoid scope creep. Stated explicitly so no reader assumes it gates.
  - On success: insert the OPEN session (unique `(scheduledClassId, date)` → **409
    `session already exists`** on dup); **snapshot** one `AttendanceRecord` per student
    whose `ClassEnrollment.status = ENROLLED` in the section at open time, default
    status **ABSENT** (documented, settings-overridable — faculty then flips present
    students; not business law); and one `AttendanceRecordHistory` `MARKED` row per
    record (`actorMembershipId` populated with the marker's membership, §6.1/NIT-3).
  - **Enrollment lifecycle vs. the snapshot (resolves MEDIUM-5):** records are
    snapshotted from `status = ENROLLED` **at open**. A student who enrolls *after* the
    session is opened is **not** retroactively added to that existing session
    (documented limitation; their attendance begins with the next session opened after
    they enrolled). A student who is **dropped** (`DROPPED`/`COMPLETED`) after records
    were created keeps their existing record (preserve-history non-negotiable — the
    record is never removed). Because open is idempotent on `(scheduledClassId, date)`
    (409 on dup), there is no re-seed path that could reconcile late enrollees.
- **mark/edit:** `PATCH /sessions/:id/records` updates record statuses while OPEN
  (always) or SUBMITTED (if `allowSelfCorrectionBeforeFinalize`); each change appends a
  `MARKED` history row (actor membership populated). Refused if FINALIZED (409).
  **A record batch may only target students who have an `AttendanceRecord` in this
  session** (i.e. were ENROLLED at open); marking a `studentId` with no record in the
  session → **409 `student not in this session`** (resolves MEDIUM-5 markable-student
  validation). This is enforced by updating existing records by
  `(attendanceSessionId, studentId)` — an unmatched pair is rejected, never inserted.
- **submit:** OPEN → SUBMITTED, set `submittedAt`.
- **finalize:** SUBMITTED → FINALIZED, set `finalizedAt`. After this, only the
  approved-correction path mutates records.

### 8.4 Route list (`apps/api/src/routes/attendance.ts`, registered at `/api/attendance`)

All routes: top-level `authenticate` preHandler; per-route `requirePermission(...)`
**and** `requireModuleActive("attendance")`; handler body in
`withTenant(institutionId, tx => ...)` with `institutionId` from `request.user`
(token only); mutations write `recordAuditEvent(..., tx)` in-tx.

| Method + path | Permission | Purpose |
|---|---|---|
| `POST /sessions` | `attendance.mark` | Open a session for a `scheduledClassId` + `date` (faculty-scope checked §7); seeds records from enrollment |
| `GET /sessions` | `attendance.view` / `attendance.mark` | List sessions (HOD dept-scoped; faculty sees own-marked) |
| `GET /sessions/:id` | `attendance.view` / `attendance.mark` | Session detail + records (scope-checked) |
| `PATCH /sessions/:id/records` | `attendance.mark` | Mark/edit a batch of records (OPEN/SUBMITTED; §7 owner) |
| `POST /sessions/:id/submit` | `attendance.mark` | OPEN → SUBMITTED |
| `POST /sessions/:id/finalize` | `attendance.mark` | SUBMITTED → FINALIZED |
| `POST /corrections` | `attendance.mark` | Faculty requests a correction on a FINALIZED record (reason required) |
| `GET /corrections` | `attendance.correct` / `attendance.view` | List corrections (HOD dept-scoped) |
| `POST /corrections/:id/approve` | `attendance.correct` | Approve → rewrite record + history + audit |
| `POST /corrections/:id/reject` | `attendance.correct` | Reject → audit, record untouched |
| `GET /me` | `attendance.view_own` | Student reads own records + computed rate |
| `GET /reports/section/:sectionId` | `attendance.view` | Section report: per-student rate, low-attendance list (HOD dept-scoped) |
| `GET /export` | `attendance.export` | Export of section/term attendance; audited `attendance.exported` (shape §8.7) |

HOD department scope (`attendanceDepartmentScopeFilter`, mirrors
`classesDepartmentScopeFilter`): for session/correction/report queries, filter through
the relation graph `attendanceSession → scheduledClass → classSection → program:
{ departmentId: scope }`; `{}` for ADMIN. Out-of-scope row → 404 (not-found), matching
`classes.ts`.

**Section report rate domain + scoping (resolves NIT-3).** `GET /reports/section/:sectionId`
takes a **required `academicTermId` query param** (matching `GET /export`, §8.7) and
computes each student's rate with the **same** pure `attendanceRate(records, policy)`
helper over the **same FINALIZED-only domain** as §8.5/§8.6 — provisional OPEN/SUBMITTED
marks are excluded, numerator = `status ∈ policy.presentStatuses`, denominator =
`status != EXCUSED`. The low-attendance list on the report is exactly the set of
students whose rate `< policy.lowAttendanceThresholdPercent` over that domain, so the
report, `GET /me`, and the alert all agree by construction (one helper, one domain).

### 8.5 Student self-service read (`GET /me`)

`attendance.view_own`: resolve the caller's `StudentProfile` (by `userId`,
institution), return that student's `AttendanceRecord`s (joined to session for
date/subject) + the computed rate. A student sees **only their own** rows (filter
`studentId = own`), proven by the tenancy escape suite's notification/own-data scope
test extended to attendance (§11). `GET /me` takes a **required `academicTermId` query
param** (matching `GET /export`, §8.7) scoping the returned records and the rate.

**Rate domain is the ONE shared definition (resolves NIT-3).** `GET /me`'s rate is the
**same pure helper** `attendanceRate(records, policy)` over the **same FINALIZED-only
domain** defined for the alert path in §8.6: only `AttendanceRecord`s in
`status = FINALIZED` sessions for the term count; OPEN/SUBMITTED provisional marks are
**excluded**; numerator = `status ∈ policy.presentStatuses`, denominator =
`status != EXCUSED`. There is one helper and one domain definition, referenced from
§8.5 (`GET /me`), §8.4 (section report), and §8.6 (alert) — so a student's dashboard
rate, the section report, and the threshold that fired their alert can never disagree.

**`GET /me` is module-gated like every operational route.** It carries
`requireModuleActive("attendance")`, so if the tenant's `attendance` module is
SUSPENDED the student's own read returns **403** — **including for historical,
already-finalized data**. This is **intended gated-module behavior** (the
`campus_movement` precedent), **not** a data-loss path: the records remain in the
database and become readable again the moment the module is reactivated.

### 8.7 Export shape (`GET /export`) (resolves NIT-5)

Query params: `sectionId` (required), `academicTermId` (required), `format`
(optional, `csv` | `json`, default `csv`). Validated by `attendanceExportQuerySchema`.
The export is **row-per-(student, session)** with exactly these columns:

```
studentEnrollmentId, studentName, sectionCode, subjectCode, sessionDate,
sessionStatus, attendanceStatus, markedAt
```

PII scope is limited to the student's enrollment identifier + display name already
visible to staff with `attendance.view` for that section — no contact details,
documents, or other SIS PII are included. The export **respects the HOD department
scope** (`attendanceDepartmentScopeFilter`, §8.4): a HOD exporting a section outside
their department gets **404** (same not-found semantics as the read routes), so export
cannot widen a HOD's read reach. Every export writes an `attendance.exported` audit
(`resourceType = "AttendanceExport"`, metadata = `{ sectionId, academicTermId, format,
rowCount }`) inside the request transaction before the file is streamed.

### 8.6 Low-attendance alert (reuse existing notification service)

**No new notification service is built** — `notifyUser(userId, payload, db)` from
`services/notifications.ts` already persists + WebSocket-pushes and derives the tenant
from the recipient. §8.6 defines exactly what rate is computed, what "crossing" means,
and how the alert is decoupled from the finalize commit (resolves MEDIUM-3).

**Rate domain — pinned (resolves MEDIUM-3).** A student's term attendance rate is
computed by the pure helper `attendanceRate(records, policy)` over the student's
`AttendanceRecord`s in sessions with **`status = FINALIZED`** for the term — including
the session being finalized in this transaction, and **excluding** any OPEN/SUBMITTED
sessions (an unfinalized session's marks are provisional and must not move the rate).
Over that set:
- **numerator** = `count(status ∈ policy.presentStatuses)` (default `PRESENT`, `LATE`),
- **denominator** = `count(status != EXCUSED)` (an approved-leave day is excluded from
  both numerator and denominator, §3.5),
- rate = `denominator == 0 ? null : (numerator / denominator) * 100`.
Numerator and denominator apply the same EXCUSED exclusion, so the helper is internally
consistent and unit-testable without a DB.

**Crossing baseline — pinned (resolves MEDIUM-3).** For each affected student, compute
two FINALIZED-only rates: `priorRate` over the student's FINALIZED sessions **before**
this finalize (i.e. excluding the just-finalized session), and `postRate` over the
FINALIZED set **including** it. Alert **iff** `postRate != null && postRate <
threshold && (priorRate == null || priorRate >= threshold)` — i.e. the student is below
threshold now and was at/above threshold (or had no prior FINALIZED history) before this
finalize. This fires exactly on the **downward crossing**, so repeatedly finalizing
further sessions while the student stays below threshold does not re-spam; a student who
was already below threshold before this session does not re-alert.

**Decoupled from the finalize commit (resolves MEDIUM-3; supersedes the old §11.1
"tx rolls back" row).** The alert is informational and **must not** be able to fail or
delay the finalize. Sequence:
1. Inside the finalize `withTenant` transaction: flip the session to FINALIZED, set
   `finalizedAt`, write `attendance.session.finalized` audit. **Commit.** The attendance
   state is now durable regardless of anything that follows.
2. **After** the transaction commits, compute per-student `priorRate`/`postRate`
   (a read-only query via a fresh short `withTenant` read). Then, for **each** crossing
   student, run the notify **and** its alert-audit **inside a fresh short
   `withTenant(institutionId, tx => …)`** — a second, short transaction entirely
   separate from the committed finalize tx — and **pass that `tx` to both**
   `notifyUser(studentUserId, payload, tx)` and
   `recordAuditEvent("attendance.low_attendance.alerted", tx)`. This is **mandatory,
   not optional**: `notification` and `audit_events` are tenant-owned tables under
   RLS, so their `create` WITH CHECK requires `app.current_institution_id` to be set
   by `withTenant`. `notifyUser(userId, payload, db)` defaults `db` to the base
   `prisma` client, which has **no** GUC set; calling `notifyUser(studentUserId,
   payload)` with no third argument would make the `notification.create` fail closed
   (every alert silently hitting the catch/warn path), and likewise an audit write
   outside a tenant tx would be rejected. The base-`prisma` default is **never** used
   for these tenant-owned writes.

   The whole per-student block is wrapped in try/catch so a notification/WebSocket
   failure is **caught and logged (warn)**, never propagated — a failed alert rolls
   back only that one student's `notification` + alert-audit (they share the one short
   post-commit `withTenant` tx), leaving the finalize fully intact. It is at-most-once
   best-effort, acceptable for an informational notification (not a financial event):

   ```ts
   // after the finalize tx has COMMITTED:
   for (const s of crossingStudents) {
     try {
       await withTenant(institutionId, async (tx) => {
         await notifyUser(s.studentUserId, lowAttendancePayload(s), tx); // tx, NOT base prisma
         await recordAuditEvent(
           { action: "attendance.low_attendance.alerted", result: "SUCCESS",
             actorUserId, actorRoleKey, institutionId,
             resourceType: "StudentProfile", resourceId: s.studentId,
             metadata: { ratePercent: s.ratePercent, threshold } },
           tx,
         );
       });
     } catch (err) {
       request.log.warn({ err, studentId: s.studentId }, "low-attendance alert failed");
     }
   }
   ```

The alert payload carries only `{ type: "attendance.low", studentId, ratePercent,
threshold }` (no PII dump). Because the alert compute runs after commit, it reads the
just-committed FINALIZED session naturally — no "pre/post inside one tx" ambiguity
remains. The §11.2 "low-attendance notification emitted on the downward crossing"
integration test depends on this tenant-tx wiring: without it the `notification.create`
fails closed and the test cannot pass.

---

## 9. Tenancy checklist compliance (`tenancy.md` §8) — per new table

All four new tables are tenant-owned. Checklist applied uniformly:

| Requirement | AttendanceSession | AttendanceRecord | AttendanceCorrection | AttendanceRecordHistory |
|---|---|---|---|---|
| non-null `institutionId` | ✅ | ✅ | ✅ | ✅ |
| composite FK (incl. `institutionId`) on every tenant link | 3-col scheduledClass+term FK, markedByFaculty | attendanceSession, student | attendanceRecord | attendanceRecord |
| `(id, institutionId)` composite unique | ✅ | ✅ | ✅ | ✅ |
| ENABLE + FORCE RLS + policies | standard pair | standard pair | standard pair | **append-only pair** |
| access via tenant-scoped client | all routes use `withTenant` | ✅ | ✅ | ✅ |
| escape tests extended (incl. buggy-query) | ✅ (§11) | ✅ | ✅ | ✅ (self-contained append-only case) |
| `@@index([institutionId])` (+ composite) | ✅ | ✅ | ✅ | ✅ |

`requestedByUserId` / `reviewedByUserId` / `actorUserId` / `correctionId` are recorded
id columns with **no FK** (the `schedule_revisions.actorUserId` / `AuditEvent`
precedent — a correction may be reviewed by an actor whose relational anchoring is not
required, and recorded-id columns avoid cross-table coupling). Documented, consistent
with Phase 1/2/3.

---

## 10. Migration — `packages/db/prisma/migrations/20261101000000_phase4_attendance/`

Hand-authored per `database.md` (NEVER `prisma migrate dev` against shared Supabase).
**Workflow:** hand-author `migration.sql` in the Phase 3 house style → confirm DDL with
read-only `prisma migrate diff` → apply via `prisma migrate deploy` →
`prisma migrate status`. The nine existing dirs are FROZEN (never edited); this is a
NEW dir only; `_prisma_migrations` ledger untouched. Timestamp `20261101000000` sorts
after `20261028000000_phase3_classes`.

Section order (mirrors the Phase 3 migration sections a–j):

- **a. Enums:** `CREATE TYPE "AttendanceSessionStatus"`, `"AttendanceStatus"`,
  `"AttendanceCorrectionReviewStatus"`, `"AttendanceRecordHistoryChangeType"`.
- **b. Tables + PKs:** `attendance_sessions`, `attendance_records`,
  `attendance_corrections`, `attendance_record_history` (createdAt DEFAULT
  CURRENT_TIMESTAMP; updatedAt NOT NULL on the three mutable tables; history has no
  updatedAt).
- **c. Indexes:** each `(id, institutionId)` unique; the business uniques
  (`attendance_sessions (scheduledClassId, date)`, `attendance_records
  (attendanceSessionId, studentId)`); every `(institutionId)` index + the §3 query
  indexes. **Plus the additive `scheduled_classes (institutionId, id, academicTermId)`
  UNIQUE** (FK target for term integrity, §3.2 — created here in the Phase 4 dir, not by
  editing the frozen Phase 3 dir). **Plus the partial unique
  `attendance_corrections_one_pending` on `(institutionId, attendanceRecordId) WHERE
  reviewStatus = 'PENDING'`** (one open correction per record, §8.1).
- **d. Tenant-root FKs:** `institutionId → institutions(id) ON DELETE RESTRICT ON
  UPDATE CASCADE` on all four.
- **e. Composite same-tenant FKs** (per §3 shapes), all `ON DELETE RESTRICT ON UPDATE
  CASCADE`. Most reference parents' `(institutionId, id)` uniques. The
  **`attendance_sessions` session↔class↔term FK is three-column** —
  `(institutionId, scheduledClassId, academicTermId) →
  scheduled_classes(institutionId, id, academicTermId)` — referencing the additive
  `scheduled_classes (institutionId, id, academicTermId)` UNIQUE from §10c. This makes a
  denormalized-term mismatch impossible by construction (MEDIUM-4). The
  `attendance_sessions` → `faculty_profiles(institutionId, id)` FK and the record /
  correction / history FKs remain two-column `(institutionId, id)` references.
- **f. CHECK constraints:**
  - `attendance_corrections`: `char_length("reason") >= 1`.
  - (status/date correctness is enforced by enum types + app state machine; no extra
    CHECK needed beyond reason non-empty.)
- **g. RLS:** ENABLE + FORCE on all four. The **three mutable** tables
  (`attendance_sessions`, `attendance_records`, `attendance_corrections`) get the
  standard nullif-guarded fail-closed pair `{tenant_isolation_select,
  tenant_isolation_modify}`. `attendance_record_history` gets the **append-only** pair
  `{tenant_isolation_select, attendance_record_history_tenant_insert}` (SELECT + INSERT
  only, NO modify), using
  `nullif(current_setting('app.current_institution_id', true), '')`.
- **h. Append-only trigger:** `CREATE FUNCTION "attendance_record_history_append_only"`
  (RAISE EXCEPTION on any op, ERRCODE `restrict_violation`) + `CREATE TRIGGER
  "attendance_record_history_no_update_delete" BEFORE UPDATE OR DELETE ON
  "attendance_record_history" FOR EACH ROW EXECUTE FUNCTION ...` — binds every role
  incl. owner (the `schedule_revisions` house style).
- **i. GRANT refresh (guarded):** inside `IF EXISTS (… rolname='campass_app')`: full
  `SELECT, INSERT, UPDATE, DELETE` on the three mutable tables; `GRANT SELECT, INSERT`
  + `REVOKE UPDATE, DELETE` on `attendance_record_history`. Never grant BYPASSRLS.
- **j. Catalogue seed:** the five `attendance.*` permissions + their
  `role_permissions` pairs (STUDENT, FACULTY, HOD, ADMIN per §5.2), using the exact
  seed-block shape + `AS m("roleKey","permKey")` join + markers the earlier seeds use
  so the catalogue-sync parser carves out this block. The FACULTY template role
  already exists (seeded by phase3). `ON CONFLICT DO NOTHING`.

Example RLS block for the append-only table (verbatim house style):

```sql
ALTER TABLE "attendance_record_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_record_history" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_select" ON "attendance_record_history";
CREATE POLICY "tenant_isolation_select" ON "attendance_record_history"
  FOR SELECT
  USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

DROP POLICY IF EXISTS "attendance_record_history_tenant_insert" ON "attendance_record_history";
CREATE POLICY "attendance_record_history_tenant_insert" ON "attendance_record_history"
  FOR INSERT
  WITH CHECK ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));
```

```sql
CREATE OR REPLACE FUNCTION "attendance_record_history_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'attendance_record_history is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "attendance_record_history_no_update_delete"
  BEFORE UPDATE OR DELETE ON "attendance_record_history"
  FOR EACH ROW EXECUTE FUNCTION "attendance_record_history_append_only"();
```

**`SEEDING_MIGRATION_DIRS`:** add `"20261101000000_phase4_attendance"` to the array in
`apps/api/src/services/__tests__/catalogue-sync.test.ts` (it seeds catalogue rows —
`database.md` rule).

---

## 11. Verification plan

### 11.1 Error-handling contract (per operation that can fail)

| Operation | Failure | Recoverable? | Caller receives | Logged? |
|---|---|---|---|---|
| open session: bad/foreign `scheduledClassId` | not-found/out-of-tenant | yes (fix id) | 404 | info |
| open session: caller not a faculty | no ACTIVE FacultyProfile | no (wrong user) | 403 `not a faculty member` | info + DENIED audit |
| open session: not assigned | §7 check false | no | 403 `not assigned to this class` | info + DENIED audit |
| open session: duplicate (scheduledClassId,date) | unique violation | yes | 409 `session already exists` | info |
| mark/submit on FINALIZED session | state-machine | no | 409 `session finalized` | info |
| open session: date ≠ scheduled-class recurrence | validation (HIGH-2) | yes (fix date) | 409 `date does not match scheduled class` | info |
| open session: scheduled class CANCELLED | state (HIGH-2) | no | 409 `scheduled class cancelled` | info |
| mark/edit: student has no record in session | not ENROLLED at open (MEDIUM-5) | yes | 409 `student not in this session` | info |
| correction on non-FINALIZED record | state-machine | yes | 409 | info |
| correction request: `requestedStatus == priorStatus` | no-op (MEDIUM-2) | yes | 400 `no change requested` | — |
| correction request: a PENDING already exists | partial-unique (MEDIUM-2) | yes | 409 `a correction is already pending for this record` | info |
| correction approve: not PENDING | state-machine | no | 409 | info |
| correction approve: live status ≠ priorStatus | optimistic concurrency (MEDIUM-2) | yes (refile) | 409 `record changed since request` | info |
| correction approve: HOD out-of-scope | scope filter | no | 404 | info |
| empty `reason` | Zod + CHECK | yes | 400 | — |
| RLS GUC unset / cross-tenant | DB fail-closed | no | zero rows / WITH CHECK reject | DB |
| `requireModuleActive` state read throws | infra | — | 500 fail-closed | error |
| low-attendance alert failure (post-commit) | infra (MEDIUM-3) | n/a | finalize already committed (200); alert skipped | warn (caught, not propagated) |

Each external input is Zod-validated in `@campusgate/shared` (new schemas:
`openAttendanceSessionSchema`, `markAttendanceRecordsSchema`,
`requestCorrectionSchema`, `reviewCorrectionSchema`, `attendanceReportQuerySchema`,
`attendanceExportQuerySchema`):
types, required/optional, `reason` min length, `date` ISO, `status` enum membership,
record-batch array bounds. Invalid → 400 with `error.flatten()` (the `classes.ts`
shape).

### 11.2 Tests

- **Unit (no DB):** `attendance-policy.test.ts` (rate computation across
  present/absent/late/excused + threshold crossing + settings override + defaults);
  `attendance-authz.test.ts` can run the pure branch of `assertFacultyAssigned` (the
  direct `scheduled.facultyId === facultyId` fast path) without DB; the DB branch is
  integration-tested.
- **Integration (live Supabase, `campass_app`):** `attendance-behavioral.integration`
  and `attendance-routes.integration` covering the lifecycle (open → mark → submit →
  finalize), the **faculty-scope 403** (a faculty posting an unassigned
  `scheduledClassId` is denied), the **correction workflow** (request → HOD approve →
  record rewritten + history row present + audit written; reject leaves record
  untouched), **finalized immutability** (mark on a FINALIZED session → 409; direct
  update attempt blocked), **module-inactive rejection** (suspend `attendance` →
  every operational route 403), **student own-read isolation**, **low-attendance
  notification** emitted on the downward crossing (and NOT re-emitted on a subsequent
  finalize while the student stays below threshold — the §8.6 crossing de-dupe),
  **no-op correction 400**, **PENDING-uniqueness 409**, **stale-approve 409**
  (record changed since request), **date-mismatch 409** (session date ≠ scheduled-class
  recurrence), **CANCELLED-class 409**, and **term-integrity** (a tampered
  `academicTermId` on session insert is rejected by the three-column FK).
- **Escape suite extension** (`tenant-escape-setup.ts` + `tenant-escape.integration`):
  seed the three mutable attendance tables per tenant (A/B) via `adminClient`
  (standard pair) and add them to `RLS_TABLES`, `countRemainingTestRows`, and the
  cleanup order (child-first: records/corrections → sessions; history excluded from
  the generic loop like `schedule_revisions`). Add
  `attendance_record_history` to `RLS_TABLES` + `EXPECTED_POLICIES`
  (`["tenant_isolation_select","attendance_record_history_tenant_insert"]`). Cover
  read-escape, spoofed-tenant write, foreign-parent write, the deliberately-buggy
  query (forgets tenant filter → RLS returns only A), and the self-contained
  append-only case for history.
- **Meta-tests:** `catalogue-sync.test.ts` passes with the new dir + keys (union
  set-equality green). **`module-system.integration.test.ts` is re-architected per
  §4.2.1** — the four exemplar assertions move from `attendance` onto `examinations`
  (multi-dep: `missingDependencies`, `DEPS_UNMET`-blocked-until-ACTIVE) and `fees` /
  `academic_sessions` (reverse-edge + suspend-warning + audit-scalar persistence), so
  the dependency state machine stays fully proven (not weakened) after
  `MODULE_DEPENDENCIES.attendance = []`. The exact `it(...)` names being rewritten are
  listed in the §4.2.1 table. **`modules.test.ts`** gains the two positive assertions
  from §4.2.1 (attendance deps `[]`; examinations still declares its three edges); its
  existing generic assertions are unchanged. The RLS meta-test (escape suite) asserts
  every new tenant-owned table has RLS + the correct policy set.
- **Regression:** Phase 1/2/3 suites (academics, SIS, classes) + the GatePass/campus
  movement suites must stay green — attendance adds tables/routes/permissions only and
  touches no existing table's RLS/FK/grant (migration only CREATEs + seeds), so
  regression risk is confined to the `MODULE_DEPENDENCIES.attendance` edit (covered by
  the module tests) and the shared-catalogue additions (covered by catalogue-sync).

### 11.3 DB-verification proof points (live smoke, per `database.md`)

0. **Pre-flight `prisma migrate status` is clean (resolves NIT-6).** Before authoring
   or deploying, run `prisma migrate status` and confirm it reports "up to date" with
   the nine frozen dirs and no ledger drift (the `database.md` §6a notes record prior
   drift incidents, so this is a required step-0, not optional). Also confirm **no other
   in-flight migration dir claims a `202610xx`–`20261101` timestamp slot** that would
   interleave before `20261101000000_phase4_attendance` and break the deploy ordering;
   if a sibling dir exists, bump the Phase 4 timestamp so it sorts strictly last.
1. `prisma migrate diff` (DIRECT_URL, read-only) shows exactly the four new tables +
   enums + constraints **plus the one additive
   `scheduled_classes (institutionId, id, academicTermId)` UNIQUE** (the FK target for
   term integrity, §3.2/§10e) — no other drift against the frozen nine.
2. `prisma migrate deploy` applies the new dir; `prisma migrate status` → "up to
   date", no duplicates, nine frozen dirs unchanged.
3. `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='campass_app'` → both
   `false` (unchanged).
4. Seed run: DEMO `attendance` row ACTIVE; sample session/records present.
5. Append-only proof: as `campass_app`, `UPDATE attendance_record_history …` and
   `DELETE …` both raise `restrict_violation` (trigger) and are REVOKEd.
6. Fail-closed proof: a query with the GUC unset returns zero attendance rows.
7. `npm ci` clean build + `turbo` typecheck/test green across `packages/shared`,
   `packages/db`, `apps/api`.

---

## 12. Testability summary

- **Unit-testable without a DB:** the rate/threshold policy
  (`attendancePolicy` + rate computation) and the faculty-assignment fast-path
  decision — pure functions, the `student-sis.ts` / `faculty-assignment.ts` precedent.
- **Integration-tested (needs RLS/DB):** faculty-scope ownership (reads
  `FacultyAssignment` under RLS), the correction transaction (record + history + audit
  atomicity), append-only enforcement, module-active gating, tenant isolation.
- The design keeps domain decisions in pure helpers and I/O in thin handlers, so the
  risky invariants (immutability, scope, rate) are directly testable — a design that
  was hard to test here would indicate the record-level check or the history write was
  mis-placed.

---

## 13. Explicit non-couplings and out-of-scope

- **No GatePass/movement coupling:** no FK, no shared table, no import between
  `attendance.ts` and `guard.ts`/`student.ts`/pass lifecycle. Attendance is its own
  module (architecture §4 boundary rule). Confirmed by the audit/permission namespaces
  being disjoint.
- **Out of scope / deferred (Phase 4):**
  - **Submission-deadline enforcement (resolves NIT-4):** `submissionDeadline` is
    modeled on `AttendanceSession` and accepted at open, but is **purely informational
    in Phase 4 — it does NOT gate submit/finalize.** The column is reserved so a later
    phase can enforce it (e.g. reject submit after the deadline, or flag late
    submissions) without a schema change. A reader must not assume deadlines block
    submission today.
  - **Student-initiated correction/dispute requests** (deferred — faculty-only
    initiator this phase; a future `attendance.dispute` permission is the clean add).
  - **QR/self-check-in/biometric marking** (roadmap notes these as later add-ons
    needing their own anti-abuse controls — not built, not assumed to prove presence).
  - **Phase 1 academic-calendar day-type cross-check at open** (holiday/working-day
    validation) — documented as a later refinement (§8.3); not built in Phase 4.
  - **Nightly/batch low-attendance recompute job** (Phase 4 computes on finalize; a
    scheduled recompute is a clean later addition).
  - Any `apps/web` frontend (Option A deferral); Phase 5 Library (independent).

---

## 14. Summary of decisions (for the reviewer)

1. **Dependency model: Option (a)** — `attendance` declares no gated-module deps
   (`MODULE_DEPENDENCIES.attendance = []`); only the `attendance` row must be
   ENTITLED→ACTIVE; foundational class/student/session prerequisites validated at
   operation time. Consistent with the Phase 1/2/3 foundational-not-gated decision;
   resolves the Phase 3 known issue.
2. **History vs audit: dedicated append-only `AttendanceRecordHistory` table** (plus
   AuditEvent for the actor trail) — typed before/after, mirrors
   `schedule_revisions` / `student_profile_history`, enforced immutable by INSERT-only
   RLS + REVOKE + BEFORE UPDATE/DELETE trigger.
3. **`canOnResource`: explicit in-handler `FacultyAssignment` ownership check**
   (`assertFacultyAssigned`), not a generic engine method — matches the live GatePass/
   classes record-level precedent, keeps the engine's hot-path guards pure, leaves the
   shim + legacy role claim intact.
4. **Correction initiator: faculty-only** (on their own finalized sessions); students
   read-only; reviewer HOD (department-scoped) or ADMIN; separation of duties (a
   faculty cannot approve their own request — no `attendance.correct`).

**Deliverable written to:** `c:\campusgate\docs\phase4\design.md`.

---

## 15. Response to the design review (revision iteration)

Verdict addressed: CHANGES_REQUESTED (2 HIGH, 5 MEDIUM, 6 NIT). Every HIGH and MEDIUM
is **addressed** (none backlogged or ignored); all NITs are addressed too. The choices
align with the original requirements (foundational-not-gated, by-construction
immutability/integrity, in-handler record-level authz, faculty-only correction
initiator).

| Finding | Disposition | Where resolved |
|---|---|---|
| **HIGH-1** — `MODULE_DEPENDENCIES.attendance = []` breaks the dependency engine's multi-dep exemplar; was mischaracterized as an expectation bump | **Addressed.** Documented as a test **re-architecture**: the four exemplar `it(...)` assertions move onto `examinations` (multi-dep) and `fees`/`academic_sessions` (reverse-edge + suspend + audit-scalar), so engine coverage is preserved not deleted; added positive assertions that attendance deps are `[]` and examinations keeps its three edges; listed the exact test names rewritten. | §4.2.1, §11.2 |
| **HIGH-2** — `AttendanceSession.date` ↔ `ScheduledClass` recurrence relationship unspecified | **Addressed.** `date` is a required Zod field coerced to UTC midnight; on open it must match `dayOfWeek` (weekday via `getUTCDay()`, SUN=0) for a recurring slot or `ScheduledClass.date` for a one-off, else 409; CANCELLED scheduled class rejected (409); Phase 1 calendar day-type explicitly NOT consulted (deferred). | §3.2, §8.3, §13 |
| **MEDIUM-1** — role-permission pairs given as prose, not the authoritative seed list | **Addressed.** Replaced prose with the explicit nine `(role, key)` pairs; GUARD/SUPER_ADMIN get none; stated `PERMISSIONS` (5 keys) + `ROLE_PERMISSIONS` (5 arrays) edited in lockstep with the migration seed for set-equality. | §5.2 |
| **MEDIUM-2** — no-op correction + priorStatus staleness/concurrency unvalidated | **Addressed.** Reject `requestedStatus == priorStatus` (400) at request; one PENDING per record via partial unique index (409 on second); approve re-reads live status and 409s if it no longer equals `priorStatus`. | §8.1, §8.2, §10c, §11.1 |
| **MEDIUM-3** — low-attendance crossing baseline under-specified + notify coupled to finalize rollback | **Addressed.** Pinned rate domain (FINALIZED sessions incl. the one finalizing; numerator = presentStatuses, denominator = non-EXCUSED); pinned the downward-crossing baseline (priorRate ≥ threshold → postRate < threshold, first-finalize undefined → alert); moved notify **after commit**, best-effort/try-caught/logged; reconciled the old §11.1 rollback row. | §8.6, §11.1 |
| **MEDIUM-4** — denormalized `academicTermId` equality enforced only in prose | **Addressed by construction.** Session↔class link is now a three-column FK `(institutionId, scheduledClassId, academicTermId) → scheduled_classes(institutionId, id, academicTermId)`, backed by a new additive `scheduled_classes (institutionId, id, academicTermId)` UNIQUE created in the Phase 4 dir; DB refuses a mismatched term. Tamper test added. | §3.2, §10c, §10e, §11.2 |
| **MEDIUM-5** — enrollment lifecycle vs. snapshot unspecified | **Addressed.** Records snapshotted from `status = ENROLLED` at open; late enrollees not retroactively added (documented); dropped students' records retained (preserve-history); marking a student with no record in the session → 409. | §8.3, §11.1 |
| **NIT-1** — DENIED-audit commit semantics inside `withTenant` | **Addressed.** Deny handlers write the DENIED audit then `return reply.status(403)` from a normally-returning `withTenant` callback (no throw), so the audit commits (GatePass precedent). | §7.3, §11.1 |
| **NIT-2** — `actorRoleKey` source unspecified | **Addressed.** Sourced from `request.auth.roles[0]` (classes.ts precedent). | §5.3 |
| **NIT-3** — `AttendanceRecordHistory.actorMembershipId` nullable weakens who-trail | **Addressed.** Populated non-null on MARKED/CORRECTED rows; null reserved for future system rows only. | §6.1, §8.3, §8.2 |
| **NIT-4** — `submissionDeadline` modeled but non-enforcing vs. roadmap scope | **Addressed.** Called out in §13 as deferred/reserved; does not gate submit/finalize. | §13 |
| **NIT-5** — export format/columns/PII/dept-scope under-specified | **Addressed.** `GET /export` columns, `format` param, limited PII scope, and HOD dept-scope adherence (404 out-of-scope) pinned. | §8.7, §8.4 |
| **NIT-6** — migration ordering assumes no sibling; no pre-flight status | **Addressed.** Added step-0 `prisma migrate status` clean pre-flight + sibling-slot confirmation (bump timestamp if needed). | §11.3 |

### 15.1 Revision iteration 3 — response to the iteration-2 re-check

Iteration-2 review (`design-review.json` / `design-review.md`): verdict
CHANGES_REQUESTED, **all 13 prior findings CLOSED**, with **1 new MEDIUM + 3 new NIT**
from reviewing the changed material. Every new finding is **addressed** below (none
backlogged or ignored); all align with the original requirements (reuse the existing
notification/audit tenant-tx contract, one shared rate domain, truthful live
timestamps, gated-module semantics).

| Finding | Disposition | Where resolved |
|---|---|---|
| **MEDIUM-1 (new)** — post-commit low-attendance notify sets no tenant RLS context; `notifyUser(studentUserId, payload)` without a `tx` defaults to base `prisma` (no GUC) and the tenant-owned `notification.create` + alert-audit fail closed | **Addressed.** §8.6 step 2 now wraps the per-student notify **and** its `attendance.low_attendance.alerted` audit in a **fresh short `withTenant(institutionId, tx => …)`** (a second transaction separate from the committed finalize tx) and **passes that `tx` to both** `notifyUser(studentUserId, payload, tx)` and `recordAuditEvent(..., tx)`. States the base-`prisma` default is never used for these tenant-owned writes, the notify + its audit share one short post-commit tx, and the §11.2 crossing test depends on this wiring. Added the concrete code snippet. | §8.6 |
| **NIT-1 (new)** — `GET /me` module-gating consequence (403 on own read, incl. historical finalized data, when `attendance` SUSPENDED) unstated | **Addressed.** §8.5 now states `GET /me` is module-gated like every operational route, so a SUSPENDED module returns 403 on the student's own read including historical finalized data, and that this is intended gated-module behavior (not a data-loss path) — records return on reactivation. | §8.5 |
| **NIT-2 (new)** — correction-apply overwrites `AttendanceRecord.markedAt`, erasing the original mark time from the live row | **Addressed (recommended option a).** §8.2 now updates **`status` only** and **does NOT bump `markedAt`**; §3.3 defines `markedAt` as the immutable original mark time, with correction when/who tracked on the history row + `AttendanceCorrection.reviewedAt`. §8.2 and §3.3 agree. | §8.2, §3.3 |
| **NIT-3 (new)** — report / `GET /me` rate domain + term-scoping input unspecified; only the alert path pinned the FINALIZED-only domain | **Addressed.** §8.5 (`GET /me`) and §8.4 (`GET /reports/section/:sectionId`) now use the **same** pure `attendanceRate(records, policy)` helper over the **same FINALIZED-only domain** as §8.6 (provisional OPEN/SUBMITTED excluded), each with a **required `academicTermId` query param** matching `GET /export`. One helper, one domain, referenced from all three places. | §8.5, §8.4 |
