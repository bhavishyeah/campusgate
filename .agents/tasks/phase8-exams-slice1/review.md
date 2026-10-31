# Phase 8 Examinations Slice 8.1 (backend) — semantic review

Slice 8.1 lands the exam DB foundation plus the full backend lifecycle: ten tenant-owned exam tables behind ENABLE+FORCE RLS, a hand-authored lettered a–j migration, the `exams.*` RBAC catalogue, a pure integer grading engine, and the `/api/exams` route surface (setup, capacity-aware allocation, faculty-scoped marks entry with audited corrections, moderation/approval, step-up-gated append-only versioned publication, and published-only student reads). The work is two commits on `main` (`9d4df52` feature, `beb0b52` tests) over the `e113810` Phase-7 baseline. It follows the proven house patterns: `institutionId` + composite same-tenant FKs on every table, nullif-guarded fail-closed policies, forward-only column guards, append-only triggers, `withTenant` on every handler, and `requireModuleActive("examinations")` layered on `requirePermission`.

Watch for: nothing blocking. All three hard MUST-FIX items are satisfied (confirmed against the real files), the 14 frozen migration dirs are byte-untouched, `modules.ts` is unedited (the `examinations` dependency graph is preserved per D-E), and the recorded verification is green (fast 484/48; tenant-escape 82/1 with teardown total 0; exams-behavioral 7/1; migrate status up to date at 15 migrations).

**Verdict**: APPROVED

## High-level view

The RBAC binding (MUST-FIX 1) is exact in both `packages/shared` and the migration seed: ADMIN and HOD each get the same six management keys, FACULTY gets `exams.marks.enter` only, STUDENT gets `exams.results.view_own` only — 14 pairs, with ADMIN never granted marks entry or the student-only read. The catalogue-sync set-equality test is the self-enforcing backstop and is recorded green.

Audit keys (MUST-FIX 2) collapse every lifecycle transition onto the single `exams.examination.status_changed` key with `{from,to}` metadata; the `exams.marks.locked` and `exams.moderation.opened` keys do not exist in the shared list, so there are no dead keys.

The tenant-escape harness (MUST-FIX 3) extends `SeededTenant` with a typed id per newly-seeded exam table, returns them from `seedTenant`, seeds the seven mutable/column-guard tables in child-safe FK order, adds those seven to `countRemainingTestRows`, and excludes the three INSERT-only tables from the generic seed/count loop (the payment_allocations precedent). All ten exam tables are in `RLS_TABLES`; the three INSERT-only tables are in `EXPECTED_POLICIES`; the suite proves read-escape, spoofed-insert, foreign-parent FK, buggy-query backstop, three-GUC fail-closed, the two column guards, and a self-contained append-only case.

The grading engine is pure integer/BigInt with a single round-half-up step, `isPassing`-authoritative banding, weight-sum=100 re-asserted, and a typed `GradingError` on no-match — no float touches the computation or a band boundary. The route layer enforces marks scope from `FacultyAssignment` reusing the attendance-authz helpers verbatim, including the `FacultyProfile.status='ACTIVE'` deactivation gate, and makes publication step-up-gated with append-only versioning and published-only student visibility at both the query and permission layers.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking action items. Every MUST-FIX and task requirement verified against the real files is satisfied.

</details>

<details>
<summary>Details</summary>

### MUST-FIX 1 — RBAC binding is exact (confirmed)

`packages/shared/src/permissions.ts` catalogues eight `exams.*` PermissionDefs, all under module `examinations`. `ROLE_PERMISSIONS` binds ADMIN to `{exams.manage, exams.grading.manage, exams.candidates.manage, exams.moderate, exams.results.publish, exams.results.view}`, HOD to the identical six, FACULTY to `exams.marks.enter`, and STUDENT to `exams.results.view_own`. ADMIN's array contains neither `exams.marks.enter` nor `exams.results.view_own`, so the §12 separation of duties (ADMIN never enters marks, never gets the student-only read) holds. The migration's section (j) seeds the same eight permissions (`INSERT INTO "permissions" ... ON CONFLICT ("key") DO NOTHING`) and exactly the same 14 role_permissions pairs via the `FROM (VALUES ...) AS m("roleKey","permKey")` form — the two catalogue-sync parser markers are present. 6 + 6 + 1 + 1 = 14 pairs. The set-equality catalogue-sync test unions `PERMISSION_KEYS`/`ROLE_PERMISSIONS` against the migration spans and is recorded green in the fast suite (484/48), and the fast wiring suite independently asserts the exact ADMIN/HOD six and the two ADMIN exclusions.

### MUST-FIX 2 — audit-key consistency (confirmed)

`audit-actions.ts` carries 15 `exams.*` keys. The status transitions (MARKS_OPEN→MARKS_LOCKED, MARKS_LOCKED→MODERATION, MODERATION→APPROVED, and all others) are audited under the single `exams.examination.status_changed` key; the `/:id/status` handler writes that key with `metadata: { from, to }`. A grep of the shared list confirms `exams.marks.locked` and `exams.moderation.opened` do not exist — no dead keys. `exams.marks.entered` doubles as the DENIED out-of-scope marks audit, as designed.

