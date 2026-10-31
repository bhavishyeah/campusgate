# CAMPASS Phase 8 — Examinations & Results, SLICE 8.1 (backend only)

Combined requirements + technical design. Access-and-correctness-critical
(the exam analog of money-critical): unpublished results are invisible to
students, marks integrity is trigger-enforced, publication is step-up-gated and
irreversible-by-default (a correction is a NEW controlled re-publication, never a
silent edit).

Grounded in the REAL repo at `c:\campusgate` at HEAD `e113810` (Phase 7 fees
complete). Work directly on `main`. Do NOT push or deploy.

Reference files actually read while authoring (not assumed):
`packages/db/prisma/schema.prisma`, the frozen fees migrations
`20261122000000_phase7_fees_slice1` + `20261129000000_phase7_fees_slice2`,
`packages/db/src/index.ts`, `packages/shared/src/{permissions,audit-actions,modules}.ts`,
`apps/api/src/services/{authz-engine,mfa}.ts`,
`apps/api/src/middleware/step-up.ts`, `apps/api/src/routes/{fees,library,attendance}.ts`,
`apps/api/src/services/__tests__/catalogue-sync.test.ts`,
`apps/api/src/routes/__tests__/{tenant-escape.integration.test.ts,helpers/tenant-escape-setup.ts}`,
`apps/api/vitest.live-db-suites.ts`, `docs/{roadmap.md,superadmin-security.md}`.

---

## 1. Summary

Slice 8.1 delivers the exam DB foundation + the backend service/route layer for
the full lifecycle: exam setup, capacity-aware scheduling/room allocation,
candidate registration, weighted assessment components, faculty-scoped marks
entry with audited post-lock corrections, moderation/approval, a deterministic
server-side grading engine, and controlled append-only versioned result
publication gated by MFA step-up. Student-facing reads return only the latest
PUBLISHED version; staff can see unpublished state. Re-evaluation and
supplementary exams are reserved for slice 8.2 (the status enum and schema leave
room; no routes are built for them here).

The slice follows the proven Phases 1–7 house patterns exactly: `institutionId`
on every new table + composite same-tenant FKs; ENABLE+FORCE RLS with
nullif-guarded fail-closed policies; hand-authored lettered a–j migration in the
frozen house style; append-only triggers + forward-only column-guard triggers;
`withTenant` for every tenant read/write; `requireModuleActive("examinations")` +
`requirePermission(...)` on every route; step-up reuse for publication;
catalogue-sync + tenant-escape + live-DB suites extended.

---

## 2. Functional Requirements

FR-1. **Examinations.** Create/update an `Examination` scoped to
`(institutionId, academicSessionId, academicTermId, programId)` with a `type`
(`MIDTERM | FINAL | INTERNAL | SUPPLEMENTARY`) and a forward-only `status`
lifecycle `DRAFT → SCHEDULED → MARKS_OPEN → MARKS_LOCKED → MODERATION → APPROVED → PUBLISHED`.

FR-2. **Schedules + capacity-aware room allocation.** Per-`(exam, subject)`
`ExamSchedule` (date/time + room + capacity). A candidate is allocated to a
schedule's room without exceeding `roomCapacity`, using the library copy-issue
concurrency idiom (advisory xact lock + conditional count + partial-unique
backstop) so two concurrent allocations cannot over-fill a room.

FR-3. **Candidates.** Register a `StudentProfile` as a `Candidate` of an
`Examination`; unique per `(examId, studentId)`. Candidate rows are materialized
from program/section enrolment (derived, then persisted).

FR-4. **Assessment components.** A `(exam, subject)` has one or more weighted
`Assessment` components, each with `maxMarks` and `weight`. The sum of weights
per `(exam, subject)` must equal exactly **100** (see §6, decision).

FR-5. **Scoped marks entry.** A faculty may enter/edit a `MarksRecord` for a
candidate's `Assessment` ONLY for `(subject, section)` pairs the faculty is
assigned to via an ACTIVE `FacultyAssignment`. Marks are `0 ≤ mark ≤ maxMarks`.
Marks are editable while the exam is `MARKS_OPEN`; after `MARKS_LOCKED` any change
is an audited append-only correction (`MarksRecordHistory`), never a silent
overwrite. An out-of-scope write produces a `DENIED` audit + HTTP 403.

FR-6. **Moderation/approval.** A moderator reviews marks in
`MARKS_LOCKED → MODERATION`; mark changes during moderation are audited
corrections; `MODERATION → APPROVED` gates publication.

FR-7. **Configurable grading engine.** A per-institution `GradingScheme` =
ordered grade bands (`minPercentBps..maxPercentBps (0..10000) → grade label +
gradePoints + isPassing`).
Final percentage per `(candidate, subject)` = weighted sum of
`(mark/maxMarks × weight)` across the subject's assessments, then banded to a
grade + grade points. Deterministic server-side engine, NO formula interpreter.

FR-8. **Controlled publication.** `ResultPublication` is append-only and
versioned per `(exam, scope)`; publishing computes results via the grading engine
and snapshots them into immutable `ResultSnapshot` rows under the version. Gated
by `requireStepUp("exams.results.publish")` + `requirePermission("exams.results.publish")`.
A correction after publication is a NEW publication version (re-evaluation itself
lands in 8.2). Publication drives `APPROVED → PUBLISHED`.

FR-9. **Result visibility.** Student-facing reads (`exams.results.view_own`)
return ONLY the latest PUBLISHED version's snapshot for the calling student.
Unpublished/in-progress results are invisible to students, enforced BOTH at the
query layer (filter to the latest PUBLISHED version) AND by permission
(`exams.results.view` for staff can see unpublished).

FR-10. **Result reports.** Read-only JSON endpoints (staff `exams.results.view`):
exam result summary, pass/fail + grade distribution, per-subject and per-section
rollups. Excel export mirrors the `admin.ts` ExcelJS pattern. All student-facing
reads are published-only.

## 3. Non-Functional Requirements

NFR-1. **Multi-tenancy (A2).** `institutionId` on every new table; composite
same-tenant FKs incl. `institutionId`; ENABLE+FORCE RLS with nullif-guarded
fail-closed `USING`/`WITH CHECK`; `campass_app` GRANT refresh (NOSUPERUSER
NOBYPASSRLS, never BYPASSRLS). Every tenant read/write via `withTenant`.

NFR-2. **Integrity.** Append-only tables are trigger-protected (unconditional
raise on UPDATE/DELETE). Lifecycle tables use a forward-only column-guard
(IS DISTINCT FROM immutable-column checks + enumerated transitions + always-raise
on DELETE). Marks snapshots and publication versions are immutable once written.

NFR-3. **Determinism.** The grading engine is pure and deterministic with a
single documented rounding rule; identical inputs always yield identical grades.

NFR-4. **Migration discipline.** Hand-authored a–j migration dir
`20261206000000_phase8_exams_slice1`; NEVER `prisma migrate dev`; sanity-check
with `prisma migrate diff --from-schema-datasource`, apply with
`prisma migrate deploy`, confirm `prisma migrate status` up to date. No DROP on
existing tables; the 14 frozen dirs stay untouched. The known composite-vs-single
FK cosmetic diff is expected.

NFR-5. **Tests.** `npm test -w @campusgate/api` (fast/mocked) stays fully green
(currently 454). New live-DB suites pass IN ISOLATION via
`npm run test:integration` and are added to `vitest.live-db-suites.ts`. The
tenant-escape suite is extended to cover every new exams table.

## 4. Acceptance Criteria (testable, numbered)

AC-1. A student with only `exams.results.view_own` receives an empty/absent
result for an exam in any status other than `PUBLISHED`, and receives exactly the
latest PUBLISHED version's snapshot once published. (live-DB + fast)

AC-2. A faculty writing a `MarksRecord` for a `(subject, section)` they hold NO
ACTIVE `FacultyAssignment` for receives HTTP 403 and a `DENIED` audit event
(`exams.marks.entered`, result `DENIED`); no row is written. (live-DB)

AC-3. A mark outside `[0, maxMarks]` is rejected 400; a mark change after
`MARKS_LOCKED` writes a `MarksRecordHistory` row (append-only) and never silently
overwrites. (fast + live-DB)

AC-4. Two concurrent allocations into a room with capacity N never produce N+1
occupants: one succeeds, the other is rejected (room full). (live-DB
concurrency)

AC-5. Illegal exam status transitions (e.g. `DRAFT → PUBLISHED`,
`PUBLISHED → MARKS_OPEN`, any DELETE) raise `restrict_violation` at the DB.
(live-DB)

AC-6. `POST /exams/:id/publish` without a valid `x-step-up` header for action
`exams.results.publish` returns 401 `{ error: "Step-up required" }`; with a valid
token and `APPROVED` status it creates a new `ResultPublication` version +
immutable snapshots and moves the exam to `PUBLISHED`. (fast + live-DB)

AC-7. A publication attempt by a holder of `exams.results.publish` whose User has
`mfaEnabled = false` cannot obtain a step-up token (the `/mfa/verify` precondition
fails), so the publish route is unreachable (401). A live test asserts the
un-enrolled error path. (live-DB)

AC-8. The grading engine unit tests cover: integer basis-point band boundaries,
the integer half-up rounding (`(num + 5000n)/10000n`) INCLUDING an explicit test
that the naive `Math.round(89.995*100) === 8999` float path is NOT taken,
weight-sum=100 enforcement, zero marks, absent-mark-is-0, the 0% and 100%
extremes, `passed = band.isPassing` (including a passing band with
`gradePoints = 0`), and the band-gap `GradingError` — all fast/mocked. (fast)

AC-9. `catalogue-sync.test.ts` passes with the new `exams.*` permission keys and
role pairs present in BOTH `packages/shared` and the new migration's
`INSERT INTO "permissions"` + `role_permissions` spans, and the new dir added to
`SEEDING_MIGRATION_DIRS`. (fast)

AC-10. The tenant-escape suite proves RLS isolation + policy shape for EVERY new
exams table (read escape, spoofed-insert escape, `EXPECTED_POLICIES`/
`DEFAULT_POLICIES` membership), with the guard-trigger-disable teardown dance for
every table carrying an append-only/column-guard trigger. (live-DB)

AC-11. A publish that equals a prior version (correction) produces a NEW version
row with `version = prior + 1`; no prior version or snapshot row is mutated or
deleted. (live-DB)

## 5. Out of Scope (slice 8.1)

- Re-evaluation workflow and supplementary-exam intake routes (8.2). The
  `SUPPLEMENTARY` exam type and the version model are present so 8.2 is additive.
- Student-facing transcript/CGPA aggregation across exams (8.2+).
- Any frontend. Any push/deploy. Any Razorpay/payment interaction.

---

## 6. Locked product decisions (with rationale)

