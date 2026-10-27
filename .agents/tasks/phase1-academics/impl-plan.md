# Implementation Plan — CAMPASS Phase 1: Shared Institutional Data

The first real ERP data phase on the LIVE Phase-0 foundation. Implements the APPROVED
design at `.agents/tasks/phase1-academics/design.md` (reviewer verdict APPROVED in
`design-review.md`). Additive only: the six FROZEN migrations are untouched; ONE new
migration (`phase1_academics`) is added. Work on `main`, NO worktree. Do NOT push or deploy.
The app must keep working at every step — in particular the allowance-engine's existing
`AcademicCalendarDay` reads must not break.

## Working context (read before starting)

- Repo: `c:\campusgate` — Turborepo monorepo (npm workspaces, NOT pnpm), Windows/PowerShell.
  Prisma `6.19.3` (NOT upgraded to the 8.x RC the deploy log advertises).
- Build (the CLEAN sequence, from repo root unless noted):
  1. `npm ci`
  2. `cd packages/shared && npx tsc`  (rebuild @campusgate/shared so `dist` is current
     BEFORE api/seed consume the new catalogue keys)
  3. (root) `npx prisma generate --schema=packages/db/prisma/schema.prisma`
  4. `cd apps/api && npx tsc`
  5. (root) `npm run build` (turbo build across workspaces)
- Tests: `cd apps/api && npx vitest run`. The escape suite + the calendar/route integration
  tests hit live Supabase and read `apps/api/.env` + `packages/db/.env`. Leave those `.env`
  files untouched and NEVER stage them.
- Migrations: six exist and are FROZEN (`..._init`, `..._add_allowance_and_reliability_models`,
  `..._tenancy_isolation_rls` [B-1], `..._identity_rbac_b2`, `..._superadmin_security`,
  `..._module_system`). Add exactly ONE new migration. Author it with
  `cd packages/db && npx prisma migrate dev --create-only --name phase1_academics`, hand-edit
  the generated `migration.sql`, then apply with `npx prisma migrate deploy`. NEVER run
  `prisma migrate dev` (without `--create-only`) against the shared Supabase DB. The free-tier
  pooler pauses on inactivity — retry transient `P1001` / `tenant or user not found` /
  `Can't reach database server` errors rather than treating them as logic failures (the
  escape harness `withRetry` documents this pattern).
- House-style references to mirror exactly:
  - Migration DDL / RLS / GRANT / append-only trigger / catalogue seed:
    `packages/db/prisma/migrations/20261019053533_superadmin_security/migration.sql` and
    `.../20261019093119_module_system/migration.sql`.
  - `withTenant`, `privilegedPrisma`, `DbClient`: `packages/db/src/index.ts`.
  - `recordAuditEvent(input, tx?)` + `sanitizeMetadata`: `apps/api/src/services/audit.ts`.
  - Shared catalogues: `packages/shared/src/{permissions,audit-actions,validation}.ts` + `index.ts`.
  - Live calendar handlers: `apps/api/src/routes/admin.ts` (`GET/PUT/DELETE /academic-calendar...`).
  - Allowance engine: `apps/api/src/services/allowance-engine.ts` (`getRemainingAllowance`).
  - Auth surface: `apps/api/src/middleware/auth.ts` (`RequestAuth`, `authenticate`).
  - Escape harness: `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` +
    `tenant-escape.integration.test.ts`.
  - catalogue-sync meta-test: `apps/api/src/services/__tests__/catalogue-sync.test.ts`.

## Hard ordering constraints (design §8)

- The migration (items 3–4) and the new routes (item 5) ship in the same deployable;
  `migrate deploy` runs before the API boots. There is no new-gate 403 window (academics is
  NOT a gated module — Decision A), so ordering is a correctness-of-reads concern: the new
  tables/columns must exist before any new route serves.
- Rebuild `@campusgate/shared` (item 1 verify) before the api/seed steps consume the new keys.
- The `academic_calendar_day_revisions` table is append-only at the DB layer (INSERT-only RLS,
  `REVOKE UPDATE,DELETE` from `campass_app`, and a `BEFORE UPDATE OR DELETE` trigger that binds
  every role). Its escape coverage and teardown are handled specially (item 7), mirroring how
  `audit_events` is kept out of the shared escape `cleanup()`.