### MUST-FIX 3 — tenant-escape harness completeness (confirmed)

`helpers/tenant-escape-setup.ts` extends `SeededTenant` with `examinationId, gradingSchemeId, gradeBandId, examScheduleId, assessmentId, candidateId, marksRecordId` (a typed id per newly-seeded table), seeds all seven in child-safe RESTRICT order (examination → grading_scheme → grade_band → exam_schedule → assessment → candidate → marks_record) via the RLS-bypassing admin client against the already-seeded session/term/program/subject/student, and returns them from `seedTenant`/`seedBothTenants`. `cleanup` adds the guard-disable teardown dance for `examinations_guard` and `marks_records_guard` with child-first deletes. `countRemainingTestRows` counts those seven mutable/guarded tables so the teardown total==0 covers them; the three INSERT-only tables (`marks_record_history`, `result_publications`, `result_snapshots`) are excluded from the generic seed/count loop, mirroring payment_allocations/receipts/processed_webhook_events. All ten exam tables are in `RLS_TABLES`; the three INSERT-only tables are in `EXPECTED_POLICIES` with their `*_tenant_insert` policy, while the seven mutable/guard tables fall through to `DEFAULT_POLICIES` (row immutability is a column guard, not an append-only RLS policy — the payment_transactions precedent). The suite (`tenant-escape.integration.test.ts`) adds per-table read-escape, spoofed-insert escape, foreign-parent composite-FK violation, buggy-query backstop, three-GUC fail-closed, the examinations/marks_records DELETE-and-illegal-transition guards, and a self-contained append-only insert/update/delete case for the three INSERT-only tables that cleans up within its own trigger-disable scope. Recorded: 82 passed / 1 file in isolation, countRemainingTestRows==0 after teardown.

### Schema, RLS, and migration discipline

The migration dir is `20261206000000_phase8_exams_slice1` (the next sensible timestamp after 20261129000000), hand-authored in the lettered a–j house style. It is strictly additive — no DROP on existing tables, no frozen-dir edits (`git diff --stat` shows only this dir under migrations), and the catalogue-sync `SEEDING_MIGRATION_DIRS` lists it. Every table carries `institutionId`, a `(id, institutionId)` composite unique anchoring the composite same-tenant FKs, an `(institutionId)` index, and the query indexes. All composite FKs carry `institutionId` and are `ON DELETE RESTRICT ON UPDATE CASCADE`; candidate/marks_record reference the shared `student_profiles` (single-identity rule, no duplicated student/class identity). RLS is ENABLE+FORCE on all ten via the `DO $$` block: seven mutable/column-guard tables get the standard `{tenant_isolation_select, tenant_isolation_modify}` pair, the three INSERT-only get `{tenant_isolation_select, <table>_tenant_insert}`, all nullif-guarded fail-closed. The `campass_app` GRANT refresh is guarded/idempotent, full DML on the seven and SELECT+INSERT (with REVOKE UPDATE,DELETE) on the three — never BYPASSRLS. The `ResultPublicationStatus` type carries the inline comment pinning `SUPERSEDED` as reserved-for-8.2.

### Status state machine and column guards

`examinations_guard()` enforces the forward-only chain DRAFT→SCHEDULED→MARKS_OPEN→MARKS_LOCKED→MODERATION→APPROVED→PUBLISHED plus the no-op self transition, freezes identity columns, freezes terminal PUBLISHED, and raises `restrict_violation` on DELETE and every illegal transition. `marks_records_guard()` freezes identity and forbids DELETE. The three append-only triggers raise unconditionally on UPDATE/DELETE. The `/:id/status` route re-checks `LEGAL_TRANSITIONS` and uses an optimistic `updateMany where:{status:from}` with the trigger as the hard backstop, mapping restrict_violation to 409 — the behavioral suite (AC-5) confirms a skip transition raises.

### Marks scope, deactivation gate, and append-only corrections

`PUT /:id/marks` is accepted only in MARKS_OPEN (409 otherwise). It first calls `resolveMarkingFaculty` — the deactivation gate: a null result (no profile, or a non-ACTIVE `FacultyProfile`) writes an `exams.marks.entered` DENIED audit in-tx and returns 403, closing the stale-ACTIVE-assignment hole. It then resolves the candidate's section(s) via `ClassEnrollment → ClassSection WHERE ClassSection.academicTermId = exam.academicTermId` (no non-existent term column on ClassEnrollment) and calls `assertFacultyAssigned` with the `facultyId:""` sentinel per candidate section, passing on any match or a subject-wide assignment; an out-of-scope write records DENIED + 403 with no row written. 0≤marks≤maxMarks is enforced (400). First write (no existing `(assessmentId,candidateId)` row) is `entered`/`MARKED`; a later edit is `corrected`/`CORRECTED` — both write a `marks_record_history` row, never a silent overwrite. The DENIED audits are written inside the returning (non-throwing) `withTenant` callback so they commit. The MODERATION-only `POST /:id/marks/:recordId/correct` is the distinct correction path.

