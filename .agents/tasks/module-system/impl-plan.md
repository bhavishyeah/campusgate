# Implementation Plan — CAMPASS Module Entitlement / Activation / Dependency System

Phase 0 final foundation piece (the "booster model", `architecture.md` §5). This plan
implements the APPROVED design at `.agents/tasks/module-system/design.md` (reviewer
verdict APPROVED in `design-review.md`). It replaces the permit-all `requireModuleActive`
stub with real server-side enforcement backed by a new tenant-owned `InstitutionModule`
table, a shared module registry + dependency graph, platform (entitlement) and
institution (activation) endpoints, audit, and tests.

## Working context (read before starting)

- Repo: `c:\campusgate` — Turborepo monorepo (npm workspaces), Windows/PowerShell.
  Work on `main`, NO worktree. Do NOT push or deploy. Commit specific files only; never
  commit `.env` (the two `.env` files at `packages/db/.env` and `apps/api/.env` carry live
  Supabase secrets and are needed by the escape suite — leave them untouched and unstaged).
- Build (the CLEAN Railway sequence, run from repo root unless noted):
  1. `npm ci`
  2. `cd packages/shared && npx tsc`
  3. `npx prisma generate --schema=packages/db/prisma/schema.prisma`  (from repo root)
  4. `cd apps/api && npx tsc`
  5. `npm run build` (from repo root; turbo build across workspaces)
- Tests: `cd apps/api && npx vitest run` — baseline is 188 passing (23 test files). All
  must stay green and new tests added here must pass. The escape suite + the module
  integration tests hit live Supabase and use the `.env` files.
- Repo convention: any build-time `@types/*` a non-dev build step needs go in
  `dependencies`, NOT `devDependencies` (see `apps/api/package.json`, which already lists
  `@types/node`, `@types/bcrypt`, etc. under `dependencies`). This task is not expected to
  add a new `@types/*`; if one becomes necessary, place it in `dependencies`.
- Migrations: 5 exist and are FROZEN (`..._init`, `..._tenancy_isolation_rls` [B-1],
  `..._identity_rbac_b2`, `..._superadmin_security`, plus the allowance model). Add exactly
  ONE NEW migration. Author it with
  `cd packages/db && npx prisma migrate dev --create-only --name module_system`, hand-edit
  the generated `migration.sql`, then apply with `npx prisma migrate deploy`. NEVER run
  `prisma migrate dev` (without `--create-only`) against the shared Supabase DB.
- House-style references to mirror exactly:
  - Migration DDL / RLS / GRANT style: `packages/db/prisma/migrations/20261019053533_superadmin_security/migration.sql`.
  - `privilegedPrisma`, `withTenant`, `recordAuditEvent(input, tx?)`: `packages/db/src/index.ts`, `apps/api/src/services/audit.ts`.
  - Shared catalogues: `packages/shared/src/{permissions,audit-actions}.ts` + `index.ts`.
  - Escape harness: `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` + `tenant-escape.integration.test.ts`.

## Hard ordering constraint (design §5, §7.3)

The backfill migration, the real `requireModuleActive` body, AND the route wiring are one
atomic unit of delivery. The stub rewrite is inert until the guard is wired (it is wired
onto zero routes today). Land the migration (item 2) and apply it (item 3) BEFORE wiring
the guard (item 10), so the backfill is present before any enforcing route serves. Keep
the app buildable at every step; enforcement only becomes live once item 10 lands.

---

- [ ] 1. Add the module registry + dependency graph to `packages/shared`.
      Create `packages/shared/src/modules.ts` with: `ModuleDef` interface; `MODULES`
      const array (9 keys — `campus_movement`, `student_management`, `academic_sessions`,
      `class_course`, `student_enrollment`, `attendance`, `examinations`, `fees`,
      `library`) `as const satisfies readonly ModuleDef[]`; `ModuleKey` type;
      `MODULE_KEYS`; `MODULE_KEY_SET`; and `MODULE_DEPENDENCIES: Record<ModuleKey,
      readonly ModuleKey[]>` transcribing the §5.4 edges verbatim (attendance →
      student_management+academic_sessions+class_course; examinations →
      academic_sessions+class_course+student_enrollment; fees → student_management; all
      others `[]`). Use the exact shapes in design §2. Add `export * from "./modules.js";`
      to `packages/shared/src/index.ts`.
      Files: `packages/shared/src/modules.ts`, `packages/shared/src/index.ts`.
      Verify: `cd packages/shared && npx tsc` compiles clean.