---

- [ ] 1. Add the `academics.*` permission keys + audit action keys to the shared catalogues and rebuild `dist`.
      In `packages/shared/src/permissions.ts`: add four `academics`-module permissions to
      `PERMISSIONS` — `academics.sessions.manage`, `academics.programs.manage`,
      `academics.calendar.manage`, `academics.view` — and bind them in `ROLE_PERMISSIONS`:
      ADMIN gains all four; STUDENT, GUARD, and HOD each gain `academics.view`. Leave
      `admin.academic_calendar.manage` in place (retained, route-unused — design §7.3 A3).
      In `packages/shared/src/audit-actions.ts`: add the twelve `academics.*` keys to
      `AUDIT_ACTIONS` (`academics.session.created|updated|activated|closed`,
      `academics.term.created|updated|activated|closed`, `academics.program.created|updated`,
      `academics.calendar.updated`) each module `"academics"`; do NOT touch
      `LEGACY_AUDIT_ACTION_MAP` (the live handlers keep writing `admin.academic_calendar.updated`
      only until item 5 re-points them). Do NOT change `modules.ts` (`academic_sessions` stays
      a dependency-graph placeholder — Decision A §1.3).
      Files: `c:\campusgate\packages\shared\src\permissions.ts`,
      `c:\campusgate\packages\shared\src\audit-actions.ts`.
      Verify: `cd c:\campusgate\packages\shared && npx tsc` compiles clean and refreshes `dist`.
      (catalogue-sync will fail until the migration seed in item 4 and the test-dir addition in
      item 6 land — expected until then.)

- [ ] 2. Add the five enums + four new models to the Prisma schema and extend `AcademicCalendarDay`.
      In `c:\campusgate\packages\db\prisma\schema.prisma`: add enums
      `AcademicSessionStatus { UPCOMING ACTIVE CLOSED }`, `AcademicStructureType { SEMESTER
      TRIMESTER ANNUAL CUSTOM }`, `AcademicTermStatus { UPCOMING ACTIVE CLOSED }`,
      `ProgramStatus { ACTIVE INACTIVE }`, `ProgramDurationUnit { TERMS YEARS }`. Add models
      `AcademicSession`, `AcademicTerm`, `Program`, `AcademicCalendarDayRevision` exactly as
      design §3.2/§4.1/§4.3 (all tenant-owned: `institutionId` + `institution` relation,
      `@@unique([id, institutionId])`, `@@index([institutionId])`, plus the natural-key uniques
      `(institutionId, name)` on sessions, `(academicSessionId, ordinal)` on terms,
      `(institutionId, code)` on programs). Add the three nullable columns to
      `AcademicCalendarDay` (`departmentId`, `academicSessionId`, `academicTermId`) with their
      optional relations, and **remove** the `@@unique([institutionId, date])` from
      `AcademicCalendarDay` (the migration replaces it with two partial unique indexes Prisma
      cannot model — §4.2; the handler rewrite in item 5 stops using the compound-unique input).
      Add all back-relations on `Institution`, `Department`, `AcademicSession`, `AcademicTerm`.
      Files: `c:\campusgate\packages\db\prisma\schema.prisma`.
      Verify: (root) `npx prisma generate --schema=packages/db/prisma/schema.prisma` succeeds
      (schema validates, client regenerates with the new delegates and WITHOUT the
      `institutionId_date` compound-unique input on `academicCalendarDay`).

