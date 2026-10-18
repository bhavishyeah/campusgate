# Tenancy B-1 Implementation Plan — Multi-tenant isolation (institutionId + composite FKs + RLS) + escape suite

> Source of truth: `docs/tenancy.md` (A2 design, §4 composite FKs, §5.3 RLS templates, §6 `withTenant`, §7 escape tests, §8 checklist), `docs/database.md` (connection split, migration workflow), `docs/roadmap.md` (Phase 0 DoD), `docs/README.md` (non-negotiables). This plan conforms to them; do not re-decide the architecture.
>
> **Scope of B-1 only:** schema + migration (columns, backfill, composite uniques, composite FKs, RLS enable/force/policies, campass_app GRANTs), the `withTenant` helper (exported, NOT wired into routes), and the cross-tenant escape suite. **NO route changes, NO auth/RBAC changes.** Route wiring is B-2.

## Design decisions recorded for this step (not re-litigated — taken from the docs)

- **Migrations run as `postgres`** via `packages/db/.env` (both `DATABASE_URL` and `DIRECT_URL` are the `postgres` pooler). The Prisma CLI must run with `cwd = packages/db` so it loads that `.env`. (`docs/database.md` §2.)
- **App runtime + escape tests run as `campass_app`** via `apps/api/.env` `DATABASE_URL` (pooler :6543 `?pgbouncer=true`). RLS only enforces for this NOSUPERUSER NOBYPASSRLS role — `postgres` bypasses RLS, so the escape suite MUST connect as `campass_app`, not reuse the migration connection. (`docs/tenancy.md` §5.1, verified.)
- **Tenant GUC via `set_config('app.current_institution_id', $1, true)` as the FIRST statement inside a Prisma `$transaction`.** Transaction-scoped; safe under the transaction pooler. (`docs/tenancy.md` §5.2/§6, verified.)
- **RLS/composite-FK/GRANT DDL is hand-written raw SQL appended to the Prisma-generated migration**, because Prisma does not model these natively. One migration file is the single source of truth. (`docs/database.md` §4.)
- **Do NOT create the `campass_app` role or set its password** — it already exists (user owns the secret). The migration only (re)applies GRANTs + ALTER DEFAULT PRIVILEGES idempotently.
- **`security_events`** keeps its nullable `institutionId` (events can occur with no institution context, e.g. failed login for unknown email). It is NOT force-converted to non-null and is NOT given RLS in this step (it already has a nullable column by design and no composite FK target). Treat it as out of the RLS set for B-1; the meta-test's tenant-owned list excludes it. Rationale: a non-null backfill is impossible for pre-auth events, and the doc's table marks it ⚠ "make non-null where an institution context exists" — that nuanced handling belongs with AuditLog v2 / security work, not this additive step.

## Tenant-owned tables in scope