- [ ] 2. Add `admin.modules.manage` permission + 4 audit-action keys to the shared catalogues.
      In `packages/shared/src/permissions.ts`: add `{ key: "admin.modules.manage", module:
      "admin", description: "Activate / suspend / view the institution's modules" }` to
      `PERMISSIONS`, and add `"admin.modules.manage"` to `ROLE_PERMISSIONS.ADMIN`.
      (`platform.entitlements.manage` already exists and is SUPER_ADMIN-bound — do not add
      a platform permission.) In `packages/shared/src/audit-actions.ts`: add four keys to
      `AUDIT_ACTIONS` — `platform.module.entitled`, `platform.module.revoked` (module
      `"platform"`), `admin.module.activated`, `admin.module.suspended` (module `"admin"`),
      each a 3-segment `<module>.module.<action>` key. Do NOT touch `LEGACY_AUDIT_ACTION_MAP`.
      Files: `packages/shared/src/permissions.ts`, `packages/shared/src/audit-actions.ts`.
      Verify: `cd packages/shared && npx tsc` clean. (catalogue-sync will fail until the
      migration seed in item 2.5 lands + item 11 updates the test — expected until then.)

- [ ] 3. Add the `ModuleState` enum + `InstitutionModule` model to the Prisma schema.
      In `packages/db/prisma/schema.prisma`: add `enum ModuleState { ENTITLED ACTIVE
      SUSPENDED }` in the ENUMS block, add the `InstitutionModule` model exactly as design
      §1.1 (fields: `id` cuid PK, `institutionId`, `institution` relation, `moduleKey`,
      `state` default ENTITLED, `entitledAt` default now, `activatedAt?`, `suspendedAt?`,
      `settings Json?`, `entitledByUserId?`, `activatedByUserId?`, `suspendedByUserId?`,
      `updatedAt @updatedAt`, `@@unique([institutionId, moduleKey])`,
      `@@unique([id, institutionId])`, `@@index([institutionId])`,
      `@@map("institution_modules")`), and add the `institutionModules InstitutionModule[]`
      back-relation to the `Institution` model.
      Files: `packages/db/prisma/schema.prisma`.
      Verify: from repo root `npx prisma generate --schema=packages/db/prisma/schema.prisma`
      succeeds (schema validates, client regenerates).

- [ ] 4. Create the NEW migration (table + RLS + GRANT + catalogue seed + backfill + guard).
      Run `cd packages/db && npx prisma migrate dev --create-only --name module_system`
      (against the local/dev target only — never plain `migrate dev` on Supabase). Then
      hand-edit the generated `.../migrations/<ts>_module_system/migration.sql` so it
      contains, in this order (mirroring `superadmin_security`):
      (a) `CREATE TYPE "ModuleState" AS ENUM ('ENTITLED','ACTIVE','SUSPENDED');`
      (b) `CREATE TABLE "institution_modules"` with all columns + PK;
      (c) `@@unique` indexes as `CREATE UNIQUE INDEX` on `(institutionId, moduleKey)` and
          `(id, institutionId)`, plus `CREATE INDEX` on `institutionId`;
      (d) composite/tenant-root FK
          `institution_modules_institution_same_tenant_fkey` → `institutions(id)`
          `ON DELETE RESTRICT ON UPDATE CASCADE`;
      (e) `DO $$` block: `ENABLE` + `FORCE` RLS and the fail-closed `nullif`-guarded policy
          pair `tenant_isolation_select` (FOR SELECT) and `tenant_isolation_modify`
          (FOR ALL, USING + WITH CHECK) — exact SQL in design §1.3;
      (f) guarded `campass_app` GRANT `SELECT, INSERT, UPDATE, DELETE` (full DML — tenant
          writes here; no REVOKE, unlike audit_events) inside an
          `IF EXISTS (... pg_roles ... 'campass_app')` block; never BYPASSRLS;
      (g) permission seed block for `admin.modules.manage` using the EXACT markers the
          catalogue-sync parser keys on: `INSERT INTO "permissions" (...) VALUES (...) ON
          CONFLICT ("key") DO NOTHING;` and `INSERT INTO "role_permissions" (...) SELECT ...
          FROM (VALUES ('ADMIN','admin.modules.manage')) AS m("roleKey","permKey") JOIN ...
          ON CONFLICT ("roleId","permissionId") DO NOTHING;` (copy the shape from
          superadmin_security §2b);
      (h) the `campus_movement` ACTIVE backfill INSERT for every `code <> 'PLATFORM'`
          institution, `ON CONFLICT ("institutionId","moduleKey") DO NOTHING`, with
          `entitledAt`+`activatedAt`+`updatedAt` = now() (design §5.1);
      (i) the `DO $$ ... RAISE EXCEPTION` backfill invariant guard that aborts if any
          non-PLATFORM institution lacks an ACTIVE campus_movement row (design §5.1).
      Do NOT edit any FROZEN migration.
      Files: `packages/db/prisma/migrations/<ts>_module_system/migration.sql` (new).
      Verify: the file parses as valid SQL by eye against the superadmin_security template;
      applied + asserted in item 5.

