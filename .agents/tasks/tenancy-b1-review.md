# Tenancy B-1: institutionId + composite FKs + Postgres RLS + cross-tenant escape suite

This change implements the A2 tenant-isolation foundation from `docs/tenancy.md`: every tenant-owned row now carries its own `institutionId`, cross-row links between tenant-owned tables are enforced by composite `(institutionId, fk)` foreign keys, and Postgres Row-Level Security is enabled+forced on all 19 tenant-owned tables with `tenant_isolation` policies that read `current_setting('app.current_institution_id', true)`. A `withTenant` helper pins the tenant GUC as the first statement of a Prisma `$transaction`, and a real-DB escape suite proves isolation holds — including the headline backstop where a query that forgets its tenant filter still returns only the caller's rows. The migration was hand-authored (Prisma can't model composite FKs/RLS/GRANTs) and ordered nullable-add → backfill → NOT NULL. Route/service changes are purely additive (stamp `institutionId` on writes from server-derived context); `withTenant` is intentionally not wired into routes yet (B-2).

Watch for: nothing blocking. One **possible** behavioral note — the composite FKs use `ON UPDATE CASCADE` whereas the doc's copy-ready example shows no `ON UPDATE` clause; this is benign for immutable cuid PKs (confirmed below). The prior-pass evidence in the plan records a clean migration apply, 6/6 escape tests passing, and 10 pre-existing (proven-baseline) failures unrelated to B-1.

**Verdict**: APPROVED

## High-level view

The schema change is uniform and complete. All ten tables that lacked `institutionId` got a non-null column with an index, and the eight parents referenced by composite FKs got `@@unique([id, institutionId])`. The Prisma relations stay single-column (valid schema) while the hand-written migration carries the authoritative composite FKs — a deliberate, documented split since Prisma can't express these natively.

The migration ordering is correct and defensive: columns are added nullable, backfilled in strict dependency tiers (profiles from users → passes/snapshots/assignments from profiles → events/overrides from passes), then a `DO` block raises a loud exception if any row is still NULL before `SET NOT NULL` runs. This fails closed on orphans rather than silently defaulting a tenant.

RLS is enabled AND forced on exactly the 19-table set, with both the SELECT `USING` and ALL `USING/WITH CHECK` policies generated uniformly via a loop. `institutions` (tenant root), `security_events` (legitimately-nullable tenant), and `sessions` (per-user auth state) are excluded with recorded rationale. The `current_setting(..., true)` form gives fail-closed behavior when the GUC is unset.

The GRANT block is correctly idempotent and guarded: it never creates the `campass_app` role or sets a password, only re-applies DML grants and default privileges, skipping cleanly if the role is absent.

The escape suite connects the RLS-subject (`campass_app`) client through `withTenant` for the isolation proofs and uses the `postgres` client only for setup/teardown and `pg_catalog` inspection — exactly the split the doc demands, since `postgres` bypasses RLS. All six §7 proofs are present, including the deliberately-buggy-query backstop and the RLS-enabled+forced meta-test.

<details>
<summary>Issues (2)</summary>

1. **ON UPDATE CASCADE vs doc example (possible, non-blocking)** — composite FKs use `ON UPDATE CASCADE`; the doc's example omits `ON UPDATE`. Harmless because `id`/`institutionId` are immutable cuids that never update; no action required, noted for the record.
2. **Escape suite is a live-DB suite inside the default vitest glob (possible, non-blocking)** — `tenant-escape.integration.test.ts` requires network + campass_app creds, so a CI run of `vitest run` without DB access would fail it. The plan flags this as a later CI-tagging follow-up; B-1 does not alter CI wiring. Track for B-2/CI.

</details>

<details>
<summary>Details</summary>

### Every missing table got institutionId, backfilled correctly, indexed

The ten tables flagged in `docs/tenancy.md` §3 as missing a tenant column — `student_profiles`, `hod_profiles`, `guard_profiles`, `gate_passes`, `gate_events`, `guard_gate_assignments`, `emergency_overrides`, `reliability_score_snapshots`, `notifications`, `audit_logs` — each gained a non-null `institutionId`, an `Institution` back-relation, and `@@index([institutionId])` in the schema; the migration mirrors each index. (confirmed)

Backfill derivations match the plan's join chains exactly and run in the right order. Tier 1 derives the three profiles plus `notifications`/`audit_logs` straight from `users`; tier 2 derives `gate_passes`, `reliability_score_snapshots`, `guard_gate_assignments` from the now-populated profiles; tier 3 derives `gate_events` and `emergency_overrides` from `gate_passes`. Because each tier only reads columns the previous tier populated, no row is backfilled from a still-NULL source. (confirmed)

The orphan guard is the right call: before any `SET NOT NULL`, a `DO` block counts NULL `institutionId` across all ten tables and `RAISE EXCEPTION` with the offending table/count if any remain. This surfaces an un-derivable row loudly instead of letting a tenant default silently — matching the plan's "STOP and report" instruction. (confirmed)

