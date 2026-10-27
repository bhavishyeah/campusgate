# Module entitlement / activation / dependency enforcement — implementation review (iteration 2)

The change lands the Phase-0 "booster model": a tenant-owned `InstitutionModule` table, a shared module registry + dependency graph, platform (entitlement) and institution (activation) endpoints, a real `requireModuleActive` guard, the critical `campus_movement` backfill, and tests. It replaces the permit-all stub with server-side enforcement wired onto the GatePass routes. Iteration 1 (`e068d09`) was reviewed `CHANGES_REQUESTED` for one blocking gap: two operational `campus_movement.*` admin routes were missing the module guard. Iteration 2 (`20fbb3c`) fixes exactly that. This pass re-verifies the fix from source and confirms nothing else regressed; the broader feature was already verified conforming in the prior pass and the relevant areas were re-read here.

Watch for: nothing blocking. The prior pass's single finding — the module guard missing on `POST /admin/passes/:passId/revoke` and `POST /admin/emergency-override` — is now closed (confirmed in source), and a new 3-test suite pins both routes under a SUSPENDED module. The implementer recorded a clean build and a 214-passing suite (was 211) in `verification.md`; that evidence was read and not re-run.

**Verdict**: APPROVED

## High-level view

The one blocking finding from iteration 1 is resolved. Both previously-ungated admin routes now carry `requireModuleActive("campus_movement")` after `requirePermission`, and a grep across `admin.ts` confirms every `campus_movement.*`-keyed route is gated except the one intended carve-out, `GET /support-grants`. The `admin.*`-keyed administration routes (users, gates, departments, reasons, calendar) remain correctly un-gated, and the module-management routes themselves are permission-gated only, never self-gated.

The table, RLS, FK, GRANT, and catalogue seed are a byte-for-byte mirror of the `superadmin_security` house style: `institutionId` ownership column, composite `(id, institutionId)` unique, tenant-root FK `ON DELETE RESTRICT`, `ENABLE`+`FORCE` RLS with the fail-closed `nullif`-guarded policy pair, and a guarded full-DML `campass_app` GRANT with no BYPASSRLS. The migration is additive — one new type, one new table, one new permission — and the frozen migrations are untouched. The `campus_movement` ENTITLED+ACTIVE backfill plus the `RAISE EXCEPTION` invariant guard are present, and the seed mirrors it for the demo tenant.

The state machine lives in one service with a single dependency-satisfaction predicate (a dep satisfies iff its row exists and is ACTIVE), applied identically to first activation and reactivation, direct-deps-only with the transitive guarantee argued by induction. There is no force-activate path. The platform/institution split matches the platform-action vs tenant-action contract, and audit metadata serializes the dependent set to `sanitizeMetadata`-surviving scalars.

The guard reads the institution's row via a token-scoped `privilegedPrisma` point lookup and fails closed (401 unset / 500 on throw / 403 unless ACTIVE). The new test pins the two formerly-missed routes: SUSPENDED → 403 before the handler runs (no pass/override prisma call), ACTIVE → pass-through. The wiring omission that slipped iteration 1's green suite is now covered.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking issues. The one blocking finding from iteration 1 is resolved and pinned by a new test.

</details>

<details>
<summary>Details</summary>

### Iteration-1 blocking finding resolved (confirmed)

Iteration 1 flagged that `POST /admin/passes/:passId/revoke` (`campus_movement.pass.revoke`) and `POST /admin/emergency-override` (`campus_movement.pass.override`) carried `requirePermission` but not `requireModuleActive("campus_movement")`, leaving a partial-enforcement hole where a suspended module still let an admin revoke passes and issue emergency overrides. Commit `20fbb3c` adds the guard to both `preHandler` arrays:

```
apps/api/src/routes/admin.ts
  1768  app.post("/passes/:passId/revoke", { preHandler: [requirePermission("campus_movement.pass.revoke"), requireModuleActive("campus_movement")] }, ...)
  1857  app.post("/emergency-override",    { preHandler: [requirePermission("campus_movement.pass.override"), requireModuleActive("campus_movement")] }, ...)
```

