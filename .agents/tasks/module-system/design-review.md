# Design Review — CAMPASS Module Entitlement / Activation / Dependency System

**Design under review:** `c:\campusgate\.agents\tasks\module-system\design.md`
**Specs:** `architecture.md` §5, `identity-rbac.md` §6.2/§7, `tenancy.md`,
`superadmin-security.md`, `database.md`
**Reviewed fresh, without the context that produced the design.** Every source claim the
design makes was re-checked against the live codebase.

---

## Verdict

**APPROVED** — 0 HIGH, 0 MEDIUM findings. (NITs listed below are non-blocking and do not
change the verdict.)

This is the design's third review round (it carries responses to two prior rounds in
§12). The two MEDIUM gaps and the HIGH `sanitizeMetadata` gap from prior rounds are
resolved in the text, and I independently re-verified the resolutions against source. The
design stands on its own for implementation.

---

## Findings

1. **NIT — `sanitizeMetadata` secret-key pattern is a latent trap the design does not
   name.** `apps/api/src/services/audit.ts` drops any metadata key matching
   `/password|token|secret|mfa|qr/i` *in addition to* dropping arrays/objects (verified).
   The design's chosen scalar field names — `affectedDependents` and
   `affectedDependentsCount` — do not match that pattern, so they persist correctly. The
   design covers the array-dropping behavior exhaustively (§4, finding-1 resolution) but
   never mentions the secret-key filter. This is safe today, but an implementer who later
   renames the field (e.g. to `revokedModuleToken…` or anything containing `secret`)
   would silently lose the audit field again — the exact §5.5 "silent break" the design
   is guarding against.
   **Fix:** add one sentence to §4 noting the field names must also avoid the
   `password|token|secret|mfa|qr` substrings, and have the §9.2 persisted-row assertion
   stand as the regression guard if a rename ever happens.

2. **NIT — the `activate()` function signature is referenced but never written out.** §3
   specifies the transition rules, the dependency-satisfaction predicate, the 409 body
   shape, and the atomicity requirement in prose, but unlike `requireModuleActive` (§7.1,
   full body) and the audit serialization (§4, concrete snippet), `activate()`,
   `suspend()`, `entitle()`, and `revoke()` have no signatures. The return-shape contract
   is implied ("return a structured failure listing the unmet keys") but not typed — e.g.
   whether `activate()` returns a discriminated union, throws, or returns
   `{ ok, missingDependencies }` is left to the implementer, and the route-layer mapping
   to 404/409 depends on that shape.
   **Fix:** add the four service signatures and their result type to §3, e.g.
   ```ts
   type ActivateResult =
     | { ok: true; module: InstitutionModule }
     | { ok: false; reason: "NOT_ENTITLED" }                       // -> 404
     | { ok: false; reason: "DEPS_UNMET"; missingDependencies: ModuleKey[] }; // -> 409
   export function activate(tx: Prisma.TransactionClient, institutionId: string,
     moduleKey: ModuleKey, actorUserId: string): Promise<ActivateResult>;
   ```
   so the route handlers in §6.2 have an unambiguous contract to map.

3. **NIT — `settings` validation rule is unspecified for the `activate`/`suspend`
   endpoints.** §1.1 adds a nullable `settings` Json column and §3/§6.2 name it as the
   future required-config seam (A5). But the Phase-0 endpoints (`POST
   /admin/modules/:moduleKey/activate`, `suspend`) do not state whether they accept a
   `settings` body, ignore it, or reject a non-empty one. `POST .../activate` with a
   `settings` payload today would have no defined behavior.
   **Fix:** state explicitly that Phase-0 activate/suspend take **no** body (or ignore
   `settings`), and that `settings` is written only by a future config step — so there is
   no half-wired write path. One sentence in §6.2.

---

## Check-by-check assessment (task's 7 questions)

**(1) `InstitutionModule` shape — state model + tenancy checklist.** PASS.
- `NOT_ENTITLED` = absent row; enum holds only `ENTITLED | ACTIVE | SUSPENDED` — matches
  `architecture.md` §5.2 exactly (§1.1).