**D-A. Weight-sum rule = exactly 100 (integer percent), NOT 1.0.** Weights are
stored as `INTEGER` percent points; the sum of ACTIVE assessment weights per
`(exam, subject)` MUST equal `100`. Rationale: the whole codebase models
percentages/ratios as integers to avoid float drift (fees uses integer paise and
`percentBps`; `ConcessionDefinition.percentBps`). Integer `weight` summing to 100
is exact, trivially validated, and avoids the "0.1+0.2 ≠ 0.3" float trap that a
`1.0` sum invites. Enforced at the service layer on every assessment
create/update (recompute the ACTIVE set sum within the tenant tx) AND guarded by
a per-row CHECK `weight BETWEEN 1 AND 100`. The exact-100 invariant is a
multi-row property, so it is owned by the **service layer** inside `withTenant`
(a single-row CHECK cannot express a cross-row sum); the DB CHECK is the
per-component sanity bound only. See §12 for the invariant-ownership statement.

**D-B. Rounding rule = round-half-up (round half away from zero) to 2 decimal
places, computed with INTEGER/BigInt arithmetic end-to-end — never on a scaled
float.** The weighted percentage is accumulated in `BigInt` and rounded ONCE at
the end to `percentBps` (0..10000, i.e. pct×100). Rationale: round-half-up at a
fixed 2 dp is the convention registrars expect and is locale-independent; doing
it in integers makes it exactly deterministic (NFR-3) and immune to IEEE-754
drift. Critically, `Math.round(pct * 100)` is REJECTED as the implementation:
`89.995` is not representable in a double, so `89.995 * 100 = 8999.4999…` and
`Math.round` yields `8999` (89.99), silently mis-banding at a boundary — exactly
the failure mode this access-and-correctness-critical code must not have. The
engine uses the integer pipeline in §11 instead (half-up via `(num + 5000n) /
10000n` on a non-negative `BigInt`).

Banding is a PURE-INTEGER comparison: `percentBps` and the `grade_bands` edges
are both in basis points (MEDIUM-2), so a band matches when
`minPercentBps ≤ percentBps ≤ maxPercentBps`. Bands must be contiguous and
non-overlapping with `nextBand.minPercentBps = prevBand.maxPercentBps + 1`
(validated at scheme save); exactly one band matches by construction. If none
matches (misconfigured scheme) the engine raises a typed `GradingError` (fatal,
409 at the route) rather than guessing. No float ever touches the computation or
the boundary.

**D-C. No formula interpreter (decision (c) rejected).** Grading is a fixed,
auditable, server-side computation (`services/exams/grading.ts`), not a
per-institution expression string. Rationale: an interpreter is an injection and
correctness risk in access-and-correctness-critical code; the configurable
surface is the DATA (bands + weights + maxMarks), which is sufficient for the
roadmap's "configurable grading — not one universal formula" while staying
deterministic and unit-testable.

**D-D. Moderator role binding = ADMIN + the HOD/faculty-lead path; NO new
additive role.** Exam setup, grading-scheme management, moderation, and
publication bind to `ADMIN` and `HOD`. Rationale: unlike fees (which warranted a
genuinely new cross-cutting `ACCOUNTANT` persona), exam control maps cleanly onto
the EXISTING academic-leadership role `HOD`, which already owns
`classes.*`/`attendance.correct`/`students.*` (the academic supervision surface)
in `ROLE_PERMISSIONS`. Introducing an `EXAM_CONTROLLER` role would duplicate the
HOD persona and add a template-role migration for no separation-of-duties gain
that HOD does not already provide. `FACULTY` gets marks entry only. `ADMIN`
retains everything (institution super-persona). Publication additionally requires
MFA step-up regardless of role (§9), which is the real high-assurance control.
If a future institution needs a dedicated examinations controller distinct from
HOD, it is added additively later exactly as `ACCOUNTANT` was — out of scope here.

**D-E. Module key = `examinations` (correcting the brief's `exams`), and the
dependency graph is left UNCHANGED.** The brief says
`MODULE_DEPENDENCIES.exams = []`, but the REAL `packages/shared/src/modules.ts`
registry key is `examinations` (and the `exams.*` prefix is used only for
permissions/audit keys). The gate is `requireModuleActive("examinations")`.

The registry currently declares
`examinations: ["academic_sessions", "class_course", "student_enrollment"]`.
**This slice does NOT change it.** The brief's "make exams foundational-not-gated"
instruction was written by analogy to fees/attendance/admissions, but that
analogy does NOT hold for exams, and acting on it would break currently-green
tests. Two concrete reasons, both verified against the real files:

1. *The rationale does not transfer.* fees/attendance/admissions were re-pointed
   to `[]` because their real prerequisites are **foundational DATA with no
   module row** (StudentProfile / Program / Session rows that are never an ACTIVE
   `InstitutionModule`), so a gated edge would permanently block activation.
   Exams' prerequisites are different: `academic_sessions`, `class_course`, and
   `student_enrollment` are themselves **declared gated module keys** in `MODULES`
   that CAN be activated. A gated edge onto them does NOT permanently block
   activation — it just requires those modules to be ACTIVE first, which is the
   intended booster-model behaviour.
2. *It would turn the suite red.* `examinations` is the sole remaining
   **multi-dependency exemplar** in the graph and is asserted verbatim by the
   fast and live suites: `services/__tests__/modules.test.ts` has two cases
   (`"examinations still declares its three foundational edges"` and
   `"examinations keeps its three edges; fees is foundational-not-gated"`) that
   assert equality with `["academic_sessions","class_course","student_enrollment"]`,
   and `services/__tests__/module-system.integration.test.ts` drives
   `examinations` through its three edges in `missingDependencies`,
   `affectedDependents`, the DEPS_UNMET activation test, the SUSPENDED-dependency
   409 test, and the platform-revoke tenant-scope test. Re-pointing to `[]` would
   break ≥2 fast cases and ≥5 integration cases, directly violating NFR-5
   ("stay fully green, currently 454").

**Decision: keep `examinations: ["academic_sessions","class_course","student_enrollment"]`
exactly as-is.** This slice makes NO edit to `MODULE_DEPENDENCIES` and NO edit to
the module-system test exemplar. Exam routes are gated purely by
`requireModuleActive("examinations")` layered on top of the existing dep graph.
The only shared-foundation files this slice edits are
`packages/shared/src/{permissions,audit-actions}.ts` (§14) — NOT `modules.ts`.
Rationale: lowest blast radius, no churn in a frozen shared file or its two test
suites, and self-consistent with the booster model (gated prerequisites are a
feature, not a bug, when the prerequisites are themselves gated modules).

---

## 7. Schema additions

Nine new tenant-owned tables + the enums. Every table carries `institutionId` +
`institution Institution @relation(...)`, `@@unique([id, institutionId])`
(anchors composite same-tenant FKs), an `(institutionId)` index, and the §7.x
query indexes. Prisma relations reference the single PK; the composite
same-tenant FKs (incl. `institutionId`), partial unique indexes, CHECKs, RLS
policies, triggers, GRANT refresh, and catalogue seed are RAW SQL in the
hand-authored migration (Prisma's diff models none of those — the library/fees
precedent). The composite-vs-single-FK cosmetic diff is expected.

### 7.1 Enums (Prisma + `CREATE TYPE`)

```
enum ExaminationType   { MIDTERM FINAL INTERNAL SUPPLEMENTARY }
enum ExaminationStatus { DRAFT SCHEDULED MARKS_OPEN MARKS_LOCKED MODERATION APPROVED PUBLISHED }
enum MarksRecordHistoryChangeType { MARKED CORRECTED }    -- value-identical to AttendanceRecordHistoryChangeType {MARKED,CORRECTED}
enum ResultPublicationStatus { PUBLISHED SUPERSEDED }     -- 8.1 writes PUBLISHED ONLY; SUPERSEDED is RESERVED for 8.2 and MUST NOT be written by any 8.1 code path. "superseded" is DERIVED as version < max(version); the append-only trigger forbids mutating a prior row to SUPERSEDED, so writing it in 8.1 would be a bug.
```

(`SUPERSEDED` is a label on prior versions for reporting; the publication table
is still append-only — "supersede" is recorded by inserting a newer version, and
prior rows' status is NOT mutated. The `latest PUBLISHED` read is "max version
for the scope"; `SUPERSEDED` is informational metadata written at insert time of
the superseding row's siblings only if needed. To stay strictly append-only we do
NOT update prior rows — see §10 for the exact "latest" selection.)

### 7.2 Tables

**examinations** — the exam instance (lifecycle via column-guard trigger).
```
id            TEXT PK
institutionId TEXT NOT NULL
academicSessionId TEXT NOT NULL
academicTermId    TEXT NOT NULL
programId         TEXT NOT NULL
name          TEXT NOT NULL
type          ExaminationType NOT NULL
status        ExaminationStatus NOT NULL DEFAULT 'DRAFT'
createdByUserId TEXT NOT NULL          -- recorded actor id, NO FK
createdAt     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
updatedAt     TIMESTAMP(3) NOT NULL
```
Composite same-tenant FKs: `(institutionId, academicSessionId) → academic_sessions`,
`(institutionId, academicTermId) → academic_terms`,
`(institutionId, programId) → programs`. All `ON DELETE RESTRICT ON UPDATE CASCADE`.
Indexes: `(id, institutionId)` unique; `(institutionId)`;
`(institutionId, academicTermId)`; `(institutionId, programId)`;
`(institutionId, status)`. CHECK `char_length(name) >= 1`. **Column-guard trigger**
(forward-only lifecycle, §8).

**grading_schemes** — per-institution scheme header (mutable, standard RLS pair).
```
id institutionId name
status FeeStructureStatus-like? NO — use a local ExaminationStatus? NO.
```
Decision: give grading schemes their own minimal lifecycle via a boolean
`isActive BOOLEAN NOT NULL DEFAULT false` + `name` unique per institution; no new
enum needed. Columns:
```
id            TEXT PK
institutionId TEXT NOT NULL
name          TEXT NOT NULL
isActive      BOOLEAN NOT NULL DEFAULT false
createdByUserId TEXT NOT NULL
createdAt / updatedAt
```
Unique: `(institutionId, name)`, `(id, institutionId)`. Standard RLS pair,
mutable (edited until referenced by a publication; once a publication snapshots a
grade it is immutable by value because the snapshot copies gradeLabel/points).

**grade_bands** — ordered bands of a scheme (mutable until the scheme is used;
standard RLS pair). **Edges are stored in basis points (0..10000, i.e. pct×100)
— the SAME unit the engine produces — so banding is an integer comparison with
no float ever touching the boundary (MEDIUM-2).**
```
id institutionId gradingSchemeId
minPercentBps INTEGER NOT NULL     -- 0..10000 (pct*100); e.g. 9000 = 90.00%
maxPercentBps INTEGER NOT NULL     -- minPercentBps <= maxPercentBps; contiguous/non-overlap (service-owned)
gradeLabel    TEXT NOT NULL        -- e.g. 'A+','A','B','F'
gradePoints   INTEGER NOT NULL     -- GRADE_POINTS_SCALE=100: integer points *100 (e.g. 1000 = 10.00) to stay float-free
isPassing     BOOLEAN NOT NULL     -- authoritative pass/fail flag for this band (MEDIUM-1); passed := band.isPassing
ordinal       INTEGER NOT NULL
createdAt / updatedAt
```
Composite FK `(institutionId, gradingSchemeId) → grading_schemes`. Unique
`(institutionId, gradingSchemeId, ordinal)`, `(id, institutionId)`. CHECKs:
`minPercentBps >= 0`, `maxPercentBps <= 10000`, `minPercentBps <= maxPercentBps`,
`gradePoints >= 0`, `char_length(gradeLabel) >= 1`. The computed value
(`percentBps`, §11) and the band edges are in the IDENTICAL basis-point unit, so
the engine bands with the pure-integer predicate
`minPercentBps <= percentBps <= maxPercentBps`; contiguity is
`nextBand.minPercentBps = prevBand.maxPercentBps + 1` (half-open on integers — no
gap, no overlap), validated at scheme save. `gradePoints` uses a single shared
scale constant `GRADE_POINTS_SCALE = 100` (NIT-5): the value is always
points×100, pinned by this comment and the `services/exams/grading.ts` constant,
never stored raw.

**exam_schedules** — per-`(exam, subject)` sitting + room (mutable until
MARKS_OPEN; standard RLS pair). Carries `roomCapacity` for allocation.
```
id institutionId examId subjectId
room        TEXT NOT NULL
roomCapacity INTEGER NOT NULL
startsAt    TIMESTAMP(3) NOT NULL
endsAt      TIMESTAMP(3) NOT NULL
createdAt / updatedAt
```
Composite FKs `(institutionId, examId) → examinations`,
`(institutionId, subjectId) → subjects`. Unique `(institutionId, examId, subjectId)`
(one schedule per exam+subject), `(id, institutionId)`. CHECKs `roomCapacity > 0`,
`endsAt > startsAt`, `char_length(room) >= 1`.

**candidates** — a StudentProfile registered for an exam; one allocation.
```
id institutionId examId studentId
examScheduleId TEXT NULL       -- room allocation target (set by the allocation op)
seatNo         TEXT NULL
createdAt / updatedAt
```
Composite FKs `(institutionId, examId) → examinations`,
`(institutionId, studentId) → student_profiles` (SHARED identity — the single-
identity rule; `studentId` is a `StudentProfile.id`),
`(institutionId, examScheduleId) → exam_schedules` (nullable). Unique
`(examId, studentId)` (no duplicate candidate — hard), `(id, institutionId)`.
Indexes `(institutionId, examId)`, `(institutionId, studentId)`,
`(institutionId, examScheduleId)`. Allocation concurrency: see §11.

**assessments** — weighted component of an exam's subject evaluation (mutable
until MARKS_LOCKED; standard RLS pair).
```
id institutionId examId subjectId
name     TEXT NOT NULL        -- e.g. 'INTERNAL','EXTERNAL'
maxMarks INTEGER NOT NULL
weight   INTEGER NOT NULL     -- percent points; ACTIVE set per (exam,subject) sums to 100 (service-owned)
createdAt / updatedAt
```
Composite FKs `(institutionId, examId) → examinations`,
`(institutionId, subjectId) → subjects`. Unique `(institutionId, examId, subjectId, name)`,
`(id, institutionId)`. Indexes `(institutionId, examId, subjectId)`. CHECKs
`maxMarks > 0`, `weight BETWEEN 1 AND 100`, `char_length(name) >= 1`.

