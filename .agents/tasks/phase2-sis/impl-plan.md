# Implementation Plan — CAMPASS Phase 2: Student Information System (SIS)

Implements the APPROVED design at `.agents/tasks/phase2-sis/design.md` (reviewer verdict
APPROVED in `design-review.md`). The delicate core is **generalizing the LIVE
`student_profiles` table in place, additively** — no data loss, no broken consumer
(GatePass / allowance / reliability). Work on `main`, NO worktree. Do NOT push or deploy.
Additive only: the SEVEN FROZEN migrations are untouched; ONE new migration (`phase2_sis`)
is added. The app must keep building and running at every numbered boundary.

This phase decomposes into three FEATs (mirroring Phase 1): **FEAT-001** = data + catalogue
+ migration substrate (shared catalogues, schema, the `phase2_sis` migration applied to live
Supabase, client regen, seed); **FEAT-002** = the API (new `students.ts` admin routes, the
`student-sis.ts` transition service, the folded-in bulk-import/register, self-service on
`student.ts`, validation schemas, server registration); **FEAT-003** = the test plan (escape
suite extension, the four roadmap tests, GatePass/allowance/reliability regression, full
clean build + live smoke). If the FEAT decomposition is active, the authoritative per-FEAT
specs live under `.agents/tasks/phase2-sis/features/`; this file is the equivalent linear
plan and the fallback.

## Working context (read before starting)

- Repo: `c:\campusgate` — Turborepo monorepo (npm workspaces, NOT pnpm), Windows/PowerShell.
  Prisma `6.19.3` (do NOT upgrade to the 8.x RC the deploy log advertises). ESM, `.js`
  import specifiers.
- Build (the CLEAN sequence, from repo root unless noted):
  1. `npm ci`
  2. `cd packages/shared && npx tsc` (rebuild `@campusgate/shared` so `dist` is current
     BEFORE api/seed consume the new catalogue keys — this must happen first)
  3. (root) `npx prisma generate --schema=packages/db/prisma/schema.prisma`
  4. `cd apps/api && npx tsc`
  5. (root) `npm run build`
- Tests: `cd apps/api && npx vitest run` (single file: `npx vitest run <path>`). The escape
  suite + any real-DB integration tests hit live Supabase and read `apps/api/.env` +
  `packages/db/.env`. Leave those `.env` files untouched and NEVER stage them.
- Migrations: SEVEN exist and are FROZEN (`20260824143031_add_allowance_and_reliability_models`,
  `20261018100917_init`, `20261018110658_tenancy_isolation_rls` [B-1],
  `20261018171747_identity_rbac_b2`, `20261019053533_superadmin_security`,
  `20261019093119_module_system`, `20261027111710_phase1_academics`). Add exactly ONE new
  migration dir, `<ts>_phase2_sis`. **Do NOT run `prisma migrate dev`** (plain or
  `--create-only`) against the shared Supabase DB — the live `_prisma_migrations` ledger has
  a pre-existing, harmless checksum drift on the FROZEN `superadmin_security` row that can
  trip `migrate dev` into a RESET prompt (forbidden). Instead **hand-author** `migration.sql`
  in the house style, confirm the modelled DDL with the read-only
  `prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel packages/db/prisma/schema.prisma --script`,
  then apply with `cd packages/db && npx prisma migrate deploy` (deploy does NOT re-verify
  applied-migration checksums, so it tolerates the drift — proven by Phase 1). Retry transient
  pooler errors (`P1001` / `tenant or user not found` / `Can't reach database server`) rather
  than treating them as logic failures. If `migrate deploy` reports NEW drift, STOP and
  diagnose; never force-reset the shared DB.
