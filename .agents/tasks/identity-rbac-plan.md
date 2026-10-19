# CAMPASS Phase 0 — Identity & RBAC (B2) Implementation Plan

Derived from the APPROVED design `c:\campusgate\.agents\tasks\identity-rbac-design.md` and the live docs `docs/identity-rbac.md` (§3–§8), `docs/tenancy.md`, `docs/superadmin-security.md`, `docs/database.md`. AUTH-CRITICAL work on `main`, NO worktree. The app must stay buildable and working at every step (the compatibility shim keeps legacy role guards passing throughout).

## Ground rules discovered during exploration (read before starting)

- **Package manager is npm + Turborepo**, NOT pnpm. The design text uses `pnpm --filter`; the real commands are `npm run <script> --workspace <pkg>` or `cd <pkg> && npx <cmd>`. Prisma CLI is `6.19.3` (do NOT upgrade to the 8.x RC the deploy log advertises).
- **`@campusgate/shared` resolves at runtime to `./dist/index.js`** (built output), while `types` points at `./src/index.ts`. So any new export in `packages/shared/src` MUST be compiled (`npm run build --workspace @campusgate/shared`, i.e. `tsc`) before `apps/api` (tsx/node) or the seed (`tsx`) can import it at runtime. `@campusgate/db` and `@campusgate/api` consume `.ts` directly. This build-order is load-bearing.
- **Migrations run as `postgres` via `DIRECT_URL`** (session pooler, 5432) from `packages/db`. Runtime tenant client is `campass_app` via `DATABASE_URL` (6543, `pgbouncer=true`). Privileged client is `PRIVILEGED_DATABASE_URL` (postgres, 6543), falling back to `DIRECT_URL` then `DATABASE_URL`. These are already configured in `packages/db/.env` and `apps/api/.env`.
- **B-1 migration `20261018110658_tenancy_isolation_rls` is FROZEN** — never edit it. Its exact patterns (NULLABLE-add → backfill → `DO $$ RAISE EXCEPTION` guard → `SET NOT NULL` → composite uniques → composite FKs `ON DELETE RESTRICT ON UPDATE CASCADE` → `DO $$ FOREACH` RLS ENABLE+FORCE + `tenant_isolation_select`/`tenant_isolation_modify` → idempotent `campass_app` GRANT block) are the templates the new migration mirrors.
- **The existing parent uniques the new composite FKs target already exist from B-1**: `users_id_institutionId_key`, `departments_id_institutionId_key`.
- **Each GatePass route file installs exactly ONE top-level role hook** (`guard.ts`→`requireTenantRole("GUARD")`, `student.ts`→`STUDENT`, `hod.ts`→`HOD`, `admin.ts`→`ADMIN`); `platform.ts`→`requireSuperAdmin()`; `notifications.ts`→bare `authenticate`. `requireTenantRole`/`requireRole`/`requireSuperAdmin` call `authenticate` internally today — so authentication is owned by the role guard, NOT a separate hook.
- **The escape suite runs under normal `npm test`** in `apps/api` (vitest `include` matches `src/**/*.test.ts`); `tenant-escape.integration.test.ts` hits the LIVE Supabase DB via `apps/api/.env` (campass_app) + `packages/db/.env` (postgres). Its `cleanup()` asserts `countRemainingTestRows() === 0`.
- There is **no root AGENTS.md / CONTRIBUTING / `.kiro/steering`**; README documents npm workspace + turbo conventions.

Scope is identity-rbac.md §3–§8 (NOT §9). `User.role` and `User.institutionId` are KEPT for the whole phase (the shim needs them). No B-1 object is altered. `campass_app` never gets BYPASSRLS. MFA fields modelled only. `requireModuleActive` is a permissive stub; `canOnResource` is documented-only. Legacy `role` claim stays.

---

## Verification commands (used throughout)

