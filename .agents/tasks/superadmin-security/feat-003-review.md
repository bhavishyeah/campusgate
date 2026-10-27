# MFA, step-up, break-glass grants, and audit explorer for CAMPASS platform security

FEAT-003 lands the final slice of the Phase 0 Super Admin security spine: real TOTP enrollment/verification for platform accounts, an action-class-bound step-up token, a mandatory-MFA gate on the platform plugin, the SupportGrant lifecycle with a single read-only break-glass proxy, the platform/tenant grant endpoints, the Super-Admin audit explorer, and the extended RLS escape suite. It builds on FEAT-001 (`withSupportGrant` + the `breakGlassPrisma` campass_app client) and FEAT-002 (`recordAuditEvent` + `audit_events`), neither of which this commit alters. The implementation follows the APPROVED design closely — the six baked-in findings (nullif-guarded RLS, append-only trigger, read-only break-glass + separate audit append, RECOVERY_CODE_COUNT=10, conditional lazy-expiry, singular/plural namespace note) are all honored — and the coder's evidence (root `npm run build` 3/3, `vitest run` 188 passed against live Supabase, 20/20 live smoke) covers every acceptance criterion.

Watch for: a resolved design decision worth noting, not a defect — the audit explorer (`GET /api/platform/audit-events`) is gated on `platform.security.respond` rather than `platform.support.grant` (confirmed); the design §7.5 pins no specific key, and this is a defensible platform-scoped choice. The `POST /verify` action class defaults to `"support_grant.create"` from the body (confirmed), which is fine because `requireStepUp` always checks the action class server-side. No blocking concerns found.

**Verdict**: APPROVED

## High-level view

MFA is real, not stubbed. `services/mfa.ts` pins `authenticator.options = { window: 1, step: 30 }`, issues exactly `RECOVERY_CODE_COUNT = 10` Crockford-base32 codes matching `^[0-9A-HJKMNP-TV-Z]{10}$`, bcrypt-hashes them at cost 12, returns plaintext once, and removes the consumed hash on use. `/enroll/start` stores the secret without flipping `mfaEnabled`, exactly as the spec requires.

The step-up token is a signed JWT `{ userId, jti, stepUp: true, action, exp: 5m }` minted through the existing `@fastify/jwt` signer. `verifyStepUpToken` checks signature/expiry (via the verifier), `stepUp === true`, `userId` match, and `action === actionClass`, rejecting a wrong action class — so a grant-create token cannot authorize a different high-risk action. It is multi-use within the 5-minute TTL, an explicitly accepted Phase-0 decision with the `jti` already minted for a later single-use upgrade.

The mandatory-MFA gate `requirePlatformMfa()` is wired on `platformRoutes` AFTER `requireSuperAdmin()`, reads `mfaEnabled` via `privilegedPrisma`, 403s un-enrolled platform holders, and exempts the enrollment endpoints by URL prefix.

Break-glass is the only path into a tenant's rows and it is read-only by construction. The sole caller of `withSupportGrant` validates the grant on `privilegedPrisma` first (ACTIVE, not expired via lazy-expiry, operator-bound, institution not suspended), reads with an explicit `where: { institutionId }` inside the read-only campass_app transaction, then writes the `.accessed` audit on a separate awaited `privilegedPrisma` call after the helper returns — a failed audit write aborts with 500.

Grant lifecycle uses a conditional `updateMany` for lazy-expiry so concurrent loaders are idempotent: only `count === 1` writes the single `.expired` audit. Tenant revoke asserts `grant.institutionId === request.auth.institutionId` (404 otherwise) and is gated on the dedicated write key `admin.support.revoke`; the tenant grant list reads through `withTenant`.

The escape suite adds `audit_events` and `support_grants` to `RLS_TABLES` with a per-table expected-policy map, and the new integration suite proves all five design §9.2 cases against live Supabase: break-glass scope (including a filter-less probe and a rejected write), three GUC states on both the SELECT policy and the INSERT WITH CHECK, append-only for both campass_app (GRANT) and the privileged owner (trigger), tenant transparency, and lazy-expiry idempotency.

<details>
<summary>Issues (3)</summary>

1. **Audit-explorer permission choice** — `GET /api/platform/audit-events` is gated on `platform.security.respond`; the design pins no key here. Informational; confirm this is the intended key or switch to `platform.support.grant` for consistency with the other grant endpoints. Non-blocking.
2. **Step-up action class defaults from request body** — `POST /api/auth/mfa/verify` defaults `action` to `"support_grant.create"` from the body. Safe because `requireStepUp` checks the class server-side, but a client requesting a token for an unintended class is possible. Informational, non-blocking.
3. **Guard 403/401 shapes not in service unit tests** — spec step 7d lists guard-response-shape assertions; these are covered by the live smoke rather than a unit test. Non-blocking given the smoke evidence; consider adding a route-level test later.

</details>

<details>
<summary>Details</summary>

### MFA and recovery codes

