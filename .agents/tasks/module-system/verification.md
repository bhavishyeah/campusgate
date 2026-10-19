# Verification — CAMPASS Module Entitlement / Activation / Dependency System

Phase 0 final foundation piece. All commands below were actually run on `main`
(no worktree), Windows/PowerShell, against the live Supabase instance. The app
was NOT pushed or deployed.

## 1. Migration applied + backfill proof

New migration (FROZEN migrations untouched): `20261019093119_module_system`.

> Authored by hand (the repo's shared Supabase DB has a pre-existing checksum
> mismatch on the frozen migrations, so `prisma migrate dev --create-only` wants
> a destructive reset — which is forbidden on the shared DB. `migrate status`
> confirmed exactly one pending migration and no checksum complaint on the
> applied ones, so the migration dir + SQL were authored by hand in the
> `superadmin_security` house style and applied with `migrate deploy`.)

```
cd packages/db && npx prisma migrate deploy
# -> Applying migration `20261019093119_module_system`
# -> All migrations have been successfully applied.  (invariant guard did NOT raise)
cd .. && npx prisma generate --schema=packages/db/prisma/schema.prisma  # OK
```

Backfill verified directly against live Supabase (temp script, since deleted):

```
Institutions: 2
institution_modules rows: 1
  DEMO | campus_movement | ACTIVE | id=imod_04837837-... | entitledAt=true activatedAt=true
Non-PLATFORM institutions: 1
Missing ACTIVE campus_movement: []
```

Every non-PLATFORM institution (DEMO) has `campus_movement` ENTITLED+ACTIVE with
an `imod_` backfill id; PLATFORM was correctly excluded. The invariant guard
would have aborted the deploy on any gap — it did not raise.

## 2. Seed mirror

`packages/db/src/seed.ts` now upserts `campus_movement` ENTITLED+ACTIVE for the
demo `institution` object it creates (idempotent `where: institutionId_moduleKey`,
`update: {}`), right after memberships are ensured. Type-checked via the full
clean build below. (Not re-run as a full seed to avoid churning the live demo
data; the upsert is idempotent and the live DEMO row already matches it.)

## 3. CLEAN build check (MANDATORY — the whole Railway sequence)

Run in order, all from the stated directories; all exited 0:

```
npm ci                                                             # 786 pkgs, OK
cd packages/shared && npx tsc                                      # OK
(root) npx prisma generate --schema=packages/db/prisma/schema.prisma   # OK
cd apps/api && npx tsc                                             # OK
(root) npm run build   # turbo: @campusgate/shared, @campusgate/api, @campusgate/web
                       # -> Tasks: 3 successful, 3 total
```

No new dependency was added, so the `@types/*`-in-`dependencies` rule did not
apply (nothing to place).

## 4. Full test suite

```
cd apps/api && npx vitest run
# -> Test Files  25 passed (25)
# ->      Tests  211 passed (211)
```

Baseline was 188; +23 net new. New / changed coverage:

- `src/services/__tests__/modules.test.ts` (NEW, 7) — registry key uniqueness,
  set consistency, every graph key/value is a known MODULE_KEY, graph is acyclic.
- `src/services/__tests__/authz-engine.test.ts` — the permit-all `requireModuleActive`
  pin REPLACED with real enforcement tests: ACTIVE allows; SUSPENDED and no-row
  (NOT_ENTITLED) → 403; state-read throw → 500 fail-closed; `request.auth` unset
  → 401 and never reads state.
- `src/services/__tests__/catalogue-sync.test.ts` — `20261019093119_module_system`
  added to `SEEDING_MIGRATION_DIRS`; set-equality now covers `admin.modules.manage`.
