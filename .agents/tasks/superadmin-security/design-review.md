# Design Review — CAMPASS Phase 0 Super Admin & Platform Security (resumed round)

**Design under review:** `.agents/tasks/superadmin-security/design.md` (revision round 4 — responding to the latest `design-review.json`)
**Prior verdict being re-checked:** CHANGES_REQUESTED (1 HIGH, 2 MEDIUM, 3 NIT) from `design-review.json`
**Specs cross-checked:** `docs/superadmin-security.md`, `docs/tenancy.md`, `docs/identity-rbac.md`, `docs/database.md`
**Live source re-verified this round:** `packages/db/src/index.ts`, `packages/db/.env.example`, the two frozen migrations (`20261018110658_tenancy_isolation_rls`, `20261018171747_identity_rbac_b2`), `apps/api/src/services/__tests__/catalogue-sync.test.ts`
**Posture:** AUTH/SECURITY-CRITICAL. This is a targeted resolution check: the security spine is already approved in spirit; the only question is whether each of the six prior findings landed and whether any previously-resolved item regressed. No approach changes are demanded.

---

## Scope of this review

Per the step brief, I judged exactly two things:

1. Does each of the six prior findings (1 HIGH, 2 MEDIUM, 3 NIT) now resolve fully in the design text?
2. Did any previously-resolved item regress (campass_app NOBYPASSRLS; inert `TO postgres` policies removed; 28-value `LEGACY_AUDIT_ACTION_MAP`; frozen migrations untouched; `recordAuditEvent` optional-tx; otplib pinning)?

I read the full design (§0–§16) and spot-verified the load-bearing live-source claims the resolutions rest on.

---

## Resolution check — the six prior findings

### HIGH #1 — nullable-`institutionId` `=` policy proven fail-closed for empty-string/unset GUC — RESOLVED

The required `nullif(current_setting('app.current_institution_id', true), '')` wrapper now appears in **both** `USING` and `WITH CHECK` on all three load-bearing policies:

- §2.4 `support_grants_tenant_read` — `USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''))`.
- §2.5 `tenant_isolation_select` — same `USING`.
- §2.5 `audit_events_tenant_insert` — same expression in `WITH CHECK`.

The design argues the collapse correctly: `nullif(..., '')` turns both an unset GUC (already NULL) and an empty-string GUC (`''`) into NULL, so `"institutionId" = NULL` is NULL (never TRUE) — genuinely fail-closed in both states. §2.5 adds the note that `withTenant`/`withSupportGrant` always `set_config` a validated non-empty cuid, never `''`, making the wrapper defense-in-depth rather than the sole guard.

The verification plan matches the brief: §9.2 #3 exercises **three GUC states** — foreign-tenant (A set, probing B), empty-string (`''`), and unset — and for each asserts **zero rows on SELECT and rejection on the INSERT `WITH CHECK`**, covering both the SELECT policy and the INSERT path. This is exactly the three-state SELECT + INSERT assertion the finding demanded.

### MEDIUM #2 — DB-enforced append-only for every role incl. owner — RESOLVED (option b)

§2.6 step 6a adds the `BEFORE UPDATE OR DELETE` trigger on `audit_events`:

```sql
CREATE OR REPLACE FUNCTION "audit_events_append_only"() RETURNS trigger ...
  RAISE EXCEPTION 'audit_events is append-only: % is not permitted', TG_OP USING ERRCODE = 'restrict_violation';
CREATE TRIGGER "audit_events_no_update_delete"
  BEFORE UPDATE OR DELETE ON "audit_events" FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"();
```

The design correctly notes a trigger binds even the table owner (unlike a GRANT, which the owner is exempt from), so the `postgres`/`privilegedPrisma` path can no longer `UPDATE`/`DELETE` an audit row — closing the exact hole the finding named.