`services/mfa.ts` is real TOTP: `authenticator.options = { window: 1, step: 30 }` is set at module load (confirmed), `verifyTotp` trims the token and treats an otplib throw as a rejection rather than a 500. `generateMfaEnrollmentSecret` produces the secret + otpauth URI + QR data URL; `/enroll/start` stores the secret on `mfaSecret` and deliberately does not set `mfaEnabled`, so a half-finished enroll never weakens existing MFA.

Recovery codes meet every pinned constraint (confirmed): `RECOVERY_CODE_COUNT = 10`; `drawRecoveryCode` draws from the Crockford alphabet with explicit modulo-bias rejection; codes are stored as bcrypt hashes at cost 12 and returned in plaintext exactly once from `/enroll/verify`. `consumeRecoveryCode` normalizes (strip whitespace/hyphens, upper-case), enforces `^[0-9A-HJKMNP-TV-Z]{10}$` before any bcrypt compare, and returns the matched hash so the route can filter it out of `mfaRecoveryCodes` — single-use by removal. The unit suite asserts the happy path, wrong code, single-use consumption, and format rejection.

### Step-up token

`mintStepUpToken` sets `{ userId, jti: randomUUID(), stepUp: true, action }` with `expiresIn: 300`. `verifyStepUpToken` returns a discriminated result and rejects on invalid/expired signature, `stepUp !== true`, user mismatch, and wrong action class — each as a distinct reason, so `requireStepUp` can 401 uniformly while logging the cause. The guard reconstructs the verifier from `request.server.jwt` (the same signer that mints), checks the `x-step-up` header is a non-empty string, and fails closed when `request.auth` is absent. Wrong-action-class and wrong-user rejections are unit-tested.

The multi-use-within-TTL decision is the design's explicitly accepted Phase-0 trade-off; the `jti` claim is present so a consumed-jti store is a non-breaking later addition. The `// PHASE-0 SEAM` note in `step-up.ts` documents that the other high-risk actions attach to this same guard when their modules land.

### Mandatory-MFA gate placement

`requirePlatformMfa()` is added to `platformRoutes` as a second `preHandler` hook immediately after `requireSuperAdmin()` (confirmed in `platform.ts`), so `request.auth` is populated before it runs. It fails closed if `auth` is missing (401), exempts the three enrollment URLs via `startsWith` on `routeOptions.url ?? request.url`, and otherwise reads `mfaEnabled` through `privilegedPrisma.user.findUnique` — correct, since a platform user is pre/non-tenant. An un-enrolled holder gets `403 { error: "MFA enrollment required" }`. The enrollment endpoints themselves live on the `mfaRoutes` plugin under `/api/auth/mfa` with only `authenticate`, so they are reachable without MFA.

### Break-glass read path

```
POST/validate on privilegedPrisma         read on breakGlassPrisma (campass_app)        append on privilegedPrisma
──────────────────────────────────        ─────────────────────────────────────        ──────────────────────────
validateGrantForAccess(id)                 withSupportGrant(institutionId):              recordAuditEvent(.accessed,
  ACTIVE / not expired (lazy) /               SET TRANSACTION READ ONLY (1st)              SUCCESS)  ← awaited, AFTER
  grantedToUserId === caller /                NOBYPASSRLS role probe                       failure ⇒ 500, result
  institution not SUSPENDED                   set_config(GUC = institutionId)              discarded
  (DENIED audit on any failure)               fn: findMany where institutionId
```

`breakGlassReadTenant` is the only caller of `withSupportGrant` (confirmed by inspection) and always injects `where: { institutionId: grant.institutionId }` into both the `auditEvent` and `gatePass` reads — defense-in-depth over the RLS layer, which is itself genuine here because `breakGlassPrisma` runs as NOBYPASSRLS `campass_app` and the helper's first statement is `SET TRANSACTION READ ONLY` followed by the `rolbypassrls` probe that throws if the role ever bypasses RLS. The `.accessed` SUCCESS audit is a separate, awaited `privilegedPrisma` write issued after the read-only transaction returns; its failure returns `auditWriteFailed`, which the route maps to 500 and discards the read. `validateGrantForAccess` writes a DENIED `.accessed` audit (best-effort, `.catch(() => {})`) on every rejection branch and re-checks expiry via `lazyExpireGrant` rather than trusting `status` alone.

The integration suite proves this at the DB layer against live Supabase: case 1 reads only tenant A's rows through the real helper including a filter-less probe (RLS alone scopes), and case 1b confirms a `notification.create` inside the helper rejects with `/read-only transaction/i`.

### Grant lifecycle and lazy-expiry idempotency

`createSupportGrant` collapses REQUESTED→ACTIVE for the Super-Admin flow, takes `grantedToUserId` from `actor.userId` (never the body), and writes both `.created` and `.activated` audits. The zod schema bounds `purpose` to 1..500, requires `expiresAt > now` and `<= now + MAX_TTL_MS` (4h), and shapes `scope` as an optional advisory object. `lazyExpireGrant` is a conditional `updateMany WHERE id, status='ACTIVE', expiresAt<=now` and writes the single `.expired` audit only when `count === 1`, so concurrent loaders produce exactly one audit — case 6 of the integration suite confirms exactly one winner under two concurrent updates and the final EXPIRED status.

