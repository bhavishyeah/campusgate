# Design Review — CAMPASS Phase 0 Identity & RBAC (B2)

Reviewed document: `c:\campusgate\.agents\tasks\identity-rbac-design.md`
Review type: gate step of the design loop (round 5). Document-only review; no build/test run.
Reviewer posture: fresh read, verifying every "verified against the code / schema / doc" claim against the live source-of-truth docs and real code rather than trusting the design's word.

## Verdict

**APPROVED.** Zero HIGH and zero MEDIUM findings. The one NIT below is non-blocking and does not change the verdict.

The revision that resolved round 4's findings (0 HIGH, 2 MEDIUM, 1 NIT) landed correctly, and I independently re-verified the round-1→4 resolutions this gate was asked to confirm. No new gaps were introduced by the edits.

---

## Findings

1. **NIT — `role_permissions` single-column FK ordering rationale is lightly overstated as the only ordering constraint.** §3.1 step 2b says `role_permissions` "must be inserted after both or the FK insert fails" because it has single-column FKs to both `roles` and `permissions`. That is correct. A tightening for the implementer: the pinned order (permissions → roles → role_permissions) also happens to be the only order that satisfies *both* FK legs simultaneously, so the rule is not merely a preference — spell out that `roles` before `permissions` is interchangeable but `role_permissions` strictly last. Concrete fix: in step 2b, change "must be inserted after both" to "must be inserted strictly last (the `roles`↔`permissions` relative order is free; only `role_permissions` is order-constrained, needing both parents present)." Non-blocking; the current text already produces a correct migration.

No HIGH or MEDIUM findings.

---

## Targeted resolution checks (the items this gate was asked to confirm)