- `institutionId` non-null + `@@index`, composite FK to `institutions(id)` with
  `ON DELETE RESTRICT`, `@@unique([institutionId, moduleKey])`, and `@@unique([id,
  institutionId])` for later composite referencing — matches the `tenancy.md` §4/§8
  checklist. The design correctly argues there is no *second* tenant-owned parent, so a
  single-leg tenant-root FK is the right shape (mirrors `notifications`/`audit_events`).
- `ENABLE`+`FORCE` RLS with the fail-closed `nullif(current_setting(...,true),'')`
  policy pair, matching the `superadmin_security` house style (verified the newer
  `nullif` form is the stronger current convention per `tenancy.md`).
- Correctly uses `DEFAULT_POLICIES = {tenant_isolation_select, tenant_isolation_modify}`
  — verified against the live `tenant-escape-setup.ts`: only `audit_events` and
  `support_grants` have `EXPECTED_POLICIES` overrides, so a standard-pair table needs
  only a `RLS_TABLES` entry. The design's §9.1 RLS-naming note is correct.

**(2) Dependency validation (§5.4) + suspend behavior (§5.5).** PASS.
- Single satisfaction predicate (a dep satisfies iff its row exists AND `state=ACTIVE`;
  `missingDependencies` lists absent/ENTITLED/SUSPENDED), applied identically on first
  activation and `SUSPENDED→ACTIVE` reactivation (§3). Resolves the prior MEDIUM.
- Validation runs inside the same `withTenant` transaction as the write (atomic
  check-then-set) — matches `tenancy.md` §6.2.
- Transitive-closure-by-induction argument is sound and the no-force-activate-bypass
  invariant that it rests on is called out (§3).
- Suspend preserves history (update in place), warns dependents (reverse-edge set over
  `ACTIVE`+`SUSPENDED`), does not cascade (A2) — matches §5.5 "never a silent break"
  read as warning-not-cascade. The dependency-graph edges transcribe `architecture.md`
  §5.4 verbatim (verified).

**(3) `campus_movement` ENTITLED+ACTIVE backfill (migration + seed).** PASS.
- Migration backfill INSERTs one `campus_movement` `ACTIVE` row per non-PLATFORM
  institution, idempotent `ON CONFLICT DO NOTHING`, both `entitledAt`+`activatedAt` set,
  plus a `RAISE EXCEPTION` invariant guard that aborts the deploy on any missed tenant
  (§5.1).
- Seed mirrors it against the concrete demo `institution` object (verified: `seed.ts`
  creates exactly one PLATFORM + one DEMO institution, so iterating the created object
  rather than `findMany` is correct — resolves prior NIT 9).
- The hard ordering constraint (backfill migration + real guard body + route wiring ship
  in one deployable; `migrate deploy` before API boot) is specified and binds correctly
  to the **wiring** step, which is where enforcement actually begins — verified the stub
  is wired onto zero routes today (`grep requireModuleActive` → only the stub +
  its unit test), so the stub-body rewrite alone is inert. This is sufficient to keep
  every live GatePass route working the instant the guard begins serving.

