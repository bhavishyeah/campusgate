# Design Review — CAMPASS Phase 8 Examinations, Slice 8.1 (Round 3)

Scope: `c:\campusgate\.agents\tasks\phase8-exams-slice1\design.md`, reviewed fresh
and verified against the real repo at `c:\campusgate`. This is a REVISION: a prior
`design-review.json` (Round 2, verdict CHANGES_REQUESTED, 2 MEDIUM + 2 NIT) exists
and the design's §22 claims all four are addressed. Per the revision protocol each
prior finding is re-checked against the new design and the real source, then the
changed design is reviewed for new problems.

Access-and-correctness-critical code: RBAC bindings, RLS/trigger integrity, the
grading engine, and publication gating were checked against source, not taken on
the design's word.

---

## Prior findings re-check (Round 2 → Round 3)

- **Round-2 Finding 1 [MEDIUM] — marks-scope omitted the `FacultyProfile.status='ACTIVE'`
  gate → CLOSED.** Verified `apps/api/src/services/attendance-authz.ts`:
  `resolveMarkingFaculty` filters `status: "ACTIVE"` and returns `null` otherwise;
  `assertFacultyAssigned` has the `scheduled.facultyId === facultyId` fast path plus
  the general `OR:[{classSectionId},{classSectionId:null}]` path. The design §12/§20/§21
  now reuse BOTH verbatim and pass the `facultyId: ""` sentinel in `scheduled` so the
  fast path can never short-circuit (`"" === <cuid>` is false). The deactivated-teacher
  hole is closed by step 1.

- **Round-2 Finding 2 [MEDIUM] — moderation-correction audit key unspecified → CLOSED.**
  §12's status × route matrix + the authoritative binding list pin each write path to
  exactly one key: `PUT …/marks` first write ⇒ `exams.marks.entered`/`MARKED`; `PUT …/marks`
  later edit (MARKS_OPEN) ⇒ `exams.marks.corrected`/`CORRECTED`; `POST …/marks/:recordId/correct`
  (MODERATION) ⇒ `exams.marks.corrected {reason}`/`CORRECTED`; out-of-scope ⇒
  `exams.marks.entered`/DENIED. First-vs-edit decided by existence of the
  `(assessmentId, candidateId)` row. §16 carries matching rows.

- **Round-2 Finding 3 [NIT] — `ResultPublicationStatus.SUPERSEDED` dead value → CLOSED.**
  §7.1 enum comment, §10 narrative, and §18(a) migration step all state 8.1 writes
  `PUBLISHED` only, `SUPERSEDED` reserved for 8.2 / never written in 8.1, "superseded"
  derived as `version < max(version)`; the `CREATE TYPE` carries the inline comment.

- **Round-2 Finding 4 [NIT] — one-schedule-per-candidate ownership unlisted → CLOSED.**
  §12 invariant-ownership list now states candidate single-allocation is SERVICE-owned
  (`examScheduleId` set once under the advisory lock; re-allocation out of 8.1 scope;
  already-allocated-elsewhere ⇒ 409) and that `candidates_schedule_seat_unique`
  backstops only double-seating within a room.

All four prior findings are Closed and consistent with the real source.

---

## New findings (this round)

### 1. [MEDIUM] `§14.1` ADMIN role binding is internally contradictory ("all eight" vs the table vs the next clause)

**Where:** §14.1, `ROLE_PERMISSIONS` edits paragraph.

**Problem.** The paragraph says "add the `exams.*` keys to ADMIN and HOD (**ADMIN gets
all eight** except nothing is removed; HOD gets [six keys])… add `exams.marks.enter`
to FACULTY, and add `exams.results.view_own` to STUDENT. **ADMIN does NOT receive
`exams.marks.enter`**." "All eight" directly contradicts (a) the §14.1 table, which
binds `exams.marks.enter` to FACULTY only and `exams.results.view_own` to STUDENT only,
and (b) the very next clause and the §12 separation-of-duties invariant ("ADMIN/HOD are
NOT granted `exams.marks.enter`"). This is RBAC on access-critical code, and the
catalogue-sync meta-test asserts EXACT set-equality between `ROLE_PERMISSIONS` and the
migration's `role_permissions` seed pairs (`catalogue-sync.test.ts`,
"(roleKey, permissionKey) pairs (union) equal ROLE_PERMISSIONS"). An implementer who
follows "all eight" literally would bind ADMIN to `exams.marks.enter` (violating the
stated separation of duties) and to `exams.results.view_own` (a STUDENT-only read),
and must mirror those exact pairs into the seed or the test turns red.

**Fix.** Delete the phrase "ADMIN gets all eight" and state the exact ADMIN set that
matches the table and §12: ADMIN is bound to the six keys `exams.manage`,
`exams.grading.manage`, `exams.candidates.manage`, `exams.moderate`,
`exams.results.publish`, `exams.results.view` (NOT `exams.marks.enter`, NOT
`exams.results.view_own`). HOD gets the same six. FACULTY gets `exams.marks.enter`.
STUDENT gets `exams.results.view_own`. The §14.2 `role_permissions` VALUES list must
contain exactly these 6 ADMIN + 6 HOD + 1 FACULTY + 1 STUDENT = 14 pairs.