### Grading engine

`services/exams/grading.ts` is pure, no DB, integer/BigInt only. It re-asserts weight-sum=100 and positive maxMarks (defense-in-depth), accumulates `(m * weight * 1e6) / maxMarks` in BigInt treating absent marks as 0, rounds once half-up via `(num + 5000n) / 10000n` to percentBps 0..10000, bands by the pure-integer `min ≤ percentBps ≤ max` predicate, copies gradeLabel/gradePoints, and sets `passed = band.isPassing`. No-match throws `GradingError` (mapped to 409 at publish). The test file covers the band boundaries, the explicit integer-half-up-not-float assertions (89.995→9000 and 1.005→101 with the naive `Math.round` counter-examples), weight-sum enforcement, zero/absent marks, the 0%/100% extremes, the single-assessment case, a passing band with gradePoints=0, the band-gap error, and determinism.

### Publication and student visibility

`POST /:id/publish` runs `[requirePermission, requireStepUp, requireModuleActive]` in the exact fees-refund order. Inside an advisory-locked `withTenant` tx it requires APPROVED (first) or PUBLISHED (correction), requires exactly one ACTIVE grading scheme (409 otherwise), computes per-(candidate,subject) snapshots through the engine, inserts a new `result_publications` row with `version = max+1` (reason required when version>1), and advances APPROVED→PUBLISHED only on first publish — a correction stays PUBLISHED and adds a new version, mutating no prior row (AC-11). Student reads (`/me/results`, `/me/results/:examId`) resolve the caller's StudentProfile and return only the max-version publication's snapshots filtered to `studentId`; an unpublished exam yields empty/404 — published-only visibility enforced at both the query layer and the `exams.results.view_own` vs `exams.results.view` permission split. Capacity-aware allocation uses the library advisory-lock idiom with a count-under-lock, the `candidates_schedule_seat_unique` partial-unique backstop, and server-assigned integer-ordinal seats; the behavioral suite (AC-4) confirms two concurrent allocations into a capacity-2 room never yield three.

### Module gating and wiring

Every `/api/exams` route carries `requireModuleActive("examinations")` in addition to `requirePermission` (the `/:id/status` route checks the permission inside the handler because the required key depends on the target status). `server.ts` registers `examsRoutes` at `/api/exams`. `modules.ts` is absent from the diff, so `MODULE_DEPENDENCIES.examinations` is unchanged (D-E). The fast wiring suite (`exams-routes.integration.test.ts`, DB mocked, correctly NOT in `vitest.live-db-suites.ts`) pins permission/module/step-up/Zod/range/weight-sum/status-409/publish-409 gating; the behavioral suite is registered in the live-db-suites glob so the fast run stays clean.

### Test coverage

Covered: the catalogue-sync set-equality (MUST-FIX 1), 14 grading unit tests (AC-8), 16 fast route-wiring tests, the 7-case behavioral live-DB suite (AC-1..7, AC-11), and the extended tenant-escape suite over all ten tables (AC-9/AC-10). Recorded verification per the commit messages: fast 484/48, tenant-escape 82/1 (teardown total 0), exams-behavioral 7/1, migrate diff cosmetic-only with no DROP, migrate deploy applied, migrate status up to date (15 migrations). Not re-run here per instructions; the recorded results are accepted.

</details>

<details>
<summary>File map</summary>

- `packages/db/prisma/schema.prisma` — nine/ten new models + four enums (single-PK relations; composite FKs/RLS/triggers in the migration).
- `packages/db/prisma/migrations/20261206000000_phase8_exams_slice1/migration.sql` — new lettered a–j migration: tables, indexes, composite FKs, CHECKs, RLS, column guards, append-only triggers, GRANT refresh, catalogue seed.
- `packages/shared/src/permissions.ts` — 8 `exams.*` PermissionDefs + the 14-pair ROLE_PERMISSIONS binding.
- `packages/shared/src/audit-actions.ts` — 15 `exams.*` audit keys; no dead marks.locked/moderation.opened keys.
- `packages/shared/src/validation.ts` — Zod schemas for every exams input.
- `apps/api/src/services/exams/grading.ts` + `__tests__/grading.test.ts` — pure integer grading engine + exhaustive unit tests.
- `apps/api/src/routes/exams.ts` — the `/api/exams` route module.
- `apps/api/src/server.ts` — registers `examsRoutes` at `/api/exams`.
- `apps/api/src/services/__tests__/catalogue-sync.test.ts` — adds the new dir to SEEDING_MIGRATION_DIRS.
- `apps/api/src/routes/__tests__/exams-routes.integration.test.ts` — fast mocked route-wiring suite.
- `apps/api/src/routes/__tests__/exams-behavioral.integration.test.ts` + `vitest.live-db-suites.ts` — live-DB behavioral suite (AC-1..7, AC-11) + its glob.
- `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` + `tenant-escape.integration.test.ts` — tenant-escape extended over all ten exam tables.

Full diff: `git -C c:\campusgate diff e113810..HEAD`

</details>