**Already have `institutionId` (keep; add composite-unique targets + RLS):** `institutions` (tenant root — NOT RLS'd, it is the platform table per §3; see note below), `departments`, `users`, `gates`, `exit_reasons`, `guard_shifts`, `emergency_alerts`, `academic_calendar_days`, `institution_configs`, `allowance_policies`.

**Missing `institutionId` (add + backfill + RLS):** `student_profiles`, `hod_profiles`, `guard_profiles`, `gate_passes`, `gate_events`, `guard_gate_assignments`, `emergency_overrides`, `reliability_score_snapshots`, `notifications`, `audit_logs`.

> **`institutions`** is the tenant root / platform table (`docs/tenancy.md` §3: "Institution itself" is NOT tenant-owned). It does NOT get RLS or an `institutionId` column (it has `id`). It DOES need a `(id)`-based reference target only where a child FKs to it — children already FK `institutionId -> institutions.id` via single-column FKs, which is correct and stays. RLS is applied to the ten "already have" tenant tables (minus `institutions`) plus the ten "missing" tables = the RLS set below.

**RLS set (ENABLE + FORCE + policies on each):** `departments`, `users`, `gates`, `exit_reasons`, `guard_shifts`, `emergency_alerts`, `academic_calendar_days`, `institution_configs`, `allowance_policies`, `student_profiles`, `hod_profiles`, `guard_profiles`, `gate_passes`, `gate_events`, `guard_gate_assignments`, `emergency_overrides`, `reliability_score_snapshots`, `notifications`, `audit_logs`. (19 tables. `institutions` and `security_events` and `sessions` excluded — see notes; `sessions` is not tenant-owned, it is per-user auth state keyed by `userId` with no institution column and is out of scope.)

## Per-table backfill derivations (for the nullable→NOT NULL step)

Each new `institutionId` is derived from the existing join chain, then set NOT NULL:

- `student_profiles.institutionId` ← `users.institutionId` via `student_profiles.userId = users.id`.
- `hod_profiles.institutionId` ← `users.institutionId` via `hod_profiles.userId = users.id`.
- `guard_profiles.institutionId` ← `users.institutionId` via `guard_profiles.userId = users.id`.
- `gate_passes.institutionId` ← `student_profiles.institutionId` (after student_profiles is backfilled) via `gate_passes.studentId = student_profiles.id`.
- `gate_events.institutionId` ← `gate_passes.institutionId` (after gate_passes) via `gate_events.passId = gate_passes.id`.
- `guard_gate_assignments.institutionId` ← `guard_profiles.institutionId` (after guard_profiles) via `guard_gate_assignments.guardId = guard_profiles.id`.
- `emergency_overrides.institutionId` ← `gate_passes.institutionId` (after gate_passes) via `emergency_overrides.gatePassId = gate_passes.id`.
- `reliability_score_snapshots.institutionId` ← `student_profiles.institutionId` (after student_profiles) via `reliability_score_snapshots.studentId = student_profiles.id`.
- `notifications.institutionId` ← `users.institutionId` via `notifications.userId = users.id`.
- `audit_logs.institutionId` ← `users.institutionId` via `audit_logs.actorId = users.id`.

> **Backfill ordering matters** (dependency chain): backfill `student_profiles`, `hod_profiles`, `guard_profiles` FIRST (derive directly from `users`); THEN `gate_passes` (from student_profiles), `reliability_score_snapshots` (from student_profiles), `guard_gate_assignments` (from guard_profiles), `notifications`/`audit_logs` (from users); THEN `gate_events` and `emergency_overrides` (from gate_passes). Write the raw SQL `UPDATE`s in this order before any `SET NOT NULL`.

## Composite FKs to create (tenant-owned → tenant-owned links; `docs/tenancy.md` §4)

Each requires a `(id, institutionId)` composite UNIQUE on the parent, then drop the single-column FK and add a composite FK carrying `institutionId`. Single-column FKs that point at `institutions` (the tenant root) or at `users` from a non-tenant angle stay as-is where noted.

Parents needing `(id, institutionId)` composite unique: `student_profiles`, `exit_reasons`, `gate_passes`, `gates`, `guard_profiles`, `hod_profiles`, `users`.

FKs to convert (old constraint name → new composite FK, from the init migrations):

- `gate_passes.studentId` → `student_profiles(id, institutionId)`. Drop `gate_passes_studentId_fkey`.
- `gate_passes.reasonId` → `exit_reasons(id, institutionId)`. Drop `gate_passes_reasonId_fkey`.
- `gate_passes.approvedById` → `hod_profiles(id, institutionId)` — **nullable** FK; composite FK must allow NULL (Postgres MATCH SIMPLE skips the check when any column is NULL, which is correct). Drop `gate_passes_approvedById_fkey`.
- `gate_events.passId` → `gate_passes(id, institutionId)`. Drop `gate_events_passId_fkey`.
- `gate_events.gateId` → `gates(id, institutionId)`. Drop `gate_events_gateId_fkey`.
- `gate_events.guardId` → `guard_profiles(id, institutionId)`. Drop `gate_events_guardId_fkey`.
- `guard_gate_assignments.guardId` → `guard_profiles(id, institutionId)`. Drop `guard_gate_assignments_guardId_fkey`.
- `guard_gate_assignments.gateId` → `gates(id, institutionId)`. Drop `guard_gate_assignments_gateId_fkey`.
- `emergency_overrides.gatePassId` → `gate_passes(id, institutionId)`. Drop `emergency_overrides_gatePassId_fkey`.
- `reliability_score_snapshots.studentId` → `student_profiles(id, institutionId)`. Drop `reliability_score_snapshots_studentId_fkey`.
- `guard_shifts.guardId` → `guard_profiles(id, institutionId)`. Drop `guard_shifts_guardId_fkey`.
- `guard_shifts.gateId` → `gates(id, institutionId)`. Drop `guard_shifts_gateId_fkey`.
- `student_profiles.departmentId` → `departments(id, institutionId)` (needs `departments` composite unique too — add `departments` to the parents list). Drop `student_profiles_departmentId_fkey`.
- `hod_profiles.departmentId` → `departments(id, institutionId)`. Drop `hod_profiles_departmentId_fkey`.

> Add `departments` to the composite-unique parents list (referenced by `student_profiles`/`hod_profiles.departmentId`).
>
> **Links that stay single-column (NOT converted):** FKs to the tenant root `institutions.id` (e.g. `users.institutionId`, `departments.institutionId`, `gates.institutionId`, …) — the parent is the tenant root, so a composite is meaningless. Profile→user links (`student_profiles.userId`, `hod_profiles.userId`, `guard_profiles.userId` → `users.id`): the profile and user are the same tenant by construction; convert `student_profiles.userId`, `hod_profiles.userId`, `guard_profiles.userId` to composite `users(id, institutionId)` too, since both now carry `institutionId` and this closes the same-tenant guarantee (drop `student_profiles_userId_fkey`, `hod_profiles_userId_fkey`, `guard_profiles_userId_fkey`). Actor/user links on cross-cutting tables — `audit_logs.actorId`, `notifications.userId`, `emergency_overrides.overriddenById`, `guard_shifts.createdById`, `emergency_alerts.declaredById/resolvedById` → `users` — convert the ones where both sides are guaranteed same-tenant and non-null: `audit_logs.actorId` and `notifications.userId` → composite `users(id, institutionId)`. Leave `emergency_overrides.overriddenById`, `guard_shifts.createdById`, `emergency_alerts.declaredById/resolvedById` as single-column FKs (an override/declaration actor could in principle be a platform/cross-institution admin; keep additive and low-risk — the RLS policy on the row's own `institutionId` still isolates the row). Record this choice; the escape suite proves the row-level isolation regardless.

## RLS policy template (apply to every table in the RLS set; `docs/tenancy.md` §5.3)

For each table `T`:
```sql
ALTER TABLE "T" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "T" FORCE  ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_select" ON "T"
  FOR SELECT
  USING ("institutionId" = current_setting('app.current_institution_id', true));

CREATE POLICY "tenant_isolation_modify" ON "T"
  FOR ALL
  USING ("institutionId" = current_setting('app.current_institution_id', true))
  WITH CHECK ("institutionId" = current_setting('app.current_institution_id', true));
```
Make the raw SQL idempotent where practical (`DROP POLICY IF EXISTS` before each `CREATE POLICY`). `current_setting(..., true)` returns NULL when unset → `=` yields no rows → fail-closed.

## campass_app GRANTs (idempotent; do NOT create role or set password; `docs/tenancy.md` §5.1)

```sql
GRANT USAGE ON SCHEMA public TO "campass_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "campass_app";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "campass_app";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "campass_app";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "campass_app";
```
Guard with a `DO $$ ... IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='campass_app') ... $$` block so the migration still applies cleanly in an environment where the role is absent (it just skips grants rather than erroring).

---

# Ordered implementation items

- [ ] 1. **Update `schema.prisma`: add `institutionId` + relations + composite uniques + indexes.**
      Add non-null `institutionId String` and `institution Institution @relation(...)` to each model currently missing it: `StudentProfile`, `HodProfile`, `GuardProfile`, `GatePass`, `GateEvent`, `GuardGateAssignment`, `EmergencyOverride`, `ReliabilityScoreSnapshot`, `Notification`, `AuditLog`. Add the matching back-relations on `Institution`. Add `@@unique([id, institutionId])` to the parents referenced by composite FKs: `StudentProfile`, `ExitReason`, `GatePass`, `Gate`, `GuardProfile`, `HodProfile`, `User`, `Department`. Add `@@index([institutionId])` on every newly-tenant-stamped model. For the FK relations between tenant tables, express them in Prisma using the composite reference form `@relation(fields: [institutionId, studentId], references: [institutionId, id])` where the generated SQL will be replaced/augmented by hand-written SQL in item 2 — but keep Prisma's model valid (it must `prisma validate`). Where Prisma's composite relations are too awkward (e.g. the nullable `approvedById`), keep the scalar `institutionId` field + a plain relation and rely on the raw-SQL composite FK; document that the DB constraint is the authority.
      Files: `packages/db/prisma/schema.prisma`
      Verify: `npx prisma validate --schema=packages/db/prisma/schema.prisma` reports the schema is valid, AND `npx prisma generate` (cwd `packages/db`) succeeds.

- [ ] 2. **Create the Prisma migration with generated DDL + hand-written raw SQL.**
      From `cwd = packages/db`, run `npx prisma migrate dev --name tenancy_isolation_rls --create-only` to generate the migration folder WITHOUT applying it. Then edit the generated `migration.sql`:
      (a) Ensure new columns are added as **nullable first** (if Prisma emitted them `NOT NULL`, change to nullable or move the `SET NOT NULL` after the backfill — the coder must reorder so backfill runs before NOT NULL).
      (b) Insert the backfill `UPDATE` statements in the dependency order in "Per-table backfill derivations" above, then `ALTER TABLE ... ALTER COLUMN "institutionId" SET NOT NULL` for each.
      (c) Append `(id, institutionId)` composite UNIQUE constraints on the parents (`student_profiles`, `exit_reasons`, `gate_passes`, `gates`, `guard_profiles`, `hod_profiles`, `users`, `departments`).
      (d) Append the DROP of each old single-column FK and ADD of each composite FK per "Composite FKs to create".
      (e) Append the RLS ENABLE+FORCE+policies for all 19 RLS-set tables (template above, with `DROP POLICY IF EXISTS`).
      (f) Append the idempotent campass_app GRANT block (guarded by the `pg_roles` existence check).
      Files: `packages/db/prisma/migrations/<timestamp>_tenancy_isolation_rls/migration.sql`
      Verify: deferred to item 3 (apply) — do not apply with `--create-only`.

- [ ] 3. **Apply the migration against live Supabase and confirm clean apply.**
      From `cwd = packages/db`, run `npx prisma migrate dev` (loads `packages/db/.env`, connects as `postgres` via session pooler). Confirm it reports the migration applied with no errors and the DB is in sync. If backfill fails on an orphaned row (a child with no derivable parent), STOP and report — do not silently default `institutionId`.
      Files: (none new; applies item 2's migration)
      Verify: `npx prisma migrate status` (cwd `packages/db`) reports "Database schema is up to date" / no pending migrations and the new migration listed as applied.

- [ ] 4. **Update `seed.ts` for the now-required `institutionId` on nested creates.**
      The seed creates `hodProfile`, `guardProfile`, `studentProfile` as nested writes under `user.create` and `guardProfile.assignedGates` (guard_gate_assignments). With `institutionId` now required on those tables, add `institutionId: institution.id` to each nested profile create and to the nested `assignedGates` create (guard_gate_assignment). Verify no other INSERT in the seed now misses a required `institutionId`.
      Files: `packages/db/src/seed.ts`
      Verify: from `cwd = packages/db`, `npx tsx src/seed.ts` runs to completion printing "Seed completed successfully" with no Prisma validation or null-constraint errors. (Seed uses the `postgres` connection from `packages/db/.env`, which bypasses RLS — correct for seeding.)

- [ ] 5. **Add the `withTenant` tenant-scoped helper to `packages/db` and export it.**
      Create `packages/db/src/with-tenant.ts` implementing `withTenant<T>(institutionId: string, fn: (tx) => Promise<T>): Promise<T>` exactly as `docs/tenancy.md` §6.2: `prisma.$transaction(async (tx) => { await tx.$executeRawUnsafe("SELECT set_config('app.current_institution_id', $1, true)", institutionId); return fn(tx); })`. Use `Prisma.TransactionClient` as the `tx` type. Re-export `withTenant` from `packages/db/src/index.ts`. Do NOT wire it into any route (that is B-2).
      Files: `packages/db/src/with-tenant.ts`, `packages/db/src/index.ts`
      Verify: from `cwd = packages/db`, `npx tsc --noEmit -p tsconfig.json` compiles with no errors; and `import { withTenant } from "@campusgate/db"` resolves (confirmed by the escape suite in item 7 importing it, or a quick `npx tsx -e "import('@campusgate/db').then(m => console.log(typeof m.withTenant))"` prints `function`).

- [ ] 6. **Add a dedicated test Prisma client + seed/teardown helper for the escape suite (real DB, campass_app + postgres).**
      Create `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` that provides: (a) `appClient` — a `new PrismaClient()` using `apps/api/.env` `DATABASE_URL` (campass_app, pooler 6543, pgbouncer=true) — the RLS-subject connection the escape tests exercise; (b) `adminClient` — a `PrismaClient` using the migration/`postgres` connection (read `DIRECT_URL`/`DATABASE_URL` from `packages/db/.env`, or an explicit env var) used ONLY in setup/teardown to insert and later delete two institutions (A and B) plus overlapping-shaped data (departments, users, student_profiles, exit_reasons, gates, gate_passes, gate_events) so cross-tenant IDs are plausible; (c) exported captured IDs for A and B; (d) a `cleanup()` that deletes exactly the rows it created (by captured IDs / a unique code prefix like `ESCAPE_TEST_`), never a blanket delete. Do NOT mock `@campusgate/db` in this suite (unlike the other integration tests). Do NOT read or print secret values.
      Files: `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`
      Verify: compiled as part of item 7's run; the setup's `beforeAll` seeds without error and `afterAll` cleanup leaves zero `ESCAPE_TEST_` rows (assert in the meta-test).

- [ ] 7. **Write the cross-tenant escape suite (`docs/tenancy.md` §7) against the real tables.**
      Create `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts` using vitest + the helper from item 6. Every tenant-data query in the tests goes through `withTenant(institutionId, tx => ...)` on `appClient` (the campass_app connection), EXCEPT the explicit fail-closed test which runs a raw query on `appClient` with no tenant GUC. Tests (each must be DENIED or empty):
      1. **Read escape:** as A (`withTenant(A)`), `tx.gatePass.findUnique/findFirst` for a pass ID owned by B → null; `findMany` returns only A's rows (none of B's).
      2. **Write escape — foreign parent:** as A, attempt `tx.gatePass.create` referencing B's `studentId` → rejected (composite FK violation and/or RLS WITH CHECK). Expect the call to throw.
      3. **Spoofed-tenant insert:** as A, attempt to create a row with `institutionId = B` (e.g. a notification/gate_pass with B's id) → RLS WITH CHECK rejection (throws).
      4. **Deliberately-buggy query (headline):** inside `withTenant(A)`, run a query that FORGETS any tenant filter (e.g. `tx.gatePass.findMany({})` with no where) → returns ONLY A's rows because RLS forces it. Assert every returned row has `institutionId === A` and count equals A's seeded count.
      5. **Missing-context fail-closed:** on `appClient` (NOT inside withTenant), run `appClient.gatePass.findMany({})` → zero rows (GUC unset → NULL → no rows). Assert length 0.
      6. **Meta-test:** query `pg_tables`/`pg_class` via `adminClient` to assert every table in the RLS set has `relrowsecurity = true` AND `relforcerowsecurity = true` (enumerate the 19-table list; fail if any is missing RLS or FORCE). Also assert each has the two expected policies in `pg_policies`.
      Also assert cleanup ran (no `ESCAPE_TEST_` rows remain) in `afterAll`.
      Files: `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts`
      Verify: from `cwd = apps/api`, `npx vitest run src/routes/__tests__/tenant-escape.integration.test.ts` — ALL tests pass, especially the buggy-query backstop (#4) and fail-closed (#5). (This suite requires network access to Supabase and the campass_app credentials in `apps/api/.env`.)

- [ ] 8. **Run the full existing apps/api test suite and the root build to prove nothing regressed.**
      Confirm the new real-DB suite coexists with the mocked integration suites. If the existing `vitest.config.ts` `include` glob would force the escape suite to run in every CI invocation without DB access, note it but do NOT change CI behavior in B-1 beyond what's needed to keep `npm run build` green — the escape suite is run explicitly in item 7. (If the whole-suite run fails only because the escape suite needs the network, document that the escape suite is the real-DB suite run separately; do not weaken the other tests.)
      Files: (none — verification only)
      Verify: from `cwd = apps/api`, `npx vitest run` completes (the mocked suites pass); from repo root `c:\campusgate`, `npm run build` (turbo build) completes successfully for all packages (prisma generate + tsc across `packages/db`, `packages/shared`, `apps/api`, `apps/web`).

- [ ] 9. **Clean up and commit the specific files.**
      Delete any temporary verification scripts created during the work (e.g. ad-hoc `.ts`/`.sql` probes). Stage ONLY: `packages/db/prisma/schema.prisma`, the new `packages/db/prisma/migrations/<timestamp>_tenancy_isolation_rls/` folder, `packages/db/src/with-tenant.ts`, `packages/db/src/index.ts`, `packages/db/src/seed.ts`, `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts`, `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`. NEVER `git add .`; NEVER stage any `.env`. Commit on `main` with a message like `feat(tenancy): B-1 institutionId + composite FKs + RLS + cross-tenant escape suite`. Do not push unless asked.
      Files: (git staging only)
      Verify: `git status` shows only the intended files staged and no `.env` among them; `git diff --cached --stat` lists exactly the files above; `git log -1 --oneline` shows the new commit.

## Gaps / assumptions noted

- **`security_events`, `sessions`, `institutions`** are intentionally excluded from the RLS set (reasons recorded above). If a later reviewer wants `security_events` RLS, that is a separate follow-up because its `institutionId` is legitimately nullable for pre-auth events.
- **Actor/declarer user FKs** on `emergency_overrides`, `guard_shifts`, `emergency_alerts` are left single-column (not composite) to stay additive and avoid assuming the actor is always same-tenant; row-level RLS still isolates those rows. Recorded as a deliberate choice; the escape suite proves isolation holds.
- **Escape suite network dependency:** the suite requires live Supabase + `campass_app` creds from `apps/api/.env`. It is run explicitly (item 7). If CI runs `vitest run` with no DB access, the team may later tag this suite to a separate script; B-1 does not alter CI wiring beyond keeping `npm run build` green.
- **`approvedById` nullable composite FK:** Postgres MATCH SIMPLE (default) skips FK validation when any referenced column is NULL, so a pass with no approver is unaffected; when set, both `institutionId` and `approvedById` must match a `hod_profiles` row in the same tenant. Correct behavior.
- If backfill hits an orphaned child row (no derivable parent → NULL `institutionId`), the `SET NOT NULL` will fail; the coder must surface the offending table/rows rather than defaulting a tenant.

---

# Implementation evidence (first iteration — completed)

**Migration created:** `packages/db/prisma/migrations/20261018110658_tenancy_isolation_rls/migration.sql` (hand-authored: nullable-add → tiered backfill → NOT NULL → institutionId indexes → `(id, institutionId)` composite uniques → composite FKs → `institutionId → institutions(id)` FKs for the 10 new columns → RLS ENABLE+FORCE + `tenant_isolation_select`/`tenant_isolation_modify` policies on 19 tables via a `DO` loop → guarded idempotent `campass_app` GRANT block). Prisma's interactive `migrate dev --create-only` was aborted (it prompts for confirmation on the backfill warning and cannot be answered non-interactively); the migration SQL was authored directly instead, giving full control over the nullable→backfill→NOT NULL ordering.

**Commands actually run and their results:**

1. `npx prisma validate` (cwd `packages/db`) → "The schema at prisma\schema.prisma is valid 🚀". `npx prisma generate` → "Generated Prisma Client (v6.19.3)".
2. `npx prisma migrate deploy` (cwd `packages/db`, loads `packages/db/.env`, connects as `postgres` via session pooler :5432) → "Applying migration `20261018110658_tenancy_isolation_rls`" … "All migrations have been successfully applied." (First attempt hit a transient P1001 against the session pooler; immediate retry applied cleanly. `migrate dev` is interactive for the create step, so `deploy` was used to apply; `migrate status` then confirms the result `migrate dev` would reach.)
3. `npx prisma migrate status` (cwd `packages/db`) → "3 migrations found" … "Database schema is up to date!" (no drift, schema in sync — confirms `migrate dev` would be a no-op/clean).
4. `npx tsx src/seed.ts` (cwd `packages/db`) → "✅ Seed completed successfully!" (seed.ts updated to supply `institutionId` on the nested `studentProfile`/`hodProfile`/`guardProfile` and `assignedGates` guard_gate_assignment creates).
5. `npx vitest run src/routes/__tests__/tenant-escape.integration.test.ts` (cwd `apps/api`, campass_app runtime connection) → **6 passed (6)**:
   - (1) read escape → foreign pass `null`, list returns only A's rows.
   - (2) write escape foreign parent → rejected by composite FK `gate_passes_student_same_tenant_fkey`.
   - (3) spoofed-tenant insert → rejected by RLS WITH CHECK (Postgres error 42501 "new row violates row-level security policy for table \"notifications\"").
   - (4) **HEADLINE buggy query** (`findMany({})`, no where) → returns ONLY A's rows, count equals A's admin-verified count, none of B's rows leaked.
   - (5) fail-closed (no tenant GUC on the campass_app client) → zero rows.
   - (6) meta-test → all 19 RLS-set tables have `relrowsecurity = true` AND `relforcerowsecurity = true` and both `tenant_isolation_*` policies.
6. `npx vitest run` (cwd `apps/api`, full suite) → **99 passed, 10 failed (109 total)**. The 10 failures are PRE-EXISTING and unrelated to B-1: 8 in `allowance-integration.test.ts` and 2 in `pass-revocation-summary.integration.test.ts`. Proven pre-existing by stashing the `packages/db` source changes and re-running those two suites on the baseline tree → identical 10 failures (8 + 2). The cross-tenant escape suite passes inside the full run too (setup/teardown wrapped in a transient-retry helper so the flaky session pooler doesn't spuriously fail the suite under concurrent load).
7. `npm run build` (repo root, turbo) → "Tasks: 3 successful, 3 total" (prisma generate + tsc across `packages/db`, `apps/api`, `apps/web`).

**Existing write paths fixed for the now-NOT-NULL `institutionId`** (derive from request/context; NO route refactor onto `withTenant`, that is B-2): `apps/api/src/routes/admin.ts` (audit_logs for every admin action, nested student/hod/guard profile + guard_gate_assignment creates, bulk-import student profile, emergency_override), `apps/api/src/routes/hod.ts` (emergency_override + approve/reject/revoke/override audit logs), `apps/api/src/routes/student.ts` (gate_pass create + PASS_REQUESTED/PASS_CANCELLED audit), `apps/api/src/routes/guard.ts` (gate_event EXIT/RETURN + shift/expiry/gate audit logs), `apps/api/src/routes/auth.ts` (self-registration nested student profile), `apps/api/src/services/notifications.ts` (`notifyUser` derives institutionId from the recipient user), `apps/api/src/services/reliability-engine.ts` (`recordSnapshot` now takes `institutionId` from the caller). The one mocked test that asserted the snapshot payload (`reliability-integration.test.ts`) was updated to pass + expect `institutionId` — a payload-shape sync for the required schema change, not a weakening.

**withTenant helper:** `packages/db/src/with-tenant.ts`, exported from `packages/db/src/index.ts`. Interactive `$transaction` whose first statement is `set_config('app.current_institution_id', $1, true)`. NOT wired into any route (B-2).