### 2. [NIT] `§14.3` declares audit keys `exams.marks.locked` and `exams.moderation.opened` that no documented code path emits

**Where:** §14.3 (audit keys) vs §12 status × route matrix / §14.3 `status_changed` rule.

**Problem.** §14.3 removed `exams.exam.approved` on the explicit rationale that a status
transition is audited under `exams.examination.status_changed` with `{from,to}` metadata
"like every other transition." But §14.3 still declares `exams.marks.locked`
(MARKS_OPEN → MARKS_LOCKED) and `exams.moderation.opened` (MARKS_LOCKED → MODERATION),
which are themselves status transitions. Per the stated rule they would be emitted as
`exams.examination.status_changed`, leaving these two keys declared-but-unused — the same
dead-value shape the design just fixed for `SUPERSEDED` and `exams.exam.approved`. Audit
keys are validated only in `recordAuditEvent` (not migration-mirrored), so an unused key
is harmless at runtime, but it is a self-inconsistency in an access-critical audit spec.

**Fix.** Either (a) delete `exams.marks.locked` + `exams.moderation.opened` and state
that the lock and moderation-open transitions are audited under
`exams.examination.status_changed` `{from,to}` like all others (consistent with the
NIT-6 decision); or (b) keep them and state explicitly that the MARKS_OPEN→MARKS_LOCKED
and MARKS_LOCKED→MODERATION transitions emit these dedicated keys INSTEAD of
`status_changed`, and reconcile that exception with the §14.3 "every other transition
uses status_changed" sentence.

### 3. [NIT] `§19` tenant-escape extension omits the `SeededTenant` interface and `countRemainingTestRows` additions

**Where:** §19 (test plan, tenant-escape bullet) vs `helpers/tenant-escape-setup.ts`.

**Problem.** §19 says to add the nine tables to `RLS_TABLES`, the three INSERT-only
tables to `EXPECTED_POLICIES`, seed fixtures in `seedBothTenants`, and extend `cleanup`
with the guard-disable dance. Verified against the real helper: adding a seeded table to
this suite also requires extending the exported `SeededTenant` interface (every seeded id
is a typed field), returning the new ids from `seedTenant`, and extending
`countRemainingTestRows` (the teardown assertion that total remaining test rows == 0).
§19 names `seedBothTenants`/`cleanup`/`RLS_TABLES`/`EXPECTED_POLICIES` but not
`SeededTenant` or `countRemainingTestRows`, so the "extend the suite for EVERY new table"
requirement is under-specified for those two spots.

**Fix.** Add to §19: "extend the `SeededTenant` interface + `seedTenant` return with the
new exam-table ids, and add the six seeded mutable/guarded exam tables to
`countRemainingTestRows` (the three INSERT-only tables are excluded from the generic
seed/count loop, mirroring `payment_allocations`/`receipts`/`processed_webhook_events`)."

---

## Verified assumptions (checked against real source)

1. **`examinations` is a real `ModuleKey` with deps `["academic_sessions","class_course","student_enrollment"]`.**
   Confirmed in `packages/shared/src/modules.ts`. D-E's decision to leave
   `MODULE_DEPENDENCIES` unchanged is correct; `requireModuleActive("examinations")`
   type-checks against `ModuleKey`. The D-E claim that `fees`/`attendance`/`admissions`
   were re-pointed to `[]` on a foundational-data rationale is confirmed by the comments
   in `modules.ts`. The claim that re-pointing `examinations` would break the
   `modules.test.ts` / `module-system.integration.test.ts` exemplar is plausible and the
   safe choice either way.

2. **Marks-scope helpers.** `resolveMarkingFaculty` (ACTIVE `FacultyProfile` gate) and
   `assertFacultyAssigned` (ACTIVE `FacultyAssignment` on subject+term+section, with the
   subject-wide `classSectionId IS NULL` path and the `scheduled.facultyId === facultyId`
   fast path) exist verbatim in `apps/api/src/services/attendance-authz.ts`. The
   `facultyId: ""` sentinel correctly bypasses the fast path.

3. **`ClassEnrollment` has no `academicTermId`; the term lives on `ClassSection.academicTermId`.**
   Confirmed in `schema.prisma` (NIT-4 join path is correct).

4. **Composite-FK anchors exist.** `student_profiles`, `programs`, `subjects`,
   `academic_terms`, `academic_sessions` all carry `@@unique([id, institutionId])`, so the
   design's composite same-tenant FKs are expressible (library/fees precedent).