- [ ] 3. Author the NEW `phase1_academics` migration (tables + enums + FKs + partial uniques + RLS + GRANT + append-only trigger + catalogue seed).
      Run `cd c:\campusgate\packages\db && npx prisma migrate dev --create-only --name
      phase1_academics` (create-only; never plain `migrate dev` on Supabase). Hand-edit the
      generated `migration.sql` to contain, in this order (mirroring `module_system` /
      `superadmin_security`):
      (a) `CREATE TYPE` the five new enums;
      (b) `CREATE TABLE` `academic_sessions`, `academic_terms`, `programs`,
          `academic_calendar_day_revisions` with PKs, the `(id, institutionId)` composite
          uniques, the natural-key uniques (`(institutionId,name)`, `(academicSessionId,ordinal)`,
          `(institutionId,code)`), and `institutionId` indexes;
      (c) `ALTER TABLE "academic_calendar_days" ADD COLUMN` the three nullable columns;
      (d) tenant-root FKs (`institutionId → institutions(id)`, `ON DELETE RESTRICT`) on all four
          new tables; composite same-tenant FKs (incl. `institutionId`) for
          `academic_terms → academic_sessions` (RESTRICT), `programs → departments` (RESTRICT),
          and the three new `academic_calendar_days` links (department RESTRICT; session/term
          `ON DELETE SET NULL`) — exact DDL in design §3.2/§4.1/§4.2;
      (e) swap the calendar unique: `DROP INDEX "academic_calendar_days_institutionId_date_key"`;
          create the two partial unique indexes `..._inst_date_institutionwide`
          (`WHERE "departmentId" IS NULL`) and `..._inst_date_dept` (`WHERE "departmentId" IS NOT NULL`);
      (f) the partial unique `academic_sessions_one_active_per_institution`
          (`ON "academic_sessions"("institutionId") WHERE "status" = 'ACTIVE'`);
      (g) `DO $$` block: `ENABLE` + `FORCE` RLS on all four new tables. `academic_sessions`,
          `academic_terms`, `programs` get the standard fail-closed `nullif`-guarded pair
          (`tenant_isolation_select` FOR SELECT + `tenant_isolation_modify` FOR ALL). The
          revision table gets the append-only pair — `tenant_isolation_select` (FOR SELECT) +
          `academic_calendar_day_revisions_tenant_insert` (FOR INSERT WITH CHECK) and NO modify
          policy — byte-for-byte the `audit_events` shape;
      (h) the append-only trigger: function `academic_calendar_day_revisions_append_only()`
          raising `restrict_violation` and trigger `academic_calendar_day_revisions_no_update_delete`
          `BEFORE UPDATE OR DELETE` on every row (mirror the `audit_events_append_only` /
          `audit_events_no_update_delete` function+trigger split — design-review NIT 1);
      (i) guarded idempotent `campass_app` GRANT in a `DO $$ ... IF EXISTS (pg_roles...)`:
          `GRANT SELECT, INSERT, UPDATE, DELETE` on the three mutable tables (no REVOKE);
          `GRANT SELECT, INSERT` on the revision table and `REVOKE UPDATE, DELETE` from
          `campass_app` on it (the `audit_events` pin). Never BYPASSRLS;
      (j) seed the four `academics.*` permissions + their `role_permissions` pairs (ADMIN × all
          four; STUDENT/GUARD/HOD × `academics.view`) using the EXACT markers the catalogue-sync
          parser keys on (`INSERT INTO "permissions" (...) VALUES (...) ON CONFLICT ("key") DO
          NOTHING;` and `INSERT INTO "role_permissions" (...) SELECT ... FROM (VALUES ...) AS
          m("roleKey","permKey") JOIN ... ON CONFLICT ("roleId","permissionId") DO NOTHING;`).
      No backfill is needed (brand-new tables, no existing rows). Do NOT edit any FROZEN migration.
      Files: `c:\campusgate\packages\db\prisma\migrations\<ts>_phase1_academics\migration.sql` (new).
      Verify: the SQL parses by eye against the `superadmin_security` template; applied + asserted
      in item 4.

- [ ] 4. Apply the migration to live Supabase and regenerate the client.
      From `c:\campusgate\packages\db` run `npx prisma migrate deploy` (uses DIRECT_URL per
      `database.md`; retry transient pooler errors). Confirm it reports `<ts>_phase1_academics`
      applied. Then (root) `npx prisma generate --schema=packages/db/prisma/schema.prisma`. If
      `migrate deploy` reports drift, STOP and diagnose — do NOT force-reset the shared DB.
      Files: none (applies item 3).
      Verify: `npx prisma migrate deploy` exits 0 and lists the new migration; `cd packages/db
      && npx prisma migrate status` shows the DB up to date.