- [ ] 5. Apply the migration to live Supabase and sanity-check the table/backfill.
      From `packages/db` run `npx prisma migrate deploy` (uses DIRECT_URL / privileged
      session pooler per `database.md`). Confirm it reports the new migration applied and
      the invariant guard did NOT raise. Then regenerate the client from repo root:
      `npx prisma generate --schema=packages/db/prisma/schema.prisma`.
      Files: none (applies item 4).
      Verify: `npx prisma migrate deploy` exits 0 and lists `<ts>_module_system` as applied;
      a quick `npx prisma migrate status` from `packages/db` shows the DB up to date. If
      `migrate deploy` reports drift or the guard raises, STOP and diagnose before
      proceeding (do not force-reset the shared DB).

- [ ] 6. Mirror the backfill in the seed script.
      In `packages/db/src/seed.ts`, right after the `ensureMembership(...)` calls (~line
      304-308, before the final success log), add an idempotent upsert of a
      `campus_movement` module row for the demo `institution` object the seed created (NOT
      a `findMany`, NOT the PLATFORM institution): `prisma.institutionModule.upsert({ where:
      { institutionId_moduleKey: { institutionId: institution.id, moduleKey:
      "campus_movement" } }, update: {}, create: { institutionId: institution.id, moduleKey:
      "campus_movement", state: "ACTIVE", entitledAt: new Date(), activatedAt: new Date() }
      })`, with a `console.log("  ✓ ...")` line matching the seed's style.
      Files: `packages/db/src/seed.ts`.
      Verify: `cd packages/db && npx tsc` (or `npx tsx --check src/seed.ts`) type-checks;
      the client from item 5 exposes `institutionModule`. (Full seed run is covered by the
      live smoke test, item 14.)

- [ ] 7. Create the module-system service (state machine) with typed result contracts.
      Create `apps/api/src/services/module-system.ts` exporting the state-machine functions
      that run on a passed `Prisma.TransactionClient`/`DbClient`: `entitle`, `revoke`,
      `activate`, `suspend`, plus the pure helpers `missingDependencies(moduleKey, rowsByKey)`
      and `affectedDependents(moduleKey, rowsByKey)` (reverse-edge set over ACTIVE+SUSPENDED).
      Type the results as discriminated unions per the review NIT 2, e.g. `ActivateResult =
      { ok: true; module } | { ok: false; reason: "NOT_ENTITLED" } | { ok: false; reason:
      "DEPS_UNMET"; missingDependencies: ModuleKey[] }`, and a `SuspendResult` carrying
      `affectedDependents: ModuleKey[]`. `activate` applies the single satisfaction predicate
      (dep satisfies iff its row exists AND state=ACTIVE) identically for ENTITLED→ACTIVE and
      SUSPENDED→ACTIVE, direct-deps only (inductive, §3), reads deps within the same tx,
      sets ACTIVE/activatedAt/actor and clears suspendedAt on success. `suspend` does
      ACTIVE→SUSPENDED in place (history preserved) and computes `affectedDependents`. Do
      NOT add any force-activate/bypass path. Name the future `requiredConfigSatisfied` seam
      in a comment (no impl, A5).
      Files: `apps/api/src/services/module-system.ts` (new).
      Verify: `cd apps/api && npx tsc` compiles clean.

- [ ] 8. Replace the `requireModuleActive` stub with real enforcement.
      In `apps/api/src/services/authz-engine.ts`: add `import { privilegedPrisma } from
      "@campusgate/db"` and `import type { ModuleKey } from "@campusgate/shared"`; narrow
      the exported signature to `requireModuleActive(moduleKey: ModuleKey)`; implement the
      preHandler exactly as design §7.1 — 401 when `request.auth` unset (same defensive
      branch as `requirePermission`); read `institutionId` from `request.auth` ONLY; point
      read `privilegedPrisma.institutionModule.findUnique({ where: { institutionId_moduleKey:
      { institutionId, moduleKey } }, select: { state: true } })`; fail CLOSED to 500 on
      throw; 403 `{ error: "Module not active: <key>" }` when no row or state !== "ACTIVE".
      Files: `apps/api/src/services/authz-engine.ts`.
      Verify: `cd apps/api && npx tsc` clean. (The existing permit-all unit test in
      `authz-engine.test.ts` will now be wrong — it is updated in item 12; leave it for now,
      the compile is what this step verifies.)