**(4) Platform vs institution endpoints, gating, audit keys.** PASS.
- Platform grant/revoke/list on `platform.ts` under
  `requirePermission('platform.entitlements.manage')` (verified: permission exists and is
  SUPER_ADMIN-bound) on top of the plugin-level `requireSuperAdmin()` +
  `requirePlatformMfa()` (verified both are registered as plugin preHandlers). All writes
  on `privilegedPrisma` (verified exported from `@campusgate/db`). Target-tenant
  `institutionId` on the audit event, null `actorMembershipId` (A9) — supported by the
  `AuditInput` shape and the no-`tx` privileged write path (verified `recordAuditEvent`
  uses `privilegedPrisma` when `tx` is omitted, which is required for a row whose tenant
  is not the actor's).
- Institution activate/suspend/list on `admin.ts` under the new `admin.modules.manage`
  permission via `withTenant` (verified exported), audit inside the transaction via
  `recordAuditEvent(input, tx)`.
- Revoke guard blocks 409 on `ACTIVE` **and** `SUSPENDED` dependents (resolves prior
  MEDIUM — a SUSPENDED dependent would otherwise become permanently un-reactivatable).
  The revoke/list `findMany` carries the **mandatory** `where: { institutionId }` filter
  under `privilegedPrisma` — correctly flagged as load-bearing because the privileged
  client bypasses RLS.
- Audit keys `platform.module.entitled`/`revoked`, `admin.module.activated`/`suspended`
  are well-formed 3-segment `<module>.<resource=module>.<action>` keys that pass the
  existing `audit-actions.test.ts` shape regex (verified the catalogue convention and the
  no-migration-mirror rule for audit actions). The new `admin.modules.manage` permission
  does need a migration seed + `SEEDING_MIGRATION_DIRS` addition — correctly specified
  (§8.3), with the exact block markers the parser keys on verified against
  `catalogue-sync.test.ts` (`INSERT INTO "permissions" ... ON CONFLICT`, `INSERT INTO
  "role_permissions" ... AS m(`).

**(5) `requireModuleActive` enforcement — right institution row, platform/pre-auth
un-gated.** PASS.
- Reads `request.auth.institutionId` (token-derived only, never request input) — matches
  `identity-rbac.md` §5.1/§6.3. Point read on `privilegedPrisma` filtered by
  `(institutionId, moduleKey)`, fail-closed 500 on throw, 403 on not-ACTIVE, 401 on unset
  `request.auth` (mirrors the verified `requirePermission` defensive branch). The
  `string → ModuleKey` param narrowing is source-compatible (every call site passes the
  literal `"campus_movement"`).
- Platform, pre-auth, and the module-management routes are explicitly NOT gated (circular
  for the latter). SUPER_ADMIN handled by not wiring the guard onto platform routes (A7),
  not a branch.
- The `GET /admin/support-grants` carve-out is real and correctly reasoned: verified that
  route is keyed `campus_movement.audit.view` (`admin.ts` ~line 2012) and reads the
  platform `support_grants` table — a break-glass surface, not a Campus Movement
  operation. The full call-site audit table (`/stats`, `/analytics` =
  `analytics.view`; `/audit-logs`, `/support-grants` = `audit.view`) matches the live
  routes (verified). The `(method,url)` allow-list carve-out is the right mechanism and
  option (b)/(c) rejections are sound.

**(6) Test plan — escape suite, dependency validation, suspended→403.** PASS.
- Escape-suite extension: add `institution_modules` to `RLS_TABLES`; the design correctly
  identifies both edits needed — `cleanup()` (delete child-first, before the institution
  delete, because the FK is `ON DELETE RESTRICT`) **and** `countRemainingTestRows()` (add
  to the counted list, else a leaked row is silently uncounted and the `=== 0` assertion
  loses coverage). Verified against the live helper that both functions exist and that the
  teardown asserts count `=== 0`. Cross-tenant read/write/buggy-query/three-GUC-state
  tests all extended.
- Dependency validation via the declared `attendance` edge (real declared edge, not a
  test-only constant), including the SUSPENDED-dependency 409 case and reactivation.
- `requireModuleActive`: 403-when-not-ACTIVE, allow-when-ACTIVE, fail-closed-500, and the
  deliberate update of the existing permit-all unit pin (the test-breaking change that
  proves the stub became real).
- Revoke tenant-scoping test (same dependent edge in two institutions, revoke in A lists
  only A's dependent) correctly pins the mandatory `institutionId` filter.
- `modules.test.ts` acyclicity/known-key meta-test guards the graph.

**(7) Migrations NEW-only, FROZEN untouched, no `migrate dev` against Supabase.** PASS.
- Verified 5 existing migrations (matches the startup-log "5 migrations found");
  FROZEN set (`init`/`tenancy_isolation_rls` [B-1], `identity_rbac_b2`,
  `superadmin_security`) is untouched — the design adds one NEW migration and the latest
  existing timestamp (`20261019053533`) guarantees the new one sorts last (A4 verified).
- Authoring via `migrate dev --create-only` then `migrate deploy`, never `migrate dev`
  against shared Supabase — matches `database.md` §4.
- Enum + table + composite unique/FK + RLS + GRANT pin + backfill + invariant guard +
  permission seed block all in the one hand-authored migration, per `database.md` §4's
  "same migration" rule.

---

## Verified Assumptions

These design claims were checked against source and are **correct**:

- `requireModuleActive` is a permit-all stub and is wired onto **zero** routes today
  (`authz-engine.ts`; `grep` finds it only there + its unit test). The stub-body rewrite
  is inert until the guard is wired. — **VERIFIED.**
- `sanitizeMetadata` (`apps/api/src/services/audit.ts`) copies only `string|number|
  boolean|null` and silently drops arrays/objects (and drops secret-pattern keys). An
  `affectedDependents` array would never persist. — **VERIFIED.**
- `GET /support-grants` (`admin.ts` ~line 2012) is keyed `campus_movement.audit.view` and
  reads the platform `support_grants` table. `/stats` + `/analytics` are
  `campus_movement.analytics.view`; `/audit-logs` is `campus_movement.audit.view`. —
  **VERIFIED.**
- `platform.entitlements.manage` exists in the catalogue and is bound to `SUPER_ADMIN`;
  `admin.support.revoke` exists and is ADMIN-bound (write permission); `admin.modules.
  manage` does **not** yet exist. — **VERIFIED.**
- `platformRoutes` registers `requireSuperAdmin()` + `requirePlatformMfa()` as plugin
  preHandlers; `requirePlatformMfa`/`requireStepUp` exist in `middleware/step-up.js`. —
  **VERIFIED.**
- `privilegedPrisma` and `withTenant` are exported from `@campusgate/db`;
  `recordAuditEvent(input, tx?)` uses `tx ?? privilegedPrisma`. — **VERIFIED.**
- `seed.ts` creates exactly one PLATFORM institution + one DEMO `institution` object, and
  already excludes superadmin/PLATFORM from membership backfill. — **VERIFIED.**
- `Institution.code` is a unique `String`, so `code <> 'PLATFORM'` is a valid (if
  assumption-laden) tenant discriminator. — **VERIFIED.**
- 5 migrations exist; the FROZEN set is untouchable and the new migration sorts last by
  timestamp. — **VERIFIED.**
- `tenant-escape-setup.ts` has both `cleanup()` and `countRemainingTestRows()`; the
  teardown asserts count `=== 0`; `RLS_TABLES`/`EXPECTED_POLICIES`/`DEFAULT_POLICIES`
  exist with exactly the structure the design relies on. — **VERIFIED.**
- `catalogue-sync.test.ts` parses `INSERT INTO "permissions" ... ON CONFLICT` and
  `INSERT INTO "role_permissions" ... AS m(` and unions over `SEEDING_MIGRATION_DIRS`. —
  **VERIFIED.**
- Audit action keys follow the 3-segment `<module>.<resource>.<action>` convention and
  pass `AUDIT_ACTION_KEY_SET` validation in `recordAuditEvent`. — **VERIFIED.**

## Unverified / Wrong Assumptions

- None found to be **wrong.** No design claim contradicted source.
- **Un-verifiable at design time (correctly flagged by the design, not defects):**
  - A3 (no concrete Phase-0 `campus_movement` scheduled job needs a module gate beyond
    route enforcement) — plausible; not exhaustively checked against the jobs/scheduler
    code in this review. The design scopes job-level checks out of Phase 0, which is a
    reasonable boundary.
  - The Supabase P1001 interaction with the fail-closed-500 read (§7.1, finding-7
    acknowledgement) — a production-only measurement, correctly deferred to
    `database.md`'s "measure in production" plan rather than patched speculatively.
  - `code <> 'PLATFORM'` as the sole tenant discriminator — correct **today** (one
    PLATFORM institution) but an assumption, not an invariant, since the platform
    create-institution route accepts any `code`. The design explicitly pins this and
    tells a future phase to re-key onto a status/flag column if a second non-tenant
    institution is ever created. Acceptable for Phase 0.

---

## Summary

The design is thorough, internally consistent, and every source claim it leans on is
accurate. The three MEDIUM/HIGH gaps from prior rounds are genuinely closed. The three
remaining NITs are clarity/robustness pins (name the secret-key-pattern trap, write out
the service signatures/result types, specify Phase-0 `settings` body handling) — none
block implementation. **APPROVED.**