- [ ] 5. Extend the API surface: auth `departmentScope`, allowance-engine hardening, validation schemas, CalendarService, academic-session service, and the admin CRUD/lifecycle + non-admin read routes.
      (a) `apps/api/src/middleware/auth.ts`: add `departmentScope: string | null` to
          `RequestAuth`; add `departmentScope: true` to the tenant-actor membership `select`; set
          `departmentScope: membership.departmentScope` in the tenant-actor `request.auth` branch
          and `departmentScope: null` in the SUPER_ADMIN branch (design §5.5). Additive, read-only.
      (b) `apps/api/src/services/allowance-engine.ts`: add `departmentId: null` to the
          `academicCalendarDay.findMany` `where` in `getRemainingAllowance` (design §4.4) — the one
          required behavior-preserving clause that makes the institution-wide read deterministic.
      (c) `packages/shared/src/validation.ts`: add `createAcademicSessionSchema`,
          `createAcademicTermSchema`, `createProgramSchema`, and **extend**
          `upsertAcademicCalendarDaySchema` with optional `departmentId`, `academicSessionId`,
          `academicTermId` (additive — live callers stay valid). Shapes per design §11. Rebuild
          shared (`cd packages/shared && npx tsc`) so the api sees them.
      (d) `apps/api/src/services/calendar-service.ts` (new): the `CalendarService` read API —
          `CalendarEntry` interface, `getEntries(...)` and `effectiveDayType(...)` with the
          department-wins precedence rule (design §4.4). Runs on a passed `Prisma.TransactionClient`;
          never reads cross-tenant. The precedence logic is a pure function over fetched rows
          (unit-testable without a DB, §13). Do NOT refactor the allowance-engine onto it.
      (e) `apps/api/src/services/academic-session.ts` (new): the session/term state machine —
          `createSession`, `addTerm`, `activateSession`, `closeSession`, term activate/close — with
          the preconditions in design §5.1/§5.2: PATCH only while UPCOMING; activation requires ≥1
          term and each term `startDate < endDate`; exactly-one-ACTIVE enforced (service closes the
          current ACTIVE on `handover=true`, else 409; the partial unique index is the backstop);
          soft `warnings` (term-count vs `structureType` suggestion, term-outside-session,
          term-overlap) never block. Pure transition predicates where possible (§13). Lifecycle is
          status-only (preserve-history §6); the promotion seam is modelled, NOT executed — leave a
          comment naming it, touch NO `StudentProfile`.
      (f) `apps/api/src/routes/admin.ts`: add session CRUD + term CRUD + lifecycle
          (activate/close) under `requirePermission("academics.sessions.manage")`; program CRUD
          under `requirePermission("academics.programs.manage")`; and **rewrite** the three live
          calendar handlers (`GET/PUT/DELETE /academic-calendar...`) to drop the
          `institutionId_date` compound-unique input (gone in item 2) in favour of
          `findFirst`/`create`/`update` keyed on `(institutionId, date, departmentId ?? null)`,
          gated on `academics.calendar.manage`, writing an `AcademicCalendarDayRevision` row in the
          SAME `withTenant` transaction before each mutation and auditing `academics.calendar.updated`.
          All new/rewritten routes go through `withTenant`, are permission-gated only (NO
          `requireModuleActive` — Decision A), and audit via `recordAuditEvent(input, tx)` inside
          the transaction. Decide the success-plus-warnings envelope `{ <resource>, warnings:
          Array<{ code: string; message: string }> }` (design-review NIT 3).
      (g) non-admin reads: add `GET /me/academic/current-session` and
          `GET /me/academic/calendar?startDate&endDate` on `apps/api/src/routes/student.ts` under
          `requirePermission("academics.view")` + `withTenant`, department-narrowed via
          `CalendarService.getEntries` with `departmentId = request.auth.departmentScope ??
          undefined`. Add a code comment stating these carry NO `requireModuleActive` hook, unlike
          every peer route on `student.ts` (design-review NIT 2).
      Files: `c:\campusgate\apps\api\src\middleware\auth.ts`,
      `c:\campusgate\apps\api\src\services\allowance-engine.ts`,
      `c:\campusgate\packages\shared\src\validation.ts`,
      `c:\campusgate\apps\api\src\services\calendar-service.ts` (new),
      `c:\campusgate\apps\api\src\services\academic-session.ts` (new),
      `c:\campusgate\apps\api\src\routes\admin.ts`,
      `c:\campusgate\apps\api\src\routes\student.ts`.
      Verify: `cd c:\campusgate\packages\shared && npx tsc` then `cd c:\campusgate\apps\api &&
      npx tsc` both compile clean.