- [ ] 9. Add the platform entitlement endpoints to `routes/platform.ts`.
      Inside `platformRoutes` (already guarded by `requireSuperAdmin()` +
      `requirePlatformMfa()`), add three routes each with `preHandler:
      [requirePermission("platform.entitlements.manage")]`, all writes on `privilegedPrisma`,
      each writing a platform audit event via `recordAuditEvent` (no `tx` → privileged path;
      `institutionId` = target tenant; `actorMembershipId: null`; `actorUserId` /
      `actorRoleKey` from `request.auth`): (a) `POST /institutions/:id/modules` grant —
      validate `moduleKey ∈ MODULE_KEY_SET` (400) and institution exists (404), upsert to
      ENTITLED (idempotent no-op if a row already exists), audit `platform.module.entitled`;
      (b) `DELETE /institutions/:id/modules/:moduleKey` revoke — scan dependents with the
      MANDATORY `privilegedPrisma.institutionModule.findMany({ where: { institutionId: id }
      })`, block 409 if any ACTIVE or SUSPENDED module declares `:moduleKey` as a dep (list
      them + states), else delete the row and audit `platform.module.revoked` with
      `affectedDependents` (comma-joined scalar) + `affectedDependentsCount` in metadata;
      (c) `GET /institutions/:id/modules` list — iterate the static `MODULES` catalogue,
      default no-row keys to `NOT_ENTITLED`, mapping from the same mandatory
      `where:{institutionId:id}` findMany. Reuse the service helpers from item 7 for the
      reverse-edge math. Import `MODULES`/`MODULE_KEY_SET`/`MODULE_DEPENDENCIES`/`ModuleKey`
      from `@campusgate/shared`.
      Files: `apps/api/src/routes/platform.ts`.
      Verify: `cd apps/api && npx tsc` clean.

- [ ] 10. Add the institution activation endpoints to `routes/admin.ts`.
      Inside `adminRoutes` (top-level `authenticate` hook already runs), add three routes
      each `preHandler: [requirePermission("admin.modules.manage")]`, all via `withTenant`,
      auditing inside the same transaction via `recordAuditEvent(input, tx)`: (a) `POST
      /modules/:moduleKey/activate` → call `activate()` (tx), map `NOT_ENTITLED`→404,
      `DEPS_UNMET`→409 `{ error, moduleKey, missingDependencies }`, success→audit
      `admin.module.activated`; (b) `POST /modules/:moduleKey/suspend` → `suspend()` (tx),
      return `warnings.affectedDependents`, audit `admin.module.suspended` with the
      `affectedDependents`/`affectedDependentsCount` scalars; (c) `GET /modules` → iterate
      static `MODULES`, map from a `withTenant` `findMany` with NO explicit filter (RLS
      scopes it), default no-row keys to `NOT_ENTITLED`. Phase-0 activate/suspend take NO
      body (ignore any `settings`) per review NIT 3.
      Files: `apps/api/src/routes/admin.ts`.
      Verify: `cd apps/api && npx tsc` clean.

- [ ] 11. Wire `requireModuleActive("campus_movement")` onto the GatePass tenant routes.
      This is the step that makes enforcement live — it MUST land after items 4-5 (backfill
      present). Import `requireModuleActive` alongside `requirePermission` in `student.ts`,
      `hod.ts`, `guard.ts`, `admin.ts`. Add it to the `preHandler` array AFTER
      `requirePermission(...)` on EVERY route whose permission key is in the
      `campus_movement.*` namespace — in `student.ts`, `hod.ts`, `guard.ts` that is every
      per-route guard; in `admin.ts` the `campus_movement.analytics.view`
      (`GET /stats`, `GET /analytics`), `campus_movement.audit.view` (`GET /audit-logs`),
      and `campus_movement.emergency.view` (`GET /emergency/active`, `GET /emergency`)
      routes, PLUS any other `campus_movement.*`-keyed admin routes. EXCLUDE the one named
      carve-out: `GET /admin/support-grants` (~line 2011, keyed `campus_movement.audit.view`
      but a break-glass/support surface) — do NOT gate it. Do NOT gate platform routes,
      pre-auth routes, the new module-management routes, or `admin.*`-keyed routes.
      Files: `apps/api/src/routes/{student,hod,guard,admin}.ts`.
      Verify: `cd apps/api && npx tsc` clean; `grep` the four files to confirm every
      `campus_movement.*` route (except `GET /support-grants`) now carries both guards —
      then confirm by the enforcement tests in item 13.