5. **House migration style** (lettered a–j; `CREATE TYPE`; composite FKs
   `("institutionId","id")` RESTRICT/CASCADE; `nullif(current_setting('app.current_institution_id', true),'')`
   fail-closed RLS pair; `<table>_append_only()` + `BEFORE UPDATE OR DELETE` triggers;
   column-guard `IS DISTINCT FROM` + forward-only `restrict_violation`; guarded idempotent
   `campass_app` GRANT refresh, never BYPASSRLS; catalogue seed shapes) matches
   `20261129000000_phase7_fees_slice2/migration.sql` exactly. The `examinations_guard`,
   `marks_records_guard`, and append-only triggers in §8 are faithful mirrors of
   `refunds_guard` / `student_charges_guard` / `*_append_only`.

6. **Catalogue-sync parser markers.** `extractPermissionKeys` slices
   `INSERT INTO "permissions"` → `ON CONFLICT` and reads the 2nd quoted literal as the key;
   `extractRolePermissionPairs` slices `INSERT INTO "role_permissions"` → `AS m(`. The
   design §14.2's insistence on the verbatim `… FROM (VALUES (roleKey, permKey), …) AS m("roleKey","permKey") …`
   shape and adding the dir to `SEEDING_MIGRATION_DIRS` is correct and load-bearing.
   (Note for the implementer, not a finding: the real seed's `role_permissions` join also
   requires `JOIN "roles" r ON r."key" = m."roleKey" AND r."institutionId" IS NULL` to bind
   the template roles — follow the verbatim fees form.)

7. **Step-up seam.** `requireStepUp(actionClass)` in `middleware/step-up.ts` checks the
   `x-step-up` JWT (signature/expiry, `userId` match, `stepUp===true`, `action===actionClass`)
   and returns 401 `{error:"Step-up required"}` on any failure; `mintStepUpToken` is minted
   only after a fresh MFA assertion in `/api/auth/mfa/verify`. The design §9 reuse (including
   the un-enrolled "cannot obtain a token ⇒ publish unreachable" framing in AC-7) is accurate.

8. **Publish preHandler ordering.** The design §9's claimed "exact fees-refund ordering"
   `[requirePermission, requireStepUp, requireModuleActive]` matches `routes/fees.ts` refund
   and adjust routes verbatim.

9. **`AttendanceRecordHistoryChangeType = { MARKED, CORRECTED }`** and the
   `attendance_record_history` row shape (`previousStatus` null for the initial MARKED row,
   `actorUserId`, `actorMembershipId`) confirmed in `schema.prisma`; the design's
   `MarksRecordHistoryChangeType` and `marks_record_history` are value-/shape-faithful mirrors.

10. **Library allocation idiom.** `library.ts` `lockStudent` uses
    `pg_advisory_xact_lock(hashtextextended(${institutionId}:${studentId}, 0))` + a conditional
    claim under the lock + partial-unique backstop, with DENIED audits written from a
    normally-returning `withTenant` callback. The design §13 room-allocation mirror (incl.
    the integer-ordinal seat assignment, no lexical `MAX(seatNo)`) and §10 publish advisory
    lock are faithful (MEDIUM-5 from an earlier round stays closed).

11. **Tenant-escape policy model.** `EXPECTED_POLICIES` lists only append-only tables with
    `{tenant_isolation_select, <table>_tenant_insert}`; mutable/column-guard tables fall
    through to `DEFAULT_POLICIES = {tenant_isolation_select, tenant_isolation_modify}`. The
    design §7.4 class split (3 INSERT-only → EXPECTED_POLICIES; 6 mutable/guard → DEFAULT)
    matches the `payment_transactions`/`refunds` precedent.

---

## Unverified / wrong assumptions

- **Wrong (Finding 1):** the §14.1 claim "ADMIN gets all eight" is wrong against the
  §14.1 table and §12; ADMIN is bound to six keys.
- **Unverified (not blocking):** the design asserts re-pointing `examinations` deps would
  break "≥2 fast cases and ≥5 integration cases" in `modules.test.ts` /
  `module-system.integration.test.ts`. The exemplar-key reasoning is sound and the design
  correctly makes NO edit to `modules.ts`, so the exact case count was not independently
  recounted — immaterial to the decision (leaving the file untouched is safe regardless).
- **Unverified (not blocking):** `admin.ts` ExcelJS export pattern (§10/§15 results.xlsx)
  was not opened; it is a read-only report mirror with no correctness bearing on schema,
  RLS, grading, or publication.

---

## Verdict

HIGH: 0 · MEDIUM: 1 · NIT: 2 → **CHANGES_REQUESTED** (mechanical: MEDIUM+HIGH > 0).

Finding 1 is the only blocker: an unambiguous, non-self-contradictory ADMIN RBAC binding
is required before implementation because the catalogue-sync meta-test enforces exact
set-equality and the separation-of-duties invariant depends on ADMIN not holding
`exams.marks.enter`. Findings 2 and 3 are NITs that do not block but should be folded in.