**marks_records** — a candidate's mark for an assessment (forward-only /
correction-guarded; standard RLS pair + column-guard trigger).
```
id institutionId examId assessmentId candidateId studentId
marks       INTEGER NOT NULL          -- 0 <= marks <= assessment.maxMarks (0..maxMarks CHECK is >=0; upper bound service+trigger)
enteredByUserId TEXT NOT NULL
createdAt / updatedAt
```
Composite FKs `(institutionId, examId) → examinations`,
`(institutionId, assessmentId) → assessments`,
`(institutionId, candidateId) → candidates`,
`(institutionId, studentId) → student_profiles`. Unique
`(assessmentId, candidateId)` (one mark per candidate per assessment),
`(id, institutionId)`. Indexes `(institutionId, examId)`,
`(institutionId, assessmentId)`, `(institutionId, candidateId)`. CHECK
`marks >= 0` (the `marks <= maxMarks` bound is cross-table, so it is enforced in
the service layer on every write and re-asserted by the column-guard on edit;
§8/§12). **Column-guard trigger** freezes identity columns + forbids DELETE;
`marks` is editable only while the exam is `MARKS_OPEN` (status gate enforced in
the service layer, not the row trigger, because the trigger has no exam-status
context — it guards identity + DELETE; the post-lock append-only history is the
correction mechanism).

**marks_record_history** — append-only audit of every mark write/correction
(INSERT-only; append-only RLS pair + append-only trigger). Mirrors
`attendance_record_history` exactly.
```
id institutionId marksRecordId
changeType MarksRecordHistoryChangeType
previousMarks INTEGER NULL   -- null for the initial MARKED row
newMarks      INTEGER NOT NULL
actorUserId   TEXT NOT NULL
actorMembershipId TEXT NULL
reason        TEXT NULL
metadata      JSONB NULL
createdAt     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP   -- NO updatedAt
```
Composite FK `(institutionId, marksRecordId) → marks_records`. Unique
`(id, institutionId)`. Indexes `(institutionId, marksRecordId)`.

**result_publications** — append-only versioned publication header (INSERT-only;
append-only RLS pair + append-only trigger).
```
id institutionId examId
version INTEGER NOT NULL          -- 1,2,3... per (institutionId, examId)
status  ResultPublicationStatus NOT NULL DEFAULT 'PUBLISHED'
gradingSchemeId TEXT NOT NULL     -- scheme used for this version's snapshot
publishedByUserId TEXT NOT NULL
reason  TEXT NULL                 -- required on version > 1 (correction reason, service-enforced)
publishedAt TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP   -- NO updatedAt
createdAt   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
```
Composite FKs `(institutionId, examId) → examinations`,
`(institutionId, gradingSchemeId) → grading_schemes`. Unique
`(institutionId, examId, version)` (the hard version key), `(id, institutionId)`.
Indexes `(institutionId, examId)`. CHECK `version >= 1`.

**result_snapshots** — immutable per-`(publication, candidate, subject)` computed
result (INSERT-only; append-only RLS pair + append-only trigger).
```
id institutionId resultPublicationId examId candidateId studentId subjectId
percentBps   INTEGER NOT NULL     -- computed pct in basis points (pct*100), 0..10000; produced by the integer engine (§11)
gradeLabel   TEXT NOT NULL        -- copied from the matched band at publish time (immutable)
gradePoints  INTEGER NOT NULL     -- copied from the band; GRADE_POINTS_SCALE=100 (points*100)
passed       BOOLEAN NOT NULL     -- copied from the matched band's isPassing (MEDIUM-1)
createdAt    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP   -- NO updatedAt
```
Composite FKs `(institutionId, resultPublicationId) → result_publications`,
`(institutionId, examId) → examinations`,
`(institutionId, candidateId) → candidates`,
`(institutionId, studentId) → student_profiles`,
`(institutionId, subjectId) → subjects`. Unique
`(resultPublicationId, candidateId, subjectId)`, `(id, institutionId)`. Indexes
`(institutionId, resultPublicationId)`, `(institutionId, studentId)`,
`(institutionId, examId, subjectId)`. CHECK `percentBps BETWEEN 0 AND 10000`,
`gradePoints >= 0`. The grade/points are COPIED (snapshotted) at publish time so a
later scheme edit never changes a published result.

### 7.3 Table-class summary (determines RLS + trigger shape)

- **Mutable, standard RLS pair:** `grading_schemes`, `grade_bands`,
  `exam_schedules`, `assessments`, `candidates`. (No history/guard beyond CHECKs;
  allocation uses advisory lock + partial unique, §11.)
- **Forward-only column-guard (standard RLS pair + guard trigger):**
  `examinations` (status lifecycle), `marks_records` (identity frozen, DELETE
  forbidden).
- **Append-only INSERT-only (append-only RLS pair + append-only trigger):**
  `marks_record_history`, `result_publications`, `result_snapshots`.

### 7.4 RLS policies (verbatim house idiom)

ENABLE+FORCE RLS on all nine. Mutable + column-guard tables get the standard
pair `{tenant_isolation_select, tenant_isolation_modify}`; the three INSERT-only
tables get `{tenant_isolation_select, <table>_tenant_insert}` (SELECT + INSERT,
NO modify). All policies use
`nullif(current_setting('app.current_institution_id', true), '')` so an unset or
empty-string GUC fails closed — copied from the fees slice-1/2 `DO $$ ... $$`
block. `tenant_escape-setup.ts` `EXPECTED_POLICIES` gets the three INSERT-only
tables (`*_tenant_insert`); the six mutable/guarded tables fall through to
`DEFAULT_POLICIES` (the standard pair) exactly like `payment_transactions`/
`refunds`.

### 7.5 GRANT refresh

Guarded idempotent `DO $$ IF EXISTS (campass_app) ... $$`: full
`SELECT,INSERT,UPDATE,DELETE` on the six mutable/column-guard tables (the
column-guard enforces immutability at the row level, not via grant); `SELECT,
INSERT` + `REVOKE UPDATE, DELETE` on the three INSERT-only tables. Never
BYPASSRLS.

---

## 8. Exam status state machine + forward-only column-guard trigger

`ExaminationStatus`: `DRAFT → SCHEDULED → MARKS_OPEN → MARKS_LOCKED → MODERATION → APPROVED → PUBLISHED`.

**Legal transitions (forward-only; no skips except none defined; no reverse; no
exit from PUBLISHED):**

| From | Allowed To |
|---|---|
| DRAFT | SCHEDULED |
| SCHEDULED | MARKS_OPEN |
| MARKS_OPEN | MARKS_LOCKED |
| MARKS_LOCKED | MODERATION |
| MODERATION | APPROVED |
| APPROVED | PUBLISHED |
| (any) | itself (no-op, allowed) |

Everything else raises. `PUBLISHED` is terminal (publishing a correction is a NEW
`result_publications` version, NOT a status change away from `PUBLISHED`).

**`examinations_guard()` (mirrors `payment_transactions_guard` / `student_charges_guard`):**