- [ ] 12. Add the `modules` registry/graph meta-test.
      `packages/shared` has NO test files and NO vitest runner of its own; the only runner
      is `apps/api` whose `vitest.config.ts` includes `src/**/*.test.ts` ONLY. So place the
      test at `apps/api/src/services/__tests__/modules.test.ts` (alongside
      `audit-actions.test.ts`), importing `MODULES`/`MODULE_KEYS`/`MODULE_KEY_SET`/
      `MODULE_DEPENDENCIES` from `@campusgate/shared`. Assert `MODULE_KEYS` uniqueness,
      `MODULE_KEY_SET` consistency, every key/value in `MODULE_DEPENDENCIES` is a known
      `MODULE_KEY`, and the graph is acyclic (cheap DFS).
      Files: `apps/api/src/services/__tests__/modules.test.ts` (new).
      Verify: `cd apps/api && npx vitest run src/services/__tests__/modules.test.ts` — green.

- [ ] 13. Update catalogue/audit meta-tests and the permit-all enforcement pin.
      In `apps/api/src/services/__tests__/catalogue-sync.test.ts` add the new migration dir
      `"<ts>_module_system"` to `SEEDING_MIGRATION_DIRS` so the union includes
      `admin.modules.manage`. In `apps/api/src/services/__tests__/authz-engine.test.ts`
      REPLACE the permit-all `requireModuleActive` describe block with real tests: with a
      mocked `privilegedPrisma.institutionModule.findUnique`, assert 403 when the row is
      SUSPENDED and when there is no row (NOT_ENTITLED); allow (no reply) when ACTIVE; 500
      fail-closed when the read throws; 401 when `request.auth` is unset.
      Files: `apps/api/src/services/__tests__/catalogue-sync.test.ts`,
      `apps/api/src/services/__tests__/authz-engine.test.ts`.
      Verify: `cd apps/api && npx vitest run src/services/__tests__/catalogue-sync.test.ts
      src/services/__tests__/authz-engine.test.ts src/services/__tests__/audit-actions.test.ts`
      — all green.

- [ ] 14. Extend the cross-tenant escape suite for `institution_modules`.
      In `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`: add
      `"institution_modules"` to `RLS_TABLES` (no `EXPECTED_POLICIES` entry — it uses the
      default pair); seed each tenant (A, B) a `campus_movement` `institution_modules` row
      via `adminClient` in `seedTenant` and capture its id on `SeededTenant`; add the table
      to `cleanup()` DELETED CHILD-FIRST (before the `institution` delete, because the FK is
      `ON DELETE RESTRICT`); add it to `countRemainingTestRows()` (else a leaked row is
      uncounted and the `=== 0` assertion loses coverage). In
      `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts` extend the
      cross-tenant read-denied, spoofed-write-denied, buggy-query-backstop, and
      three-GUC-state fail-closed cases to the new table.
      Files: `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`,
      `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts`.
      Verify: `cd apps/api && npx vitest run src/routes/__tests__/tenant-escape.integration.test.ts`
      — green, teardown row count 0 (needs live Supabase + the `.env` files).

- [ ] 15. Add the dependency-validation + suspend/revoke + audit-persistence integration tests.
      Add a new test file under `apps/api/src/services/__tests__/` (or `routes/__tests__/`
      alongside the escape suite if it needs the live DB + `withTenant`). Cover, per design
      §9.2: using the declared `attendance` edge — entitle `attendance`, leave
      `student_management` inactive, assert `activate` returns 409 /
      `DEPS_UNMET` with the missing keys; then activate the three deps and assert `attendance`
      activates (ACTIVE, activatedAt set). Add (a) a SUSPENDED-dependency 409 case (suspended
      key appears in `missingDependencies`), (b) a reactivation SUSPENDED→ACTIVE re-running
      the predicate. Unit-test `affectedDependents` (suspending `student_management` with
      `fees`/`attendance` ACTIVE or SUSPENDED lists them). Audit-persistence: after a
      suspend/revoke with dependents, re-read the persisted `audit_events` row and assert
      `metadata.affectedDependents` (joined string) + `affectedDependentsCount`; companion
      empty case persists `""` / `0`. Revoke tenant-scoping: seed the same `fees →
      student_management` edge ACTIVE in two institutions, platform-revoke
      `student_management` from A, assert the 409 lists only A's `fees`, never B's.
      Files: new test file(s) under `apps/api/src/...__tests__/`.
      Verify: `cd apps/api && npx vitest run <new test path>` — green (live DB where the test
      uses `withTenant`/RLS).

