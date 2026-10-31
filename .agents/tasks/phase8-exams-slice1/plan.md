# Implementation Plan — CAMPASS Phase 8 Examinations, Slice 8.1 (backend only)

Source of truth: the APPROVED design at `.agents/tasks/phase8-exams-slice1/design.md`
and the Round-3 `design-review.md`. Work is directly on branch `main` in
`c:\campusgate` — NO worktree, NO push, NO deploy.

Build/test commands discovered during exploration:
- Fast suite (must stay green, currently **454 pass / 46 files**): `npm test -w @campusgate/api`
- Live-DB suite (each passes IN ISOLATION): `npm run test:integration -w @campusgate/api`
- Prisma client generate / typecheck: `npm run build -w @campusgate/api`
  (`prisma generate` + `tsc`).
- Migration workflow (NFR-4): from `packages/db`,
  `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma`
  for the sanity diff (the composite-vs-single-FK cosmetic diff is EXPECTED),
  then `npx prisma migrate deploy`, then `npx prisma migrate status` (must report
  up to date). NEVER `prisma migrate dev`. NO DROP on existing tables; the 14
  frozen migration dirs stay byte-untouched.

Binding correction from the design review (Finding 1, the lone blocker): the
§14.1 narrative phrase "ADMIN gets all eight" is WRONG and contradicts its own
table + §12 separation of duties. The authoritative ADMIN binding is the SIX
keys `exams.manage`, `exams.grading.manage`, `exams.candidates.manage`,
`exams.moderate`, `exams.results.publish`, `exams.results.view` (NOT
`exams.marks.enter`, NOT `exams.results.view_own`). HOD gets the same six.
FACULTY gets `exams.marks.enter`. STUDENT gets `exams.results.view_own`. Total =
6 ADMIN + 6 HOD + 1 FACULTY + 1 STUDENT = **14 role_permissions pairs**. NITs 2
and 3 are folded into the relevant steps below.

The module gate is `requireModuleActive("examinations")` (the real registry key;
D-E — `packages/shared/src/modules.ts` is READ-ONLY this slice, its dependency
edges unchanged). The permission/audit KEY prefix stays `exams.*`.

Order is by dependency: the hand-authored migration + Prisma models + RBAC
catalogue must land and deploy before any live-DB test can run; the pure grading
engine is independent and can land in parallel conceptually but is sequenced
before the routes that call it; the routes depend on all of the above; the
live-DB + tenant-escape suites come last because they exercise the deployed DB.

---

- [ ] 1. Add the nine Prisma models + four enums to `schema.prisma` (single-PK
      relations only; composite FKs / partial uniques / RLS / triggers / CHECKs
      live in the migration, documented in each model's comment block — the
      fees/library precedent). Models: `Examination`, `GradingScheme`,
      `GradeBand`, `ExamSchedule`, `Candidate`, `Assessment`, `MarksRecord`,
      `MarksRecordHistory`, `ResultPublication`, `ResultSnapshot`. Enums:
      `ExaminationType`, `ExaminationStatus`, `MarksRecordHistoryChangeType`
      (`MARKED`, `CORRECTED` — value-identical to `AttendanceRecordHistoryChangeType`),
      `ResultPublicationStatus` (`PUBLISHED`, `SUPERSEDED`). Every table carries
      `institutionId` + `@@unique([id, institutionId])` + `@@index([institutionId])`
      + the §7.x query indexes + the `institution Institution @relation(...)` back-ref.
      Columns, FK targets, uniques, indexes, and CHECK intentions exactly per §7.2.
      Files: `packages/db/prisma/schema.prisma`
      Verify: `npm run build -w @campusgate/api` — `prisma generate` succeeds and
      `tsc` has no new errors (the client now exposes the nine delegates).