- [ ] 6. Extend the seed for the DEMO institution.
      In `c:\campusgate\packages\db\src\seed.ts`, after the membership upserts, add idempotent
      upserts (operating on the existing `institution` / `bca` objects, NOT a `findMany`): one
      `AcademicSession` `"2026-2027"` `SEMESTER` `ACTIVE` keyed on `(institutionId, name)`; two
      `AcademicTerm`s (`"Semester 1"` ordinal 1 ACTIVE, `"Semester 2"` ordinal 2 UPCOMING) keyed
      on `(academicSessionId, ordinal)`; two `Program`s keyed on `(institutionId, code)` — `BCA`
      under the `bca` department (code `512`) and `BTECH-CSE` under the `501` department (look up
      via `institutionId_code`), both `TERMS`/`duration 6`; and a few calendar entries (one
      institution-wide `HOLIDAY`, one institution-wide `WORKING_DAY`, one BCA-department-scoped
      `EXAM_DAY`) via the `findFirst`+`create`/`update` approach from item 5 (not the removed
      compound upsert), linked to the session. Do NOT seed revision rows. Mirror the seed's
      `console.log("  ✓ ...")` style.
      Files: `c:\campusgate\packages\db\src\seed.ts`.
      Verify: `cd c:\campusgate\packages\db && npx tsc` type-checks (or `npx tsx --check src/seed.ts`);
      the regenerated client from item 4 exposes `academicSession` / `academicTerm` / `program`.

- [ ] 7. Extend the cross-tenant escape suite to every new tenant-owned table.
      In `c:\campusgate\apps\api\src\routes\__tests__\helpers\tenant-escape-setup.ts`: add
      `"academic_sessions"`, `"academic_terms"`, `"programs"`, `"academic_calendar_day_revisions"`
      to `RLS_TABLES`; register `academic_calendar_day_revisions` in `EXPECTED_POLICIES` as
      `["tenant_isolation_select", "academic_calendar_day_revisions_tenant_insert"]` (the other
      three use `DEFAULT_POLICIES`). Seed each tenant (A, B) an `AcademicSession` (+1 term), a
      `Program`, and a department-scoped calendar entry via `adminClient`; capture their ids on
      `SeededTenant`. Add the three MUTABLE new tables to `cleanup()` (deleted child-first: terms
      before sessions; programs before departments; all before the institution, because the
      tenant-root FKs are `ON DELETE RESTRICT`) AND to `countRemainingTestRows()`. Do NOT add
      `academic_calendar_day_revisions` to the shared `cleanup()`/`countRemainingTestRows()`
      seed-and-delete path (the append-only trigger blocks even `adminClient` — follow the
      `audit_events` precedent and seed NO revision rows here; its escape behavior is covered by
      its own self-contained test in item 8). In
      `c:\campusgate\apps\api\src\routes\__tests__\tenant-escape.integration.test.ts`: extend the
      cross-tenant read-denied, spoofed-write-denied, buggy-query-backstop, and three-GUC-state
      fail-closed cases to the three mutable tables; add an assertion that `campass_app` cannot
      UPDATE or DELETE a revision row (the REVOKE + the trigger). The RLS-forced meta-test (case 6)
      already iterates `RLS_TABLES`, so it covers the new tables once added.
      Files: `c:\campusgate\apps\api\src\routes\__tests__\helpers\tenant-escape-setup.ts`,
      `c:\campusgate\apps\api\src\routes\__tests__\tenant-escape.integration.test.ts`.
      Verify: `cd c:\campusgate\apps\api && npx vitest run src/routes/__tests__/tenant-escape.integration.test.ts`
      — green, teardown row count 0 (needs live Supabase + the `.env` files).