- `src/routes/__tests__/tenant-escape.integration.test.ts` (+5 live-DB cases,
  `institution_modules`): cross-tenant read denied; spoofed-tenant insert denied
  (WITH CHECK); spoofed-tenant update matches 0 rows (B untouched); buggy-query
  backstop (unfiltered findMany returns only A's rows, count-matched); three
  GUC-state fail-closed (unset / empty-string / own-visible). Teardown row count
  `=== 0` (table added to both `cleanup()` child-first and `countRemainingTestRows()`).
- `src/services/__tests__/module-system.integration.test.ts` (NEW, 7 live-DB):
  `missingDependencies`/`affectedDependents` pure helpers; activation BLOCKED
  (DEPS_UNMET) until every declared dep is ACTIVE using the DECLARED `attendance`
  edge, then succeeds; SUSPENDED dependency → 409 (the suspended key appears in
  `missingDependencies`) and SUSPENDED→ACTIVE reactivation re-runs the predicate;
  suspend warns ACTIVE+SUSPENDED dependents and the PERSISTED audit row carries
  `affectedDependents` (joined scalar) + `affectedDependentsCount` (survives
  `sanitizeMetadata`); empty case persists `""`/`0`; platform revoke dependent
  scan is tenant-scoped (A's revoke lists only A's `fees`, never B's).
- Five mocked integration suites (analytics, auth-regression, emergency-alerts,
  pass-revocation-summary, tenant-boundary) got `institutionModule.findUnique ->
  { state: "ACTIVE" }` added to their `@campusgate/db` mock, because wiring the
  real guard onto the campus_movement routes now point-reads module state (the
  mock mirrors the production backfill: campus_movement ACTIVE).

## 5. LIVE smoke test (built `node dist/server.js` against Supabase)

Server started from `apps/api/dist/server.js` on :4000 against live Supabase.
Exact HTTP results (temp scripts since deleted). SUPER_ADMIN MFA was temporarily
enabled to reach the MFA-gated platform routes, then restored to `false`.

- (a) Backfill works — tenant GatePass still serves:
  `GET /api/student/reasons` → **200**; `GET /api/admin/modules` → **200** with
  `campus_movement: ACTIVE`.
- (b) Tenant activate/suspend lifecycle (audited):
  `POST /api/admin/modules/campus_movement/suspend` → **200** `state:SUSPENDED`,
  `warnings.affectedDependents:[]`;
  `POST /api/admin/modules/campus_movement/activate` → **200** `state:ACTIVE`.
- (b) Platform grant/revoke (audited, SUPER_ADMIN):
  `POST /api/platform/institutions/:id/modules {moduleKey:attendance}` → **200**
  `state:ENTITLED`; `GET .../modules` → **200** full matrix;
  `DELETE .../modules/attendance` → **200** `state:NOT_ENTITLED`.
- (c) Dependency validation: `POST /api/admin/modules/attendance/activate` → **409**
  `{ error:"Module dependencies not satisfied", missingDependencies:
  ["student_management","academic_sessions","class_course"] }`. Also, before the
  grant, the same call → **404** `Module not entitled for this institution`.
- (d) Suspended campus_movement blocks GatePass: with campus_movement SUSPENDED,
  `GET /api/student/reasons` → **403** `{ error:"Module not active: campus_movement" }`
  and `GET /api/hod/requests` → **403** same; after reactivation both → **200**.
- (e) Cross-tenant isolation: `GET /api/admin/modules` returns ONLY the caller's
  institution rows (escape suite proves the RLS backstop at the DB layer too).

Audit rows re-read from `audit_events` (temp script, since deleted):

```
platform.module.revoked   | attendance      | meta={affectedDependents:"", affectedDependentsCount:0, moduleKey:"attendance"}
platform.module.entitled  | attendance      | meta={moduleKey:"attendance", idempotentNoop:true/false}
admin.module.activated     | campus_movement | meta={moduleKey:"campus_movement"}
admin.module.suspended     | campus_movement | meta={affectedDependents:"", affectedDependentsCount:0, moduleKey:"campus_movement"}
```

Environment left clean: server stopped; `institution_modules` = one row
(DEMO campus_movement ACTIVE); `attendance` revoked; SUPER_ADMIN `mfaEnabled`
restored to `false`; all temp scripts deleted.

## 6. Constraints honored

- `campass_app` granted full DML on `institution_modules` (tenant writes), never
  BYPASSRLS. RLS ENABLE+FORCE with the fail-closed `nullif`-guarded standard
  policy pair (escape meta-test asserts both policies present).
- FROZEN migrations untouched; exactly one NEW migration added.
- Platform/SUPER_ADMIN/pre-auth routes not module-gated; the new module-management
  routes are permission-gated only (not self-gated). `GET /admin/support-grants`
  carve-out left ungated. No force-activate/bypass path exists.
- `.env` files left untouched and will NOT be committed.

## 7. Iteration 2 — review finding fix (blocking)

Finding (`impl-review.json`): two operational `campus_movement.*` admin routes
carried `requirePermission` but not `requireModuleActive("campus_movement")`, so a
suspended `campus_movement` still let an admin revoke passes and issue emergency
overrides — a partial-enforcement hole. The equivalent HOD routes were already
gated, so this was an inconsistency, not a design question.

Fix (behavior-preserving relative to the approved design — these routes are in the
`campus_movement.*` namespace and §7.3/A6 require the guard; they are not the
`GET /admin/support-grants` carve-out):

- `apps/api/src/routes/admin.ts` — added `requireModuleActive("campus_movement")`
  after `requirePermission(...)` in the `preHandler` arrays of
  `POST /passes/:passId/revoke` (`campus_movement.pass.revoke`, ~L1768) and
  `POST /emergency-override` (`campus_movement.pass.override`, ~L1857).
- `apps/api/src/routes/__tests__/admin-module-suspended.integration.test.ts` (NEW,
  3 tests) — pins the wiring with the mocked-`@campusgate/db` pattern: with
  `institutionModule.findUnique → { state: "SUSPENDED" }`, both routes return
  **403** `{ error: "Module not active: campus_movement" }` and the guard fires
  BEFORE the handler (no `gatePass`/`emergencyOverride` prisma call happens); with
  `state: "ACTIVE"` both routes pass the guard through to the handler.

Re-verification (all run on `main`, all exited 0):

```
npm ci                                                             # 786 pkgs, OK
cd packages/shared && npx tsc                                      # OK
(root) npx prisma generate --schema=packages/db/prisma/schema.prisma   # OK
cd apps/api && npx tsc                                             # OK
(root) npm run build   # turbo -> Tasks: 3 successful, 3 total
cd apps/api && npx vitest run
# -> Test Files  26 passed (26)
# ->      Tests  214 passed (214)   (was 211; +3 for the new pin suite)
```

No new dependency added; no schema/migration/seed change in this iteration (the
live migration + backfill from §1 remain applied). `.env` files untouched.