The overstated "owned by the DB GRANT" claim is replaced. §8 "Invariant ownership" now reads: append-only is "owned by a DB `BEFORE UPDATE OR DELETE` trigger … which binds **every** role including the table owner / `postgres` privileged path — not merely the `campass_app` GRANT," with the GRANT as a second layer for the tenant role. The design also states the trigger is scoped to `audit_events` only, so the §6.4 `support_grants` lazy-expiry update is unaffected.

The source-assertion test is present: §9.1 asserts `auditEvent.update`/`.delete`/`.deleteMany` never appear anywhere under `apps/api/src`; §9.2 #4 adds a live test that a privileged `UPDATE`/`DELETE` on `audit_events` is rejected by the trigger while the `support_grants` expiry update still succeeds. Both halves of the finding (trigger + source assertion) landed.

### MEDIUM #3 — break-glass read-only by construction + separate privileged audit tx — RESOLVED

§6.2 opens the break-glass transaction with `SET TRANSACTION READ ONLY` as the **first** statement, before `set_config`:

```ts
await tx.$executeRawUnsafe(`SET TRANSACTION READ ONLY`);
await assertBreakGlassRoleIsRlsSubject(tx);
await tx.$executeRawUnsafe(`SELECT set_config('app.current_institution_id', $1, true)`, institutionId);
```

The "read-only by convention" language is replaced with the enforced mechanism in §6.2 and in §13(d) ("opened `SET TRANSACTION READ ONLY` as its first statement … a break-glass write is rejected by Postgres by construction — not merely 'read-only by convention'").

The audit-write placement is exactly as the finding required: §6.2, §6.3, and §13(d) all state the `platform.support_grant.accessed` insert cannot run in the read-only tx and is written by a **separate** `recordAuditEvent` call on `privilegedPrisma` **after** `withSupportGrant` returns, in the order "read-only tenant read → privileged audit insert." §6.3's flow diagram and prose confirm the audit write is awaited before the response and a failure aborts with 500.

Verification matches: §9.2 #1 confirms `SET TRANSACTION READ ONLY` works over the Supavisor 6543 transaction pooler inside the explicit tx, and asserts a write attempted inside `withSupportGrant` is rejected with `cannot execute … in a read-only transaction`. Both the rejected-write test and the pooler-compatibility note are present.

### NIT #4 — audit-action namespace note — RESOLVED

§4.1 adds the namespace note: the singular `platform.institution.*` audit-action keys are a separate namespace from the plural `platform.institutions.manage` permission key, no relationship implied, singular/plural intentional.

### NIT #5 — recovery-code count + format pinned — RESOLVED

`RECOVERY_CODE_COUNT = 10` is pinned in §2.3, §5.2, and §8.1, with a concrete format: 10 characters of Crockford base32 `^[0-9A-HJKMNP-TV-Z]{10}$`, CSPRNG-generated, shown grouped `XXXXX-XXXXX`, stored bcrypt-hashed, compared hyphen-stripped. §9.1 asserts exactly 10 codes, each matching the regex, with single-use (consumed hash removed, reuse rejected).

### NIT #6 — conditional lazy-expiry + single-event audit — RESOLVED

§6.4 makes the expiry flip a conditional `updateMany({ where: { id, status: 'ACTIVE', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } })` and writes `platform.support_grant.expired` **only when `count === 1`**. §9.2 #6 asserts two concurrent loads of the same stale grant produce exactly one expiry audit row.

---

## Regression check — previously-resolved items

All held; none regressed.