- [ ] 16. Full build + full test gate (the CLEAN sequence).
      From repo root run, in order: `npm ci`; `cd packages/shared && npx tsc`; (root)
      `npx prisma generate --schema=packages/db/prisma/schema.prisma`; `cd apps/api && npx
      tsc`; (root) `npm run build`. Then `cd apps/api && npx vitest run` and confirm ALL
      green (188 baseline + the new tests). If any `@types/*` was added for a build step,
      confirm it is under `dependencies` not `devDependencies`. Fix any failure before
      proceeding; do not leave red.
      Files: none (verification). Clean up any throwaway scratch files created during
      debugging.
      Verify: every command above exits 0; `vitest run` reports 0 failures and a total ≥ the
      baseline plus the new tests.

- [ ] 17. LIVE smoke test of the end-to-end lifecycle.
      With the API running against live Supabase (`cd apps/api && npm run dev`, or the built
      server), prove, as real HTTP calls (document the exact requests/responses in the PR /
      commit notes): (a) the existing GatePass flow still works for the demo tenant (a
      student/HOD/guard campus-movement route returns 200, not 403 — backfill worked); (b)
      platform grant → institution activate → suspend → reactivate lifecycle, each returning
      the expected status and writing an `audit_events` row (query the row back); (c)
      dependency validation returns 409 with `missingDependencies` on a synthetic
      `attendance` activate with deps inactive; (d) a suspended `campus_movement` makes a
      GatePass route 403 `{ error: "Module not active: campus_movement" }`, and reactivating
      restores 200; (e) cross-tenant isolation — a tenant's `GET /admin/modules` shows only
      its own states. Restore `campus_movement` to ACTIVE for the demo tenant at the end so
      the environment is left working.
      Files: none (manual/live verification). Do NOT push or deploy.
      Verify: each scenario observed as described; the demo tenant ends with
      `campus_movement` ACTIVE and GatePass flows working.

- [ ] 18. Commit the specific changed files on `main`.
      Stage ONLY the files this task changed (the new `modules.ts`, shared catalogue edits,
      `schema.prisma`, the new migration dir, `seed.ts`, `module-system.ts`,
      `authz-engine.ts`, `platform.ts`, `admin.ts`, `student.ts`, `hod.ts`, `guard.ts`, the
      escape helper + integration test, the new/updated test files). NEVER stage `.env`
      files. Commit with a clear message (e.g. `feat(module-system): entitlement/activation/
      dependency enforcement`). Do NOT push.
      Files: git index (specific paths only).
      Verify: `git status` shows a clean tree except the intended commit; `git show --stat`
      lists exactly the intended files and no `.env`.

---

## Notes / assumptions carried from the design (for the implementer)

- `NOT_ENTITLED` = absence of a row; the enum holds only ENTITLED/ACTIVE/SUSPENDED.
- Audit metadata MUST avoid array/object values AND keys matching
  `/password|token|secret|mfa|qr/i` (`sanitizeMetadata` drops both). The scalar names
  `affectedDependents` / `affectedDependentsCount` are safe — do not rename them into that
  pattern (review NIT 1).
- The revoke dependent-scan and the platform list findMany run on `privilegedPrisma`
  (RLS-bypassed); the `where: { institutionId: id }` filter is MANDATORY on both.
- The admin `GET /modules` findMany runs under `withTenant` and takes NO explicit filter
  (RLS scopes it).
- `code <> 'PLATFORM'` is the deliberate sole definition of "tenant institution" for
  Phase 0 (design §5.1).
- The design reviewer did NOT re-run builds/tests. Even where code looks like it already
  satisfies a requirement, the verification steps above still exercise it — run them.

## Stop contract

The implement-and-review loop stops when
`.agents/tasks/module-system/impl-review.json` has `"verdict": "APPROVED"`. The implementer
runs first; the verdict-writing reviewer runs last.