- Prisma client + schema validity: `npx prisma validate --schema=packages/db/prisma/schema.prisma` and `npm run db:generate` (root) / `npx prisma generate` from `packages/db`.
- Shared build: `npm run build --workspace @campusgate/shared`.
- API typecheck/build: `npm run build --workspace @campusgate/api` (runs `prisma generate` + `tsc`).
- API tests (unit + integration incl. live escape suite): `npm test --workspace @campusgate/api` (i.e. `vitest run`). To run one file: `npx vitest run <path>` from `apps/api`.
- Migration against live Supabase: from `packages/db`, `npx prisma migrate dev --name identity_rbac_b2` (dev/author), `npx prisma migrate deploy` (apply). Seed: `npx tsx src/seed.ts` from `packages/db`.
- LIVE smoke: start the API (`npm run dev --workspace @campusgate/api` or the deployed Railway URL) and exercise login + a migrated route per role.

---

## Plan

- [ ] 1. Add the permission catalogue + role→permission map to `packages/shared`.
      Create `packages/shared/src/permissions.ts` exporting `PermissionDef` interface, `PERMISSIONS` (`as const satisfies readonly PermissionDef[]`) with every §4 key (`campus_movement.*`, `admin.*`, `platform.*`), `PermissionKey` type, `PERMISSION_KEYS`, and `ROLE_PERMISSIONS: Record<string, readonly PermissionKey[]>` holding the §5 map for STUDENT/GUARD/HOD/ADMIN/SUPER_ADMIN. Re-export both from `packages/shared/src/index.ts`. Keys MUST match §4 exactly (they are transcribed into the migration SQL in item 3 and checked set-equal by the meta-test in item 10).
      Files: `packages/shared/src/permissions.ts`, `packages/shared/src/index.ts`
      Verify: `npm run build --workspace @campusgate/shared` compiles clean and emits `packages/shared/dist/index.js` exporting `PERMISSIONS`/`ROLE_PERMISSIONS`; `node -e "require('./packages/shared/dist/index.js').PERMISSIONS.length"` prints a non-zero count.

- [ ] 2. Add the RBAC models to the Prisma schema (schema only; migration is item 3).
      In `packages/db/prisma/schema.prisma`: add `enum MembershipStatus { ACTIVE SUSPENDED }`; add to `User` the fields `phone String?`, `mfaEnabled Boolean @default(false)`, `mfaSecret String?`, and `memberships InstitutionMembership[]`; add models `InstitutionMembership` (per §2.2: `permissionsVersion Int @default(0)`, `departmentScope String?`, `@@unique([userId, institutionId])`, `@@unique([id, institutionId])`, `@@index([institutionId])`, `@@index([userId])`, `@@map("institution_memberships")`), `Role` (§2.4: `institutionId String?`, `@@unique([key, institutionId])`, `@@index([institutionId])`, `@@map("roles")`), `Permission` (§2.3), `MembershipRole` (§2.5: `institutionId String`, `@@unique([membershipId, roleId])`, `@@index([institutionId])`, NO `@@unique([id, institutionId])`), `RolePermission` (§2.6); add the `Institution.memberships`/`Institution.roles` and other back-relations the new relations require. Do NOT add any DB-level id default (ids stay `@default(cuid())`).
      Files: `packages/db/prisma/schema.prisma`
      Verify: `npx prisma validate --schema=packages/db/prisma/schema.prisma` passes; `npx prisma generate` from `packages/db` regenerates the client with the new models.