- House-style references to mirror exactly:
  - Migration DDL / enum / composite FK / RLS / GRANT / append-only trigger / catalogue seed:
    `packages/db/prisma/migrations/20261027111710_phase1_academics/migration.sql` (the newest
    precedent — the `academic_calendar_day_revisions` append-only pair + the `programs`/
    `academic_terms` composite FKs are the templates) and
    `.../20261019053533_superadmin_security/migration.sql` / `.../20261019093119_module_system/migration.sql`.
  - `withTenant`, `privilegedPrisma`, `DbClient`: `packages/db/src/index.ts`.
  - `recordAuditEvent(input, tx?)` + `sanitizeMetadata`: `apps/api/src/services/audit.ts`.
  - Pure transition services for DB-free unit tests: `apps/api/src/services/module-system.ts`,
    `academic-session.ts`.
  - Shared catalogues: `packages/shared/src/{permissions,audit-actions,validation}.ts` + `index.ts`.
  - Live routes folded-in: `apps/api/src/routes/admin.ts` (`/students/bulk-import`,
    `/students/export`), `auth.ts` (`/register`), `student.ts` (self-service + the Decision-A
    `academics.view` reads already on it).
  - `getStudentInTenant(userId, institutionId, tx)`: `apps/api/src/services/authz.ts`.
  - Catalogue-sync + escape helpers: `apps/api/src/services/__tests__/catalogue-sync.test.ts`,
    `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`,
    `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts`.
- Decision A (verified in code): SIS is foundational institution-layer data. New routes are
  `requirePermission(...)`-gated ONLY — NEVER `requireModuleActive(...)`. Do NOT edit
  `packages/shared/src/modules.ts`.

---

## FEAT-001 — data, catalogue, and the `phase2_sis` migration substrate

- [ ] 1. Add the six `students.*` permissions + their role bindings to the shared catalogue.
      In `packages/shared/src/permissions.ts` append a `students` module block to `PERMISSIONS`:
      `students.view`, `students.create`, `students.update`, `students.enroll`, `students.promote`,
      `students.deactivate`, plus the self-service low-privilege key `students.view_own`. Bind in
      `ROLE_PERMISSIONS`: `ADMIN` gains all six admin keys + `students.view_own`; `HOD` gains
      `students.view`, `students.update`, `students.enroll`, `students.promote`, `students.view_own`;
      `STUDENT` gains `students.view_own`. GUARD/SUPER_ADMIN gain nothing. Export stays on the
      existing `admin.students.export` key (do NOT add `students.export`).
      Files: `packages/shared/src/permissions.ts`
      Verify: deferred to step 4 (`cd packages/shared && npx tsc`) + step 12 catalogue-sync test.

- [ ] 2. Add the eight `students.student.*` audit keys to the shared catalogue.
      In `packages/shared/src/audit-actions.ts` append a `students` module block to `AUDIT_ACTIONS`:
      `students.student.created`, `.updated`, `.program_assigned`, `.enrolled`, `.promoted`,
      `.transferred`, `.deactivated`, `.imported`. Do NOT touch `LEGACY_AUDIT_ACTION_MAP` or the
      retained live `admin.students.imported` key. Each new key is 3-segment and passes the
      `audit-actions.test.ts` `KEY_RE` meta-test.
      Files: `packages/shared/src/audit-actions.ts`
      Verify: deferred to step 4 + `cd apps/api && npx vitest run src/services/__tests__/audit-actions.test.ts`.

- [ ] 3. Add the SIS zod schemas to shared validation (consumed by FEAT-002 but shipped here so
      `dist` is complete). In `packages/shared/src/validation.ts` add `createStudentSchema`
      (email, name, enrollmentNo, departmentId, program [required], semester [1..12], section?,
      rollNumber?, dob?, phone?, address?, admissionDate?, programId?), `updateStudentSchema`
      (`.strict()`, keys exactly `{ name?, rollNumber?, section?, dob?, phone?, address?,
      admissionDate? }`), `assignProgramSchema`, `enrollStudentSchema`, `promoteStudentSchema`,
      `transferStudentSchema`, `deactivateStudentSchema`, `listStudentsQuerySchema`
      (status?/programId?/departmentId?/q?/page/pageSize with the 1..100 clamp), and their
      inferred types. Keep `semester` bounds consistent with `bulkImportStudentSchema`/`registerSchema`.
      Files: `packages/shared/src/validation.ts`
      Verify: step 4 compiles shared clean.

- [ ] 4. Rebuild `@campusgate/shared` so its `dist` carries the new keys/schemas before any
      consumer reads them.
      Files: (none — build artifact)
      Verify: `cd packages/shared && npx tsc` exits 0.