A full grep of `admin.ts` confirms this is now exhaustive: every `campus_movement.*`-keyed route carries both guards (`/stats`, `/analytics`, `/emergency/active`, `/emergency`, `/emergency/declare`, `/emergency/:id/resolve`, `/passes/:passId/revoke`, `/emergency-override`, `/audit-logs`), with the single intended exception `GET /support-grants` (keyed `campus_movement.audit.view` but a break-glass support surface, design §7.3 carve-out). The `admin.*`-keyed routes (user/department/gate/shift/reason/allowance/config/calendar management) are correctly not gated, matching design A6. The module-management routes (`/modules`, `/modules/:moduleKey/activate`, `/modules/:moduleKey/suspend`) are gated by `admin.modules.manage` only — not self-gated, which would be circular.

The new `admin-module-suspended.integration.test.ts` (3 tests) pins the fix: with `institutionModule.findUnique → { state: "SUSPENDED" }`, both routes return 403 `{ error: "Module not active: campus_movement" }` and the guard fires before the handler (asserted by `gatePass.findFirst`/`updateMany` and `emergencyOverride.create` never being called); with `state: "ACTIVE"` the revoke route passes through to the handler. This closes the exact test gap the prior pass called out — had either route been pinned in iteration 1, the missing guard would have failed the suite.

### Checklist items re-confirmed as conforming

The feature was verified conforming in the prior pass; the following were re-read in this pass and remain correct.

(1) Tenancy/state model — the migration mirrors `superadmin_security`: `institutionId` ownership column with `@@index`, `@@unique([institutionId, moduleKey])` and `@@unique([id, institutionId])`, tenant-root FK `→ institutions(id) ON DELETE RESTRICT ON UPDATE CASCADE`, `ENABLE`+`FORCE` RLS with the `nullif(current_setting('app.current_institution_id', true), '')` policy pair (SELECT + FOR ALL USING/WITH CHECK) failing closed on both unset and empty-string GUC, and the guarded full-DML `campass_app` GRANT with no REVOKE and no BYPASSRLS. `NOT_ENTITLED` = row absence; enum holds the three real states.

(2) Additive, frozen untouched — exactly one new migration dir `20261019093119_module_system`; no frozen migration appears in the diff. The note explains it was hand-authored (not `migrate dev`) to avoid a destructive reset against the checksum-mismatched shared DB, then applied with `migrate deploy`.

(3) Backfill — the migration inserts `campus_movement` ACTIVE (both timestamps) for every `code <> 'PLATFORM'` institution idempotently (`ON CONFLICT DO NOTHING`), followed by the `RAISE EXCEPTION` invariant guard that aborts on a partial backfill; the seed upsert mirrors it for the demo `institution` object (not a `findMany`, not PLATFORM). Evidence: deploy applied, guard did not raise, DEMO row present.

(4) Dependency validation — `activate()` reads the institution's rows in-tx; `missingDependencies` lists any declared dep whose row is absent or not ACTIVE; DEPS_UNMET maps to 409 `{ error, moduleKey, missingDependencies }`. Same predicate for ENTITLED→ACTIVE and SUSPENDED→ACTIVE, no bypass. The synthetic `attendance`-edge test proves the 409 with the three missing keys, success once all three deps are ACTIVE, the SUSPENDED-dep 409 (not-ACTIVE is the bar), and reactivation clearing `suspendedAt`.

(5) Suspend — `ACTIVE→SUSPENDED` in place (row updated, history preserved); `affectedDependents` computed over reverse edges ∩ ACTIVE+SUSPENDED; route returns `warnings.affectedDependents` and audits `admin.module.suspended`. Operational rejection on suspend now holds at the route layer for student/hod/guard **and** the two admin routes that the iteration-2 fix gated.

(6) Platform vs institution split — platform grant/revoke/list on `privilegedPrisma` under `platform.entitlements.manage`, both scan/list carrying the mandatory `where: { institutionId: id }` filter, auditing `platform.module.*` with `actorMembershipId: null` and `institutionId` = target tenant; institution activate/suspend/list under `withTenant` and `admin.modules.manage`, auditing `admin.module.*` in-tx. Revoke blocks (409 `HAS_DEPENDENTS`) on ACTIVE or SUSPENDED dependents; the test proves the scan is tenant-scoped (A's revoke lists only A's `fees`). Audit metadata serializes to `affectedDependents` (joined) + `affectedDependentsCount`, and the persisted-row re-read confirms both survive `sanitizeMetadata`, including the `""`/`0` empty case.