### Composite FKs enforce same-tenant links at the DB

The eight parents referenced by composite FKs (`departments`, `users`, `exit_reasons`, `gates`, `student_profiles`, `hod_profiles`, `guard_profiles`, `gate_passes`) each got a `(id, institutionId)` composite unique in both schema and migration — the prerequisite for referencing them with `institutionId`. (confirmed)

Every tenant-owned → tenant-owned link listed in the plan is converted: the single-column FK is dropped and replaced with a composite FK carrying `institutionId` on both sides (`gate_passes.studentId/reasonId/approvedById`, `gate_events.passId/gateId/guardId`, `guard_gate_assignments.guardId/gateId`, `guard_shifts.guardId/gateId`, `emergency_overrides.gatePassId`, `reliability_score_snapshots.studentId`, `student_profiles.userId/departmentId`, `hod_profiles.userId/departmentId`, `guard_profiles.userId`, `audit_logs.actorId`, `notifications` via its own tenant column). The DB now physically cannot store a child whose parent lives in another tenant. (confirmed)

The nullable `gate_passes.approvedById` composite FK is correct: Postgres MATCH SIMPLE skips the check when `approvedById` is NULL, so an unapproved pass is unaffected; when set, approver and pass must share a tenant. It carries `ON DELETE SET NULL` (the others use `ON DELETE RESTRICT`), consistent with a nullable optional approver. (confirmed)

The cross-cutting actor FKs deliberately left single-column — `emergency_overrides.overriddenById`, `guard_shifts.createdById`, `emergency_alerts.declaredById/resolvedById` — match the plan's recorded choice. Row-level RLS on each row's own `institutionId` still isolates them, and the escape suite proves that isolation independent of the FK shape. The Prisma schema keeps these models' relations single-column, which is why `prisma validate`/`generate` succeed while the raw SQL carries the composite constraints — the documented split where the DB constraint is the authority. (confirmed)

One minor deviation from the doc's copy-ready example: the composite FKs add `ON UPDATE CASCADE`, which the §4 example omits (it shows only `ON DELETE RESTRICT`). Since `id` and `institutionId` are immutable cuid/FK values that are never updated in place, the cascade never fires and the behavior is identical to the doc's intent. Flagging as a **possible** cosmetic divergence, not a correctness issue. (possible)

### RLS enabled + forced on all 19 tables, fail-closed policies

The migration's `DO` loop runs `ENABLE` then `FORCE ROW LEVEL SECURITY` and creates `tenant_isolation_select` (`FOR SELECT USING`) and `tenant_isolation_modify` (`FOR ALL USING + WITH CHECK`) on the exact 19-table RLS set from the plan. `FORCE` is present, so even the table owner is subject to policies. `DROP POLICY IF EXISTS` precedes each `CREATE`, making re-application idempotent. (confirmed)

The policy predicate `"institutionId" = current_setting('app.current_institution_id', true)` is the fail-closed form: the `true` argument returns NULL when the GUC is unset, and `= NULL` matches no rows, so a request with no tenant context sees nothing rather than everything. The escape suite's test 5 exercises exactly this. (confirmed)

`institutions`, `security_events`, and `sessions` are excluded. `institutions` is the tenant root (platform table, §3), `security_events` has a legitimately-nullable `institutionId` for pre-auth events, and `sessions` is per-user auth state with no tenant column. The exclusions and their rationale are recorded in the plan, and the meta-test's table list matches the migration's set exactly, so the enumeration can't silently drift. (confirmed)

### campass_app grants: no role creation, no password

The GRANT block is wrapped in `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='campass_app')` and contains only `GRANT ... TO campass_app` plus `ALTER DEFAULT PRIVILEGES`. There is no `CREATE ROLE` and no password anywhere in the migration — the role pre-exists in Supabase and owns its own secret, exactly as the plan requires. The guard also lets the migration apply cleanly in an environment where the role is absent (it skips the grants). (confirmed)

### withTenant: GUC first, exported, not wired into routes

`packages/db/src/with-tenant.ts` opens a `prisma.$transaction` whose **first** statement is `set_config('app.current_institution_id', $1, true)` via `$executeRawUnsafe`, then runs the caller's `fn(tx)`. The transaction-local `set_config(..., true)` is the pooler-safe form verified in the doc. It is re-exported from `packages/db/src/index.ts` (`export { withTenant } from "./with-tenant.js"`). A grep of the route files shows no import of `withTenant` — route wiring is correctly deferred to B-2. (confirmed)

### Escape suite: right connection, all six proofs

The setup helper pins `process.env.DATABASE_URL` to the `campass_app` URL before `@campusgate/db` is imported, so `withTenant` runs through the RLS-subject role; `adminClient` uses the `postgres` `DIRECT_URL` only for seed/teardown and `pg_catalog` inspection. This is the load-bearing split from §5.1 — reusing the migration (`postgres`) connection would bypass RLS and make the suite prove nothing. The suite does not mock `@campusgate/db` (unlike the other integration suites), and secrets are parsed from `.env` into memory, never printed. (confirmed)