```sql
CREATE OR REPLACE FUNCTION "examinations_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'examinations is append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  -- immutable scope/identity columns
  IF NEW."institutionId"     IS DISTINCT FROM OLD."institutionId"
  OR NEW."academicSessionId" IS DISTINCT FROM OLD."academicSessionId"
  OR NEW."academicTermId"    IS DISTINCT FROM OLD."academicTermId"
  OR NEW."programId"         IS DISTINCT FROM OLD."programId"
  OR NEW."type"              IS DISTINCT FROM OLD."type"
  OR NEW."createdByUserId"   IS DISTINCT FROM OLD."createdByUserId"
  THEN
    RAISE EXCEPTION 'immutable examinations column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  -- terminal state frozen
  IF OLD."status" = 'PUBLISHED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'published examination status is frozen' USING ERRCODE = 'restrict_violation';
  END IF;
  -- forward-only transitions
  IF NOT (
       (OLD."status" = 'DRAFT'        AND NEW."status" = 'SCHEDULED')
    OR (OLD."status" = 'SCHEDULED'    AND NEW."status" = 'MARKS_OPEN')
    OR (OLD."status" = 'MARKS_OPEN'   AND NEW."status" = 'MARKS_LOCKED')
    OR (OLD."status" = 'MARKS_LOCKED' AND NEW."status" = 'MODERATION')
    OR (OLD."status" = 'MODERATION'   AND NEW."status" = 'APPROVED')
    OR (OLD."status" = 'APPROVED'     AND NEW."status" = 'PUBLISHED')
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal examinations status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "examinations_guard" BEFORE UPDATE OR DELETE ON "examinations"
  FOR EACH ROW EXECUTE FUNCTION "examinations_guard"();
```

**`marks_records_guard()`** — identity frozen, DELETE forbidden; `marks` and
`updatedAt` may change (the exam-status gate for "editable only while MARKS_OPEN,
else correction" is enforced in the service layer because the row has no exam
status; the history row is written on every change):

```sql
CREATE OR REPLACE FUNCTION "marks_records_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'marks_records is append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."institutionId" IS DISTINCT FROM OLD."institutionId"
  OR NEW."examId"        IS DISTINCT FROM OLD."examId"
  OR NEW."assessmentId"  IS DISTINCT FROM OLD."assessmentId"
  OR NEW."candidateId"   IS DISTINCT FROM OLD."candidateId"
  OR NEW."studentId"     IS DISTINCT FROM OLD."studentId"
  THEN
    RAISE EXCEPTION 'immutable marks_records column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "marks_records_guard" BEFORE UPDATE OR DELETE ON "marks_records"
  FOR EACH ROW EXECUTE FUNCTION "marks_records_guard"();
```

**Append-only triggers** for `marks_record_history`, `result_publications`,
`result_snapshots` are the verbatim `<table>_append_only()` unconditional-raise
functions + `BEFORE UPDATE OR DELETE ... FOR EACH ROW` triggers (binds the owner
too), copied from the fees INSERT-only tables.

The service layer performs status transitions via a tiny
`advanceExamStatus(tx, examId, from, to)` helper that updates with a
`where: { id, institutionId, status: from }` guard (optimistic) and relies on the
trigger as the hard backstop — mirroring the attendance/fees pattern.

---

## 9. MFA step-up reuse for publication

Publication is a step-up action, REUSING the existing seam unchanged (no parallel
mechanism):

- Route: `POST /api/exams/:id/publish`, preHandler order
  `[requirePermission("exams.results.publish"), requireStepUp("exams.results.publish"), requireModuleActive("examinations")]`
  — the exact fees-refund ordering (`requirePermission` → `requireStepUp` →
  `requireModuleActive`).
- `requireStepUp("exams.results.publish")` (from
  `apps/api/src/middleware/step-up.ts`, used unchanged) verifies the `x-step-up`
  header JWT: signature+expiry via `request.server.jwt`, `userId` match,
  `stepUp === true`, `action === "exams.results.publish"`. Any failure ⇒ 401
  `{ error: "Step-up required" }`.
- The token is minted by the EXISTING `POST /api/auth/mfa/verify` flow
  (`mintStepUpToken(signer, userId, "exams.results.publish")`,
  `STEP_UP_TTL_SECONDS = 5m`, action-class bound). No new minting path.

**Un-enrolled error path (documented, mirrors fees slice 7.1 / ACCOUNTANT-ADMIN
self-enrol precondition).** The publishing roles (`ADMIN`, `HOD`) must be able to
self-enrol MFA. A publisher whose `User.mfaEnabled = false` cannot produce a
fresh MFA assertion at `/api/auth/mfa/verify`, so `mintStepUpToken` is never
reached and the publish route is unreachable (401 "Step-up required"). The
enrolment endpoints (`/api/auth/mfa/enroll/start`, `/enroll/verify`,
`/api/auth/mfa/verify`) are the self-enrol path; they are not gated behind a
module and are reachable by any authenticated user holding the publish
permission. A live test asserts: (1) publish without step-up ⇒ 401; (2) a holder
with `mfaEnabled=false` cannot complete `/mfa/verify` (no secret) and thus cannot
publish; (3) after enrol+verify, publish with the minted token succeeds. This is
the fees-refund precondition replicated for exams.

---

## 10. Publication / correction versioning model

`ResultPublication` is append-only and versioned per `(institutionId, examId)`.
The unique key `(institutionId, examId, version)` is the hard monotonic version.

**Publish operation (inside one `withTenant` tx):**
1. Advisory xact lock on `(institutionId, examId)` (serialize concurrent
   publishes of the same exam) — `pg_advisory_xact_lock(hashtextextended(key,0))`
   with `key = "exampub:" || institutionId || ":" || examId` (the library idiom).
2. Load the exam `FOR`-current status; require `APPROVED` (first publish) or
   `PUBLISHED` (a correction/re-publish). Any other status ⇒ 409.
3. Compute `nextVersion = COALESCE(max(version),0)+1` for the scope.
4. Resolve the ACTIVE `GradingScheme` (require exactly one `isActive` scheme; else
   409 `GradingError`).
5. For every candidate × subject, run the grading engine (§11) over the
   `marks_records`; INSERT one immutable `result_snapshots` row per
   `(candidate, subject)` under the new `result_publications` row, copying
   `gradeLabel`/`gradePoints` from the matched band.
6. INSERT the `result_publications` row (`version = nextVersion`, `status =
   PUBLISHED`, `reason` REQUIRED when `version > 1`).
7. If first publish, `advanceExamStatus(... APPROVED → PUBLISHED)`; for a
   correction the exam stays `PUBLISHED` (terminal) and only a new version is
   added.
8. Audit `exams.results.published` (SUCCESS) with `{ version, scope,
   snapshotCount }`.

**"Latest PUBLISHED" selection (append-only, no row mutation):** the latest
version for a scope is `max(version)`. Prior versions are never updated or
deleted. Student reads and reports always query the MAX-version publication's
snapshots. Because we never mutate prior rows, the `SUPERSEDED` status is not
written by updating old rows; it is a derived label ("not the max version"). The
schema keeps the `status` column for forward-compatibility with 8.2 but 8.1 only
ever writes `PUBLISHED` and derives "superseded" as `version < max(version)`.
(This keeps the table strictly INSERT-only and consistent with the append-only
trigger.)