- [ ] 3. Hand-author the `identity_rbac_b2` migration mirroring the B-1 patterns.
      From `packages/db`, scaffold with `npx prisma migrate dev --name identity_rbac_b2 --create-only`, then REPLACE the generated SQL with the ordered script per design §3.1: (1) CREATE the five tables with the two tenant tables' `institutionId` NULLABLE; (2) single-column FKs (`membership_roles.roleId→roles`, `role_permissions.roleId→roles`+`permissionId→permissions`, `institution_memberships.institutionId→institutions`, `roles.institutionId→institutions`); (2a) partial unique index `roles_key_template_unique ON "roles"("key") WHERE "institutionId" IS NULL`; (2b) in-migration seed in order permissions→roles→role_permissions (hand-transcribed from `@campusgate/shared` `PERMISSIONS`+`ROLE_PERMISSIONS`, `ON CONFLICT DO NOTHING`); (3a) membership backfill `'mbr_'||gen_random_uuid()::text` excluding `role='SUPER_ADMIN'` AND users on the PLATFORM institution; (3c) membership-role backfill `'mrl_'||gen_random_uuid()::text` joining `users.role`→template `roles.key`; (4) `SET NOT NULL` on both `institutionId` columns + the two `DO $$ RAISE EXCEPTION` guards (null-tenant guard, and the exactly-one-membership-role guard with the §3.1-step-4 SQL/message verbatim); (5) `institution_memberships_id_institutionId_key` composite unique + the three composite FKs (`(userId,institutionId)→users` RESTRICT; `(departmentScope,institutionId)→departments` RESTRICT MATCH SIMPLE; `(membershipId,institutionId)→institution_memberships` RESTRICT) + plain uniques; (6) indexes; (7) RLS `DO $$ FOREACH ARRAY['institution_memberships','membership_roles']` ENABLE+FORCE + both policies; (8) the idempotent `campass_app` GRANT `DO $$ IF EXISTS` block. NO `CREATE EXTENSION`. The two global tables (`permissions`,`roles`,`role_permissions`) get NO RLS.
      Files: `packages/db/prisma/migrations/<ts>_identity_rbac_b2/migration.sql`
      Verify: from `packages/db`, `npx prisma migrate dev` (or `migrate deploy`) against live Supabase applies with no error and the two guards do NOT raise; then `npx prisma migrate status` shows the migration applied.

- [ ] 4. Make the seed idempotent for the new RBAC entities.
      Edit `packages/db/src/seed.ts` per §3.2: upsert catalogue permissions from `@campusgate/shared` `PERMISSIONS`; resolve the five template roles with find-first-then-create on `(key, institutionId:null)` (NOT a null composite upsert); upsert `role_permissions` from `ROLE_PERMISSIONS`; for each demo user ensure a membership (`upsert` on `(userId, institutionId)`) + `membership_roles.upsert` on `(membershipId, roleId)` bound to the template role matching `user.role` — EXCEPT `superadmin@campusgate.local` which gets NO membership. Keep all existing user `role` enums.
      Files: `packages/db/src/seed.ts`
      Verify: `npm run build --workspace @campusgate/shared` first (seed imports dist), then from `packages/db` `npx tsx src/seed.ts` completes without error and is safe to re-run (run twice; second run makes no duplicates).