- [ ] 5. Add the three enums + the two new models + the generalized `StudentProfile` fields +
      all back-relations to the Prisma schema. In `packages/db/prisma/schema.prisma`: add enums
      `StudentStatus {APPLICANT ENROLLED ACTIVE ON_LEAVE GRADUATED WITHDRAWN SUSPENDED}`,
      `StudentHistoryChangeType {CREATED STATUS_CHANGED PROGRAM_CHANGED ENROLLED PROMOTED
      TRANSFERRED DEACTIVATED UPDATED}`, `StudentDocumentKind {ID_PROOF PHOTO TRANSCRIPT
      CERTIFICATE OTHER}`. On `StudentProfile` add (all existing fields UNCHANGED):
      `status StudentStatus @default(ACTIVE)`, `admissionDate DateTime?`, `programId String?` +
      `structuredProgram Program? @relation(fields:[programId],references:[id])`,
      `academicSessionId String?` + `academicSession AcademicSession? @relation(...)`,
      `currentTermId String?` + `currentTerm AcademicTerm? @relation(...)`, plus back-relations
      `history StudentProfileHistory[]` and `documents StudentDocument[]`; add
      `@@index([institutionId, status])` and `@@index([institutionId, programId])` (keep the
      existing `@@unique([id, institutionId])`, `@@index([institutionId])`, `@@map`). Add models
      `StudentProfileHistory` and `StudentDocument` per design §4.1/§5.6 (institutionId + relation;
      `@@unique([id, institutionId])`; indexes; snapshot columns on history, metadata columns on
      document). Add the required back-relations: on `Institution` add `studentProfileHistory
      StudentProfileHistory[]` + `studentDocuments StudentDocument[]`; on `Program`,
      `AcademicSession`, `AcademicTerm` add distinctly-named `StudentProfile[]` back-relations
      (e.g. `students` / `enrolledStudents` / `currentTermStudents`). The relation field MUST be
      named `structuredProgram` (not `program`) because the scalar free-text `program` column
      stays.
      Files: `packages/db/prisma/schema.prisma`
      Verify: step 6 regenerates the client clean.

- [ ] 6. Regenerate the Prisma client so the delegates/types exist for later steps.
      Files: (none — generated client)
      Verify: `npx prisma generate --schema=packages/db/prisma/schema.prisma` (repo root) exits 0
      and the client exposes `studentProfileHistory` + `studentDocument` delegates and the new
      `StudentProfile` fields.

- [ ] 7. Hand-author the `phase2_sis` migration SQL in the house style. Create
      `packages/db/prisma/migrations/<ts>_phase2_sis/migration.sql` (timestamp from the system
      clock, sorting AFTER the seven FROZEN dirs) containing, in order (design §10.1): (a) `CREATE
      TYPE` the three enums; (b) `ALTER TABLE "student_profiles"` ADD COLUMN `status "StudentStatus"
      NOT NULL DEFAULT 'ACTIVE'` (this IS the backfill — existing rows get ACTIVE), `admissionDate
      TIMESTAMP(3)`, `programId`/`academicSessionId`/`currentTermId` TEXT (all nullable); (c)
      `CREATE TABLE student_profile_history` + `student_documents` with PKs, `(id, institutionId)`
      uniques, institutionId + composite indexes; (d) tenant-root FKs (`institutionId ->
      institutions(id)` RESTRICT) on both new tables; (e) composite same-tenant FKs — DROP Prisma's
      single-col FKs on `student_profiles` and ADD `student_profiles_program_same_tenant_fkey` /
      `_session_same_tenant_fkey` / `_term_same_tenant_fkey` (FK on `(institutionId, <col>)` ->
      parent `(institutionId, id)`, all `ON DELETE SET NULL ON UPDATE CASCADE`), plus
      `student_profile_history.studentProfileId` + `student_documents.studentProfileId` composite
      FKs to `student_profiles(institutionId, id)` `ON DELETE RESTRICT`; (f) the two new
      `student_profiles` indexes `(institutionId, status)` + `(institutionId, programId)`; (g)
      `DO $$ ENABLE + FORCE RLS` with nullif-guarded fail-closed policies — `student_documents`
      gets the STANDARD pair (`tenant_isolation_select` + `tenant_isolation_modify`),
      `student_profile_history` gets the APPEND-ONLY pair (`tenant_isolation_select` +
      `student_profile_history_tenant_insert`, NO modify policy); DO NOT touch `student_profiles`
      RLS (already ENABLE+FORCE from B-1); (h) append-only function
      `student_profile_history_append_only()` raising `restrict_violation` + trigger
      `student_profile_history_no_update_delete` BEFORE UPDATE OR DELETE binding every role; (i)
      guarded `IF EXISTS (pg_roles ... 'campass_app')` GRANT refresh — full DML on
      `student_documents`, `GRANT SELECT, INSERT` + `REVOKE UPDATE, DELETE` on
      `student_profile_history`; never BYPASSRLS; (j) seed the six `students.*` permissions +
      `students.view_own` and their role_permissions pairs with the EXACT catalogue-sync markers
      (`INSERT INTO "permissions" ... ON CONFLICT`; `INSERT INTO "role_permissions" ... AS m(`),
      idempotent `ON CONFLICT DO NOTHING`. No separate backfill UPDATE; no structured-link backfill
      in DDL. Do NOT edit any FROZEN migration.
      Files: `packages/db/prisma/migrations/<ts>_phase2_sis/migration.sql`
      Verify: step 8 (read-only diff + deploy).