**`SUPERSEDED` is a reserved-for-8.2 dead value in 8.1 (Finding 3).** No 8.1 code
path writes it: every `INSERT` into `result_publications` sets
`status = 'PUBLISHED'`, and the append-only trigger forbids `UPDATE`, so a prior
row can never be flipped to `SUPERSEDED`. The migration's `CREATE TYPE
"ResultPublicationStatus"` MUST carry an inline SQL comment stating exactly this
("8.1 writes PUBLISHED only; SUPERSEDED reserved for 8.2 — MUST NOT be written by
any 8.1 path; 'superseded' is derived as version < max(version)"), so an
implementer is not tempted to "helpfully" write it (which the trigger would then
reject on prior rows). The variant is retained rather than deferred so the 8.2
re-evaluation slice is purely additive, but it is inert in 8.1.

A correction is therefore a NEW version — never a silent edit of a published
result. This is the exact fees append-only-ledger discipline applied to results.

---

## 11. Grading engine spec (`apps/api/src/services/exams/grading.ts`)

Pure, deterministic, no DB access (takes plain inputs), exhaustively unit-tested
fast/mocked.

**Inputs per `(candidate, subject)`:** the subject's assessments
`[{ assessmentId, maxMarks, weight }]` (weights sum to 100, validated upstream and
re-asserted) and the candidate's marks `[{ assessmentId, marks }]`. The active
`GradingScheme` bands `[{ minPercentBps, maxPercentBps, gradeLabel, gradePoints, isPassing }]`
(contiguous on basis points, non-overlapping, validated at scheme save).

**Algorithm (integer/BigInt only — no float anywhere, D-B/MEDIUM-2):**
1. For each assessment, the contribution to the final percentage is
   `marks / maxMarks × weight` (weight is a percent point, and Σweight = 100, so
   the sum is already a percentage). Absent marks (no `marks_records` row) are
   treated as `0` (documented: an unentered mark contributes 0 to the weighted
   percentage — a missing mark is a 0, never "excluded", so grades are never
   inflated by absence).
2. Accumulate the percentage scaled by `1e6` in a `BigInt` so the per-assessment
   `/ maxMarks` division retains guard digits before the single final rounding
   (`1e6` = 2 dp of percentBps × 2 guard digits):
   ```ts
   // percentBps in 0..10000 means 0.00%..100.00%
   let num = 0n; // accumulates (percentage * 1e6), pre-rounding
   for (const a of assessments) {
     const m = BigInt(marksByAssessment.get(a.assessmentId) ?? 0); // absent => 0
     // m/maxMarks is the fraction; ×weight (a percent point) ×1e6 scale:
     num += (m * BigInt(a.weight) * 1_000_000n) / BigInt(a.maxMarks);
   }
   ```
   `BigInt` (not `number`) avoids any `2^53` overflow across many components and
   makes the integer division associativity-independent and exact for the stated
   scale.
3. **Rounding (D-B):** half-up from `percentage × 1e6` to `percentBps`
   (`percentage × 1e2`) by dividing by `1e4` with a half-up bias on the
   non-negative `BigInt`:
   ```ts
   const percentBps = Number((num + 5_000n) / 10_000n); // 0..10000, exact half-up
   ```
   `percentBps` is clamped-by-construction to `0..10000` (marks ≤ maxMarks,
   Σweight = 100). This is the SINGLE value stored and banded, so the stored
   percentage and the grade are always mutually consistent.
4. **Band (pure integer):** select the band with
   `minPercentBps ≤ percentBps ≤ maxPercentBps`. Exactly one matches (contiguity
   `nextBand.minPercentBps = prevBand.maxPercentBps + 1`, non-overlap, validated
   at scheme save). None ⇒ throw `GradingError` (fatal; 409). Copy
   `gradeLabel`/`gradePoints` from the matched band.
5. **Pass/fail (MEDIUM-1):** `passed = band.isPassing`, the authoritative flag on
   the matched `grade_bands` row. The old `gradePoints > 0` heuristic is DELETED —
   it diverged from `isPassing` for a legitimately passing band with
   `gradePoints = 0` (e.g. a 'P' band awarding 0 points), which `grade_bands`
   permits (`gradePoints >= 0`). Scheme-save validation asserts consistency: bands
   are ordered by `minPercentBps`, and no passing band may sit strictly below a
   failing band (`isPassing` is monotonic non-decreasing up the band order) so a
   scheme cannot mark a high band fail while a lower band passes.

**Edge cases (all unit-tested):** mark == 0 (0% ⇒ `percentBps = 0`), mark ==
maxMarks (100% ⇒ `percentBps = 10000`), exact basis-point band boundary values
(e.g. `percentBps = 9000` lands in the band with `minPercentBps = 9000`), a
single-assessment subject (weight 100), weights that do NOT sum to 100 (engine
asserts and throws — the caller has already validated, so this is
defense-in-depth), absent marks (⇒ 0), empty assessment list (no result row
emitted for that subject), and a half-up boundary stated in INTEGER terms: inputs
that make `num = …49995000…` round UP via `(num + 5000n)/10000n` (a dedicated
test asserts the naive `Math.round(89.995 * 100) === 8999` float path is NOT the
one taken, so a value that must become `9000` does). Determinism: identical inputs
always produce identical `percentBps`/grade.

**Testability:** the engine is 100% unit-testable (pure). The
publish/persistence wrapper and scope/status checks are integration-tested
against the live DB. A hard-to-test design would mix DB reads into the math; the
split keeps the math pure.

---

## 12. Marks-scope enforcement + invariant ownership

**Scope rule (FR-5).** A `MarksRecord` write is authorized iff the acting user
is an ACTIVE faculty member AND holds an ACTIVE `FacultyAssignment` matching the
marks row's `(subject, section)`. **This slice REUSES the proven house helpers in
`apps/api/src/services/attendance-authz.ts` verbatim — it does NOT hand-roll a
parallel derivation** (MEDIUM Finding 1). Those helpers are the established seam
for exactly this record-level "faculty may mark only an assigned (subject,
section)" rule, and they run inside the request's `withTenant` tx (RLS-scoped).
Two guards, in order:

1. **`resolveMarkingFaculty(tx, institutionId, request.user.userId)`** — resolves
   the caller's `FacultyProfile` with `status = 'ACTIVE'`. A `null` result
   (no profile, or a DEACTIVATED/INACTIVE profile) ⇒ `DENIED` audit
   (`exams.marks.entered`, result `DENIED`, metadata `{ reason: "not_faculty" }`)
   + 403 "not a faculty member". **This is the critical gate the prior design
   omitted:** a deactivated teacher who still has a left-over ACTIVE
   `FacultyAssignment` row is rejected here because their `FacultyProfile.status`
   is no longer `'ACTIVE'` — closing the access-control hole in access-critical
   code.
2. **`assertFacultyAssigned(tx, institutionId, marking.facultyId, { classSectionId,
   subjectId: assessment.subjectId, academicTermId: exam.academicTermId, facultyId:
   "" })`** — checks an ACTIVE `FacultyAssignment` on the same subject + term and
   the candidate's section (or a section-less `classSectionId IS NULL` subject-wide
   assignment, via the helper's `OR: [{ classSectionId }, { classSectionId: null }]`).
   The `facultyId: ""` sentinel forces the GENERAL assignment path (the helper's
   `scheduled.facultyId === facultyId` fast path is a ScheduledClass concept that
   does not exist for exams, so passing an empty sentinel guarantees it never
   short-circuits). A `false` result ⇒ `DENIED` audit (`exams.marks.entered`,
   result `DENIED`, metadata `{ reason: "out_of_scope", subjectId, candidateId }`)
   + 403.

The candidate's section is resolved via the student's `ClassEnrollment` joined to
`ClassSection` — **`ClassEnrollment` has NO `academicTermId` column (the term
lives on `ClassSection`), so the join path is `ClassEnrollment → ClassSection WHERE
ClassSection.academicTermId = exam.academicTermId AND ClassEnrollment.studentId =
candidate.studentId`** (NIT-4; do NOT filter `ClassEnrollment` by a non-existent
term column). The resolved `ClassSection.id` values are the candidate's sections
for the term; `assertFacultyAssigned` is called per candidate section (passing if
the faculty is assigned to ANY of them, or holds a subject-wide assignment). The
`DENIED` audit is written inside the tenant tx (so the audit commits, mirroring
the fees `deny()` + `recordAuditEvent` pattern) and the route returns 403.
`ADMIN`/`HOD` are NOT granted `exams.marks.enter`, so they cannot enter marks
(separation of duties); marks entry is `FACULTY` only.

**Marks lifecycle — the status × route matrix (MEDIUM-3, authoritative).** There
are TWO distinct write paths; which one is legal depends solely on the exam
status:

| Exam status | Legal write path | Permission / actor | History row | Audit action key (result) | Else |
|---|---|---|---|---|---|
| `MARKS_OPEN` | `PUT /exams/:id/marks` — FIRST write of a record | `exams.marks.enter`, FACULTY, in-scope | `MARKED` | `exams.marks.entered` (SUCCESS) | — |
| `MARKS_OPEN` | `PUT /exams/:id/marks` — later edit of an existing record | `exams.marks.enter`, FACULTY, in-scope | `CORRECTED` | `exams.marks.corrected` (SUCCESS) | — |
| `MODERATION` | `POST /exams/:id/marks/:recordId/correct` (single, reason required) | `exams.moderate`, ADMIN/HOD | `CORRECTED` + `reason` | `exams.marks.corrected` (SUCCESS, `{ reason }`) | — |
| (scope fail on `PUT …/marks`) | rejected | — | none (no row) | `exams.marks.entered` (DENIED) | 403 |
| any other (`DRAFT`, `SCHEDULED`, `MARKS_LOCKED`, `APPROVED`, `PUBLISHED`) | none | — | — | — | 409 `marks locked` |

**Audit-key binding (Finding 2, authoritative — each write path maps to EXACTLY
one key):**
- `PUT …/marks` first write of a record ⇒ audit `exams.marks.entered` (SUCCESS),
  history `MARKED`.
- `PUT …/marks` later edit of an already-existing record (still `MARKS_OPEN`) ⇒
  audit `exams.marks.corrected` (SUCCESS), history `CORRECTED`.
- `POST …/marks/:recordId/correct` (MODERATION) ⇒ audit `exams.marks.corrected`
  (SUCCESS, metadata `{ reason }`), history `CORRECTED`.
- out-of-scope write on `PUT …/marks` ⇒ audit `exams.marks.entered` result
  `DENIED` (no row written, no history).

"First write vs later edit" is decided by whether a `marks_records` row already
exists for `(assessmentId, candidateId)` (its hard unique key): absent ⇒ INSERT +
`entered`/`MARKED`; present ⇒ UPDATE + `corrected`/`CORRECTED`. This pins the most
sensitive post-lock write (`exams.marks.corrected`) to its own key so the audit
trail distinguishes an initial entry from every correction.

So: `PUT …/marks` is accepted ONLY in `MARKS_OPEN` (409 in every other status,
including `MODERATION`); the moderator correction route
`POST …/marks/:recordId/correct` is accepted ONLY in `MODERATION` (409
otherwise). This removes the §12↔§16 conflict: a MODERATION-time correction uses
the DISTINCT correction route, never `PUT …/marks`. Both paths write a
`marks_record_history` row (the only correction mechanism — mirrors attendance's
approved-correction → history-row idiom) and exactly one audit event per the
binding above; no silent overwrite ever occurs. Every write re-validates
`0 ≤ marks ≤ maxMarks` and (for the FACULTY path) the FacultyAssignment scope.

**Invariant ownership (NFR-2):**
- *Tenant isolation* — owned by the DB (RLS + composite FKs). Rationale:
  fail-closed, defense independent of app bugs (tenant-escape suite proves it).
- *Row immutability / forward-only lifecycle* — owned by the DB
  (column-guard/append-only triggers). Rationale: binds even the table owner;
  app code cannot bypass.
- *`marks ≤ maxMarks`* — owned by the SERVICE layer (cross-table), with a DB CHECK
  `marks >= 0` as the lower bound. Rationale: a single-row CHECK cannot reference
  another table's `maxMarks`; the service validates on every write inside the tx.
- *Weight-sum = 100 per `(exam, subject)`* — owned by the SERVICE layer
  (multi-row), DB CHECK bounds each `weight` to `1..100`. Rationale: cross-row sum
  is not a single-row CHECK; recomputed in-tx on every assessment write.
- *Marks-entry scope* — owned by the SERVICE layer (derived from
  `FacultyAssignment`), because it depends on the authenticated actor + runtime
  enrolment, not a static row property.
- *Result visibility (published-only for students)* — owned by BOTH the query
  layer (filter to max-version PUBLISHED) AND permission
  (`exams.results.view_own` vs `exams.results.view`). Rationale: defense in depth
  on access-critical data.
- *Candidate single allocation (one schedule per candidate)* — owned by the
  SERVICE layer (Finding 4). Each candidate has exactly ONE `candidates` row per
  `(exam, student)` (the hard `(examId, studentId)` unique), and its nullable
  `examScheduleId` is set ONCE under the allocation advisory lock (§13);
  re-allocation to a different schedule is OUT OF 8.1 scope (an
  already-allocated-elsewhere candidate ⇒ 409). There is deliberately NO DB
  constraint on `(examId, candidateId)` across schedules because a candidate only
  ever occupies one row. The partial-unique index
  `candidates_schedule_seat_unique` backstops ONLY double-seating within a room
  (`(institutionId, examScheduleId, seatNo)`), NOT one-schedule-per-candidate —
  the latter is a service invariant enforced by the under-lock check in §13.

---

## 13. Room-allocation concurrency idiom (mirrored from library copy-issue)

Exact mechanism (named): **transaction-scoped PostgreSQL advisory lock
(`pg_advisory_xact_lock(hashtextextended(key, 0))`) keyed on the tenant-qualified
schedule, a conditional occupancy count under the lock, plus a hard partial-unique
backstop** — identical to `library.ts` `lockStudent` + the
`library_loans_one_active_per_copy` partial unique.

**Request shape (MEDIUM-4).** `POST /api/exams/:id/schedules/:scheduleId/allocate`
body = `{ candidateIds: string[] }` (1..N candidate ids, all must belong to this
exam + tenant). `seatNo` is **server-assigned sequentially under the advisory
lock** — the client never supplies seat numbers. Rationale: server assignment
makes the capacity count authoritative (no client race on seat numbers) and makes
the partial-unique backstop automatic. A candidate already allocated to a DIFFERENT
schedule for this exam is rejected 409 `already allocated` (re-allocation is NOT
in 8.1 scope — an allocated candidate must stay put; this keeps the op purely
additive). A candidate already on THIS schedule is a no-op (idempotent re-send).

Allocation op (inside one `withTenant` tx):
1. `pg_advisory_xact_lock(hashtextextended(${institutionId}:${scheduleId}, 0))`
   (the exact library `lockStudent` idiom; two tenants hashing the same
   scheduleId never contend).
2. Load `exam_schedules.roomCapacity`; `occupied = count(candidates WHERE
   examScheduleId = scheduleId AND institutionId)`; `requested =
   candidateIds.length` (minus any already on this schedule). If
   `occupied + requested > roomCapacity` ⇒ 409 `room full` + `DENIED` audit (no
   rows written).
3. Assign seats by INTEGER ordinal computed in app code — never a lexical
   `MAX()` over the `TEXT` `seatNo` column (MEDIUM-5). Under the advisory lock the
   occupancy `occupied` is already counted in step 2; because re-allocation is out
   of scope (allocations are purely additive and gap-free — no candidate is ever
   removed from a schedule in 8.1), the live seats are exactly ordinals
   `1..occupied`. So the requested candidates receive the next contiguous integer
   ordinals `occupied + 1, occupied + 2, …`, each stored as its decimal string
   (`seatNo = String(nextOrdinal)`). The ordinal is computed as a JS/SQL integer,
   so seat 10 follows seat 9 correctly (a lexical `'9' + 1 = '10'` collision can
   never arise, which previously broke any room of capacity ≥ 10). The advisory
   lock makes count-then-assign atomic; the partial-unique index
   `candidates_schedule_seat_unique` is the hard backstop. (A future slice that
   adds de-allocation would switch to an explicit integer `seatOrdinal` column
   with its own partial unique; 8.1 does not need it because seats are gap-free.)

**Hard backstop:** a partial unique index enforcing seat uniqueness per schedule —
`CREATE UNIQUE INDEX "candidates_schedule_seat_unique" ON "candidates"
("institutionId","examScheduleId","seatNo") WHERE "examScheduleId" IS NOT NULL AND
"seatNo" IS NOT NULL;` (Prisma cannot express a partial unique — raw SQL in the
migration, the library/fees precedent). Capacity itself is enforced by the
count-under-lock (a capacity cap is not a unique constraint); the partial unique
prevents double-seating within a room. The advisory lock makes the
count-then-write atomic so two concurrent allocations cannot both pass the
capacity check.

---

## 14. RBAC catalogue additions

### 14.1 New `exams.*` permission keys (`packages/shared/src/permissions.ts`)

The `module` column uses the registry key `examinations` (NIT-3) for consistency
with the `requireModuleActive("examinations")` gate; the `exams.*` prefix stays on
the permission KEY only. (catalogue-sync does not validate the `module` field, so
this is a cosmetic-but-consistent choice, not a correctness requirement.)

| key | module | bound roles | notes |
|---|---|---|---|
| `exams.manage` | `examinations` | ADMIN, HOD | create/update examinations, schedules, assessments; status advance (setup lifecycle up to APPROVED) |
| `exams.grading.manage` | `examinations` | ADMIN, HOD | create/update grading schemes + bands |
| `exams.candidates.manage` | `examinations` | ADMIN, HOD | register candidates; allocate rooms |
| `exams.marks.enter` | `examinations` | FACULTY | enter/edit own in-scope marks (scope enforced in service) |
| `exams.moderate` | `examinations` | ADMIN, HOD | lock marks, run moderation corrections, approve |
| `exams.results.publish` | `examinations` | ADMIN, HOD | publish (step-up-gated) |
| `exams.results.view` | `examinations` | ADMIN, HOD | staff read of unpublished + published results/reports |
| `exams.results.view_own` | `examinations` | STUDENT | student read of OWN latest PUBLISHED result only |

`ROLE_PERMISSIONS` edits: add the `exams.*` keys to `ADMIN` and `HOD`
(ADMIN gets all eight except nothing is removed; HOD gets
`exams.manage, exams.grading.manage, exams.candidates.manage, exams.moderate,
exams.results.publish, exams.results.view`), add `exams.marks.enter` to `FACULTY`,
and add `exams.results.view_own` to `STUDENT`. `ADMIN` does NOT receive
`exams.marks.enter` (separation of duties; §12). No new template role (D-D).

### 14.2 Migration seed (`20261206000000_phase8_exams_slice1`, section j)

The migration physically contains an `INSERT INTO "permissions" (...) VALUES ...
ON CONFLICT ("key") DO NOTHING` span listing the eight `exams.*` keys (the
catalogue-sync parser `extractPermissionKeys` reads the 2nd quoted literal of
each tuple as the key, so the tuple shape must match the fees slice-2 seed),
followed by the `role_permissions` span. **The `role_permissions` span MUST use
the verbatim form `INSERT INTO "role_permissions" (...) SELECT ... FROM (VALUES
(roleKey, permKey), ...) AS m("roleKey","permKey") JOIN "roles" r ... JOIN
"permissions" p ... ON CONFLICT DO NOTHING`** — the `extractRolePermissionPairs`
parser slices the block up to the LITERAL marker `AS m(`, so the
`AS m("roleKey","permKey")` alias is load-bearing (the parser's end-marker); the
exact `(roleKey, permKey)` pairs are those in §14.1. No new `roles` row (D-D — reuse ADMIN/HOD/FACULTY/STUDENT). The new dir is
added to `SEEDING_MIGRATION_DIRS` in `catalogue-sync.test.ts`, so the meta-test
unions it and asserts set-equality against `PERMISSION_KEYS`/`ROLE_PERMISSIONS`.

### 14.3 Audit action keys (`packages/shared/src/audit-actions.ts`)

New `exams.*` keys (NO migration mirror — validated only in `recordAuditEvent`,
the fees precedent):
`exams.examination.created`, `exams.examination.updated`,
`exams.examination.status_changed`, `exams.schedule.created`,
`exams.schedule.updated`, `exams.candidate.registered`,
`exams.candidate.allocated`, `exams.assessment.created`,
`exams.assessment.updated`, `exams.marks.entered`, `exams.marks.corrected`,
`exams.marks.locked`, `exams.moderation.opened`,
`exams.grading_scheme.created`, `exams.grading_scheme.updated`,
`exams.results.published`, `exams.results.exported`. `exams.marks.entered` is also
the key used for the `DENIED` out-of-scope audit (result `DENIED`).

The APPROVED transition (`MODERATION → APPROVED`) does NOT get its own key: it is
one status transition and is audited under `exams.examination.status_changed`
with `{ from: "MODERATION", to: "APPROVED" }` metadata, like every other
transition (NIT-6 — the earlier `exams.exam.approved` broke the
`exams.examination.*` family naming and is removed; the call site emits
`exams.examination.status_changed` verbatim). Audit keys are not
migration-mirrored (validated only in `recordAuditEvent`), so this is a naming
consistency fix, not a schema change.

---

## 15. Routes (`apps/api/src/routes/exams.ts`, registered `/api/exams`)

House pattern (mirrors fees/library/admissions): one top-level `authenticate`
preHandler; per-route `requirePermission(key)` AND
`requireModuleActive("examinations")`; publish additionally
`requireStepUp("exams.results.publish")`; every handler runs inside
`withTenant(institutionId, tx => ...)` with `institutionId` from `request.user`,
never from the body; audits via `recordAuditEvent`; deterministic well-typed JSON;
Zod validation on every input.

- `POST /exams` · `PATCH /exams/:id` · `GET /exams` · `GET /exams/:id` — setup
  (`exams.manage` / `exams.results.view`).
- `POST /exams/:id/status` — advance status (`exams.manage` for ≤APPROVED,
  `exams.moderate` for the lock/moderation/approve steps).
- `POST /exams/:id/schedules` · `GET /exams/:id/schedules` — schedules
  (`exams.manage`/`exams.results.view`).
- `POST /exams/:id/schedules/:scheduleId/allocate` — capacity-aware allocation
  (`exams.candidates.manage`, §13).
- `POST /exams/:id/candidates` (register, derive from enrolment) · `GET` —
  (`exams.candidates.manage`/`exams.results.view`).
- `POST /exams/:id/assessments` · `PATCH .../:assessmentId` · `GET` —
  (`exams.manage`; weight-sum=100 validated).
- `PUT /exams/:id/marks` (bulk upsert for in-scope rows; accepted ONLY while
  `MARKS_OPEN`, else 409) · `GET .../marks` — (`exams.marks.enter` for write with
  the `attendance-authz.ts` `resolveMarkingFaculty` + `assertFacultyAssigned`
  scope check, §12 Finding 1; `exams.results.view` for staff read). Audit key per
  row: first write ⇒ `exams.marks.entered`; later edit ⇒ `exams.marks.corrected`
  (§12 Finding 2).
- `POST /exams/:id/marks/:recordId/correct` — single audited correction (accepted
  ONLY while `MODERATION`, else 409; `reason` required) — (`exams.moderate`,
  ADMIN/HOD). Audit key `exams.marks.corrected` `{reason}`, history `CORRECTED`
  (§12 Finding 2). This is the moderation-correction route.
- `POST /grading-schemes` · `PATCH /grading-schemes/:id` · bands sub-routes · `GET`
  — (`exams.grading.manage`/`exams.results.view`).
- `POST /exams/:id/publish` — step-up-gated publish (`exams.results.publish`,
  §9/§10).
- `GET /exams/:id/results` (staff, all versions) · `GET /exams/:id/results.xlsx`
  (ExcelJS, mirror `admin.ts`) · `GET /exams/:id/results/distribution` ·
  `.../rollups` — (`exams.results.view`).
- `GET /me/results` · `GET /me/results/:examId` — student, latest PUBLISHED only
  (`exams.results.view_own`, §9/§10).

---

## 16. Error handling (concrete, per failing operation)

| Operation | Failure | Recoverable? | Caller receives | Logged |
|---|---|---|---|---|
| Any route, auth missing | `request.auth` unset (wiring bug) | fatal | 401 `Unauthorized` | error |
| Any route, permission | missing permission | recoverable | 403 `Forbidden: missing permission <k>` | info |
| Any route, module | `examinations` not ACTIVE | recoverable | 403 `Module not active: examinations` | info |
| Module state read | read throws | fatal | 500 `Module state unavailable` (fail CLOSED) | error |
| Publish, step-up | invalid/absent `x-step-up` | recoverable | 401 `Step-up required` | info |
| Zod validation | bad body/param | recoverable | 400 `{ error: flatten() }` | — |
| Marks write, not faculty | `resolveMarkingFaculty` → null (no/INACTIVE FacultyProfile) | recoverable | 403 "not a faculty member" + `DENIED` audit (`exams.marks.entered`, `{reason:"not_faculty"}`) | info + audit |
| Marks write, scope | `assertFacultyAssigned` → false | recoverable | 403 + `DENIED` audit (`exams.marks.entered`, `{reason:"out_of_scope"}`) | info + audit |
| `PUT …/marks` write (success) | — | — | 200; audit `exams.marks.entered` (first write) or `exams.marks.corrected` (later edit) | audit |
| `POST …/correct` (success) | — | — | 200; audit `exams.marks.corrected` `{reason}` | audit |
| Marks write, range | `marks < 0` or `> maxMarks` | recoverable | 400 `marks out of range` | — |
| `PUT …/marks`, status | exam not `MARKS_OPEN` | recoverable | 409 `marks locked` | info |
| `POST …/correct`, status | exam not `MODERATION` | recoverable | 409 `marks locked` | info |
| `POST …/correct` | missing `reason` | recoverable | 400 `reason required` | — |
| Assessment write | weights would not sum to 100 | recoverable | 400 `weights must sum to 100` | — |
| Allocation | `count + requested > roomCapacity` | recoverable | 409 `room full` + `DENIED` audit | info + audit |
| Allocation | candidate already on another schedule | recoverable | 409 `already allocated` | info |
| Allocation | double-seat (partial unique backstop) | recoverable | 409 `seat taken` | info |
| Status advance | illegal transition (optimistic where misses) | recoverable | 409 `illegal status transition` | info |
| Status advance | trigger raises (`restrict_violation`) | fatal | 409 mapped `illegal status transition` | error |
| Publish | exam not `APPROVED`/`PUBLISHED` | recoverable | 409 `exam not approved` | info |
| Publish | no single ACTIVE grading scheme | recoverable | 409 `no active grading scheme` | info |
| Grading engine | band gap / no match | fatal | 409 `grading misconfigured` (`GradingError`) | error |
| Candidate register | duplicate `(exam, student)` | recoverable | 409 `already a candidate` | info |
| Any append-only table | trigger raises on UPDATE/DELETE | fatal | 500/409 (should never happen via app) | error |

All DB `restrict_violation` errors are caught and mapped to a 409 with a typed
message; they are the backstop, not the primary path (the service validates
first). `withTenant` callbacks return normally (never `throw`) when they need an
audit to commit, mirroring the fees `deny()` idiom.

## 17. Input validation (per external input)

- `institutionId`/`userId` — NEVER from body/param; always from the verified
  token (`request.user`).
- `name` (exam/scheme/assessment) — required string, `1..200` chars (Zod +
  CHECK `char_length >= 1`).
- `type` — required enum `ExaminationType`.
- `academicSessionId`/`academicTermId`/`programId`/`subjectId`/`studentId`/
  `examScheduleId` — required cuid-shaped strings; existence + same-tenant
  enforced by composite FK (insert fails ⇒ 409) and in-handler lookup for a clean
  message.
- `maxMarks` — required int `> 0`.
- `weight` — required int `1..100`; ACTIVE set per `(exam, subject)` must sum to
  exactly 100 (service).
- `marks` — required int `0..maxMarks`.
- `roomCapacity` — required int `> 0`; `room` non-empty; `endsAt > startsAt`.
- `candidateIds` (allocate) — required non-empty array of cuid-shaped strings,
  each must belong to this exam + tenant (in-handler lookup). `seatNo` is NOT a
  client input — it is server-assigned sequentially under the advisory lock
  (§13). An already-allocated-elsewhere candidate ⇒ 409; already on this schedule
  ⇒ no-op.
- `minPercentBps`/`maxPercentBps` — int `0..10000`, `min ≤ max`, bands contiguous
  (`nextBand.minPercentBps = prevBand.maxPercentBps + 1`) + non-overlapping
  (service); `gradePoints` int `≥ 0` (GRADE_POINTS_SCALE=100); `isPassing`
  required boolean (monotonic non-decreasing up the band order); `gradeLabel`
  non-empty.
- `version`/`reason` — `reason` required when publishing a correction
  (`version > 1`).
- All failures ⇒ 400 with the Zod `flatten()` payload.

---

## 18. Migration workflow (NFR-4)

New dir `packages/db/prisma/migrations/20261206000000_phase8_exams_slice1/migration.sql`,
hand-authored in the frozen lettered a–j house style (header comment enumerating
the 14 frozen dirs it must not touch, the table-class split, and the ordering):

a. `CREATE TYPE` the four enums. The `ResultPublicationStatus` `CREATE TYPE`
   carries the inline comment pinning `SUPERSEDED` as reserved-for-8.2 /
   never-written-in-8.1 (Finding 3).
b. `CREATE TABLE` the nine tables + PKs (`createdAt DEFAULT CURRENT_TIMESTAMP`;
   `updatedAt NOT NULL` on the six mutable/column-guard tables; the three
   INSERT-only tables have no `updatedAt`).
c. `(id, institutionId)` uniques + business uniques + `(institutionId)`/query
   indexes + the raw-SQL partial unique `candidates_schedule_seat_unique` + the
   `(institutionId, examId, version)` unique.
d. tenant-root `institutionId → institutions(id)` RESTRICT on all nine.
e. composite same-tenant FKs incl. `institutionId` (§7.2).
f. CHECKs (§7.2, §17).
g. ENABLE+FORCE RLS — standard pair on the six mutable/column-guard tables;
   append-only SELECT + `<table>_tenant_insert` on the three INSERT-only.
h. triggers — `examinations_guard()` + `marks_records_guard()` column guards; the
   three `<table>_append_only()` + `BEFORE UPDATE OR DELETE` triggers.
i. guarded `campass_app` GRANT refresh (§7.5).
j. catalogue seed — the eight `exams.*` permissions + the role_permissions pairs
   (NO new role).

Then: `prisma migrate diff --from-schema-datasource` sanity-check (the known
composite-vs-single-FK cosmetic diff is expected; NO DROP on existing tables),
`prisma migrate deploy`, `prisma migrate status` must report up to date. The
Prisma models in `schema.prisma` are added for the nine tables (single-PK
relations) so the client is generated; the composite FKs/partial unique/RLS/
triggers/CHECKs live only in the migration (documented in the schema comment
block, the library/fees precedent).

---

## 19. Test plan (NFR-5)

**Fast / mocked (`npm test -w @campusgate/api`, must stay green — currently 454):**
- `services/exams/__tests__/grading.test.ts` — exhaustive engine unit tests
  (AC-8): integer basis-point band boundaries, integer half-up rounding + the
  explicit "naive `Math.round(89.995*100)===8999` NOT taken" assertion,
  weight-sum=100 assertion, zero marks, absent-mark-is-0, 0%/100% extremes,
  single-assessment subject, `passed = band.isPassing` (incl. a 0-point passing
  band), band-gap `GradingError`.
- `routes/__tests__/exams.test.ts` (mocked `@campusgate/db`) — route wiring:
  permission + module gating, step-up gating on publish (AC-6 fast portion),
  Zod 400s, marks range 400, weight-sum 400, status-advance 409, publish 409 when
  not approved / no active scheme.
- `services/__tests__/catalogue-sync.test.ts` — extended `SEEDING_MIGRATION_DIRS`
  (AC-9); asserts the eight `exams.*` keys + pairs set-equal
  `PERMISSION_KEYS`/`ROLE_PERMISSIONS`.

**Live-DB (`npm run test:integration`; each MUST pass IN ISOLATION — the
acceptance bar; added to `vitest.live-db-suites.ts`):**
- `routes/__tests__/exams-behavioral.integration.test.ts` — NEW suite:
  faculty-scope DENIED + 403 (AC-2), post-lock correction → history row (AC-3),
  capacity-aware allocation concurrency (AC-4), illegal status transitions raise
  (AC-5), publish step-up success/failure + un-enrolled path (AC-6, AC-7),
  correction = new version, no prior-row mutation (AC-11), student sees only
  latest PUBLISHED (AC-1).
- `routes/__tests__/tenant-escape.integration.test.ts` + its
  `helpers/tenant-escape-setup.ts` — EXTENDED: add all nine tables to
  `RLS_TABLES`; add the three INSERT-only tables to `EXPECTED_POLICIES`
  (`*_tenant_insert`); seed exam fixtures for both tenants in `seedBothTenants`;
  extend `cleanup` with the guard-trigger-disable teardown dance for
  `examinations` (`examinations_guard`), `marks_records` (`marks_records_guard`),
  and the three append-only tables (`*_no_update_delete`), exactly like the
  fees `slice2GuardedTables` + `payment_transactions`/`student_charges` dance.
  Prove read-escape + spoofed-insert-escape for each table (AC-10).

Clean up any temporary scaffolding; add the new suite glob to
`vitest.live-db-suites.ts`.

---

## 20. Integration points (named)

- `packages/db/src/index.ts` — `withTenant`, `prisma`, `privilegedPrisma` (used
  as-is).
- `apps/api/src/services/authz-engine.ts` — `requirePermission`,
  `requireModuleActive` (used as-is; gate = `"examinations"`).
- `apps/api/src/services/attendance-authz.ts` — **`resolveMarkingFaculty` +
  `assertFacultyAssigned` (used UNCHANGED)** as the marks-entry scope seam
  (Finding 1). `resolveMarkingFaculty` supplies the `FacultyProfile.status =
  'ACTIVE'` gate; `assertFacultyAssigned` supplies the ACTIVE
  `FacultyAssignment` subject/section/term check (with the subject-wide
  `classSectionId IS NULL` path). The exam marks service calls these rather than
  re-deriving the scope rule (§12).
- `apps/api/src/middleware/step-up.ts` — `requireStepUp("exams.results.publish")`
  (used UNCHANGED).
- `apps/api/src/services/mfa.ts` + `POST /api/auth/mfa/verify` — mints the
  step-up token (unchanged seam).
- `apps/api/src/services/audit.ts` — `recordAuditEvent` (new `exams.*` keys).
- `packages/shared/src/{permissions,audit-actions}.ts` — catalogue edits (§14).
  `packages/shared/src/modules.ts` is READ-ONLY this slice: the gate reuses the
  existing `examinations` key and its unchanged dependency edges (§6 D-E).
- `apps/api/src/routes/admin.ts` — ExcelJS export pattern to mirror for the result
  report.
- `apps/api/src/server.ts` — register `examsRoutes` at `/api/exams` (mirror the
  fees registration).

---

## 21. Assumptions (explicit)

- `Examination` scope is `(session, term, program)`; a single exam spans the
  program's subjects, with per-subject schedules/assessments. (Roadmap names the
  tables but not the scope columns; this mirrors how `ClassSection` is scoped.)
- Candidate section is resolved via `ClassEnrollment → ClassSection WHERE
  ClassSection.academicTermId = exam.academicTermId` (NIT-4 — `ClassEnrollment`
  has no term column). If a student has multiple sections for the term, the
  marks-scope check passes if the faculty is assigned to ANY of the candidate's
  sections for that subject (or holds a subject-wide assignment with
  `classSectionId IS NULL`). The scope check itself is NOT hand-rolled: it REUSES
  `resolveMarkingFaculty` (which requires `FacultyProfile.status = 'ACTIVE'`, so a
  deactivated teacher with a stale ACTIVE assignment is rejected) +
  `assertFacultyAssigned` from `attendance-authz.ts` (Finding 1, §12/§20).
- Grade band edges are stored in BASIS POINTS (`minPercentBps`/`maxPercentBps`,
  0..10000) — the SAME unit as the computed `percentBps` — so banding is a pure
  integer comparison with no float at the boundary (MEDIUM-2). Basis points give
  2-dp band edges for free (e.g. an edge at 89.50% is `8950`); sub-0.01% edges
  are out of scope.
- "Scope" for a `ResultPublication` is the whole `Examination` (per exam+version);
  finer per-program/section publication scopes are not needed in 8.1 because an
  Examination is already program-scoped.

These assumptions are internally consistent with the roadmap and the real schema;
the design review will catch any that do not hold.

---

## 22. Responses to design review (`design-review.json`, verdict CHANGES_REQUESTED)

Every finding verified against the real files before acting. All are ADDRESSED
(none backlogged or ignored); each choice aligns with the brief + requirements.

- **HIGH-1 (module dep graph breaks tests) — ADDRESSED.** Verified in
  `packages/shared/src/modules.ts` that `examinations` is the sole multi-dep
  exemplar, and in `services/__tests__/modules.test.ts` (2 cases) +
  `services/__tests__/module-system.integration.test.ts` (5+ cases) that its
  three edges are asserted verbatim. Adopted the reviewer's recommended fix (a):
  **`MODULE_DEPENDENCIES.examinations` is left UNCHANGED** at
  `["academic_sessions","class_course","student_enrollment"]`; routes are gated by
  `requireModuleActive("examinations")` only. D-E rewritten with the "the
  rationale does not transfer (exams' prereqs are themselves gated modules)"
  reasoning; NFR-5 / §20 updated so `modules.ts` is read-only this slice.

- **HIGH-2 (float rounding contradicts determinism) — ADDRESSED.** D-B + §11
  rewritten to integer/`BigInt`-only arithmetic: accumulate `(m * weight * 1e6) /
  maxMarks` in `BigInt`, half-up once via `(num + 5000n) / 10000n` to
  `percentBps`. `Math.round(pct*100)` explicitly REJECTED with the IEEE-754
  explanation; a unit test asserts the naive float path is not taken.

- **MEDIUM-1 (pass/fail stated two ways) — ADDRESSED.** Added
  `grade_bands.isPassing BOOLEAN NOT NULL`; `passed = band.isPassing`; deleted the
  `gradePoints > 0` heuristic; scheme-save validates `isPassing` is monotonic up
  the band order.

- **MEDIUM-2 (float vs integer band edges) — ADDRESSED.** `grade_bands` edges are
  now `minPercentBps`/`maxPercentBps` (0..10000), banded with the pure-integer
  predicate `minPercentBps ≤ percentBps ≤ maxPercentBps`; contiguity redefined as
  `nextBand.minPercentBps = prevBand.maxPercentBps + 1`. §21 assumption updated.

- **MEDIUM-3 (marks write vs correction matrix) — ADDRESSED.** §12 now carries an
  authoritative status × route matrix: `MARKS_OPEN` → `PUT …/marks` (FACULTY,
  in-scope); `MODERATION` → new `POST …/marks/:recordId/correct` (`exams.moderate`,
  reason required); all other statuses → 409. The correction route is added to
  §15 and the 409/400 rows to §16; the §12↔§16 conflict is resolved.

- **MEDIUM-4 (allocation shape) — ADDRESSED.** §13 now defines the body
  `{ candidateIds: string[] }`, server-assigned sequential `seatNo` under the
  advisory lock, and the already-allocated-elsewhere → 409 / already-here → no-op
  semantics. §17 + §16 updated.

- **NIT-1 — ADDRESSED.** Enum renamed to `{ MARKED, CORRECTED }` (value-identical
  to the real `AttendanceRecordHistoryChangeType`); the "initial row" comment and
  history narrative updated.

- **NIT-2 — ADDRESSED.** §14.2 states verbatim that the `role_permissions` span
  must use `FROM (VALUES …) AS m("roleKey","permKey")` because the
  `extractRolePermissionPairs` end-marker is the literal `AS m(`.

- **NIT-3 — ADDRESSED.** Permission-row `module` column set to `examinations`
  (with a note that the field is not validated by catalogue-sync).

- **NIT-4 — ADDRESSED.** §12 + §21 state the join path
  `ClassEnrollment → ClassSection WHERE ClassSection.academicTermId =
  exam.academicTermId` (verified: `ClassEnrollment` has no `academicTermId`).

- **NIT-5 — ADDRESSED.** `GRADE_POINTS_SCALE = 100` pinned in the `grade_bands` /
  `result_snapshots` column comments and as the shared engine constant.

- **MEDIUM-5 (lexical `max(seatNo)+1` over a TEXT column) — ADDRESSED.** Verified
  the library idiom in `apps/api/src/routes/library.ts` (`lockStudent` =
  `pg_advisory_xact_lock(hashtextextended(key,0))` + a conditional count/claim
  under the lock, no lexical ordinal math). §13 step 3 no longer emits any
  `MAX()` over the `TEXT` `seatNo`. Under the advisory lock the occupancy
  `occupied` is already counted (step 2); because 8.1 allocation is purely
  additive and gap-free (no de-allocation — out of scope), live seats are exactly
  ordinals `1..occupied`, so the next integer ordinals are `occupied + 1, …`,
  computed as integers in app code and stored as their decimal strings
  (`seatNo = String(nextOrdinal)`). Seat 10 now correctly follows seat 9; the
  partial-unique `candidates_schedule_seat_unique` remains the hard backstop. The
  design notes that a future de-allocation feature would switch to an explicit
  integer `seatOrdinal` column — 8.1 does not need it.

- **NIT-6 (`exams.exam.approved` breaks the `exams.examination.*` family) —
  ADDRESSED.** Removed `exams.exam.approved` from §14.3. The `MODERATION →
  APPROVED` transition is audited under the existing
  `exams.examination.status_changed` key (one status transition like every
  other), keeping the `exams.examination.*` family consistent. The call site
  emits `exams.examination.status_changed` verbatim. Audit keys are validated
  only in `recordAuditEvent` (not migration-mirrored), so this is a naming fix
  with no schema impact.

---

### Round 2 (second `design-review.json`, verdict CHANGES_REQUESTED): 2 MEDIUM + 2 NIT — all ADDRESSED

Every Round-2 finding was verified against the real source before acting
(`apps/api/src/services/attendance-authz.ts` opened and confirmed). All ADDRESSED;
none backlogged or ignored. Each change aligns with the brief (reuse-don't-reinvent;
access-and-correctness-critical) and the requirements.

- **Finding 1 [MEDIUM] — marks-scope omitted the `FacultyProfile.status='ACTIVE'`
  gate — ADDRESSED.** Verified the proven helper
  `apps/api/src/services/attendance-authz.ts`: `resolveMarkingFaculty` resolves the
  caller's `FacultyProfile` with `status: "ACTIVE"` (null ⇒ reject), and
  `assertFacultyAssigned` does the ACTIVE `FacultyAssignment` subject/section/term
  check with the `OR:[{classSectionId},{classSectionId:null}]` subject-wide path and
  a `scheduled.facultyId === facultyId` fast path. §12 rewritten to REUSE both
  helpers VERBATIM (not a hand-rolled derivation): step 1 `resolveMarkingFaculty`
  (the `status='ACTIVE'` gate — a deactivated teacher with a stale ACTIVE assignment
  is now rejected, closing the access-control hole), step 2 `assertFacultyAssigned`
  with `facultyId: ""` sentinel to force the general path (no ScheduledClass fast
  path exists for exams). §20 now NAMES `attendance-authz.ts` as a reused
  (unchanged) seam; §21 updated. The two DENIED cases are distinguished
  (`not_faculty` vs `out_of_scope`), both audited `exams.marks.entered`/`DENIED`.

- **Finding 2 [MEDIUM] — moderation-correction audit key unspecified — ADDRESSED.**
  §12's status × route matrix gained an explicit "Audit action key (result)" column
  and an authoritative binding list: `PUT …/marks` FIRST write ⇒
  `exams.marks.entered` + history `MARKED`; `PUT …/marks` later edit (MARKS_OPEN) ⇒
  `exams.marks.corrected` + history `CORRECTED`; `POST …/marks/:recordId/correct`
  (MODERATION) ⇒ `exams.marks.corrected` `{reason}` + history `CORRECTED`;
  out-of-scope ⇒ `exams.marks.entered`/`DENIED`. First-vs-edit is decided by whether
  a `marks_records` row already exists for `(assessmentId, candidateId)`. §16 gained
  explicit success rows for both write paths. Each write path now maps to exactly
  one key.

- **Finding 3 [NIT] — `ResultPublicationStatus.SUPERSEDED` is a dead value in 8.1 —
  ADDRESSED.** The enum in §7.1, the §10 narrative, and the §18(a) migration step now
  state that 8.1 writes `PUBLISHED` only, `SUPERSEDED` is reserved for 8.2 and MUST
  NOT be written by any 8.1 path, and "superseded" is derived as
  `version < max(version)`. The `CREATE TYPE` carries the inline comment so an
  implementer is not tempted to write it (the append-only trigger would reject it on
  prior rows). Variant retained (not deferred) so 8.2 stays purely additive.

- **Finding 4 [NIT] — one-schedule-per-candidate is app-owned, missing from the
  invariant list — ADDRESSED.** Added a §12 invariant-ownership bullet: candidate
  single-allocation is SERVICE-owned (the candidate row's `examScheduleId` set once
  under the allocation advisory lock; re-allocation out of 8.1 scope; already-
  allocated-elsewhere ⇒ 409). Stated explicitly that `candidates_schedule_seat_unique`
  backstops ONLY double-seating within a room, NOT one-schedule-per-candidate.