- [ ] 2. Hand-author the migration `packages/db/prisma/migrations/20261206000000_phase8_exams_slice1/migration.sql`
      in the frozen lettered a–j house style, mirroring
      `20261129000000_phase7_fees_slice2/migration.sql` exactly. Header comment
      enumerates the 14 frozen dirs it must not touch, the table-class split
      (§7.3), and the a–j ordering. Sections:
      (a) `CREATE TYPE` the four enums; the `ResultPublicationStatus` type carries
      the inline comment pinning `SUPERSEDED` as reserved-for-8.2 / never-written-in-8.1
      (Finding 3). (b) `CREATE TABLE` the nine tables (+ PKs; `updatedAt NOT NULL`
      only on the six mutable/column-guard tables; the three INSERT-only tables
      have no `updatedAt`). (c) `(id, institutionId)` uniques + business uniques
      + `(institutionId)`/query indexes + the raw-SQL partial unique
      `candidates_schedule_seat_unique ON "candidates"("institutionId","examScheduleId","seatNo") WHERE "examScheduleId" IS NOT NULL AND "seatNo" IS NOT NULL`
      + the `(institutionId, examId, version)` unique on `result_publications`.
      (d) tenant-root `institutionId → institutions(id)` RESTRICT on all nine.
      (e) composite same-tenant FKs incl. `institutionId` per §7.2, all
      `ON DELETE RESTRICT ON UPDATE CASCADE`. (f) CHECKs per §7.2/§17. (g)
      ENABLE+FORCE RLS via the `DO $$ ... $$` block — standard
      `{tenant_isolation_select, tenant_isolation_modify}` pair on the SIX
      mutable/column-guard tables (`examinations`, `grading_schemes`,
      `grade_bands`, `exam_schedules`, `assessments`, `candidates`,
      `marks_records` — note: 7 carry the standard pair; the THREE INSERT-only
      get `{tenant_isolation_select, <table>_tenant_insert}`), nullif-guarded
      fail-closed. (h) triggers: `examinations_guard()` + `marks_records_guard()`
      column guards (verbatim per §8), and `marks_record_history_append_only()`,
      `result_publications_append_only()`, `result_snapshots_append_only()` with
      `BEFORE UPDATE OR DELETE ... FOR EACH ROW`. (i) guarded idempotent
      `campass_app` GRANT refresh (§7.5), never BYPASSRLS. (j) catalogue seed —
      see step 4 (the seed SQL is authored here but its content is pinned by step 4).
      Files: `packages/db/prisma/migrations/20261206000000_phase8_exams_slice1/migration.sql`
      Verify: deferred to step 3 (deploy + status). Do not edit any frozen dir.