- [ ] 5. Extend the JWT payload/user types and the `authenticate` middleware.
      In `apps/api/src/middleware/auth.ts`: extend the `FastifyJWT` `payload`/`user` with `membershipId: string | null`, `roles: string[]`, `permissions: string[]`, `permissionsVersion: number | null` (KEEP `role`, `institutionId`, `jti`). Extend `authenticate` per §6.3: keep every existing check (jwtVerify, session revoke, accountStatus ACTIVE, institution ACTIVE); for non-SUPER_ADMIN load the membership by `(userId, institutionId)` via `privilegedPrisma` selecting `{ id, membershipStatus, permissionsVersion, roles→role.key, role.permissions.permission.key }`; 401 if missing, 403 if SUSPENDED, 500 fail-closed on DB error; apply the `permissionsVersion` freshness compare (re-resolve via the shared `resolvePermissions` helper on mismatch); attach `request.auth`; set `request.tenant = { institutionId }` ONLY for tenant actors; SUPER_ADMIN branch skips membership load, sets `membershipId:null`/`permissionsVersion:null`, leaves `request.tenant` undefined; keep `request.user` populated (incl. legacy `role`).
      Files: `apps/api/src/middleware/auth.ts`
      Verify: `npm run build --workspace @campusgate/api` typechecks clean. (Behavioural verification lands with items 7 and 9's tests.)

- [ ] 6. Build the central authz engine.
      Create `apps/api/src/services/authz-engine.ts` (leave existing `authz.ts` untouched): `can(auth, permission)` (pure `auth.permissions.includes`); `requirePermission(key)` preHandler — pure can-check, NO internal `authenticate`; 401 logged at ERROR with route+key if `request.auth` unset (wiring-bug defensive path), 403 logged at INFO if `!can`; `requireModuleActive(moduleKey)` permissive stub carrying the exact marker comment `// PHASE-0 STUB: permits all; real module-activation enforcement lands in the module-entitlement phase`; `canOnResource` present only as a documented comment (not exported). Add the shared `resolvePermissions(roles)` normalizer (`[...new Set(keys)].sort()`) used by both login and the authenticate re-resolve path; export it so item 5 and item 7 import the same function.
      Files: `apps/api/src/services/authz-engine.ts` (and import of `resolvePermissions` from item 5)
      Verify: `npm run build --workspace @campusgate/api` typechecks clean.

- [ ] 7. Resolve roles/permissions at login and sign the dual-shape token.
      In `apps/api/src/routes/auth.ts` `/login`: after the existing checks, for a non-SUPER_ADMIN load the membership (via `privilegedPrisma`) + its roles/permissions and compute `roles`/`permissions` via `resolvePermissions` + read `permissionsVersion`; for SUPER_ADMIN use platform roles/permissions, `membershipId:null`, `permissionsVersion:null`. Sign the canonical payload `{ userId, membershipId, institutionId, roles, permissions, permissionsVersion, role, jti }` (KEEP legacy `role`). Response body unchanged otherwise.
      Files: `apps/api/src/routes/auth.ts`
      Verify: `npm run build --workspace @campusgate/api` typechecks; add/extend a unit test asserting the signed payload carries both `permissions` and legacy `role`; `npx vitest run` from `apps/api` for that test passes.

- [ ] 8. Add unit tests for the engine and middleware branches.
      Add tests (mocked `@campusgate/db`, no DB) covering: `can()`; `resolvePermissions` dedup+sort and login-vs-re-resolve byte-identity; `ROLE_PERMISSIONS` resolution (roles→expected set); `requirePermission` 403-on-missing / pass-on-present with mocked `request.auth`; the `requireModuleActive` permit-all pin; authenticate's SUPER_ADMIN vs membership branch; the `permissionsVersion` mismatch→re-resolve path.
      Files: new test files under `apps/api/src/services/__tests__/` and/or `apps/api/src/middleware/__tests__/`
      Verify: `npx vitest run` from `apps/api` — the new unit tests pass and the existing suite stays green.

- [ ] 9. Extend the escape suite for the two new tenant tables (teardown FIRST, then assertions).
      In `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`: add `institution_memberships` and `membership_roles` to `RLS_TABLES`; in `cleanup()` add child-first `adminClient.membershipRole.deleteMany({ where })` then `adminClient.institutionMembership.deleteMany({ where })` BEFORE the user/department/institution deletes (respecting the new RESTRICT composite FKs); add both tables to `countRemainingTestRows()`; extend `seedTenant()` if the new tests seed memberships (deterministic `PREFIX` ids). In `tenant-escape.integration.test.ts` add a `membership_roles` read-escape test and a spoofed-tenant-insert test. The teardown change MUST land in the same commit as the new RLS tables or the `countRemainingTestRows()===0` assertion breaks across runs.
      Files: `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`, `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts`
      Verify: `npx vitest run src/routes/__tests__/tenant-escape.integration.test.ts` from `apps/api` (live DB) — meta-test 6 now covers the two new tables and all escape tests pass; teardown leaves zero rows.

- [ ] 10. Add the catalogue-sync CI meta-test.
      Add a static-parse test (e.g. `packages/db/src/__tests__/catalogue-sync.test.ts` or alongside the api unit tests) that reads the `identity_rbac_b2` `migration.sql`, extracts its embedded permission keys and `(roleKey, permissionKey)` pairs, and asserts set-equality against `PERMISSIONS` + `ROLE_PERMISSIONS` from `@campusgate/shared`; fail on drift. Pin it to this specific migration file by name.
      Files: new test file; may need a vitest config/include if placed in `packages/db`
      Verify: the test runs under the chosen runner and passes against the item-3 migration; introduce a deliberate drift locally to confirm it fails, then revert.

- [ ] 11. Flip GUARD routes to `requirePermission` (proving ground, first group).
      In `apps/api/src/routes/guard.ts`: REPLACE the single top-level `app.addHook("preHandler", requireTenantRole("GUARD"))` with `app.addHook("preHandler", authenticate)` and add per-route `requirePermission(<key>)` per the §7 table (`gate.verify`/`mark_exit`/`mark_return`/`lookup`, `shift.manage_own`, `emergency.view`). Record-level ownership checks (`getGuardInTenant`) stay unchanged. Add a before/after auth-regression assertion (GUARD token still passes; a non-GUARD token still 403s).
      Files: `apps/api/src/routes/guard.ts` (+ regression test)
      Verify: `npm run build --workspace @campusgate/api` typechecks; `npx vitest run` from `apps/api` — guard route tests + regression pass, full suite green.

- [ ] 12. Flip STUDENT routes.
      `apps/api/src/routes/student.ts`: replace the `requireTenantRole("STUDENT")` hook with `authenticate` + per-route `requirePermission` (`pass.request`, `pass.cancel`, `pass.view_own`, `emergency.view`) per the §7 table. Add the regression assertion.
      Files: `apps/api/src/routes/student.ts` (+ regression test)
      Verify: `npx vitest run` from `apps/api` passes; full suite green.

- [ ] 13. Flip HOD routes.
      `apps/api/src/routes/hod.ts`: replace the `requireTenantRole("HOD")` hook with `authenticate` + per-route `requirePermission` (`pass.view_department`, `pass.approve`, `pass.reject`, `pass.revoke`, `pass.override`, `emergency.view`). Add the regression assertion.
      Files: `apps/api/src/routes/hod.ts` (+ regression test)
      Verify: `npx vitest run` from `apps/api` passes; full suite green.

- [ ] 14. Flip ADMIN routes (largest surface) and complete the `admin.*` key column.
      `apps/api/src/routes/admin.ts`: replace the `requireTenantRole("ADMIN")` hook with `authenticate` + per-route `requirePermission` mapping each route to its §4 `admin.*`/`campus_movement.*` key (users/students/departments/gates/guard-shifts/reasons/allowance-policy/institution-config/academic-calendar/audit-logs/stats/analytics + pass.revoke/emergency.*). Add the regression assertion. `platform.ts` and `notifications.ts` are LEFT UNCHANGED.
      Files: `apps/api/src/routes/admin.ts` (+ regression test)
      Verify: `npx vitest run` from `apps/api` passes; full suite green including the live escape + auth-regression tests.

- [ ] 15. Full build + LIVE smoke test, then finalize.
      Run the whole build and test suite; apply the migration (`migrate deploy`) + seed against live Supabase if not already; start the API live and verify: login for each role returns a token with `permissions`+legacy `role`; a GUARD token works on `/guard/verify` and 403s a STUDENT; HOD/ADMIN/STUDENT migrated routes behave as before; SUPER_ADMIN still 403s on tenant routes and 200s on `/platform/stats`; session revocation still blocks. Confirm `User.role`/`User.institutionId` and the legacy `role` claim remain in place (removal is a later phase).
      Files: none (verification + commits)
      Verify: `npm run build` (root turbo) and `npm test --workspace @campusgate/api` all green; the live smoke checks above pass; commit locally on `main` (never push; pushing/deploy is the user's step per their workflow).

---

## Gaps / assumptions

- The catalogue-sync meta-test's home runner (item 10): `packages/db` has no vitest today. Assumption: place it under `apps/api` unit tests (which already run vitest) importing both `@campusgate/shared` and reading the migration file by relative path, to avoid standing up a new test runner in `packages/db`. If the implementer prefers `packages/db`, add a minimal vitest config there.
- Live Supabase latency from a local machine (documented in `database.md`) can make migrate/seed/escape-suite runs slow or intermittently P1001; retry rather than treat as failure (the escape harness already has `withRetry`). This does not affect correctness.
- The design is the authority for any SQL detail not re-quoted here; this plan sequences it and pins the real npm/turbo/prisma commands for this repo.