### Tenant revoke and transparency

`POST /api/admin/support-grants/:id/revoke` loads the grant on `privilegedPrisma` (correct — `support_grants` is a platform table and campass_app has SELECT only), asserts `grant.institutionId === request.user.institutionId` and returns 404 otherwise (avoiding existence disclosure for another tenant's grant), sets REVOKED + revocation metadata, and audits `.revoked`. It is gated on the dedicated `admin.support.revoke` write key, keeping revoke authority separate from the read key — the least-privilege split the design §3 insisted on. `GET /api/admin/support-grants` reads through `withTenant` so `support_grants_tenant_read` scopes rows to the caller; case 5 of the integration suite confirms a tenant sees only its own grants and that campass_app without a GUC sees zero (fail-closed).

### Audit explorer read semantics

The `/audit-logs` reader fix is the one behavioral change to an existing endpoint and it is correct: it drops the required-relation `include` on `actorUser` (which would 500 on a break-glass `.accessed` row whose platform actor is RLS-invisible to the tenant), selects rows under `withTenant` RLS, then resolves actor summaries separately on `privilegedPrisma` and attaches them — preserving the `{ logs: [{ ...row, actorUser }], pagination }` shape and delivering the design §4.4 transparency requirement (the tenant sees the break-glass row). The actor-join filter is correctly not reintroduced.

`readPlatformAuditEvents` serves the Super-Admin explorer on `privilegedPrisma` with an explicit filter per scope — `institutionId: null` for platform, or a single validated grant's tenant for `scope=grant` — so the operator never gets all tenants at once. `scope=grant` runs the full `validateGrantForAccess` (ACTIVE/operator-bound/not-suspended), and a missing `grantId` is a 400. The route gates this on `platform.security.respond`; the design pins no key for this endpoint, so this is a defensible choice rather than a deviation, called out above as informational.

### Escape suite and meta-test

`RLS_TABLES` gains `audit_events` and `support_grants`. The per-table `EXPECTED_POLICIES` map lists `audit_events → {tenant_isolation_select, audit_events_tenant_insert}` and `support_grants → {support_grants_tenant_read}`, with `DEFAULT_POLICIES` (the standard select/modify pair) for everything else; meta-test #6 now iterates the expected set per table instead of asserting the standard pair everywhere. No inert `*_platform_all TO postgres` policy is asserted, matching the design's "load-bearing policies only" stance. Case 3 exercises all three GUC states (foreign/empty-string/unset) on both the SELECT policy and the INSERT WITH CHECK; case 4 proves append-only for campass_app (GRANT-revoked UPDATE) and the privileged owner (trigger rejects UPDATE and DELETE with `/append-only/i`) while confirming a privileged `support_grants` UPDATE still succeeds (trigger scoped to `audit_events` only). The teardown correctly disables/re-enables the append-only trigger for its scoped delete.

### Scope hygiene

No new migration is added and no `prisma migrate dev` was run against the shared DB (confirmed — the changed-files list contains no `packages/db/prisma/migrations/**`). No `.env` is staged (the diff touches only `.env.example`). The no-straggler scan was generalized to skip `__tests__` helper directories so the escape-suite teardown's legitimate `auditEvent.deleteMany` is not flagged as a production write — a sound narrowing. No module-entitlement work leaked in; `scope` on a grant remains advisory as the design states. `breakGlassPrisma`/`withSupportGrant` are reused from FEAT-001 and unchanged here; campass_app is never granted BYPASSRLS.

</details>

<details>
<summary>File map</summary>

- `apps/api/src/services/mfa.ts` — TOTP + recovery codes + step-up mint/verify (new).
- `apps/api/src/routes/mfa.ts` — `/api/auth/mfa` enroll/start, enroll/verify, verify (new).
- `apps/api/src/middleware/step-up.ts` — `requirePlatformMfa()` + `requireStepUp()` (new).
- `apps/api/src/services/support-grant.ts` — grant lifecycle, lazy-expiry, break-glass proxy, audit explorer (new).
- `apps/api/src/routes/platform.ts` — support-grant CRUD, break-glass overview, audit-events explorer; MFA gate wired.
- `apps/api/src/routes/admin.ts` — tenant revoke + grant list; `/audit-logs` actor-resolution fix.
- `apps/api/src/server.ts` — registers `mfaRoutes`.
- `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` — RLS_TABLES + per-table policy map.
- `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts` — meta-test #6 per-table policies.
- `apps/api/src/routes/__tests__/superadmin-security.integration.test.ts` — design §9.2 live cases (new).
- `apps/api/src/services/__tests__/mfa.test.ts`, `support-grant.test.ts` — unit suites (new).
- `apps/api/src/services/__tests__/no-straggler-audit.test.ts` — skip `__tests__` helpers.
- `apps/api/.env.example` — break-glass role-contract doc.

Full diff: `git show HEAD` on branch `main` (commit 304f2d0).

</details>
