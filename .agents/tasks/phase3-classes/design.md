# CAMPASS Phase 3 — Class & Course Management · Technical Design

> Artifact for the design-review step. **Revision 3** — revised to resolve the findings in
> the latest `design-review.json` / `design-review.md` (verdict CHANGES_REQUESTED:
> 2 MEDIUM, 4 NIT — a table-count inconsistency and the Phase-4 dependency hand-off, plus
> four NITs). See the "Responses to design review" section at the end for a point-by-point
> mapping. The
> roadmap (`docs/roadmap.md`
> "Phase 3 — Class & Course management" + "Phase completion gate") is THE spec; on any
> conflict the roadmap wins. Grounded in the live `packages/db/prisma/schema.prisma`,
> `apps/api` source, and the `docs/` set (`tenancy.md`, `identity-rbac.md`,
> `superadmin-security.md`, `architecture.md`, `database.md`), and in the Phase 1/2
> precedents (`academic_calendar_day_revisions`, `student_profile_history`,
> `audit_events`). Runs on `main`, no worktree, keep the app working, do NOT push/deploy.

---

## 1. Overview

Phase 3 represents **what** students study (Course / Subject), **who** teaches it
(Faculty), **which cohort** studies it (ClassSection + ClassEnrollment), and **when**
it happens (Timetable + ScheduledClass), with a real server-side **conflict-detection**
algorithm and **append-only schedule revision history**.

It is built entirely on the LIVE foundation and does not reinvent any of it:

- **Tenancy A2** (`tenancy.md`): every new table is tenant-owned — non-null
  `institutionId`, `@@unique([id, institutionId])`, composite same-tenant FKs including
  `institutionId`, `ENABLE`+`FORCE` RLS with the nullif-guarded fail-closed policy pair,
  and an `institutionId` index. The hand-authored migration carries all of this (Prisma
  does not model RLS / composite FKs / triggers natively — `database.md` §4).
- **Identity/RBAC B2** (`identity-rbac.md`): new `classes.*` permission keys in
  `packages/shared`, bound to template roles, gated with `requirePermission`; the shim +
  legacy `role` claim stay intact.
- **Audit v2** (`superadmin-security.md`): class/timetable mutations write `AuditEvent`
  via `recordAuditEvent` with new `classes.*` audit keys; catalogue-sync stays green.
- **Phase 1 reuse**: `AcademicSession`, `AcademicTerm`, `Program`, `CalendarService`,
  `InstitutionConfig.workingDaysOfWeek`. **Phase 2 reuse**: the authoritative
  `StudentProfile` (enrollment references it via composite FK — never a second copy).

The single net-new identity concept is **Faculty**: a tenant-owned `FacultyProfile`
that references the shared `User` (parallel to `HodProfile`), so a user can be HOD and
faculty without a parallel account. Faculty assignment and timetable history are
**append-only**, mirroring `student_profile_history` / `academic_calendar_day_revisions`.

The deliverable proves the roadmap DoD: build a timetable; reject a double-booked
room/faculty; record a published change as a revision; students/faculty see their
schedule.

---

## 2. Technology stack (LOCKED on approval)

No new technologies. This phase is additive on the existing stack:

- **Runtime/API**: Fastify (TypeScript, ESM) in `apps/api` — the modular monolith.
- **ORM/DB**: Prisma 6.19.3 → PostgreSQL (Supabase); runtime via `campass_app`
  (NOSUPERUSER NOBYPASSRLS) over the 6543 transaction pooler; migrations/DDL + seed +
  privileged reads via `postgres` over the 5432 session pooler (`DIRECT_URL`). Do **not**
  upgrade Prisma (the 8.0.0-rc update banner is noise).
- **Shared contracts**: `@campusgate/shared` for the permission, audit-action, and module
  catalogues + Zod validation (`packages/shared/src/validation.ts`).
- **Tenant access**: the existing `withTenant(institutionId, fn)` helper
  (`set_config('app.current_institution_id', $1, true)` inside `$transaction`) for every
  tenant read/write; `privilegedPrisma` only for the audit writer's platform path (not
  used by Phase 3 tenant mutations).
- **Tests**: vitest, `fileParallelism: false`, single-run. Static unit tests for pure
  logic; real-DB integration through the shared `tenant-escape-setup.ts` helper.
- **IDs**: `cuid()` PKs (schema default), as every existing model.

No new service, queue, broker, or deployment target is introduced (consistent with D6,
`architecture.md` §4). Cross-module reactions stay in-process.

---

## 3. Architecture placement — foundational institution data, NOT a gated module

**Decision: Class & Course is institution-layer (Layer B) foundational academic data,
permission-gated ONLY — it is NOT wrapped in `requireModuleActive`.** This follows the
exact precedent set by Phase 1 academics (`academics.*`) and Phase 2 SIS (`students.*`),
which are both registered WITHOUT a module-active guard and gated by permissions alone
(verified: `apps/api/src/server.ts` registers `studentAdminRoutes`/`studentRoutes`
with no `requireModuleActive`, and `permissions.ts` annotates `students.*` as
"Foundational institution-layer data, permission-gated ONLY (never module-gated)").

Justification against `architecture.md` §5 and the dependency graph in
`packages/shared/src/modules.ts`:

- Sessions/terms/programs (Phase 1) and the authoritative student record (Phase 2) are
  **shared institutional structure** every later module composes. Courses, subjects,
  class sections, and timetables are the same kind of structural backbone: Attendance
  (Phase 4), Examinations (Phase 8), and Fees reference them. `architecture.md` §5.4
  already lists `class_course` as a **dependency** that Attendance/Examinations require
  to be present — i.e. it is foundational substrate, not an optional booster an
  institution toggles.
- The `class_course` module key in `modules.ts` and its edges in `MODULE_DEPENDENCIES`
  stay as **declared constants** (the mechanism is complete and tested at the
  foundation), but Phase 3 does **not** seed a `campus_movement`-style
  `institution_module` row for it, create activation routes for it, or gate its routes
  with `requireModuleActive("class_course")`. This mirrors how Phase 1/2 left their
  module keys declared-but-not-operational. **No change to `modules.ts` is required.**
- Consequence for Phase 4 (stated accurately against the live engine, NOT as a free
  hand-off): when Attendance ships as a real gated module, its
  `requireModuleActive("attendance")` runs `missingDependencies("attendance", rowsByKey)`,
  which (verified in `apps/api/src/services/module-system.ts`) returns any dep whose row
  `state !== "ACTIVE"`. With `MODULE_DEPENDENCIES.attendance` including `"class_course"`
  and **no `institution_module` row for `class_course`** (because Phase 3 keeps it
  foundational), `rowsByKey.get("class_course")?.state` is `undefined`, which is
  `!== "ACTIVE"`, so the current engine would report `class_course` as a **missing
  dependency** and `activate("attendance", …)` would return `DEPS_UNMET`. There is
  deliberately **no force-activate path**. Therefore the foundational placement is **not**
  free for Phase 4: it will require a concrete, named change **in Phase 4** — either (a)
  Phase 4 removes the `class_course` edge from `MODULE_DEPENDENCIES.attendance` and
  substitutes a data-existence check (preferred, matching the foundational stance), or (b)
  Phase 4 seeds + activates a `class_course` `institution_module` row during attendance
  onboarding. **Phase 3 does not edit `modules.ts`, does not seed a module row, and does
  not pretend the current engine already treats an absent row as satisfied.** This is a
  Phase-4 decision, flagged in §13 as a seam, and explicitly **not designed here**; it is
  named only so the foundational choice is made with open eyes.

> **Assumption A1 (for the reviewer):** the reviewer should confirm that leaving
> `class_course` as a declared-but-not-activated module key (foundational, like Phase
> 1/2) is correct, versus seeding an `institution_module` row and gating routes. The
> precedent (Phase 1/2) and `architecture.md` §5.4 framing of `class_course` as a
> *dependency* strongly support foundational; this design commits to foundational. The
> explicit cost of that choice — that Phase 4 attendance activation needs a concrete
> `modules.ts`/onboarding change to satisfy the live `missingDependencies` predicate — is
> named in §3 and §13, not hidden.

Routes live under a new `apps/api/src/routes/classes.ts` (admin/HOD/faculty surface)
registered in `server.ts` at prefix `/api/classes`, plus read-only "my schedule"
additions to the existing `student.ts` (`/api/student`) and a small faculty surface.
Domain logic lives in `apps/api/src/services/` (new `timetable-conflict.ts`,
`faculty-assignment.ts`, `class-enrollment.ts`), following the DB-free pure-logic +
route-owns-I/O split that `student-sis.ts` / `academic-session.ts` established.

---

## 4. Course-vs-Subject semantics (resolved)

**Decision — the chosen model:**

- **`Subject`** is the **teachable unit** — the thing a faculty member teaches and a
  timetable slot delivers (e.g. "Data Structures", "Database Systems"). It carries
  optional `credits` and `contactHoursPerWeek`. A `ScheduledClass` and a
  `FacultyAssignment` both point at a `Subject`. This is the atom Phase 4 attendance and
  Phase 8 exams will reference.
- **`Course`** is a **named grouping of subjects that maps to a Program** — the curriculum
  container (e.g. the "BCA Semester 1 Core" course, or simply the program's subject set
  for a stage). A `Course` **belongs to a `Program`** (composite FK) and optionally to a
  specific `AcademicTerm`/stage. Subjects belong to a `Course`.