- [ ] 3. Apply and verify the migration. From `packages/db`: run the
      `prisma migrate diff` sanity check (the composite-vs-single-FK cosmetic
      diff is EXPECTED; confirm NO DROP on any existing table), then
      `npx prisma migrate deploy`, then `npx prisma migrate status`.
      Files: none (DB side effect; consumes step 2's SQL).
      Verify: `npx prisma migrate status` reports the DB up to date with all
      migrations applied, including `20261206000000_phase8_exams_slice1`; no
      frozen dir changed.

- [ ] 4. Add the RBAC catalogue to `packages/shared` and wire the seed. In
      `permissions.ts`: append the eight `exams.*` `PermissionDef` rows (module
      `examinations`) and edit `ROLE_PERMISSIONS` — add the SIX keys
      (`exams.manage`, `exams.grading.manage`, `exams.candidates.manage`,
      `exams.moderate`, `exams.results.publish`, `exams.results.view`) to BOTH
      `ADMIN` and `HOD`; add `exams.marks.enter` to `FACULTY`; add
      `exams.results.view_own` to `STUDENT`. (ADMIN does NOT get
      `exams.marks.enter` or `exams.results.view_own`.) In `audit-actions.ts`:
      append the `exams.*` audit keys, dropping `exams.marks.locked` and
      `exams.moderation.opened` (NIT 2 — those transitions audit under
      `exams.examination.status_changed`); keep `exams.examination.created/updated/status_changed`,
      `exams.schedule.created/updated`, `exams.candidate.registered/allocated`,
      `exams.assessment.created/updated`, `exams.marks.entered/corrected`,
      `exams.grading_scheme.created/updated`, `exams.results.published/exported`.
      Then author the migration's section (j) INSERT spans: `INSERT INTO "permissions" (...) VALUES ... ON CONFLICT ("key") DO NOTHING`
      (eight tuples, `('perm_...', 'exams.key', 'examinations', 'desc')` shape so
      `extractPermissionKeys` reads the 2nd literal) and the role_permissions span
      using the VERBATIM form
      `INSERT INTO "role_permissions" (...) SELECT ... FROM (VALUES (roleKey, permKey), ...) AS m("roleKey","permKey") JOIN "roles" r ON r."key" = m."roleKey" AND r."institutionId" IS NULL JOIN "permissions" p ... ON CONFLICT ("roleId","permissionId") DO NOTHING`
      (the `AS m(` marker is the parser end-marker) listing exactly the 14 pairs.
      NO new `roles` row. Add `"20261206000000_phase8_exams_slice1"` to
      `SEEDING_MIGRATION_DIRS` in `catalogue-sync.test.ts`. Re-deploy the
      migration if its seed span changed after step 3.
      Files: `packages/shared/src/permissions.ts`,
      `packages/shared/src/audit-actions.ts`,
      `packages/db/prisma/migrations/20261206000000_phase8_exams_slice1/migration.sql`,
      `apps/api/src/services/__tests__/catalogue-sync.test.ts`
      Verify: `npm test -w @campusgate/api -- catalogue-sync` — the set-equality
      assertions pass (union of migration keys/pairs equals `PERMISSION_KEYS` /
      `ROLE_PERMISSIONS`).

- [ ] 5. Implement the pure deterministic grading engine in
      `apps/api/src/services/exams/grading.ts` — no DB access, integer/`BigInt`
      only, with `GRADE_POINTS_SCALE = 100` and a typed `GradingError`. Export
      the banding/weighting function per §11: accumulate
      `num += (m * weight * 1_000_000n) / maxMarks` in `BigInt` (absent mark ⇒ 0),
      round half-up once via `percentBps = Number((num + 5_000n) / 10_000n)`,
      band with the pure-integer predicate `minPercentBps ≤ percentBps ≤ maxPercentBps`,
      copy `gradeLabel`/`gradePoints`, set `passed = band.isPassing`; throw
      `GradingError` on weight-sum≠100, band gap/no-match. Add the exhaustive
      unit tests in `apps/api/src/services/exams/__tests__/grading.test.ts`
      covering AC-8 (basis-point boundaries, the explicit "naive
      `Math.round(89.995*100)===8999` NOT taken" assertion, weight-sum=100,
      zero marks, absent-mark-is-0, 0%/100% extremes, single-assessment subject,
      `passed = isPassing` incl. a 0-point passing band, band-gap `GradingError`).
      Files: `apps/api/src/services/exams/grading.ts`,
      `apps/api/src/services/exams/__tests__/grading.test.ts`
      Verify: `npm test -w @campusgate/api -- grading` — all new unit tests pass;
      `npm run build -w @campusgate/api` typechecks.

- [ ] 6. Implement the exams routes in `apps/api/src/routes/exams.ts` and
      register them at `/api/exams` in `server.ts` (mirror the fees
      registration). House pattern: one top-level `authenticate` preHandler;
      per-route `[requirePermission(key), requireModuleActive("examinations")]`;
      publish uses the exact fees-refund ordering
      `[requirePermission("exams.results.publish"), requireStepUp("exams.results.publish"), requireModuleActive("examinations")]`;
      every handler inside `withTenant(institutionId, tx => ...)` with
      `institutionId` from `request.user`; Zod on every input; audits via
      `recordAuditEvent`. Include a `advanceExamStatus(tx, examId, from, to)`
      helper (optimistic `where:{id,institutionId,status:from}` + trigger
      backstop). Routes per §15: exam setup (`POST/PATCH/GET /exams`,
      `GET /exams/:id`), `POST /exams/:id/status`, schedules
      (`POST/GET /exams/:id/schedules`), capacity-aware allocation
      `POST /exams/:id/schedules/:scheduleId/allocate` (advisory-lock idiom from
      `library.ts` `lockStudent`, server-assigned integer-ordinal `seatNo`,
      count-under-lock, partial-unique backstop, already-allocated-elsewhere⇒409,
      already-here⇒no-op), candidates (`POST/GET /exams/:id/candidates`),
      assessments (`POST/PATCH/GET`; weight-sum=100 service invariant), scoped
      marks entry `PUT /exams/:id/marks` (only in `MARKS_OPEN`, else 409; reuse
      `resolveMarkingFaculty` + `assertFacultyAssigned` from `attendance-authz.ts`
      VERBATIM with the `facultyId:""` sentinel; candidate section via
      `ClassEnrollment → ClassSection WHERE ClassSection.academicTermId = exam.academicTermId`;
      first-write⇒`entered`/`MARKED`, later-edit⇒`corrected`/`CORRECTED`;
      out-of-scope⇒403 + `exams.marks.entered`/DENIED), moderation correction
      `POST /exams/:id/marks/:recordId/correct` (only in `MODERATION`, reason
      required, `exams.marks.corrected`/`CORRECTED`), grading schemes + bands
      (`POST/PATCH/GET` with contiguity + monotonic-`isPassing` validation),
      publish `POST /exams/:id/publish` (§9/§10 advisory lock, require ACTIVE
      scheme, snapshot via the engine, append-only version, APPROVED→PUBLISHED on
      first publish), staff result reports (`GET /exams/:id/results`,
      `/results/distribution`, `/rollups`, `/results.xlsx` via the `admin.ts`
      ExcelJS pattern), student reads (`GET /me/results`, `/me/results/:examId` —
      latest PUBLISHED only). Add the fast mocked route test
      `apps/api/src/routes/__tests__/exams.test.ts` (permission/module gating,
      publish step-up gating fast portion, Zod 400s, marks-range 400,
      weight-sum 400, status-advance 409, publish 409 not-approved/no-scheme).
      Files: `apps/api/src/routes/exams.ts`, `apps/api/src/server.ts`,
      `apps/api/src/routes/__tests__/exams.test.ts`
      Verify: `npm test -w @campusgate/api` — full fast suite stays green (454 +
      the new fast tests); `npm run build -w @campusgate/api` typechecks.

- [ ] 7. Add the live-DB behavioral suite
      `apps/api/src/routes/__tests__/exams-behavioral.integration.test.ts`
      (no `vi.mock('@campusgate/db')`) covering AC-1..AC-7 + AC-11: faculty-scope
      DENIED+403, post-lock correction→history row, capacity-aware allocation
      concurrency (two concurrent allocations into capacity-N never yield N+1),
      illegal status transitions raise `restrict_violation`, publish step-up
      success/failure + un-enrolled path, correction = new version with no prior
      row mutated, student sees only latest PUBLISHED. Add its glob
      `'src/**/exams-behavioral.integration.test.ts'` to
      `apps/api/vitest.live-db-suites.ts`.
      Files: `apps/api/src/routes/__tests__/exams-behavioral.integration.test.ts`,
      `apps/api/vitest.live-db-suites.ts`
      Verify: `npm run test:integration -w @campusgate/api` — the new suite passes
      in isolation; `npm test -w @campusgate/api` still green (the suite is
      excluded from the fast run by the live-db-suites glob).

- [ ] 8. Extend the tenant-escape suite for EVERY new exams table (AC-10) in
      `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` and
      `tenant-escape.integration.test.ts`: add all nine tables to `RLS_TABLES`;
      add the three INSERT-only tables (`marks_record_history`,
      `result_publications`, `result_snapshots`) to `EXPECTED_POLICIES` with
      `{tenant_isolation_select, <table>_tenant_insert}` (the six
      mutable/column-guard tables fall through to `DEFAULT_POLICIES`); extend the
      `SeededTenant` interface + `seedTenant` return with the new exam-table ids;
      seed exam fixtures for both tenants in `seedTenant` (child-safe order:
      examination → grading_scheme → grade_band → exam_schedule → candidate →
      assessment → marks_record; the three INSERT-only tables are NOT seeded —
      the `payment_allocations`/`receipts` precedent); extend `cleanup` with the
      guard-trigger-disable teardown dance for `examinations` (`examinations_guard`),
      `marks_records` (`marks_records_guard`), child-first delete order; add the
      six seeded mutable/guarded exam tables to `countRemainingTestRows` (the
      three INSERT-only excluded). Prove read-escape + spoofed-insert-escape per
      table.
      Files: `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`,
      `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts`
      Verify: `npm run test:integration -w @campusgate/api` — the tenant-escape
      suite passes in isolation with the nine new tables; `countRemainingTestRows`
      returns 0 after cleanup.

- [ ] 9. Final integration verification. Run the full fast suite and the full
      live-DB suite; confirm the fast suite is green at 454 + new fast tests and
      every live-DB suite passes in isolation; confirm `prisma migrate status`
      is up to date and the 14 frozen dirs are byte-untouched; remove any
      temporary scaffolding.
      Files: none (verification only).
      Verify: `npm test -w @campusgate/api` green; `npm run test:integration -w @campusgate/api`
      green suite-by-suite; `git status` shows only intended new/edited files.

---

## Digest

Build command: `npm run build -w @campusgate/api` (= `prisma generate` + `tsc`).
Fast test command: `npm test -w @campusgate/api` (currently **454 pass / 46 files**,
verified green at HEAD). Live-DB command: `npm run test:integration -w @campusgate/api`
(suites listed in `apps/api/vitest.live-db-suites.ts`, each passes in isolation).
Migration workflow from `packages/db`: `prisma migrate diff` (cosmetic FK diff
expected, NO DROP) → `prisma migrate deploy` → `prisma migrate status` (up to date).

Files touched and the block in each:

- `packages/db/prisma/schema.prisma` — ADD nine models + four enums (single-PK
  relations, `@@unique([id, institutionId])` anchors, comment blocks noting the
  raw-SQL composite FKs/partial uniques/RLS/triggers/CHECKs — the pattern used by
  `FeeStructure`/`FeeComponent` at lines ~2062+). No existing model edited.
  Covered by: step-1 `prisma generate`+`tsc`.

- `packages/db/prisma/migrations/20261206000000_phase8_exams_slice1/migration.sql`
  — NEW file, lettered a–j mirroring `20261129000000_phase7_fees_slice2/migration.sql`
  (enums → tables → indexes incl. `candidates_schedule_seat_unique` partial +
  `(institutionId,examId,version)` unique → tenant-root FKs → composite FKs →
  CHECKs → ENABLE+FORCE RLS `DO $$` block → `examinations_guard`/`marks_records_guard`
  + three `*_append_only` triggers → guarded `campass_app` GRANT refresh →
  permissions + role_permissions seed). Append-only trigger shape and the seed
  INSERT spans are byte-faithful to the fees-slice2 forms (the catalogue-sync
  parser markers `INSERT INTO "permissions"` → `ON CONFLICT` and
  `INSERT INTO "role_permissions"` → `AS m(` are load-bearing).
  Covered by: step-3 `prisma migrate status`; step-4 `catalogue-sync` test.

- `packages/shared/src/permissions.ts` — APPEND 8 `PermissionDef` rows to
  `PERMISSIONS` (module `examinations`) and edit the `ADMIN`, `HOD`, `FACULTY`,
  `STUDENT` arrays in `ROLE_PERMISSIONS` (6+6+1+1 = 14 pairs; ADMIN binding is
  the corrected six — Finding 1). Covered by: `catalogue-sync.test.ts`
  set-equality.

- `packages/shared/src/audit-actions.ts` — APPEND the `exams.*` keys to
  `AUDIT_ACTIONS` (NO migration mirror; validated in `recordAuditEvent`). Drop
  `exams.marks.locked`/`exams.moderation.opened` (NIT 2). Covered by: `tsc`
  (the `as const satisfies` array) + the route tests emitting the keys.

- `apps/api/src/services/exams/grading.ts` — NEW pure engine + `GradingError` +
  `GRADE_POINTS_SCALE`. Covered by:
  `apps/api/src/services/exams/__tests__/grading.test.ts` (new, AC-8).

- `apps/api/src/routes/exams.ts` — NEW route module `examsRoutes`, all routes per
  §15 with the house preHandler pattern; publish uses
  `[requirePermission, requireStepUp, requireModuleActive]` (the verbatim
  `fees.ts` refund/adjust ordering at lines ~1059 and ~1122). Reuses
  `resolveMarkingFaculty`/`assertFacultyAssigned` (`attendance-authz.ts`,
  signatures confirmed) and the `library.ts` `lockStudent` advisory-lock idiom
  (`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`). ExcelJS via the
  `admin.ts` `new ExcelJS.Workbook()` / `addWorksheet` pattern. Covered by:
  `apps/api/src/routes/__tests__/exams.test.ts` (new fast, mocked `@campusgate/db`)
  + the behavioral live-DB suite.

- `apps/api/src/server.ts` — ADD `import { examsRoutes } from "./routes/exams.js"`
  and `await app.register(examsRoutes, { prefix: "/api/exams" })` next to the
  existing fees registration (line ~55). Covered by: `tsc` + route tests.

- `apps/api/src/routes/__tests__/exams.test.ts` — NEW fast suite (mocked DB).
  Covered by: `npm test`.

- `apps/api/src/routes/__tests__/exams-behavioral.integration.test.ts` — NEW
  live-DB suite (AC-1..7, AC-11). Covered by: `npm run test:integration`.

- `apps/api/vitest.live-db-suites.ts` — ADD
  `'src/**/exams-behavioral.integration.test.ts'` to `LIVE_DB_SUITES`. Covered
  by: the split fast/integration runs.

- `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` — EXTEND
  `SeededTenant`, `seedTenant` return, `seedTenant` body (seed the six
  mutable/guard tables), `cleanup` (guard-disable dance for `examinations_guard`
  + `marks_records_guard`, child-first deletes), `countRemainingTestRows` (six
  mutable/guard tables), `RLS_TABLES` (nine tables), `EXPECTED_POLICIES` (three
  INSERT-only). Mirrors the existing `slice2GuardedTables` dance (lines ~946).
  Covered by: `tenant-escape.integration.test.ts`.

- `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts` — EXTEND the
  per-table read/spoofed-insert escape coverage for the nine new tables (the
  suite already loops `RLS_TABLES` for policy shape). Covered by:
  `npm run test:integration`.

Verified today: fast suite 454/46 green; `attendance-authz.ts` exports
`resolveMarkingFaculty(tx, institutionId, userId)` and
`assertFacultyAssigned(tx, institutionId, facultyId, {classSectionId, subjectId, academicTermId, facultyId})`;
`library.ts` `lockStudent` uses the advisory-lock idiom; `fees.ts` refund/adjust
use the `[requirePermission, requireStepUp, requireModuleActive]` ordering;
`modules.ts` `examinations` deps unchanged; `catalogue-sync.test.ts` parser
markers and `SEEDING_MIGRATION_DIRS` confirmed; the fees-slice2 migration a–j
shape and seed spans confirmed; `admin.ts` uses `ExcelJS.Workbook`; schema anchor
`@@unique([id, institutionId])` present on all FK-target tables.
Not verified (noted, non-blocking): exact `admin.ts` ExcelJS column wiring
(read-only report mirror, no correctness bearing on schema/RLS/grading/publish).