- [ ] 8. Confirm the modelled DDL read-only, then apply the migration to live Supabase.
      Run `npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel
      packages/db/prisma/schema.prisma --script` and compare its `student_profiles` ALTERs, the two
      CREATE TABLEs, FK constraints, and indexes against the hand-authored SQL (the diff does NOT
      model RLS/trigger/grant/seed — review those by eye against the Phase-1 precedent). Then
      `cd packages/db && npx prisma migrate deploy` (retry transient pooler errors). Regenerate the
      client again from repo root.
      Files: (none — applies committed migration)
      Verify: `npx prisma migrate deploy` exits 0 and lists `<ts>_phase2_sis` as applied;
      `cd packages/db && npx prisma migrate status` shows the DB up to date with exactly eight
      migrations; `git diff --stat -- packages/db/prisma/migrations` shows only the new dir.

- [ ] 9. Extend the demo seed to exercise the generalized model. In `packages/db/src/seed.ts`,
      after the Phase-1 session/term/program upserts, best-effort link the seeded demo students
      (keyed by known `enrollmentNo`) to the active `2026-2027` session, Semester 1 term, and the
      matching `Program` (BCA for BCA-department students) via `update`, leaving `status = ACTIVE`
      (column default). Seed ONE `StudentProfileHistory` `ENROLLED` row per demo student via a
      `findFirst`-guarded create (NEVER upsert — the append-only trigger forbids update). Do NOT
      seed `StudentDocument` rows. Match the seed's `console.log` style.
      Files: `packages/db/src/seed.ts`
      Verify: `cd packages/db && npx tsc` type-checks clean.

- [ ] 10. Keep catalogue-sync green by registering the new migration dir. Add
      `"<ts>_phase2_sis"` to `SEEDING_MIGRATION_DIRS` in
      `apps/api/src/services/__tests__/catalogue-sync.test.ts` (the one cross-feature test edit,
      exactly as Phase 1 did).
      Files: `apps/api/src/services/__tests__/catalogue-sync.test.ts`
      Verify: step 12.

- [ ] 11. FEAT-001 integration gate: client regenerated, shared rebuilt, DB migrated.
      Files: (none)
      Verify: `cd packages/shared && npx tsc` (clean) → `npx prisma generate
      --schema=packages/db/prisma/schema.prisma` (clean) → `cd packages/db && npx prisma migrate
      status` (eight migrations, up to date).

- [ ] 12. Run the catalogue/audit meta-tests.
      Files: (none)
      Verify: `cd apps/api && npx vitest run src/services/__tests__/catalogue-sync.test.ts
      src/services/__tests__/audit-actions.test.ts` — all green (set-equality holds; new keys valid).
      NOTE: `cd apps/api && npx tsc` is NOT expected to be fully clean until FEAT-002 adds the new
      routes that consume the new schemas/delegates; FEAT-001 leaves shared+db+migration green.

---

## FEAT-002 — the SIS API (admin routes, transition service, fold-ins, self-service)