- **`ClassSection`** is the **cohort that studies** — it links `Program` +
  `AcademicSession` + `AcademicTerm` + optional section label (A/B) + capacity + status.
  Students enroll into a `ClassSection` (not into a Course/Subject directly).

So the shape is: `Program → Course → Subject`, and separately
`Program + Session + Term → ClassSection → (ClassEnrollment of students)`, with the
timetable (`ScheduledClass`) joining a `ClassSection` to a `Subject` + `Faculty` + room +
time. This cleanly matches the roadmap's "Courses/programs, subjects/units, class/section
creation" wording and keeps the "what is taught" axis (Course/Subject) orthogonal to the
"who studies together" axis (ClassSection).

> **Rationale for Course mapping to Program (not free-standing):** the roadmap says
> "Course groups them or maps to Program" and "composite FKs link to shared session".
> Binding `Course → Program` (a Phase-1 tenant-owned parent with an existing
> `(id, institutionId)` unique) gives a clean composite same-tenant FK and lets a program
> own its curriculum, which is how Phase 8 exams will want to find "the subjects of a
> program". A free-standing Course with no Program link would float without a tenant-safe
> anchor and duplicate what Program already expresses.

> **Assumption A2:** a `Subject` belongs to exactly one `Course` (hence one Program).
> Cross-listing a subject under multiple courses/programs is **out of scope** (§14) — if
> the reviewer needs cross-listing, it becomes a join table, a larger change. The single
> `courseId` FK is the committed model.

---

## 5. Faculty identity (reuse User, do not duplicate)

**Decision:** introduce a tenant-owned **`FacultyProfile`** that references the shared
`User` via `userId` (composite same-tenant FK on `(institutionId, userId)` is not needed
because `users` is tenant-owned with a `(id, institutionId)` unique — we use
`(institutionId, userId)` → `users(institutionId, id)` to keep the same-tenant guarantee,
exactly as other profiles do). `FacultyProfile` is modeled **parallel to `HodProfile`**:
one row per teaching user per institution, with `@unique userId` and
`@@unique([id, institutionId])`.

Why a profile table rather than a new `UserRole.FACULTY` enum value or overloading
`HodProfile`:

- The `UserRole` enum has **no `FACULTY` value** (verified). Adding one is an
  auth-critical enum migration touching the legacy shim; `database.md` §6a explicitly
  defers legacy-enum changes to their own reviewed workstream. We avoid it. **Faculty is
  additive**: a user becomes faculty by having a `FacultyProfile` + the FACULTY template
  role bound to their membership, NOT by changing `User.role`.
- A user may be **both HOD and faculty**: they keep their single `User`/membership, can
  hold both the HOD and FACULTY template roles (B2 memberships already support multiple
  roles via `MembershipRole`), and have both a `HodProfile` and a `FacultyProfile`. No
  parallel user, no change to `HodProfile`.
- Identity stays single: `FacultyProfile.userId → User`. Teaching assignments
  (`FacultyAssignment`) and `ScheduledClass.facultyId` reference the **FacultyProfile**,
  not the User, so the teaching domain has one stable anchor without copying identity.

**New template role `FACULTY`** (institution-null template, seeded alongside the existing
five). It holds the view-own-schedule permissions (§7). Introducing a *template role* is
data (seed + migration `roles`/`role_permissions` inserts), not a `UserRole` enum change
— the role system (`Role.key`) is already string-keyed and open (e.g. "LIBRARIAN" is
cited in `identity-rbac.md` as a future template role). The authenticate/login resolver
already resolves whatever roles a membership holds, so a FACULTY role flows into the JWT
`roles`/`permissions` with zero middleware change.