### HIGH #1 — SUPER_ADMIN enforcement is the honest three-point posture, not a claimed `withTenant`-level gate — CONFIRMED RESOLVED
§6.3's "Enforcement of the invariant — the honest Phase-0 posture (finding #1)" paragraph states exactly the three mechanisms and no more:
1. `requireSuperAdmin()` keeps platform routes off tenant routes;
2. `requirePermission` 403s a SUPER_ADMIN on every migrated tenant route because the SUPER_ADMIN role maps only to `platform.*` (so the handler's `withTenant` is never reached);
3. `request.tenant`/`institutionId` is left unset for a SUPER_ADMIN, so no tenant transaction can be opened even if a tenant route were reached.

It explicitly disclaims any gate "at the `withTenant` call site" and relegates a `tenantTx(req, fn)` wrapper to optional future hardening out of Phase-0 scope. Verified against live code:
- `packages/db/src/index.ts`: `withTenant(institutionId, fn)` is a standalone exported function with no access to `request`/`request.tenant`/`request.auth` — there is genuinely no central call site a role assertion could live at.
- `apps/api/src/routes/guard.ts`: handlers call `withTenant(institutionId, ...)` with a local `const { institutionId } = request.user`, confirming the ad-hoc pattern the design describes.
- `packages/db/src/seed.ts`: `superadmin@campusgate.local` is created with `institutionId: platformInstitution.id` (the real `code:"PLATFORM"` institution, not null) — matching §6.3's statement that the PLATFORM id is real/resolvable and must never be fed to `app.current_institution_id`.
- `apps/api/src/middleware/auth.ts` + `platform.ts`: platform routes are gated by `requireSuperAdmin()` and use `privilegedPrisma`, never `withTenant`.

The posture is factually accurate and matches §13.0 item 2 / §13.2 finding #1 annotations.

### MEDIUM #2 — authentication ownership stated once; `requirePermission` is a pure `can(...)` check — CONFIRMED RESOLVED
§6.4's "Authentication ownership — stated once (finding #2)" paragraph and §7 (intro + per-route flip steps + the per-route table) agree on one model: each migrated route file **replaces** its single top-level `requireTenantRole(...)` hook with a single top-level bare `authenticate` hook, and `requirePermission` does NOT call `authenticate` — it is a pure `can(request.auth, key)` set check assuming `request.auth` is already populated. The engine-API comment in §6.4 and §6.4's error-handling bullet say the same (defensive 401 only if the top-level hook is missing/misordered, logged at `error`).

Verified against live code:
- `apps/api/src/middleware/auth.ts`: `requireRole`/`requireTenantRole`/`requireSuperAdmin` each call `authenticate` internally — so today authentication is owned by the role guard, exactly as the design's "real starting state" claims.
- `apps/api/src/routes/{guard,student,hod,admin}.ts`: each installs exactly one top-level `requireTenantRole(...)` hook; `platform.ts` one `requireSuperAdmin()`; only `notifications.ts` installs a bare `authenticate` hook. This precisely matches §6.4/§7's starting-state description, so the "replace the role hook with a bare authenticate hook" flip is coherent and avoids both the double-`authenticate` regression and the all-401 regression the design calls out.

§6.4 and §7 are internally consistent (no contradiction), satisfying the "stated once" requirement.

### MEDIUM #3 — backfill keeps `gen_random_uuid()::text`, no `CREATE EXTENSION`, justified from pg_catalog and consistent with schema defaults — CONFIRMED RESOLVED
§3.1 step 3a (and §11, §12 item 5, §13.3 item 1) keep `gen_random_uuid()::text` with `mbr_`/`mrl_` prefixes and no `CREATE EXTENSION`, justified only by the true fact that `gen_random_uuid()` is a core `pg_catalog` function on Postgres 13+. The round-4 correction removed the earlier false "consistent with existing schema defaults / B-1 already uses gen_random_uuid()::text" clause and now states that existing ids default to cuid via Prisma, making the raw-SQL backfill ids a documented, intentional one-time split.

Verified against live code:
- `packages/db/prisma/schema.prisma`: every model uses `@default(cuid())`; there is no `gen_random_uuid()` default or `dbgenerated(...)` anywhere. The corrected text is accurate — the new tables add no DB-level id default.
- `packages/db/prisma/migrations/20261018100917_init` and `..._tenancy_isolation_rls`: confirmed id columns are declared `TEXT`/text with no DB-level default (the B-1 migration adds only `institutionId` columns, composite uniques, composite FKs, RLS, and GRANTs — no id defaults). The `pgcrypto`/`uuid-ossp` claim is correctly reframed as non-load-bearing.

The justification is now honest and does not overstate precedent.

### NIT #4 — parent uniques named in the composite-FK section — CONFIRMED RESOLVED
§2.2 and §3.1 step 5 name `users_id_institutionId_key` and `departments_id_institutionId_key` as the targets of the two new composite FKs. Verified against the B-1 migration step 5: both constraints are created verbatim (`ALTER TABLE "users" ADD CONSTRAINT "users_id_institutionId_key" UNIQUE ("id","institutionId")` and the `departments` equivalent). The `membership_roles` composite FK target `institution_memberships_id_institutionId_key` is correctly noted as created in this same new migration (step 5). Names are accurate and present.

### NIT #5 — `notifications.ts` in the §7 route inventory as bare-authenticate, out of Phase-0 scope — CONFIRMED RESOLVED
§7's per-route table has a `notifications.ts` row ("current guard = `authenticate` (bare, per-user scope)", "new guard = unchanged — stays bare `authenticate`, no role gate") plus a dedicated note making the inventory exhaustive across `guard/student/hod/admin/platform/notifications`. Verified against `apps/api/src/routes/notifications.ts`: it installs `app.addHook("preHandler", authenticate)` with no role gate, per-user scoped — exactly as described. Correctly out of the permission-flip scope.

### NIT #6 — seed/backfill insert order pinned permissions → roles → role_permissions — CONFIRMED RESOLVED
§3.1 step 2b pins the intra-step order: (i) `permissions` FIRST, (ii) `roles` next, (iii) `role_permissions` LAST. Rationale (single-column FKs to both parents) is correct. See NIT #1 above for a minor wording tightening; the order itself is right and safe.

### Prior-resolved items — NOT regressed
- **Composite FK `ON DELETE RESTRICT` (not SET NULL) on `(departmentScope, institutionId)`** — §2.2, §3.1 step 5, and the §2.7 table all specify `ON DELETE RESTRICT`, MATCH SIMPLE, nullable. Verified against B-1: every composite FK is `RESTRICT` except `gate_passes_approvedBy_same_tenant_fkey` (`SET NULL`), which carries the identical NOT-NULL-`institutionId`-leg hazard the design cites as the reason to avoid plain composite `SET NULL`. The design's uniform-RESTRICT justification is factually grounded. No regression.
- **`permissionsVersion` in the canonical JWT shape** — present and consistent in §6.1, §6.2, §6.3 (pipeline + SUPER_ADMIN branch = `null`), §11 (payload types), and §12 items 1–2. No regression.
- **Escape-suite teardown extension** — §9 and §11 specify adding `institution_memberships` + `membership_roles` to `RLS_TABLES`, child-first `membershipRole`/`institutionMembership` deletes in `cleanup()` ordered before `user`/`department`/`institution`, and both tables added to `countRemainingTestRows()`. Verified against `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`: the current `cleanup()` deletes child-first before user/department/institution and `RLS_TABLES`/`countRemainingTestRows()` do not yet include the two new tables — so the design's diagnosis and prescription are correct and necessary (the new RESTRICT composite FKs would otherwise block the existing deletes). No regression.

---

## Verified Assumptions

- `withTenant` is a standalone exported function in `packages/db/src/index.ts` with no `request` access — confirms no central call site exists for a SUPER_ADMIN gate (HIGH #1).
- Handlers (`guard.ts`) pass a local `request.user.institutionId` into `withTenant` ad hoc — confirms the design's description of the tenant-tx wiring.
- `superadmin@campusgate.local` is seeded on the real `code:"PLATFORM"` institution (`institutionId: platformInstitution.id`), not null (HIGH #1 / §6.3 invariant).
- `requireRole`/`requireTenantRole`/`requireSuperAdmin` authenticate internally; current route files use one top-level role hook each (`platform.ts` → `requireSuperAdmin()`); only `notifications.ts` uses a bare `authenticate` hook (MEDIUM #2, NIT #5, round-4 corrections).
- `schema.prisma` uses `@default(cuid())` for every id; no `gen_random_uuid()`/`dbgenerated` default anywhere; B-1 and init migrations add no DB-level id defaults (MEDIUM #3).
- B-1 migration creates `users_id_institutionId_key` and `departments_id_institutionId_key`; all composite FKs are `ON DELETE RESTRICT` except `gate_passes_approvedBy_same_tenant_fkey` (`SET NULL`) (NIT #4; prior FK-RESTRICT item).
- B-1 RLS uses `tenant_isolation_select` + `tenant_isolation_modify` keyed on `current_setting('app.current_institution_id', true)`, and GRANTs use the `IF EXISTS (pg_roles ... 'campass_app')` idempotent block — the exact patterns the design says it reuses for the two new tenant tables.
- `tenant-escape-setup.ts` `cleanup()` is child-first before user/department/institution; `RLS_TABLES` and `countRemainingTestRows()` currently omit the two new tables — confirms the teardown-extension prescription (prior MEDIUM item).
- `docs/superadmin-security.md` §5.2 and `docs/identity-rbac.md` §5.3 define "re-check permission at the point of action against the DB" + step-up — confirms the design's honest scoping of that as a deferred Phase 0 gap (not equated with the `permissionsVersion` check).
- `docs/database.md` §3.3 replaces `db push` with `prisma migrate deploy` and retires standalone seed scripts in favor of the migration pipeline + maintained seed — supports the design's "seed not guaranteed in the deploy step, so the auth-critical backfill must live in the migration" reasoning.
- `docs/identity-rbac.md` §8 keeps the legacy `role` claim during transition and removes it only after all routes use permissions — matches the design's JWT dual-shape coexistence rule. §3 lists `phone` conceptually, matching §2.1's "new schema column" label.

## Unverified / Wrong Assumptions

- **Live-instance extension state (`pgcrypto`/`uuid-ossp` installed on the Supabase instance).** Not verifiable from the repo; the design already reframes it as a non-load-bearing observation and rests the claim on core `pg_catalog` availability, which is correct for Postgres 13+. No action needed.
- **CI meta-test, `authz-engine.ts`, `permissions.ts`/`ROLE_PERMISSIONS`, and the new migration SQL do not exist yet** — these are deliverables of the implementation, not pre-existing code, so their internal consistency (catalogue-sync set-equality, `resolvePermissions` dedup/sort identity, the exactly-one guard SQL) cannot be verified at design time. The design specifies them concretely enough to implement and test; flagged only as not-yet-verifiable, not as a gap.
- No wrong assumptions were found. Every "verified against …" claim in the design that this gate could check against the repo held up.