- [ ] 13. Create the pure transition service `apps/api/src/services/student-sis.ts`, mirroring
      `module-system.ts` / `academic-session.ts`. Export DB-free pure functions that, given the
      current profile + a transition input, compute the `StudentProfileHistory` `changeType` + the
      `previous*`/`new*` snapshot payload for create / assign-program / enroll / promote / transfer /
      deactivate / update, plus the bulk-import resolve-first decision (given an existing-vs-new
      `enrollmentNo` → update | create | skip). Keep these functions free of a real client so they
      unit-test with plain inputs.
      Files: `apps/api/src/services/student-sis.ts`
      Verify: `cd apps/api && npx tsc` (clean once step 14 wires the route) — type-checks here.

- [ ] 14. Create the admin route file `apps/api/src/routes/students.ts` (exported
      `studentAdminRoutes`) with a single top-level `app.addHook("preHandler", authenticate)` and
      `requirePermission("students.<x>")` on each route — NO `requireModuleActive` (Decision A).
      Implement inside `withTenant`, each lifecycle mutation writing a `StudentProfileHistory` row
      (via `student-sis.ts`) + `recordAuditEvent(..., tx)` in the same transaction:
      `POST /` (create — 409 on existing enrollmentNo/email, history CREATED, audit
      `students.student.created`), `PATCH /:id` (update — `updateStudentSchema.strict()`, 400 "field
      not editable", history UPDATED, audit `.updated`), `POST /:id/assign-program` (audit
      `.program_assigned`), `POST /:id/enroll` (`students.enroll`, audit `.enrolled`),
      `POST /:id/promote` (`students.promote`, audit `.promoted`), `POST /:id/transfer`
      (`students.update`, audit `.transferred`), `POST /:id/deactivate` (`students.deactivate`,
      status flip only, NO delete route, audit `.deactivated`), `GET /` (paginated search,
      `students.view`, HOD narrowed to `departmentScope`), `GET /:id`, `GET /:id/history`. Use the
      §5.7 error table for status codes.
      Files: `apps/api/src/routes/students.ts`
      Verify: step 16.

- [ ] 15. Register the new route and fold the live paths onto the new model. In
      `apps/api/src/server.ts` add `await app.register(studentAdminRoutes, { prefix: "/api/students" });`
      alongside the existing registrations (no collision: admin at `/api/students/*`, self-service at
      `/api/student/me/*`). In `apps/api/src/routes/admin.ts` `/students/bulk-import`: apply the
      resolve-first re-import rule (resolve by `enrollmentNo` FIRST → update permitted fields +
      `results.updated`, else email-conflict skip, else create with `status = ACTIVE` + best-effort
      `programId`), write a `StudentProfileHistory` UPDATED row on updated rows, and switch the audit
      to `students.student.imported`. In `apps/api/src/routes/auth.ts` `/register`: preserve the
      existing collision checks unchanged; the new `status` defaults at the DB. In
      `apps/api/src/routes/student.ts` add `GET /me/profile`, `GET /me/academic`, `GET /me/services`
      (all `requirePermission("students.view_own")`, inside `withTenant`, resolving via
      `getStudentInTenant(userId, ...)` — never a request id). `/me/services` reads the institution's
      `institutionModule` rows via `tx.institutionModule.findMany({ where: { institutionId, state:
      "ACTIVE" } })` and maps ACTIVE module keys to self-service entry points.
      Files: `apps/api/src/server.ts`, `apps/api/src/routes/admin.ts`, `apps/api/src/routes/auth.ts`,
      `apps/api/src/routes/student.ts`
      Verify: step 16.

- [ ] 16. FEAT-002 build gate.
      Files: (none)
      Verify: `cd apps/api && npx tsc` compiles clean; `npm run build` (repo root) succeeds.

- [ ] 17. Unit-test the transition service (DB-free). Add
      `apps/api/src/services/__tests__/student-sis.test.ts` covering each transition's changeType +
      snapshot, the `updateStudentSchema.strict()` rejection, and the resolve-first update/create/skip
      decision.
      Files: `apps/api/src/services/__tests__/student-sis.test.ts`
      Verify: `cd apps/api && npx vitest run src/services/__tests__/student-sis.test.ts` — all green.

---

## FEAT-003 — tests, escape-suite extension, regression, and the full gate