> **Assumption A3:** the five legacy enum values map 1:1 to template roles today; adding a
> `FACULTY` template role with **no** matching `UserRole` enum value is consistent with
> B2 (roles are decoupled from the enum) but means a faculty user's legacy `User.role`
> column holds some existing value. Because Phase 3 routes are permission-gated (not
> `requireRole`), the legacy enum value on a faculty user does not gate Phase 3 access, and
> the shim reads `User.role` only for legacy GatePass routes (a faculty user simply isn't a
> GatePass actor by virtue of being faculty). To keep the seed **deterministic** (the
> reviewer's note), the exact value is pinned: a pure-faculty user is seeded with
> `role = GUARD` (an inert non-actor value for the GatePass shim), and a user who is both
> HOD and faculty keeps `role = HOD`. See §15.

---

## 6. Schema (new tenant-owned tables)

All tables: non-null `institutionId`; `@@unique([id, institutionId])`; `@@index([institutionId])`;
composite same-tenant FKs to every tenant-owned parent; `ENABLE`+`FORCE` RLS; standard
nullif-guarded policy pair (append-only pair for the revision table). Prisma models below;
the hand-authored SQL (§11) carries the RLS/FK/trigger DDL Prisma cannot express.

### 6.1 New enums

```prisma
enum ClassSectionStatus { PLANNED  ACTIVE  CLOSED  CANCELLED }
enum EnrollmentStatus   { ENROLLED  DROPPED  COMPLETED }           // no-duplicate enforced by unique
enum FacultyStatus      { ACTIVE  INACTIVE }
enum FacultyAssignmentRole   { PRIMARY  SUBSTITUTE  ASSISTANT }
enum FacultyAssignmentStatus { ACTIVE  ENDED }                      // soft transition; history preserved
enum TimetableStatus    { DRAFT  PUBLISHED  ARCHIVED }
enum ScheduledClassStatus { SCHEDULED  CANCELLED }
enum DayOfWeek          { SUN MON TUE WED THU FRI SAT }             // label->ordinal SUN=0..SAT=6, aligned to JS getUTCDay() (see §8.2 DOW_INDEX)
enum ScheduleRevisionChangeType {                                   // append-only history
  TIMETABLE_CREATED  TIMETABLE_PUBLISHED  TIMETABLE_ARCHIVED
  SCHEDULED_CLASS_ADDED  SCHEDULED_CLASS_UPDATED  SCHEDULED_CLASS_CANCELLED
  FACULTY_REASSIGNED
}
```

### 6.2 `Course` (belongs to a Program)

```prisma
model Course {
  id            String        @id @default(cuid())
  institutionId String
  programId     String                                   // composite FK -> programs
  academicTermId String?                                 // optional stage/term, composite FK (SET NULL)
  name          String
  code          String
  description   String?
  status        ProgramStatus @default(ACTIVE)           // reuse existing enum (ACTIVE|INACTIVE)
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt

  subjects      Subject[]
  @@unique([institutionId, code])
  @@unique([id, institutionId])
  @@index([institutionId])
  @@index([programId])
  @@map("courses")
}
```

> **Deliberate enum reuse (Course + Subject `status`):** a course and a subject have the
> same `ACTIVE`/`INACTIVE` lifecycle as a program, so both reuse the existing
> `ProgramStatus` enum rather than minting a near-duplicate `CourseStatus`/`SubjectStatus`.
> This is intentional (not an oversight) — the other Phase-3 tables mint their own status
> enums (§6.1) only where the lifecycle genuinely differs (sections, faculty, assignments,
> timetables, scheduled classes). A course's status is **not** coupled to its program's
> status; they are independent rows that merely share the same two-value lifecycle vocabulary.

### 6.3 `Subject` (the teachable unit)

```prisma
model Subject {
  id                 String   @id @default(cuid())
  institutionId      String
  courseId           String                              // composite FK -> courses
  name               String
  code               String
  credits            Int?                                 // optional
  contactHoursPerWeek Int?                                // optional
  status             ProgramStatus @default(ACTIVE)
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  facultyAssignments FacultyAssignment[]
  scheduledClasses   ScheduledClass[]
  @@unique([institutionId, code])
  @@unique([id, institutionId])
  @@index([institutionId])
  @@index([courseId])
  @@map("subjects")
}
```

### 6.4 `ClassSection` (the cohort)

```prisma
model ClassSection {
  id                String             @id @default(cuid())
  institutionId     String
  programId         String                               // composite FK -> programs
  academicSessionId String                               // composite FK -> academic_sessions
  academicTermId    String                               // composite FK -> academic_terms
  label             String?                              // optional "A"/"B"
  capacity          Int?
  status            ClassSectionStatus @default(PLANNED)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  enrollments       ClassEnrollment[]
  scheduledClasses  ScheduledClass[]
  assignments       FacultyAssignment[]
  @@unique([institutionId, programId, academicSessionId, academicTermId, label])  // one named section per cohort
  @@unique([id, institutionId])
  @@index([institutionId])
  @@index([institutionId, academicTermId])
  @@map("class_sections")
}
```

### 6.5 `ClassEnrollment` (student ↔ section; references shared StudentProfile)

```prisma
model ClassEnrollment {
  id             String           @id @default(cuid())
  institutionId  String
  classSectionId String                                  // composite FK -> class_sections
  studentId      String                                  // composite FK -> student_profiles(institutionId,id)
  enrolledAt     DateTime         @default(now())
  status         EnrollmentStatus @default(ENROLLED)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([classSectionId, studentId])                  // NO duplicate enrollment
  @@unique([id, institutionId])
  @@index([institutionId])
  @@index([institutionId, studentId])
  @@index([classSectionId])
  @@map("class_enrollments")
}
```

The `studentId` composite FK → `student_profiles(institutionId, id)` (ON DELETE RESTRICT)
is the single-identity guarantee: enrollment points at the authoritative Phase-2 student,
never a copy, and the composite FK forbids enrolling another tenant's student.

### 6.6 `FacultyProfile` (teaching identity, parallel to HodProfile)

```prisma
model FacultyProfile {
  id            String        @id @default(cuid())
  institutionId String
  userId        String        @unique                    // composite FK -> users(institutionId,id)
  name          String
  departmentId  String?                                  // composite FK -> departments (optional)
  status        FacultyStatus @default(ACTIVE)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  assignments      FacultyAssignment[]
  scheduledClasses ScheduledClass[]
  @@unique([id, institutionId])
  @@index([institutionId])
  @@map("faculty_profiles")
}
```

### 6.7 `FacultyAssignment` (assignment with preserved history via soft transition)

```prisma
model FacultyAssignment {
  id             String                  @id @default(cuid())
  institutionId  String
  facultyId      String                                  // composite FK -> faculty_profiles
  subjectId      String                                  // composite FK -> subjects
  classSectionId String?                                 // optional composite FK -> class_sections
  academicTermId String                                  // composite FK -> academic_terms
  role           FacultyAssignmentRole   @default(PRIMARY)
  status         FacultyAssignmentStatus @default(ACTIVE)
  assignedAt     DateTime @default(now())
  endedAt        DateTime?                               // set on soft transition (substitute swap, reassignment)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([id, institutionId])
  @@index([institutionId])
  @@index([institutionId, facultyId, status])
  @@index([subjectId])
  @@map("faculty_assignments")
}
```

**History preservation (roadmap non-negotiable "faculty assignment changes do not erase
historical teaching records") — stated as an enforced invariant:**

> **Invariant (service-layer owned):** on a `FacultyAssignment` row, `facultyId`,
> `subjectId`, `classSectionId`, `academicTermId`, and `role` are **immutable after
> insert**. The ONLY permitted in-place mutation is the soft transition
> `status: ACTIVE → ENDED` together with setting `endedAt`. Reassignment or substitution
> is **never** an UPDATE of `facultyId` on an existing row — it ALWAYS ends the current
> row (soft transition) and **INSERTs a new row** for the new faculty/role, plus writes an
> append-only `ScheduleRevision` (`FACULTY_REASSIGNED`) and an `AuditEvent`, all in one
> `withTenant` transaction.

**Who enforces it and why:** the **service layer** (`faculty-assignment.ts` + the route
handler) owns this invariant — there is no DB-level trigger this phase. Rationale: the
rule is a multi-column "only status/endedAt may change" constraint plus a "reassignment
emits a revision" side effect, which is naturally a service concern (a column-level trigger
cannot express "and also insert a revision"); the immutable *ledger* that makes the history
tamper-proof is `schedule_revisions` (which IS DB-enforced append-only via trigger +
REVOKE). So the `FacultyAssignment` table stays mutable for the one legal status flip,
prior rows are retained as the historical record, and any attempt to rewrite teaching
history would require bypassing the service layer AND forging a revision — the latter being
impossible under the append-only trigger. The reviewer asked for this to be an explicit
rule rather than a convention; it now is.

### 6.8 `Timetable` + `ScheduledClass`

```prisma
model Timetable {
  id                String          @id @default(cuid())
  institutionId     String
  academicTermId    String                               // composite FK -> academic_terms
  name              String
  status            TimetableStatus @default(DRAFT)
  publishedAt       DateTime?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  scheduledClasses  ScheduledClass[]
  @@unique([id, institutionId])
  @@index([institutionId])
  @@index([institutionId, academicTermId])
  @@map("timetables")
}

model ScheduledClass {
  id             String               @id @default(cuid())
  institutionId  String
  timetableId    String                                  // composite FK -> timetables
  classSectionId String                                  // composite FK -> class_sections
  subjectId      String                                  // composite FK -> subjects
  facultyId      String                                  // composite FK -> faculty_profiles
  academicTermId String                                  // composite FK -> academic_terms (denormalized for conflict scope)
  room           String?                                 // free-text location/room label
  dayOfWeek      DayOfWeek?                              // recurring weekly slot ...
  date           DateTime?                               // ... OR a one-off dated slot (exactly one of the two — §6.9)
  startTime      Int                                     // minutes from midnight, [0,1440)
  endTime        Int                                     // minutes from midnight, (startTime,1440]
  period         Int?                                    // optional period index
  status         ScheduledClassStatus @default(SCHEDULED)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([id, institutionId])
  @@index([institutionId])
  @@index([institutionId, academicTermId, dayOfWeek])    // supports the faculty/room/section overlap scans
  @@index([facultyId])
  @@index([classSectionId])
  @@map("scheduled_classes")
}
```

**Time representation decision:** `startTime`/`endTime` are **integer minutes from
midnight** (not `DateTime`), because recurring weekly slots have no calendar date and
integer minutes make overlap math trivial and timezone-free. A slot is **either**
recurring (`dayOfWeek` set, `date` null) **or** one-off (`date` set, `dayOfWeek` null) —
enforced by a CHECK constraint (§6.9). This design lets Phase 4 attendance reference a
`ScheduledClass` cleanly (a dated occurrence resolves from `dayOfWeek`+a concrete date, or
directly from `date`) — see §13.

### 6.9 `ScheduleRevision` (APPEND-ONLY history)

```prisma
model ScheduleRevision {
  id               String                      @id @default(cuid())
  institutionId    String
  timetableId      String?                                       // nullable: a faculty reassignment may not target a timetable
  scheduledClassId String?
  academicTermId   String?
  changeType       ScheduleRevisionChangeType
  // snapshot columns (previous*/new*) — minimal, scalar, no PII dumps
  previousFacultyId String?
  newFacultyId      String?
  previousRoom      String?
  newRoom           String?
  previousStartTime Int?
  newStartTime      Int?
  previousEndTime   Int?
  newEndTime        Int?
  previousStatus    String?
  newStatus         String?
  actorUserId       String
  actorMembershipId String?
  reason            String?
  metadata          Json?
  createdAt         DateTime @default(now())

  @@unique([id, institutionId])
  @@index([institutionId])
  @@index([institutionId, timetableId])
  @@index([scheduledClassId])
  @@map("schedule_revisions")
}
```

This table mirrors `student_profile_history` / `academic_calendar_day_revisions` exactly:
INSERT-only RLS (SELECT + INSERT policies, **no** modify/ALL policy), `REVOKE UPDATE,
DELETE FROM campass_app`, and a `BEFORE UPDATE OR DELETE` trigger that raises
`restrict_violation` to bind even the owner/privileged path. It is the immutable ledger
proving the roadmap's "a published change is recorded as a revision".

**Per-`changeType` column contract (pinned — makes the ledger self-describing):** the
`previous*`/`new*` scalar pairs are not all meaningful for every `changeType`, so the
writer populates them per type, and the slot's identifying `classSectionId`/`subjectId`
(which are **not** first-class columns on `schedule_revisions` — only `scheduledClassId`
links back) are captured in `metadata` so an auditor never has to join a possibly-later-
mutated `scheduled_classes` row:

| `changeType` | `previous*` | `new*` | `metadata` (scalar, non-PII) |
|---|---|---|---|
| `SCHEDULED_CLASS_ADDED` | all `null` | all populated (facultyId, room, start/end time, status=`SCHEDULED`) | `{ classSectionId, subjectId }` of the added slot |
| `SCHEDULED_CLASS_UPDATED` | the pre-edit values of each changed field | the post-edit values | changed field names + `{ classSectionId, subjectId }` |
| `SCHEDULED_CLASS_CANCELLED` | `previousStatus = SCHEDULED` | `newStatus = CANCELLED` | `{ classSectionId, subjectId }` |
| `FACULTY_REASSIGNED` | `previousFacultyId` (ended assignment's faculty) | `newFacultyId` (new assignment's faculty) | `{ subjectId, classSectionId?, role, endedAssignmentId, newAssignmentId }` |
| `TIMETABLE_CREATED` / `_PUBLISHED` / `_ARCHIVED` | `null` | `newStatus` = the new `TimetableStatus` | `{ timetableId }` (already a column too) |

No schema change is needed for this — it is a writer-side convention the handler and the
behavioral tests assert. It keeps "what was added / cancelled" reconstructable from the
revision row alone.

> **Timetable-change semantics:** when a `PUBLISHED` timetable is edited (add/cancel a
> `ScheduledClass`, swap faculty), the handler (a) applies the mutation to the live
> `ScheduledClass`/`FacultyAssignment` row inside `withTenant`, (b) INSERTs the matching
> `ScheduleRevision` row in the same transaction, (c) writes the `AuditEvent`. A `DRAFT`
> timetable edit does **not** require a revision (it isn't published history yet); only
> transitions on a published timetable and faculty reassignments produce revisions. This
> matches "published timetable changes create revisions" (roadmap security note).

### 6.10 Composite FK summary (every cross-tenant link)

| Child.column | → Parent(institutionId, id) | ON DELETE |
|---|---|---|
| `courses.(institutionId, programId)` | `programs` | RESTRICT |
| `courses.(institutionId, academicTermId)` | `academic_terms` | SET NULL |
| `subjects.(institutionId, courseId)` | `courses` | RESTRICT |
| `class_sections.(institutionId, programId)` | `programs` | RESTRICT |
| `class_sections.(institutionId, academicSessionId)` | `academic_sessions` | RESTRICT |
| `class_sections.(institutionId, academicTermId)` | `academic_terms` | RESTRICT |
| `class_enrollments.(institutionId, classSectionId)` | `class_sections` | RESTRICT |
| `class_enrollments.(institutionId, studentId)` | `student_profiles` | RESTRICT |
| `faculty_profiles.(institutionId, userId)` | `users` | RESTRICT |
| `faculty_profiles.(institutionId, departmentId)` | `departments` | SET NULL |
| `faculty_assignments.(institutionId, facultyId)` | `faculty_profiles` | RESTRICT |
| `faculty_assignments.(institutionId, subjectId)` | `subjects` | RESTRICT |
| `faculty_assignments.(institutionId, classSectionId)` | `class_sections` | SET NULL |
| `faculty_assignments.(institutionId, academicTermId)` | `academic_terms` | RESTRICT |
| `timetables.(institutionId, academicTermId)` | `academic_terms` | RESTRICT |
| `scheduled_classes.(institutionId, timetableId)` | `timetables` | RESTRICT |
| `scheduled_classes.(institutionId, classSectionId)` | `class_sections` | RESTRICT |
| `scheduled_classes.(institutionId, subjectId)` | `subjects` | RESTRICT |
| `scheduled_classes.(institutionId, facultyId)` | `faculty_profiles` | RESTRICT |
| `scheduled_classes.(institutionId, academicTermId)` | `academic_terms` | RESTRICT |

Every new table also gets the single-leg tenant-root FK `institutionId → institutions(id)`
RESTRICT (the `institution_modules` / Phase-2 shape). Each parent already carries its
`(id, institutionId)` composite unique (Phase 0/1/2), so no parent needs a new unique
except the new Phase-3 parents themselves (`courses`, `subjects`, `class_sections`,
`faculty_profiles`, `timetables`), which declare `@@unique([id, institutionId])` above.

---

## 7. Permissions (`classes.*`) and role mapping

New keys added to `PERMISSIONS` in `packages/shared/src/permissions.ts` (module
`"classes"`), mirrored verbatim into the Phase-3 migration seed block so catalogue-sync
stays green (§11 / §12):

| Key | Meaning |
|---|---|
| `classes.courses.manage` | Create/update courses + subjects |
| `classes.sections.manage` | Create/update class sections |
| `classes.enroll` | Enroll / drop students in a section |
| `classes.faculty.assign` | Create faculty profiles + assign/substitute faculty |
| `classes.timetable.manage` | Create/edit/publish timetables + scheduled classes |
| `classes.view` | View courses/subjects/sections/timetables (staff read) |
| `classes.view_own` | Faculty/Student view **own** schedule only |

**Template-role mapping** (added to `ROLE_PERMISSIONS` + the migration
`role_permissions` seed):

- **ADMIN**: all of `classes.courses.manage`, `classes.sections.manage`, `classes.enroll`,
  `classes.faculty.assign`, `classes.timetable.manage`, `classes.view`, `classes.view_own`.
- **HOD**: `classes.courses.manage`, `classes.sections.manage`, `classes.enroll`,
  `classes.faculty.assign`, `classes.timetable.manage`, `classes.view`,
  `classes.view_own` — **scoped to `request.auth.departmentScope`** where the resource has
  a resolvable department (see §7.1). HOD is a managing role *within its department*.
- **FACULTY** (new template role): **`classes.view_own` only** (own schedule). Least-
  privilege, committed — FACULTY is **not** granted the broad staff `classes.view`. "My
  schedule" is served through dedicated own-scoped endpoints, not the staff catalogue list.
- **STUDENT**: `classes.view_own` (own schedule only).

> **Decision A4 (committed, not an open question):** the FACULTY template role =
> **`{classes.view_own}` only**. No broad `classes.view`. This is the least-privilege
> posture and it is what the `ROLE_PERMISSIONS` map and the migration `role_permissions`
> seed encode in lockstep (§11j) — exactly one answer, so the catalogue-sync set-equality
> meta-test cannot be tripped by a stray `classes.view` grant for FACULTY. "My schedule"
> for a faculty user is served by dedicated own-scoped endpoints, never the staff
> `classes.view` catalogue list.

### 7.1 HOD department scope (record-level)

`request.auth.departmentScope` is surfaced by Phase 1 (verified in `middleware/auth.ts`
and used by `students.ts` via a `departmentScopeFilter`).

**Important — Phase 3 does NOT reuse the `students.ts` filter verbatim.** The live
`students.ts` `departmentScopeFilter(request)` returns a **direct** `{ departmentId: scope }`
fragment because `StudentProfile` carries its own `departmentId` column (verified in the
`students.ts` `departmentScopeFilter` helper). **Phase-3 tables do not carry `departmentId`**
(verified against the live schema): `Course`/`ClassSection` reach a department only through
`Program.departmentId`; `Subject` reaches it through `Course → Program`; `Timetable` has no
program link at all; only `FacultyProfile` carries its own `departmentId`. So the scope
mechanism must be expressed **per table** as a Prisma **relation filter** — not a direct
column predicate and not a pre-resolved `programId` list (we reject the pre-resolved-list
option because it costs an extra tenant query per request and leaves `Timetable`
unhandled).

**Decision — a single `kind`-parameterized relation-filter helper.** Phase 3 defines

```ts
type ClassesScopeKind =
  | "course" | "subject" | "section" | "timetable" | "scheduledClass" | "facultyProfile";

// Returns a Prisma relation-filter fragment to merge into the query `where`.
// `{}` for ADMIN / non-HOD / no-scope callers (whole tenant).
function classesDepartmentScopeFilter(
  request: FastifyRequest,
  kind: ClassesScopeKind
): Record<string, unknown> {
  const roles = request.auth?.roles ?? [];
  const scope = request.auth?.departmentScope ?? null;
  if (!(roles.includes("HOD") && !roles.includes("ADMIN") && scope)) return {};
  switch (kind) {
    case "course":         return { program: { departmentId: scope } };
    case "section":        return { program: { departmentId: scope } };
    case "subject":        return { course: { program: { departmentId: scope } } };
    case "scheduledClass": return { classSection: { program: { departmentId: scope } } };
    case "facultyProfile": return { departmentId: scope };
    case "timetable":      return { scheduledClasses: { some: { classSection: { program: { departmentId: scope } } } } };
  }
}
```

The relation-filter form means **no parent `departmentId` column is required** and every
table resolves uniformly through the relation graph Prisma already models from the §6 FKs.

- **Course / ClassSection** → `{ program: { departmentId: scope } }`.
- **Subject** → `{ course: { program: { departmentId: scope } } }` (two hops).
- **ScheduledClass** → `{ classSection: { program: { departmentId: scope } } }`.
- **FacultyProfile** → `{ departmentId: scope }` (direct — it has the column).
- **Timetable (decision — committed):** a `Timetable` spans sections and has **no single
  program**, so it is scoped by **whether it contains any in-scope ScheduledClass**:
  `{ scheduledClasses: { some: { classSection: { program: { departmentId: scope } } } } }`.
  An HOD therefore sees a timetable if and only if it schedules at least one section of a
  program in their department. We choose this over "timetable list is ADMIN-only" because
  the roadmap DoD requires HOD to manage timetables within their department, and a
  per-department timetable view must be possible. A consequence the coder must honor: an
  HOD **editing** a `ScheduledClass` on a shared timetable is additionally gated at the
  `scheduledClass` level (the `scheduledClass` filter above), so an HOD cannot add/edit a
  slot for a section outside their department even on a timetable they can see. An empty
  `DRAFT` timetable with no scheduled classes is **not** visible to an HOD until it has an
  in-scope slot; this is acceptable because an HOD creates the timetable's first slot in
  the same flow (the create handler stamps the HOD's scope on the slot it adds).

- Enforcement owner: **the route layer** (the handler merges the `kind`-appropriate scope
  filter into the `withTenant` query `where`, and 404s a resource outside scope — same
  not-found-on-out-of-scope shape as `students.ts`). RLS does **not** enforce department
  scope (it only enforces tenant); department scope is an application-layer record-level
  rule, consistent with `identity-rbac.md` §6.3 item 6 and the documented `canOnResource`
  future-stub. For **writes**, the handler resolves the target row with the scope filter
  first (a scoped `findFirst` → 404 if outside scope) before mutating, so an HOD cannot
  mutate out-of-scope rows by id.

> **Assumption A5:** the mapping from an institution's departments to the programs an HOD
> may manage is "programs whose `departmentId` is the HOD's `departmentScope`". This reuses
> Phase 1's program→department link. Confirmed against `Program.departmentId` in the live
> schema. The Timetable "any in-scope section" rule (above) is the one place this design
> extends the mapping to a table with no program link; it is committed, not left open.

Every Phase-3 route uses `preHandler: [authenticate-then-requirePermission(key)]`
(`authenticate` is the single top-level hook; `requirePermission` is a pure can-check, per
`authz-engine.ts`). No `requireModuleActive` (foundational — §3). The shim + legacy `role`
claim are untouched.

---

## 8. Conflict detection (pure server-side function)

**Decision:** a pure, DB-free function `detectTimetableConflicts(input): ConflictReport`
in `apps/api/src/services/timetable-conflict.ts`, mirroring the `student-sis.ts` /
`calendar-service.ts` pure-logic pattern (unit-testable without a DB — the route layer
fetches the candidate slots + calendar/day context and passes them in). The timetable
module decides what a calendar date **means**; `CalendarService` only *describes* the day
(`effectiveDayType`) — the calendar never invents timetable rules (roadmap / tenancy
boundary respected).

### 8.1 Inputs

```ts
interface SlotInput {
  id?: string;                 // present when editing an existing slot (excluded from self-compare)
  classSectionId: string;
  facultyId: string;
  room: string | null;
  dayOfWeek: DayOfWeek | null; // recurring
  date: string | null;        // one-off ISO date
  startTime: number;          // minutes from midnight
  endTime: number;
  status: 'SCHEDULED' | 'CANCELLED';
}
interface ConflictContext {
  candidate: SlotInput;                       // the slot being added/edited
  existing: SlotInput[];                       // SCHEDULED slots in the same term (fetched in-tenant)
  dayType: AcademicDayType | null;             // from CalendarService.effectiveDayType for the slot's date (one-off) or null
  workingDaysOfWeek: number[];                 // InstitutionConfig (0..6, JS getDay)
}
```

### 8.2 Day-axis conversion (determinism — pinned)

`ScheduledClass.dayOfWeek` is a Postgres **enum** (string labels), but the pure function
reasons about weekdays as integers (to compare against a one-off slot's `date` weekday and
against `workingDaysOfWeek: number[]`). The label→ordinal conversion is declared once and
used everywhere — no ad-hoc `indexOf`:

```ts
const DOW_INDEX = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 } as const;

// The weekday integer of a slot, or null if it is a one-off with no date (invalid upstream).
function weekdayOf(slot: SlotInput): number | null {
  if (slot.dayOfWeek) return DOW_INDEX[slot.dayOfWeek];        // recurring weekly slot
  if (slot.date) return new Date(slot.date).getUTCDay();       // one-off dated slot
  return null;
}
```

**`getUTCDay()` (not `getDay()`) is mandatory here.** Stored `date` values are date-only
(midnight UTC); using the local-timezone `getDay()` would yield a timezone-dependent
weekday and a silent off-by-one across the day boundary. (The `allowance-engine.ts`
precedent uses `getDay()` on `Date` objects it constructs locally; the timetable function
receives ISO date-only strings, so UTC is the correct and deterministic choice. This is a
deliberate, documented divergence from that precedent.)

### 8.2.1 Checks, with BLOCK vs WARN and why

Two time windows **overlap** when `a.start < b.end && b.start < a.end` on the **same
day axis**. Same day axis is defined precisely as:

- two **recurring** slots: `weekdayOf(a) === weekdayOf(b)` (same `dayOfWeek`); **or**
- a **recurring** slot and a **one-off** slot: `weekdayOf(a) === weekdayOf(b)` (the dated
  occurrence's UTC weekday equals the weekly pattern's weekday — a dated occurrence
  collides with the recurring pattern); **or**
- two **one-off** slots: the same `date`.

`CANCELLED` slots are ignored on both sides.

| # | Conflict | BLOCK / WARN | Why |
|---|---|---|---|
| 1 | **Invalid period**: `startTime >= endTime`, or `startTime < 0`, or `endTime > 1440`, or zero/negative duration | **BLOCK** | A slot with no positive duration is structurally invalid data; nothing downstream (attendance, display) can use it. Non-negotiable. |
| 2 | **Faculty double-booking**: candidate overlaps an existing SCHEDULED slot with the same `facultyId` on the same day axis | **BLOCK** | A person cannot teach two places at once — a hard physical impossibility and the roadmap's named reject case ("reject a double-booked faculty"). |
| 3 | **Room double-booking**: candidate overlaps an existing SCHEDULED slot with the same non-null `room` on the same day axis | **BLOCK** | A room cannot hold two classes at once — the roadmap's named reject case ("double-booked room"). Only compared when `room` is non-null (unassigned room = no room conflict). |
| 4 | **Section self-conflict**: candidate overlaps an existing SCHEDULED slot with the same `classSectionId` on the same day axis | **BLOCK** | A cohort cannot be in two classes simultaneously; it would make attendance ambiguous. |
| 5 | **Out-of-hours / non-working day**: the slot falls on a day the institution does not operate. **One-off (dated) slot:** resolved by `CalendarService.effectiveDayType(date)` (HOLIDAY/WEEKEND/VACATION ⇒ non-working) with fallback to `workingDaysOfWeek.has(weekdayOf(slot))` when no explicit calendar entry. **Recurring slot:** checked against `workingDaysOfWeek.has(weekdayOf(slot))` **only** — `effectiveDayType` is NOT consulted (see rule below). | **WARN** | The timetable module, not the calendar, decides this is schedulable-with-warning: institutions legitimately schedule make-up/special classes on nominally non-working days, and a draft may be built before the calendar is finalized. Blocking would let the calendar "invent a rule" the timetable must obey — explicitly forbidden. So it surfaces as a non-blocking warning the author can accept. |

**Working-day resolution — rule (pinned, deterministic):**

- **Recurring-slot out-of-hours is weekday-only.** A recurring weekly slot (`dayOfWeek`
  set, `date` null) has no concrete date, so `effectiveDayType` is **not** consulted for
  it; it is out-of-hours iff `!workingDaysOfWeek.has(weekdayOf(slot))`. (A recurring slot
  will resolve to concrete dates later, in Phase 4; checking the calendar day-type for
  every future instance of a weekday is out of scope for Phase 3 — §13/§14.)
- **One-off (dated) slot** reuses the established precedent in `allowance-engine.ts`:
  explicit calendar `dayType` wins (WORKING_DAY/SPECIAL_WORKING_DAY/EXAM_DAY/
  INSTITUTION_EVENT ⇒ working; HOLIDAY/WEEKEND/VACATION ⇒ non-working), else fall back to
  `workingDaysOfWeek.has(weekdayOf(slot))`.

Both paths use the same `weekdayOf(slot)` (§8.2) so the `DayOfWeek` ordinal (SUN=0) and
the one-off `date.getUTCDay()` share identical weekday math — no off-by-one is possible.

### 8.3 Output + response shape

```ts
interface Conflict {
  type: 'INVALID_PERIOD' | 'FACULTY_DOUBLE_BOOKED' | 'ROOM_DOUBLE_BOOKED'
      | 'SECTION_SELF_CONFLICT' | 'OUT_OF_HOURS';
  severity: 'BLOCK' | 'WARN';
  message: string;                    // human-readable, no PII beyond ids/labels
  conflictingScheduledClassId?: string; // the existing slot it collides with (types 2–4)
  detail?: Record<string, string | number>; // e.g. { facultyId, dayOfWeek, startTime, endTime }
}
interface ConflictReport { blocking: Conflict[]; warnings: Conflict[]; }
```

Route behavior:

- Create/update a `ScheduledClass`: the handler builds the `ConflictContext` (fetch
  term-scoped SCHEDULED slots + the day's `effectiveDayType` + config) and calls the pure
  function. **If `blocking.length > 0` → HTTP 409** with body
  `{ error: "Timetable conflict", conflicts: ConflictReport }` and the write is NOT
  performed (transaction rolled back / not entered). **If only `warnings` → HTTP 200/201**
  with the created slot plus `{ warnings: Conflict[] }` in the envelope (the
  success-plus-warnings envelope Phase 1 academics already uses). An explicit
  `?acceptWarnings=true` is not required because warnings never block; they are advisory.
- A dedicated **dry-run** endpoint `POST /api/classes/timetables/:id/check` returns the
  `ConflictReport` for the whole timetable (or a candidate slot) without writing — used by
  the UI to show conflicts before publish and to gate publish if the author wants.

> **Assumption A6:** blocking conflicts are checked only against **SCHEDULED** slots in the
> **same `academicTermId`** (the natural scheduling horizon). Cross-term conflicts (a
> faculty double-booked across two concurrent terms) are **out of scope** for Phase 3
> (§14) unless the reviewer flags it; the `academicTermId` filter keeps the scan indexed
> and the semantics clear.

---

## 9. Audit

New `classes.*` audit-action keys added to `AUDIT_ACTIONS` in
`packages/shared/src/audit-actions.ts` (no migration mirror needed — audit keys are
validated only in `recordAuditEvent`, no seeded rows, per the file's own note):

```
classes.course.created / classes.course.updated
classes.subject.created / classes.subject.updated
classes.section.created / classes.section.updated
classes.enrollment.enrolled / classes.enrollment.dropped
classes.faculty.profile_created
classes.faculty.assigned / classes.faculty.substituted / classes.faculty.unassigned
classes.timetable.created / classes.timetable.published / classes.timetable.archived
classes.scheduled_class.added / classes.scheduled_class.updated / classes.scheduled_class.cancelled
```

Every mutation route writes an `AuditEvent` via `recordAuditEvent(input, tx)` — passing
the **`withTenant` transaction client** so the audit row is written as `campass_app`
inside the business transaction (atomic with the mutation), satisfying the
`audit_events_tenant_insert` RLS policy (which requires `institutionId` === the active
tenant GUC). `actorRoleKey` snapshots `request.auth.roles[0]`; `resourceType`/`resourceId`
name the affected row; `result` is SUCCESS (or DENIED/ERROR on the failure paths);
`metadata` carries only scalar, non-PII detail (e.g. the conflict count on a rejected
publish), filtered by `sanitizeMetadata`.

**Naming convention (confirmed):** every key above is **past-tense** (an event that
happened — `...created`, `...assigned`, `...published`, `...cancelled`), matching the
existing `campus_movement.pass.requested`/`...approved` precedent in `audit-actions.ts`.
The present-tense `classes.faculty.assign` string is a **permission** key (§7) only and
never appears in `AUDIT_ACTIONS`; its audit counterpart is the past-tense
`classes.faculty.assigned`. Because `AuditActionKey` is a TypeScript union derived from
`AUDIT_ACTIONS`, any typo or stray present-tense verb in an audit write fails the build
(low risk) — the keys above are the exact strings added to `AUDIT_ACTIONS`.

Because the audit-action catalogue is **not** part of catalogue-sync (only the permission
catalogue is), adding `classes.*` audit keys needs no migration change — but the
**permission** additions do, and the `no-straggler-audit` test still passes because all
writes go through `recordAuditEvent`.

---

## 10. Validation (per external input)

Zod schemas in `packages/shared/src/validation.ts` (the established home), one per
create/update body. Rules, with on-failure behavior = **HTTP 400** with the Zod issue list
(the existing validation-error shape); nothing is written on a validation failure.

- **Course create**: `programId` required string (existence + same-tenant checked in-handler
  → 404/422 if the program isn't in the caller's tenant/scope); `name` required
  (1–200 chars); `code` required (1–40 chars, unique per tenant → 409 on unique
  violation); `academicTermId` optional; `description` optional (≤2000). 
- **Subject create**: `courseId` required (same-tenant/exists → 404); `name` required
  (1–200); `code` required (1–40, unique per tenant → 409); `credits` optional int
  [0,100]; `contactHoursPerWeek` optional int [0,100].
- **ClassSection create**: `programId`, `academicSessionId`, `academicTermId` required
  (all same-tenant/exist → 404; term must belong to the session → 422); `label` optional
  (≤10); `capacity` optional int [1,10000]; `status` optional enum. Duplicate
  (program,session,term,label) → 409 (the composite unique).
- **ClassEnrollment**: `classSectionId`, `studentId` required (same-tenant/exist → 404;
  student must be ACTIVE/ENROLLED status → 422). Duplicate (section,student) → **409**
  (the no-duplicate unique). Capacity: if `capacity` set and ENROLLED count ≥ capacity →
  **409** (checked inside the transaction — see capacity-race note below).

  > **Capacity-race decision (A9):** the no-duplicate guarantee is **DB-enforced** by the
  > `class_enrollments(classSectionId, studentId)` unique — two concurrent enrollers of the
  > same student can never both succeed regardless of isolation level. The **capacity**
  > check is a `SELECT count(... status = ENROLLED)` + conditional INSERT inside the
  > `withTenant` interactive transaction; at the pooler's default READ COMMITTED this is
  > NOT automatically race-safe (two concurrent enrollers of *different* students could
  > each read `count = capacity - 1` and both insert, overshooting capacity by one). Phase
  > 3 **accepts a soft one-row capacity overshoot** under concurrency rather than taking a
  > row lock, because (a) the roadmap DoD does not require concurrent-enroll safety for
  > this phase (unlike the Phase-5 library-issue contention case), and (b) the only hard
  > integrity rule here — no duplicate enrollment — is already guaranteed by the unique.
  > If strict capacity is later required, the fix is a `SELECT ... FOR UPDATE` on the
  > `class_sections` row at the top of the transaction to serialize enrollers of the same
  > section; this is noted as the upgrade path, not implemented now.
- **FacultyProfile create**: `userId` required (same-tenant user exists → 404; not already
  a faculty profile → 409 on the `userId` unique); `name` required; `departmentId`
  optional (same-tenant → 404).
- **FacultyAssignment**: `facultyId`, `subjectId`, `academicTermId` required (same-tenant
  → 404); `classSectionId` optional; `role` enum (default PRIMARY). A substitute swap
  provides `replacesAssignmentId` → the handler ends that assignment + inserts the new one
  + a revision row.
- **ScheduledClass create/update**: `timetableId`, `classSectionId`, `subjectId`,
  `facultyId`, `academicTermId` required (same-tenant → 404); `room` optional string
  (≤100); **exactly one of** `dayOfWeek` / `date` (Zod refine → 400 "specify dayOfWeek OR
  date, not both"); `startTime`/`endTime` ints in `[0,1440]`; `period` optional int
  [0,50]. Structural `startTime < endTime` is validated both in Zod (fast 400) **and** in
  the conflict function (INVALID_PERIOD BLOCK) — defense in depth; the DB also carries a
  CHECK `startTime < endTime` and `startTime BETWEEN 0 AND 1439`.
- **Timetable create/publish**: `academicTermId` required (same-tenant → 404); `name`
  required. Publish is a state transition (DRAFT→PUBLISHED) validated server-side (illegal
  transition → 409); publishing a timetable with blocking conflicts in any slot → 409 with
  the `ConflictReport` (assumption A7 below).

Every "required/optional, type, limits" rule is encoded in the Zod schema; "behavior on
failure" is the 400/404/409/422 mapping above. All IDs are validated for same-tenant
existence **inside `withTenant`** (RLS already guarantees cross-tenant rows are invisible,
so a cross-tenant id simply resolves to not-found → 404 — the `students.ts` precedent).

> **Assumption A7:** publishing a timetable re-runs conflict detection across all its
> SCHEDULED slots and **blocks** publish (409) if any blocking conflict exists; warnings do
> not block publish. This makes "the system rejects a double-booked room/faculty" true at
> the publish gate as well as at slot-create. The reviewer should confirm publish should
> hard-block on blocking conflicts.

---

## 11. Migration (hand-authored, diff→deploy workaround)

A single NEW directory `packages/db/prisma/migrations/<timestamp>_phase3_classes/migration.sql`,
appended after `20261027161616_phase2_sis`. The 8 FROZEN migrations and the
`_prisma_migrations` ledger are **untouched**. Authored and applied exactly per
`context.md` §3 / `database.md` §4:

1. Hand-write `migration.sql` (RLS, composite FKs, `(id,institutionId)` uniques, CHECK
   constraints, append-only trigger, grants, catalogue seed — all in this one migration
   with its tables).
2. Read-only verify with `prisma migrate diff` (diagnostic only; never touches the DB).
3. Apply with `prisma migrate deploy` (Railway deploys the same way on start).
4. Confirm with `prisma migrate status` ("up to date", no duplicates).

NEVER `migrate dev` against shared Supabase; NEVER `db push --accept-data-loss`.

**SQL ordering (mirrors phase2_sis §a–§j):**

a. `CREATE TYPE` the new enums (§6.1).
b. `CREATE TABLE` the **nine** new tables (`courses`, `subjects`, `class_sections`,
   `class_enrollments`, `faculty_profiles`, `faculty_assignments`, `timetables`,
   `scheduled_classes`, `schedule_revisions`) + PKs. **Authoritative count: 9 new tables =
   8 standard-RLS-pair (mutable) tables + 1 append-only table (`schedule_revisions`).**
c. Unique indexes: each table's `(id, institutionId)`; the business uniques
   (`courses(institutionId,code)`, `subjects(institutionId,code)`,
   `class_sections(institutionId,programId,academicSessionId,academicTermId,label)`,
   `class_enrollments(classSectionId,studentId)`, `faculty_profiles(userId)`); and the
   `@@index([institutionId])` + query indexes (§6).
d. Tenant-root FKs `institutionId → institutions(id)` RESTRICT on every new table.
e. Composite same-tenant FKs per the §6.10 table (RESTRICT/SET NULL as listed). These
   reference the parents' existing `(id, institutionId)` uniques (Phase 0/1/2) and the new
   Phase-3 parents' own `(id, institutionId)` uniques created in (c).
f. CHECK constraints on `scheduled_classes`: `startTime >= 0 AND startTime < 1440`,
   `endTime > 0 AND endTime <= 1440`, `startTime < endTime`, and
   `((dayOfWeek IS NULL) <> (date IS NULL))` (exactly one of recurring/one-off).
g. RLS: `ENABLE`+`FORCE` on all nine; standard nullif-guarded `{tenant_isolation_select,
   tenant_isolation_modify}` pair on the eight mutable tables; the append-only pair
   `{tenant_isolation_select, schedule_revisions_tenant_insert}` (NO modify policy) on
   `schedule_revisions`.
h. Append-only function + `BEFORE UPDATE OR DELETE` trigger on `schedule_revisions`
   (raises `restrict_violation`), copied from the `student_profile_history` precedent.
i. Guarded `campass_app` GRANT refresh (idempotent `IF EXISTS pg_roles` block): full DML
   on the eight mutable tables; `GRANT SELECT, INSERT` + `REVOKE UPDATE, DELETE` on
   `schedule_revisions`. Never grant BYPASSRLS.
j. Seed the seven `classes.*` permissions + their `role_permissions` pairs (incl. the new
   **FACULTY** template role row) with the EXACT catalogue-sync marker shape:
   `INSERT INTO "permissions" ... ON CONFLICT ("key") DO NOTHING` and
   `INSERT INTO "role_permissions" ... SELECT ... FROM (VALUES ...) AS m("roleKey","permKey")
   JOIN "roles" r ON r."key"=m."roleKey" AND r."institutionId" IS NULL JOIN "permissions" p ...
   ON CONFLICT ("roleId","permissionId") DO NOTHING`.

   **Ordering rule (catalogue-sync parser safety — pinned):** `catalogue-sync.test.ts`
   extracts permission keys by slicing from `INSERT INTO "permissions"` to the first
   `ON CONFLICT`, and extracts role↔permission pairs by slicing from
   `INSERT INTO "role_permissions"` to `AS m(` and matching two-literal `('X','Y')` tuples
   (verified). The new **FACULTY** `roles` INSERT is a **four-column** group
   (`INSERT INTO "roles" (id,key,name,institutionId) VALUES (..., 'FACULTY', 'Faculty', NULL) ON CONFLICT DO NOTHING`)
   ending in `, NULL)`, which would not match the pair regex — but to be unambiguous it
   MUST be emitted **before** the `INSERT INTO "permissions"` block (i.e. outside both
   sliced spans), so no stray tuple or `ON CONFLICT` marker falls inside the permission or
   role_permission slice. Emitting it first also means the `role_permissions` join on
   `r."key"='FACULTY' AND r."institutionId" IS NULL` resolves.

   **Shared-catalogue lockstep (both files, same change):** add `FACULTY` to
   `ROLE_PERMISSIONS` in `packages/shared/src/permissions.ts` with exactly the keys §7
   grants it (`classes.view_own`), so the catalogue-sync union set-equality
   (migration seeds == `@campusgate/shared`) holds. The coder updates the shared map
   (`ROLE_PERMISSIONS`) and the migration's `role_permissions` seed **together**; and adds
   the new migration dir to `SEEDING_MIGRATION_DIRS` in `catalogue-sync.test.ts` (noted in
   §12). All three edits land in the same change-set — a mismatch fails catalogue-sync.

> **FROZEN-migration safety:** this migration only CREATEs new objects + ADDs the FACULTY
> role/permission seed; it never ALTERs a Phase-0/1/2 table's RLS, grant, or FK, and never
> touches the ledger. `campass_app` stays NOSUPERUSER NOBYPASSRLS.

---

## 12. Testing (unit vs integration) + Phase completion gate

The 304-test baseline must stay green, and the gate (`roadmap.md` end-of-file) must be
extended. Runner: vitest, `fileParallelism: false`, single run. Transient
`FATAL: tenant/user ... not found` is Supabase auto-pause — resume/retry, never "fix" code.

**Unit (DB-free, fast — the bulk of conflict coverage):**
- `timetable-conflict.test.ts`: every conflict type (INVALID_PERIOD, FACULTY/ROOM/SECTION
  double-booking, OUT_OF_HOURS) BLOCK vs WARN; overlap boundary cases (touching-but-not-
  overlapping `a.end == b.start` ⇒ no conflict); recurring-vs-one-off day-axis matching
  including the `DOW_INDEX` label→ordinal conversion and `getUTCDay()` determinism (§8.2) —
  a one-off `date` whose UTC weekday equals a recurring slot's `dayOfWeek` collides;
  CANCELLED slots ignored; excluding the edited slot's own id from self-compare; working-
  day resolution split by slot kind (recurring = `workingDaysOfWeek` only; one-off =
  explicit `effectiveDayType` wins, else `workingDaysOfWeek` fallback).
- `faculty-assignment.test.ts` / `class-enrollment.test.ts`: the pure transition decisions
  (soft-transition on substitute swap preserves prior rows; duplicate-enrollment decision).

**Route integration (mocked Prisma — authz/audit/envelope wiring, the academics-routes
precedent):** permission gating per role (ADMIN manage; HOD manage within scope; FACULTY/
STUDENT view_own only, mutate ⇒ 403); the 409 conflict envelope on a double-booked slot;
the success-plus-warnings envelope on an out-of-hours slot; cross-tenant read ⇒ 404; the
audit `recordAuditEvent` call shape.

**Real-DB integration (through `tenant-escape-setup.ts`):**
- **Extend the escape suite** (gate requirement): add the nine tables to `RLS_TABLES`; add
  `schedule_revisions` to `EXPECTED_POLICIES` as an append-only pair
  `["tenant_isolation_select", "schedule_revisions_tenant_insert"]`; seed one row per new
  table under the `ESCAPE_TEST_` prefix in `seedTenant` (A and B) **except**
  `schedule_revisions`; extend `cleanup()` + `countRemainingTestRows()` child-first
  (enrollments/scheduled_classes/assignments → sections/subjects/timetables/faculty →
  courses, respecting the RESTRICT FKs). Add the read-escape, spoofed-write,
  foreign-parent-write, buggy-query backstop, three-GUC-state fail-closed, and meta (RLS
  enabled+forced+policies) assertions for the eight mutable tables.
- **`schedule_revisions` is a self-contained escape case** (mirroring the live
  `audit_events` / `student_profile_history` case shape, verified in
  `tenant-escape-setup.ts`): it is **excluded from the generic `ESCAPE_TEST_` seed loop**
  because its `BEFORE UPDATE OR DELETE` trigger + `REVOKE UPDATE,DELETE` would block the
  loop's generic seed/cleanup path. Its dedicated case instead: (a) INSERTs one revision
  row for tenant A via the privileged/seed path (a plain INSERT does **not** trip the
  trigger — the trigger fires only on UPDATE/DELETE, and the INSERT policy is named
  `schedule_revisions_tenant_insert`); (b) asserts a cross-tenant SELECT from tenant B's
  context returns empty (tenant isolation); (c) asserts an UPDATE and a DELETE against the
  row both raise `restrict_violation` (append-only, even on the privileged path); (d)
  cleans the row up via the privileged owner path if the trigger permits, or leaves it as
  an idempotent fixture keyed to the `ESCAPE_TEST_` tenant. The meta-assertion confirms
  RLS is ENABLE+FORCE and the exact policy pair exists.
- **Phase-3 behavioral suite** (self-contained prefix, e.g. `CLASS_TEST_`): build a small
  timetable; assert a double-booked faculty and a double-booked room are **rejected**
  (409/blocking); publish a change and assert a `schedule_revision` row is written and
  that UPDATE/DELETE on it is refused (append-only); a student/faculty reads only their own
  schedule; enrollment references the shared `StudentProfile` (no second student row).

**Gate checklist mapping:** per-module DoD (`architecture.md` §7) — functional state
machine (timetable DRAFT→PUBLISHED, enrollment/assignment transitions) enforced
server-side; authz permission-level + HOD scope + unauthorized API denied; tenant
isolation (escape suite extended, buggy-query backstop); data integrity (capacity +
duplicate-enrollment enforced transactionally, conflict detection, history preserved);
auditability (`recordAuditEvent` on every mutation); reliability (409/400 observable,
fail-closed). **catalogue-sync:** add the new dir to `SEEDING_MIGRATION_DIRS` in
`catalogue-sync.test.ts` (it seeds `classes.*` permission + role_permission rows), so the
union-of-migrations set-equality against `@campusgate/shared` stays green.

---

## 13. Phase-4 seams (noted, NOT designed here)

- **Attendance references `ScheduledClass`**: a `ScheduledClass` is the stable "when a
  subject is delivered to a section by a faculty" anchor. Phase 4's `AttendanceSession`
  will composite-FK to `scheduled_classes(institutionId, id)` + a concrete `date`
  (resolved from `dayOfWeek` for a recurring slot, or directly from `date` for a one-off).
  The integer-minute `startTime`/`endTime` + `academicTermId` denormalization are kept
  precisely so a dated occurrence is derivable without re-joining.
- **Attendance loads enrolled students** from `ClassEnrollment` filtered to a section
  (`status = ENROLLED`) — the roster the roadmap's "faculty attendance UI loading enrolled
  students from the schedule" needs.
- **Faculty-marks scope**: Phase 4's `attendance.mark` + `canOnResource` will check that a
  faculty's `FacultyAssignment`/`ScheduledClass.facultyId` matches the section being marked
  — the `faculty_assignments` + `scheduled_classes.facultyId` links make that a single
  indexed lookup.
- **`class_course` as a Phase-4 dependency**: because Phase 3 is foundational (not a
  toggled module — §3), there is **no `institution_module` row** for `class_course`. Under
  the live `missingDependencies` (verified in `module-system.ts`) an absent row evaluates
  to UNMET, so Phase 4 attendance activation would return `DEPS_UNMET` as-is. Resolving
  that is a **Phase-4** change — Phase 4 either drops the `class_course` edge from
  `MODULE_DEPENDENCIES.attendance` (replacing it with a data-existence check) or seeds +
  activates a `class_course` module row during attendance onboarding. Phase 3 does not edit
  `modules.ts`; it only guarantees the data exists and names the Phase-4 work so the
  dependency gate is not a surprise.

None of the above is implemented or further specified in Phase 3.

---

## 14. Out of scope (Phase 3)

- Phase 4 attendance (only the seams in §13).
- Subject cross-listing across multiple courses/programs (single `courseId`, §4/A2).
- Cross-term conflict detection (same-term only, §8/A6).
- Multi-institution faculty or any `UserRole` enum change (faculty is additive via
  `FacultyProfile` + FACULTY template role, §5; legacy-enum removal stays its own
  workstream per `database.md` §6a).
- Self-service role/permission management UI, calendar rule invention, timetable
  auto-generation/optimization, recurrence beyond "weekly `dayOfWeek` OR single `date`"
  (e.g. biweekly, date ranges), and room as a first-class tenant-owned entity (room is a
  free-text label this phase — assumption A8).

---

## 15. Seed (demo data)

Extend `packages/db/src/seed.ts` (idempotent, keyed on natural uniques, runs on the
RLS-bypassing `DIRECT_URL` owner connection — the existing seed contract) to add, under
the existing demo institution + its ACTIVE 2026-2027 session / Semester 1 term + BCA
program + the seeded BCA student:

- One **Course** under the BCA program (e.g. code `BCA-S1-CORE`), with one **Subject**
  (e.g. `CS101 Data Structures`, 4 credits, 4 contact hrs).
- One **ClassSection** (BCA + 2026-2027 + Semester 1, label `A`, capacity 60, status
  ACTIVE).
- One **ClassEnrollment** enrolling the seeded demo student (`BCA2024001`) into section A
  (status ENROLLED) — referencing the shared `StudentProfile`, proving single-identity.
- One **faculty user** (new `User`) whose legacy `User.role` enum column is set
  **deterministically**: if the demo faculty user is ALSO an HOD, set `role = HOD`;
  otherwise set `role = GUARD` — chosen as the inert non-actor value for a pure-faculty
  user because a faculty member is not a GatePass actor and Phase-3 access is
  permission-gated, not `requireRole`-gated (so the legacy value never gates Phase-3
  routes). The demo faculty user is a **pure faculty** user, so the seed sets
  `role = GUARD` and grants teaching capability via the **FACULTY template role** on their
  membership (not via the enum). Plus a **FacultyProfile** (department BCA) and a
  **FacultyAssignment** (PRIMARY, CS101, section A, Semester 1 term).
- One **Timetable** (Semester 1, PUBLISHED) with a small **conflict-free** set of
  `ScheduledClass` slots (e.g. Mon/Wed 09:00–10:00 `startTime=540,endTime=600`, room
  `R-101`, CS101, section A, the seeded faculty) — no overlapping faculty/room/section, on
  working weekdays.
- No `ScheduleRevision` rows are seeded (append-only history — the trigger forbids
  anything but genuine INSERTs; mirrors the seed's treatment of
  `student_profile_history` / `academic_calendar_day_revisions`). Permissions/roles are
  seeded idempotently from `@campusgate/shared` by the existing `seedRbacCatalogue`, which
  will pick up the new `classes.*` keys + FACULTY role automatically.

Idempotency: upsert/find-first-then-create keyed on the business uniques (course code,
subject code, section tuple, faculty userId, timetable (term,name)); re-running the seed
never duplicates.

---

## 16. Assumptions & ambiguities (consolidated for the reviewer)

- **A1** — `class_course` stays a declared-but-not-activated module key; Phase 3 is
  foundational, permission-gated only (no `requireModuleActive`). (§3)
- **A2** — a Subject belongs to exactly one Course/Program; no cross-listing. (§4)
- **A3** — adding a FACULTY template role with no `UserRole` enum value; a faculty user's
  legacy `User.role` is a pinned inert value (`GUARD` for pure faculty, `HOD` if also HOD)
  and does not gate Phase-3 access. (§5, §15)
- **A4** — FACULTY template role = `{classes.view_own}` only (committed least-privilege);
  no broad `classes.view`; "my schedule" via own-scoped endpoints. (§7)
- **A5** — HOD manages programs whose `departmentId` = their `departmentScope`. (§7.1)
- **A6** — conflict detection is same-`academicTermId` only. (§8)
- **A7** — publish hard-blocks on any blocking conflict; warnings never block. (§10)
- **A8** — `room` is a free-text label, not a tenant-owned Room entity. (§14)
- **A9** — enrollment accepts a soft one-row capacity overshoot under concurrency (no row
  lock this phase); no-duplicate-enrollment is DB-enforced by the unique. (§10)

Each is implemented as stated unless the review directs otherwise; none contradicts the
roadmap (they refine where the roadmap is silent).

---

## 17. Responses to design review (revision 3)

Mapping each finding in the latest `design-review.json` / `design-review.md` to its
resolution. The review verdict was CHANGES_REQUESTED (2 MEDIUM, 4 NIT, 0 HIGH); all six are
**addressed** in this revision — none backlogged or ignored. Each resolution aligns with the
original roadmap requirements and leaves the schema design untouched (the review confirmed
no schema redesign was needed).

**Finding 1 (MEDIUM — table count: 9 tables, not "ten"; 8 mutable, not "nine"; §6, §11b,
§11g, §11i, §12). → ADDRESSED.** Every "ten" is now "nine" and every "nine mutable" is now
"eight mutable" across §11/§12. §11b states it once authoritatively: **9 new tables = 8
standard-RLS-pair (mutable) tables + 1 append-only table (`schedule_revisions`)**, and the
nine-name parenthetical (the correct list the review identified) is retained. §11g now reads
"`ENABLE`+`FORCE` on all nine; … the eight mutable tables; … on `schedule_revisions`"; §11i
reads "full DML on the eight mutable tables"; §12 reads "add the nine tables to
`RLS_TABLES`" and "assertions for the eight mutable tables". A coder following §11/§12
literally now attaches the standard policy pair + full-DML grants to exactly the eight
mutable tables and looks for nine (not ten) entries in `RLS_TABLES`.

**Finding 2 (MEDIUM — foundational placement contradicts the live module-dependency engine
for Phase 4; §3, §13). → ADDRESSED.** The foundational decision is **kept** (no
`institution_module` row for `class_course`; permission-gated only, matching Phase 1/2), but
the sentence asserting the current engine "will treat `class_course` as a satisfied
structural dependency (data exists) rather than requiring an `institution_module` row" is
**removed**. §3 now states accurately — verified against `missingDependencies` in
`apps/api/src/services/module-system.ts` — that an **absent** `class_course` row evaluates to
`undefined !== "ACTIVE"` = **missing**, so Phase 4 attendance activation would return
`DEPS_UNMET` under the live engine (no force-activate path exists). It then names the concrete
Phase-4 change required: either (a) Phase 4 removes the `class_course` edge from
`MODULE_DEPENDENCIES.attendance` and substitutes a data-existence check (preferred), or (b)
Phase 4 seeds + activates a `class_course` module row during onboarding — and explicitly
states **Phase 3 does not edit `modules.ts` or seed a module row**. §13's seam bullet and the
A1 assumption note were updated to match, so the foundational choice is made with its Phase-4
cost named rather than presented as free.

**Finding 3 (NIT — stale `students.ts:57-64` line citation; §7.1). → ADDRESSED.** The exact
line numbers are dropped; §7.1 now references the helper by name (`students.ts`
`departmentScopeFilter`), which does not rot.

**Finding 4 (NIT — undocumented `ProgramStatus` reuse for `Course`/`Subject`; §6.2, §6.3). →
ADDRESSED.** A note after the `Course` model (§6.2, covering both `Course` and `Subject`)
states the reuse is deliberate: a course/subject shares the same ACTIVE/INACTIVE lifecycle as
a program, so `ProgramStatus` is reused rather than minting a near-duplicate enum — and
clarifies a course's status is independent of its program's status (same vocabulary, not
coupled rows).

**Finding 5 (NIT — per-`changeType` snapshot column contract for `ScheduleRevision` unstated;
§6.9). → ADDRESSED.** §6.9 now carries a per-`changeType` table: `SCHEDULED_CLASS_ADDED` →
all `new*` populated, all `previous*` null, slot's `{classSectionId, subjectId}` in
`metadata`; `SCHEDULED_CLASS_CANCELLED` → `previousStatus=SCHEDULED`, `newStatus=CANCELLED`;
`SCHEDULED_CLASS_UPDATED` / `FACULTY_REASSIGNED` map to the scalar pairs; timetable
transitions carry `newStatus`. The slot's section/subject live in `metadata` since they are
not first-class columns, so the ledger is self-describing without a join to a possibly-later-
mutated row. No schema change.

**Finding 6 (NIT — `classes.view` grant to FACULTY left as open assumption A4; §7, A4). →
ADDRESSED.** The "maybe also `classes.view`" hedge is deleted. §7's FACULTY row and the A4
block now state flatly that the FACULTY template role = `{classes.view_own}` only, matching
§11j's lockstep instruction, so the `ROLE_PERMISSIONS` map and migration seed encode exactly
one answer and the catalogue-sync set-equality meta-test cannot be tripped. A4 in §16 was
updated to the committed wording.

**Retained from the prior revision (confirmed correct by this review, unchanged):** the §7.1
`kind`-parameterized relation-filter helper and committed Timetable scope rule; the §8.2
`DOW_INDEX` + `getUTCDay()` determinism and recurring-vs-one-off out-of-hours split; the §9
past-tense audit-key convention; the §12 self-contained `schedule_revisions` escape case; the
§6.7 FacultyAssignment immutability invariant; and the capacity-race (A9) and seed legacy-role
(A3) pins. The review verified all of these against live source and flagged none of them.