All six §7 proofs are present and map to the strategy: (1) read escape — A cannot read B's pass by id, and `findMany` returns only A's rows; (2) write escape with a foreign parent — A creating a pass against B's `studentId` rejects (composite FK); (3) spoofed-tenant insert — A inserting a notification stamped `institutionId = B` rejects (RLS `WITH CHECK`); (4) the **headline** deliberately-buggy query — `findMany({})` with no where inside `withTenant(A)` returns only A's rows and matches A's admin-counted total, with none of B's rows leaking; (5) fail-closed — `appClient.findMany` outside `withTenant` returns zero rows; (6) the meta-test — queries `pg_class` for `relrowsecurity` AND `relforcerowsecurity` across all 19 tables and `pg_policies` for both policy names, failing if any table lacks RLS, FORCE, or either policy. (confirmed)

Cleanup is scoped, not blanket: teardown deletes only rows whose `institutionId`/`id` start with the `ESCAPE_TEST_` prefix, child-first to respect FKs, and `afterAll` asserts zero `ESCAPE_TEST_` rows remain. The transient-retry wrapper around setup/teardown touches only connectivity errors (P1001/ECONNRESET/timeouts) on the flaky session pooler and never wraps a test assertion, so it can't mask a logic failure. (confirmed)

### No auth/RBAC/Super-Admin changes; writes stamped from server context

The route and service diffs are additive only. Every change adds `institutionId` to a Prisma `create`, sourced from server-derived context — `request.user.institutionId` (student routes), the in-scope authenticated `institutionId` (admin/hod/guard audit logs, profiles, overrides), `department.institutionId` (self-registration), the recipient user's `institutionId` (notifications), or `pass.student.user.institutionId` (reliability snapshot). None of these read a client-supplied body/param for the tenant, so the stamp can't be spoofed. No auth guard, RBAC check, or Super-Admin path was modified. (confirmed)

The seed adds `institutionId` to the nested `hodProfile`/`guardProfile`/`studentProfile` and `assignedGates` creates now that those columns are required. The one mocked test touched (`reliability-integration.test.ts`) adds `institutionId` to the `recordSnapshot` call and expected payload — a payload-shape sync for the required schema change, not a weakened assertion. (confirmed)

### Commit hygiene

The commit stages exactly the intended files — `schema.prisma`, the new migration folder, `with-tenant.ts`, `index.ts`, `seed.ts`, the escape suite + helper, the additive route/service edits, the one mocked-test sync, and the plan doc — with no `.env` among them. `git show --stat` confirms 16 files, no secrets, and existing behavior preserved. (confirmed)

### Evidence relied on (not re-verified)

Per the review mandate I did not re-run the migration, seed, escape suite, or build. The plan's recorded evidence states: `prisma validate` valid + `generate` succeeded; `migrate deploy` applied cleanly (one transient P1001 on retry) and `migrate status` reports in-sync; seed completed; the escape suite ran 6/6 green against `campass_app`; the full api suite was 99 passed / 10 failed with the 10 failures proven pre-existing by a baseline re-run; and `npm run build` succeeded across all packages. The evidence is specific and internally consistent with the diff I read (table lists, constraint names, error codes all line up), so no spot-check raised an articulable doubt worth burning a re-run on. (confirmed as present and consistent)

</details>

<details>
<summary>File map</summary>

- `packages/db/prisma/schema.prisma` — institutionId + Institution relations on 10 models, `@@unique([id, institutionId])` on 8 parents, `@@index([institutionId])` on new tenant tables.
- `packages/db/prisma/migrations/20261018110658_tenancy_isolation_rls/migration.sql` — hand-authored: nullable-add → tiered backfill → orphan guard → NOT NULL → indexes → composite uniques → composite FKs → institutions FKs → RLS enable/force/policies (19 tables) → guarded idempotent campass_app GRANTs.
- `packages/db/src/with-tenant.ts` — `withTenant` helper (set_config first in `$transaction`).
- `packages/db/src/index.ts` — re-export `withTenant`.
- `packages/db/src/seed.ts` — stamp institutionId on nested profile/assignment creates.
- `apps/api/src/routes/{admin,auth,student,hod,guard}.ts` — additive institutionId on writes from server context.
- `apps/api/src/services/{notifications,reliability-engine}.ts` — derive/accept institutionId for tenant-owned writes.
- `apps/api/src/services/__tests__/reliability-integration.test.ts` — payload-shape sync for recordSnapshot.
- `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts` — the six-proof cross-tenant escape suite.
- `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` — campass_app + postgres clients, scoped seed/teardown, RLS table list.
- `.agents/tasks/tenancy-b1-plan.md` — implementation plan + recorded evidence.

Full diff: `git show c8fcb95`.

</details>