- [ ] 8. Add the Phase-1 behavioral tests (configurable structure, one-active, preserve-history/calendar/revision, allowance-engine regression, routes/permissions/audit) and update catalogue-sync.
      Add the new migration dir `"<ts>_phase1_academics"` to `SEEDING_MIGRATION_DIRS` in
      `c:\campusgate\apps\api\src\services\__tests__\catalogue-sync.test.ts` so the union includes
      the four `academics.*` permissions. Add Vitest files covering design §10.2–§10.6:
      (a) configurable-structure — SEMESTER+2 terms and ANNUAL+1 term both activate cleanly;
          TRIMESTER+2 activates with a warning; ANNUAL+0 terms is rejected;
      (b) one-active invariant — second activate without handover → 409; with handover the old
          session flips CLOSED and exactly one ACTIVE remains (partial-unique backstop);
      (c) preserve-history — closing/advancing a session leaves its terms and linked rows intact
          and readable;
      (d) calendar revision (self-contained, own prefix) — create/update/delete through the
          handler path writes revisions capturing previous values + actor; a DELETE revision
          survives the row deletion; `campass_app` UPDATE/DELETE on a revision is rejected;
          cross-tenant read denied; fail-closed GUC. Its teardown disables/recreates the trigger
          within its own `adminClient` DDL scope, never touching the shared escape `cleanup()`;
      (e) calendar-scope — an institution-wide HOLIDAY and a department-scoped EXAM_DAY on the same
          date coexist; `CalendarService.getEntries` returns both with the department entry winning
          in `effectiveDayType`; without the department it returns the institution-wide one;
      (f) allowance-engine regression — `getRemainingAllowance` computes working-day consumption
          identically with the new nullable columns present, and deterministically returns the
          institution-wide result when an institution-wide and a department-scoped row share a date
          (the `departmentId: null` clause from item 5b);
      (g) routes/permissions/audit — admin CRUDs sessions/terms/programs/calendar; a role without
          `academics.sessions.manage` → 403; a student with `academics.view` reads the current
          session but cannot mutate; each mutation writes the expected `academics.*` audit row
          (re-read `audit_events`); cross-tenant route access → not-found.
      Place DB-touching integration tests under `apps/api/src/routes/__tests__/`; pure-logic tests
      (precedence, term-count suggestion, transition predicates) under
      `apps/api/src/services/__tests__/`.
      Files: `c:\campusgate\apps\api\src\services\__tests__\catalogue-sync.test.ts` and new test
      files under `c:\campusgate\apps\api\src\routes\__tests__\` and
      `c:\campusgate\apps\api\src\services\__tests__\`.
      Verify: `cd c:\campusgate\apps\api && npx vitest run <new test paths>
      src/services/__tests__/catalogue-sync.test.ts src/services/__tests__/audit-actions.test.ts`
      — all green (live DB where tests use `withTenant`/RLS).

- [ ] 9. Full build + full test gate (the CLEAN sequence).
      From repo root, in order: `npm ci`; `cd packages/shared && npx tsc`; (root)
      `npx prisma generate --schema=packages/db/prisma/schema.prisma`; `cd apps/api && npx tsc`;
      (root) `npm run build`. Then `cd apps/api && npx vitest run` and confirm ALL green (the
      existing baseline plus the new tests). Fix any failure before proceeding; do not leave red.
      Clean up any throwaway scratch files created during debugging.
      Files: none (verification).
      Verify: every command exits 0; `vitest run` reports 0 failures and a total ≥ the prior
      baseline plus the new tests.

---

## Phase-2 (SIS) seams explicitly left for later (do NOT build)

- No `StudentProfile` FK to `Program`/`AcademicSession` (even nullable) — forward-compat is
  paid on the parent side via `(id, institutionId)` composite uniques (design §3.4 / A4).
- Promotion / session-transition that touches student records is modelled only (the seam in
  §6.3); Phase 1 executes none of it.
- `academic_sessions` stays in `MODULE_DEPENDENCIES` as a placeholder; no module row/guard/graph
  edit for academics (Decision A / A1).
- `admin.academic_calendar.manage` is retained route-unused rather than deleted (A3).

## Stop contract (loop)

The implement-and-review loop stops when
`c:\campusgate\.agents\tasks\phase1-academics\impl-review.json` has `"verdict": "APPROVED"`.
The implementer runs first; the verdict-writing reviewer runs last.