1. **campass_app NOBYPASSRLS** — §0, §6.2, and §12 keep the role NOSUPERUSER NOBYPASSRLS and explicitly state break-glass never grants BYPASSRLS. Verified against both frozen migrations' GRANT blocks (comments "stays NOSUPERUSER NOBYPASSRLS — never granted BYPASSRLS") and `packages/db/src/index.ts`. No change.
2. **Inert `TO postgres` policies removed** — §2.4, §2.5 explicitly create NO `*_platform_all TO postgres` policy; §9.3's per-table policy map lists only load-bearing policies (`audit_events → {tenant_isolation_select, audit_events_tenant_insert}`, `support_grants → {support_grants_tenant_read}`). No regression.
3. **28-value `LEGACY_AUDIT_ACTION_MAP`** — §4.4 contains the full 28-row enum→key table (incl. `EMERGENCY_OVERRIDE → campus_movement.pass.override`), captured as `LEGACY_AUDIT_ACTION_MAP` with a §9.1 unit test asserting 1:1 coverage. Intact.
4. **Frozen migrations untouched** — §2, §3, §12 reaffirm the two frozen migrations are byte-for-byte unchanged; the `admin.support.revoke` seed goes into the new `superadmin_security_c` migration and the catalogue-sync test is generalized (not the frozen SQL). Verified the test is still hard-pinned to `identity_rbac_b2` in live source, which is exactly why the design generalizes the test rather than editing the frozen file. No regression.
5. **`recordAuditEvent` optional-tx** — §4.3 keeps the optional `tx?: Prisma.TransactionClient`, `client = tx ?? privilegedPrisma`, tenant writes in-tx (atomic), platform writes on privileged. Intact and consistent with the new §2.6 INSERT grant.
6. **otplib pinning** — §5.1 pins `authenticator.options = { window: 1, step: 30 }`; §10 pins exact `otplib`/`qrcode` versions in `package.json`. Intact.

The new §2.6 targeted REVOKE of `UPDATE, DELETE` on `audit_events` and `INSERT, UPDATE, DELETE` on `support_grants` from `campass_app` is consistent with the verified live B-1 blanket `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` + `ALTER DEFAULT PRIVILEGES`, so the REVOKEs are necessary and correctly scoped — no conflict with the frozen grants.

---

## Verified Assumptions (checked against live source this round)

1. **`campass_app` is NOSUPERUSER NOBYPASSRLS** and the B-1/identity_rbac_b2 GRANT blocks hand it blanket `SELECT, INSERT, UPDATE, DELETE` + `ALTER DEFAULT PRIVILEGES` — VERIFIED in both frozen `migration.sql` files. This is why the §2.6 targeted REVOKEs are required and correct.
2. **`catalogue-sync.test.ts` is hard-pinned to `MIGRATION_DIR = "20261018171747_identity_rbac_b2"`** and asserts set-equality against `@campusgate/shared` — VERIFIED. The design's generalize-to-union approach (leaving the frozen SQL untouched) is the right way to seed `admin.support.revoke` in the third migration without breaking the test.
3. **`privilegedPrisma` connects as `postgres` and BYPASSES RLS; `DATABASE_URL`/last-resort fallback could point at campass_app** — VERIFIED in `packages/db/src/index.ts` and `.env.example`. This is the fail-open risk the §6.2 `assertBreakGlassRoleIsRlsSubject` probe closes, and it remains addressed.
4. **Both frozen migrations are present and their GRANT guards use `IF EXISTS (… rolname='campass_app')`** — VERIFIED; the new migration's §2.6 step 7 mirrors this guard.

## Unverified / Wrong Assumptions

None material to the verdict. Two items remain live-smoke-only (as the design itself states, not defects):

1. **`SET TRANSACTION READ ONLY` and `nullif(...)` behavior over the Supavisor 6543 pooler** — asserted by the design to be proven in §9.2 live-smoke, not provable from static review. The design correctly routes both through the integration suite rather than claiming them proven here. Not a blocking gap; it is the test the design commits to run.
2. **The 28 call-site line numbers in §4.4** were verified in the prior review round and are not re-litigated here; nothing in this revision changed them.

---

## Verdict

All six prior findings (1 HIGH, 2 MEDIUM, 3 NIT) are fully resolved in the design text, each with the exact mechanism and verification the finding demanded. No previously-resolved item regressed. Remaining HIGH + MEDIUM count = **0**.

**APPROVED.**