- [ ] 18. Extend the escape helper for the two new tenant-owned tables. In
      `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`: add `"student_profile_history"`
      and `"student_documents"` to `RLS_TABLES`; add
      `student_profile_history: ["tenant_isolation_select", "student_profile_history_tenant_insert"]`
      to `EXPECTED_POLICIES` (append-only pair) but do NOT add `student_documents` (it must fall
      through to `DEFAULT_POLICIES`); add `studentDocumentId` to `SeededTenant` + seed one
      `student_documents` row per tenant via `adminClient`; give the generalized `student_profiles`
      seed row `status` + optional structured links; do NOT seed `student_profile_history` (the
      trigger blocks even adminClient — audit_events/revision precedent); add `student_documents`
      to `cleanup` (child-first, before `studentProfile`) and `countRemainingTestRows`; leave
      `student_profile_history` out of cleanup/count.
      Files: `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`
      Verify: step 23.

- [ ] 19. Add the escape assertions + the append-only self-contained test to
      `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts`: cross-tenant read denied,
      spoofed-tenant write rejected, foreign-parent composite-FK violation, the deliberately-buggy
      unfiltered-query backstop, the three-GUC-state fail-closed check, and the append-only
      enforcement (campass_app UPDATE/DELETE on `student_profile_history` denied) within one tenant
      with no teardown. Extend the policy meta-test so `student_profile_history` is asserted
      append-only (and carries no `tenant_isolation_modify`) and `student_documents` standard-pair,
      both ENABLE+FORCE.
      Files: `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts`
      Verify: step 23.

- [ ] 20. Add the four roadmap-named behavioral tests. Permitted-mutable-field enforcement
      (`PATCH /students/:id` forbidden key → 400, permitted keys → 200 + UPDATED history);
      no-duplicate-identity (create/register with existing `enrollmentNo` → 409; re-import a CSV with
      an existing `enrollmentNo` → row updated not duplicated, `results.updated` increments, count
      stays 1; direct second insert rejected by the unique backstop); preserve-history
      (promote/transfer/deactivate write correct snapshots, history rejects UPDATE/DELETE, no student
      ever deleted); self-service scoping (`GET /me/profile` returns only the caller's record; `GET
      /me/services` lists only ACTIVE-module services and drops a flipped-to-SUSPENDED module).
      Files: new test files under `apps/api/src/routes/__tests__/` (and/or
      `apps/api/src/services/__tests__/` for pure parts)
      Verify: step 23.

- [ ] 21. Add the GatePass / allowance / reliability regression suite (§9.1): full gate-pass
      lifecycle against a generalized student; allowance + reliability compute identically with null
      and with populated structured links; a `GRADUATED` student's historical passes still read.
      Files: new regression test file under `apps/api/src/routes/__tests__/` or
      `apps/api/src/services/__tests__/`
      Verify: step 23.

- [ ] 22. Full clean build from a pristine install.
      Files: (none)
      Verify: from repo root — `npm ci` → `cd packages/shared && npx tsc` → `npx prisma generate
      --schema=packages/db/prisma/schema.prisma` → `cd apps/api && npx tsc` → `npm run build` — all
      succeed.

- [ ] 23. Full test suite green + live smoke. Run the entire suite (includes the real-DB escape +
      behavioral + regression tests against live Supabase, reading the untouched `.env` files). Then
      a minimal live smoke: the API boots after `migrate deploy`, a `students.*` admin route serves,
      and a self-service `/me/profile` read returns the caller's record.
      Files: (none)
      Verify: `cd apps/api && npx vitest run` — all green (the pre-existing suite plus the new Phase-2
      tests); retry transient pooler errors.

---

## Notes / assumptions

- Decision locks carried from the design: relation field named `structuredProgram`; `program`/
  `semester` retained (coexistence, no trigger sync); global `enrollmentNo UNIQUE` kept; export stays
  on `admin.students.export` (six `students.*` keys + `students.view_own`, no `students.export`);
  `StudentDocument` built as a minimal reference table (no routes); importer writes
  `students.student.imported` while the legacy `admin.students.imported` key is retained unused;
  HOD gets view + in-department enroll/promote/update, not create/deactivate.
- The exact `<ts>` for the migration dir is produced at authoring time from the system clock; wherever
  this plan writes `<ts>_phase2_sis`, use that concrete directory name consistently (schema reference,
  `SEEDING_MIGRATION_DIRS`, and the escape-suite table list are the three places that must agree).
- No gap blocks implementation; every open item in the design (§14 A1–A6) is resolved with a locked
  decision above.