(7) Guard body + wiring — narrows to `ModuleKey`, reads `institutionId` from the token only, point-reads `privilegedPrisma.institutionModule.findUnique` on the composite key, fails closed (401 unset / 500 on throw / 403 unless ACTIVE). The permit-all unit test is replaced with pins on all five branches. The wiring is complete across student/hod/guard/admin (verified by grep), and the two admin routes that were the iteration-1 gap are now wired and pinned.

(8) Catalogue-sync — the new migration dir is added to `SEEDING_MIGRATION_DIRS`; the seed block uses the exact `INSERT INTO "permissions" ... ON CONFLICT` and `role_permissions ... AS m(` markers; the four new 3-segment audit keys (`platform.module.entitled/revoked`, `admin.module.activated/suspended`) follow the grouping and shape test; `LEGACY_AUDIT_ACTION_MAP` untouched.

(9) Tests — the escape-suite extension (`institution_modules` added to `RLS_TABLES`, seeded per tenant, cleaned child-first, counted), the dependency/suspend/revoke/audit integration suite, and the suspended-admin-routes pin all exist in the diff.

### Test coverage

Covered: registry/graph meta-test (uniqueness, set consistency, known keys, acyclicity); real `requireModuleActive` enforcement (ACTIVE allow, SUSPENDED/no-row 403, throw-500, unset-401); catalogue union; escape suite extended to `institution_modules` (cross-tenant read denied, spoofed insert/update denied, buggy-query backstop, three-GUC fail-closed, teardown child-first + counted); dependency validation incl. SUSPENDED-dep 409 and reactivation; `affectedDependents` ACTIVE+SUSPENDED; audit-persistence scalar survival incl. empty case; tenant-scoped revoke scan; and now the two admin operational routes (revoke, emergency-override) 403 under a SUSPENDED module with the guard firing before the handler.

Not tested in the automated suite: the live end-to-end lifecycle (grant → activate → suspend → reactivate, cross-tenant isolation) is covered by the recorded live smoke test in `verification.md` rather than automation — consistent with the design's testability split (RLS/lifecycle integration-tested, state-machine logic unit-tested). No gap remains that a reasonable automated test should have caught.

</details>

<details>
<summary>File map</summary>

- `packages/shared/src/modules.ts` — new registry + dependency graph (9 keys, §5.4 edges).
- `packages/shared/src/{index,permissions,audit-actions}.ts` — export modules; add `admin.modules.manage`; add 4 audit keys.
- `packages/db/prisma/schema.prisma` — `ModuleState` enum + `InstitutionModule` model + back-relation.
- `packages/db/prisma/migrations/20261019093119_module_system/migration.sql` — new additive migration (table, RLS, FK, GRANT, seed, backfill, guard).
- `packages/db/src/seed.ts` — demo-tenant `campus_movement` ACTIVE upsert.
- `apps/api/src/services/module-system.ts` — new state-machine service (no force-activate path).
- `apps/api/src/services/authz-engine.ts` — real `requireModuleActive`.
- `apps/api/src/routes/platform.ts` — grant/revoke/list endpoints.
- `apps/api/src/routes/admin.ts` — activate/suspend/list endpoints; guard wiring (two routes added in iteration 2).
- `apps/api/src/routes/{student,hod,guard}.ts` — guard wiring.
- `apps/api/src/services/__tests__/{modules,authz-engine,catalogue-sync}.test.ts` — meta/enforcement/catalogue tests.
- `apps/api/src/services/__tests__/module-system.integration.test.ts` — live-DB dependency/suspend/revoke/audit suite.
- `apps/api/src/routes/__tests__/admin-module-suspended.integration.test.ts` — iteration-2 pin for the two admin routes.
- `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`, `.../tenant-escape.integration.test.ts` — escape suite extension.
- Five mocked integration suites — `institutionModule.findUnique → ACTIVE` added to the `@campusgate/db` mock.

Full diff: `git diff origin/main..HEAD` (feature `e068d09` + fix `20fbb3c`).

</details>
