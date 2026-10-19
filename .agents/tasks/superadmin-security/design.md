# CAMPASS Phase 0 — Super Admin & Platform Security — Technical Design

> Implements [`docs/superadmin-security.md`](../../../docs/superadmin-security.md) §2
> (platform-vs-tenant permission split), §4 (`SupportGrant` break-glass), §5 (MFA +
> step-up), §6 (AuditLog v2), and the §7 items not yet done. Builds on the LIVE tenancy
> model ([`docs/tenancy.md`](../../../docs/tenancy.md)), identity/RBAC model
> ([`docs/identity-rbac.md`](../../../docs/identity-rbac.md)), and connection strategy
> ([`docs/database.md`](../../../docs/database.md)).
>
> Status: **revision pass (round 4)** — addresses the latest `design-review.json`
> (verdict CHANGES_REQUESTED: 1 HIGH, 2 MEDIUM, 3 NIT). Every blocking (HIGH/MEDIUM)
> finding is resolved and all three NITs are addressed; §16 records the response to each of
> this round's findings (§14 and §15 preserve the responses to the earlier rounds for
> history). Scope is AUTH/SECURITY critical. Every genuine ambiguity is resolved and
> recorded in §13.

---

## 0. The RLS ground truth this design is built on (read first)

The previous draft rested on a factually wrong claim that the review refuted empirically
against the live Supabase instance. This revision is built on the **verified** model:

- `privilegedPrisma` connects as the **`postgres`** role, which has
  **`rolbypassrls = true`**. Under `FORCE ROW LEVEL SECURITY` the policies **never apply**
  to this role — not because of any `TO postgres` policy, but because the role bypasses RLS
  entirely. A probe setting a bogus `app.current_institution_id` GUC on this role returned
  the **full unscoped** row count. **For `postgres`, `set_config('app.current_institution_id', …)`
  is a no-op for access control.** (Confirmed in `packages/db/src/index.ts`, whose own
  comment states `privilegedPrisma` "BYPASSES the Row-Level-Security policies".)
- `campass_app` is **`NOSUPERUSER NOBYPASSRLS`** (per the B-1 migration comment). For this
  role the `tenant_isolation_*` policies — which have **no `TO` clause** — are genuinely
  enforcing. Setting the tenant GUC under `campass_app` is the *only* place in the system
  where the GUC actually scopes rows. This is the live, escape-suite-proven mechanism.

Two consequences drive the whole design:

1. **Break-glass reads must run on a `campass_app`-backed connection**, not on
   `privilegedPrisma`, so the tenant GUC is a real enforcing layer (resolves HIGH finding 1).
2. **`TO postgres` "platform ALL" policies are inert** and are NOT used as a correctness
   mechanism. Platform writes/reads on `privilegedPrisma` succeed because the role bypasses
   RLS, full stop (resolves MEDIUM finding 2).

---

## 1. Overview

Phase 0 identity/RBAC (B2) and tenancy (B-1/B-2) are already live: `campass_app` runs
every tenant query under forced RLS via `withTenant`, `privilegedPrisma` (the `postgres`
role, bypasses RLS) serves the pre-auth / platform / cross-tenant paths, and the central
authz engine (`requirePermission` / `can` / `requireModuleActive`) is wired. The platform
permission keys (`platform.*`) already exist in `@campusgate/shared` and map to
`SUPER_ADMIN`. The `authenticate` middleware already leaves `request.tenant` unset for a
Super Admin, so a platform account structurally cannot open a tenant transaction today.

This design adds the security spine on top of that foundation, in one new migration plus
API/shared code changes, without touching the two FROZEN migrations
(`20261018110658_tenancy_isolation_rls`, `20261018171747_identity_rbac_b2`):

1. **AuditLog v2** — a new generic `audit_events` table (string `action`, nullable
   `institutionId`, `supportGrantId`, `result`) that supersedes the enum-based
   `audit_logs`, plus a shared **audit-action catalogue** validated the same way the
   permission catalogue is. A single `recordAuditEvent` writer replaces the existing
   direct `tx.auditLog.create(...)` call sites. Tenant actions keep writing their audit row
   **inside the business transaction** (campass_app gets INSERT on `audit_events`),
   preserving today's atomic guarantee; platform / pre-tenant writes go on `privilegedPrisma`.
2. **`SupportGrant`** — a PLATFORM-owned break-glass table (single-tenant, purpose-bound,
   time-limited, revocable, tenant-visible, fully audited) with a gated access path that
   lets a Super Admin read exactly one tenant's data under an ACTIVE grant via the
   `set_config('app.current_institution_id', …)` RLS mechanism **on a `campass_app`-backed
   per-access transaction** — never a `BYPASSRLS` bypass, never standing access.
3. **MFA + step-up** — real TOTP enrollment/verification for platform accounts (via
   `otplib`), a mandatory-MFA policy gate for `platform.*` holders, and a concrete
   step-up gate on `SupportGrant` creation/activation, with a clearly marked seam for the
   later high-risk actions (refunds, result publish, etc.).
4. **Audit Explorer scopes** — institution admins read their own events (including
   break-glass accesses into their tenant) through the tenant-scoped path; the Super
   Admin reads platform events through the privileged path.

Nothing here builds module entitlement/activation or any §9-deferred item. The app must
keep working at every step; the compatibility shim and legacy `role` claim stay intact.

**Technology stack (locked once approved).** TypeScript (NodeNext ESM) · Fastify ·
Prisma 6.19.3 on PostgreSQL (Supabase, Supavisor pooler) · Vitest · `@campusgate/db`
(prisma clients + `withTenant` + the new `withSupportGrant`) · `@campusgate/shared`
(catalogues + zod) · **`otplib`** for TOTP · **`qrcode`** to render the enrollment otpauth
URI · `bcrypt` (already present) for hashing recovery codes. No new framework is introduced.

---

## 2. Schema & migration

One new hand-authored migration: **`<timestamp>_superadmin_security_c`**. It is additive
only — it creates two tables, adds columns to `users`, and never alters the frozen B-1 /
identity_rbac_b2 objects. It runs as the `postgres`/`DIRECT_URL` owner (DDL + RLS +
GRANT), following the exact structure of the existing `tenancy_isolation_rls` and
`identity_rbac_b2` migrations (ordered sections, `DO $$` blocks for RLS, guarded
`campass_app` GRANT refresh at the end).

### 2.1 Prisma model — `AuditEvent` (`audit_events`)

```prisma
enum AuditResult {
  SUCCESS
  DENIED
  ERROR
}

model AuditEvent {
  id               String       @id @default(cuid())
  institutionId    String?      // NULL only for pure-platform actions
  institution      Institution? @relation(fields: [institutionId], references: [id])
  actorUserId      String
  actorUser        User         @relation("AuditEventActor", fields: [actorUserId], references: [id])
  actorMembershipId String?     // null for platform actors (SUPER_ADMIN has no membership)
  actorRoleKey     String       // role snapshot at action time, e.g. "ADMIN" | "SUPER_ADMIN"
  action           String       // "<module>.<action>", validated against the shared catalogue
  resourceType     String
  resourceId       String?
  result           AuditResult
  supportGrantId   String?      // set when the action happened under a break-glass grant
  supportGrant     SupportGrant? @relation(fields: [supportGrantId], references: [id])
  requestRef       String?      // correlation id (Fastify request id)
  metadata         Json?        // minimal; NO PII dumps, NO secrets
  timestamp        DateTime     @default(now())  // server-controlled

  @@index([institutionId, timestamp])
  @@index([actorUserId, timestamp])
  @@index([action, timestamp])
  @@index([supportGrantId])
  @@map("audit_events")
}
```

Notes:

- `action` is a **plain `String`**, never a pg enum (spec §6.2). Validation lives in the
  shared catalogue (§4) and is enforced in the writer, so adding a module's audit action
  never needs a schema/enum migration.
- `institutionId` is **nullable** — the crux resolved in §2.5. A platform action (create
  institution, create a grant) writes a row with `institutionId = NULL`.
- `actorUserId → users.id` is a **single-column** FK (not composite). The actor can be a
  platform user with no membership, and rows can precede/cross tenant context, so a
  composite `(actorUserId, institutionId)` FK would be wrong (it would forbid the
  legitimate null-tenant platform row). Mirrors `security_events.userId` (a plain nullable
  FK, verified in `schema.prisma`).
- `metadata` stays minimal; the writer's `sanitizeMetadata` (§4.3) is responsible for not
  copying full records or secrets (spec §6.3).

`Institution`, `User`, and `SupportGrant` gain the back-relations
(`auditEvents AuditEvent[]`, `auditEvents AuditEvent[] @relation("AuditEventActor")`,
`auditEvents AuditEvent[]`).

### 2.2 Prisma model — `SupportGrant` (`support_grants`)

```prisma
enum SupportGrantStatus {
  REQUESTED
  ACTIVE
  EXPIRED
  REVOKED
}

model SupportGrant {
  id              String             @id @default(cuid())
  institutionId   String             // the ONE tenant this grant authorizes
  institution     Institution        @relation(fields: [institutionId], references: [id])
  grantedToUserId String              // the platform operator (SUPER_ADMIN / support user)
  grantedToUser   User               @relation("SupportGrantGrantee", fields: [grantedToUserId], references: [id])
  purpose         String              // required, non-empty (validated in zod + a CHECK)
  scope           Json?               // optional module/resource limit; advisory in Phase 0 (§5.4)
  status          SupportGrantStatus @default(REQUESTED)
  requestedAt     DateTime           @default(now())
  activatedAt     DateTime?
  expiresAt       DateTime            // hard time limit (minutes–hours)
  revokedAt       DateTime?
  revokedByUserId String?
  revokedByUser   User?              @relation("SupportGrantRevoker", fields: [revokedByUserId], references: [id])
  revokedReason   String?
  createdAt       DateTime           @default(now())

  auditEvents     AuditEvent[]

  @@index([institutionId, status])
  @@index([grantedToUserId, status])
  @@map("support_grants")
}
```

`SupportGrant` is a **PLATFORM table** (per `tenancy.md` §3 it is explicitly listed as not
tenant-owned). It is operated by the Super Admin through platform endpoints on
`privilegedPrisma`. Its `institutionId` is a plain FK to `institutions.id` identifying the
one target tenant; it is **not** a tenant-ownership column in the RLS sense. See §2.4 for
the deliberate, carefully-scoped **read-only** policy that lets the owning tenant SEE its
own grants.

### 2.3 `User` MFA fields

`User` already has `mfaEnabled Boolean @default(false)` and `mfaSecret String?` (verified).
Add:

```prisma
  mfaRecoveryCodes  Json?     // array of RECOVERY_CODE_COUNT (=10) bcrypt-hashed one-time codes; never plaintext
  mfaEnrolledAt     DateTime?
```

`mfaSecret` stays nullable and stores the base32 TOTP seed. Secret-at-rest handling is in
§6.3. No other identity change; `User` remains platform-wide and non-tenant-owned.

### 2.4 RLS posture — `SupportGrant`

The spec requires tenant admins to **see** grants affecting their institution (§4.3
transparency) while the table is platform-operated. Decision: **`ENABLE + FORCE` RLS with a
single SELECT-only tenant policy, and NO modify policy.** Writes happen on `privilegedPrisma`
(which bypasses RLS, so it needs no policy of its own). `campass_app` gets **SELECT only**
(GRANT), so a tenant request can read its own grants but can never write one.

```sql
ALTER TABLE "support_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_grants" FORCE ROW LEVEL SECURITY;

-- Tenants (campass_app, NOBYPASSRLS) read ONLY their own grants.
-- Fail-closed for BOTH unset AND empty-string ('') GUC: nullif(..., '') collapses an
-- empty-string GUC to NULL, and "institutionId" = NULL is NULL => no rows. (A plain
-- current_setting comparison would let an empty-string GUC match a hypothetical '' row;
-- nullif closes that. withTenant/withSupportGrant always set a validated non-empty cuid,
-- never '', so this guard is belt-and-suspenders — see the note below §2.5.)
CREATE POLICY "support_grants_tenant_read" ON "support_grants"
  FOR SELECT
  USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));
```

**No `support_grants_platform_all TO postgres` policy is created.** Per §0, such a policy is
inert for a `BYPASSRLS` role and would be misleading. Platform writes/reads simply run on
`privilegedPrisma`, which bypasses RLS. The *only* load-bearing policy here is the
tenant-read one, which binds `campass_app`.

Why this posture: it makes the database itself enforce the transparency boundary for
tenants (a tenant can read only its own grants, fail-closed) using the exact `=` mechanism
the escape suite already proves for B-1 tables, while keeping the write monopoly on the
platform path. The tenant Audit-Explorer read of grants goes through `withTenant` like any
other tenant-owned row.

> Escape-suite consequence: `support_grants` is added to the RLS meta-test for the
> `relrowsecurity/relforcerowsecurity = true` assertion. For the policy-name assertion it
> is a **special case**: its only policy is `support_grants_tenant_read` (NOT the standard
> `tenant_isolation_select` + `tenant_isolation_modify` pair). The meta-test's expected map
> lists exactly that one policy for this table (§9.3).

### 2.5 RLS posture — `AuditEvent` and the nullable-institutionId problem

This is the load-bearing ambiguity. The standard tenant policy is
`"institutionId" = current_setting('app.current_institution_id', true)`. With a **`=`**
comparison, a row whose `institutionId` is `NULL` (a platform audit row) can **never**
match — `NULL = anything` is `NULL`, which the policy treats as "not visible". That is
exactly what we want for tenant reads: a tenant admin must not see platform rows. But the
policy alone cannot be the whole story, because platform rows must still be readable
*somewhere*, and because tenant actions must still be able to **write** their own audit row
transactionally.

**Resolution — three policies on `audit_events`, matching the spec's platform/tenant split
and preserving the existing atomic-write guarantee:**

```sql
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;

-- (1) Tenant admins read ONLY their own tenant's rows.
--     NULL platform rows never match "=", so they stay invisible to tenants (fail-closed).
--     nullif(..., '') collapses BOTH an unset GUC (already NULL) AND an empty-string GUC
--     to NULL, so neither state can match a row — genuinely fail-closed in both cases.
CREATE POLICY "tenant_isolation_select" ON "audit_events"
  FOR SELECT
  USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

-- (2) Tenant actions may INSERT their OWN tenant's audit row inside the business tx.
--     WITH CHECK forces the row to belong to the active tenant GUC; a tenant can never
--     forge a NULL-institution platform row or another tenant's row. INSERT only — no
--     UPDATE/DELETE policy, so append-only holds for campass_app.
--     nullif(..., '') means an unset OR empty-string GUC yields NULL on the RHS, so
--     "institutionId" = NULL is NULL and the WITH CHECK FAILS — a tenant with no/empty GUC
--     cannot insert any row (including an accidental '' row). Fail-closed on insert too.
CREATE POLICY "audit_events_tenant_insert" ON "audit_events"
  FOR INSERT
  WITH CHECK ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));
```

**No `audit_events_platform_all TO postgres` policy.** Platform / pre-tenant / cross-tenant
writes and the Super-Admin read path run on `privilegedPrisma`, which bypasses RLS; they
need no policy. The two policies above are the load-bearing ones and both bind `campass_app`.

**GUC is always a validated non-empty cuid, never `''` (resolves HIGH finding 1).** Both
`withTenant` (the live tenant client) and the new `withSupportGrant` (§6.2) set
`app.current_institution_id` via `set_config(..., $1, true)` where `$1` is an
institution cuid already validated by the authz/grant layer — it is never the empty string
and never caller-controlled text. The `nullif(current_setting('app.current_institution_id',
true), '')` wrapper on every policy above is therefore defense-in-depth that makes the
fail-closed guarantee hold for the exact three GUC states the §9.2 #3 test exercises — unset
(true NULL), empty-string (`''`), and foreign-tenant — on BOTH the SELECT policy and the
INSERT `WITH CHECK`. An empty-string GUC can never leak or admit a row because `nullif`
collapses it to NULL and `institutionId = NULL` is NULL (not TRUE).

**GRANT posture (resolves finding 4).** `campass_app` gets `SELECT, INSERT` on
`audit_events` and must have `UPDATE, DELETE` **revoked** (the B-1 blanket
`GRANT … ON ALL TABLES` otherwise hands it all four). This keeps audit append-only for the
tenant role at the DB layer (no update/delete path) while **allowing the audit row to be
written inside the same tenant transaction as the business mutation** — preserving today's
atomic guarantee (see §4.3). On `support_grants`, `campass_app` keeps `SELECT` only.

The three access paths, precisely:

1. **Tenant reads** go through `withTenant` as `campass_app`. Policy (1) applies: a tenant
   admin sees exactly rows where `institutionId = GUC` — never NULL platform rows (the `=`
   fail-closed behavior is the feature), never another tenant. This includes break-glass
   rows written into their tenant (they carry that `institutionId` + a `supportGrantId`),
   delivering §4.3/§6.4 transparency.
2. **Tenant writes** go through `withTenant` as `campass_app`, inside the business tx.
   Policy (2)'s `WITH CHECK` requires `institutionId = GUC`, which the recorder sets from
   the request's tenant context — so a tenant action's audit row commits atomically with
   its mutation and cannot be mislabeled to another tenant.
3. **Platform / pre-tenant / cross-tenant writes and reads** go through `privilegedPrisma`
   (bypasses RLS). This is required for login success/failure, institution create, grant
   lifecycle, and the Super-Admin Audit Explorer. The platform read endpoint filters
   explicitly (`where institutionId: null` for platform scope, or a single granted tenant
   for grant scope) — the Super Admin never gets "all tenants' audit rows at once" (§7.5).

> Why not a `(institutionId IS NULL OR institutionId = GUC)` SELECT policy? Because it would
> let a tenant request read **every** platform row — leaking cross-tenant platform activity
> into one tenant's Explorer. The `=`-only SELECT policy keeping NULL invisible to tenants
> is the correct, fail-closed choice; platform rows are served exclusively by the privileged
> path.

### 2.6 Migration section order + GRANT refresh

Mirroring the two existing migrations:

1. `CREATE TYPE "AuditResult"`, `CREATE TYPE "SupportGrantStatus"`.
2. `CREATE TABLE "support_grants"` + indexes + single-column FKs to `institutions`/`users`
   (platform table, no composite tenant FK).
3. `CREATE TABLE "audit_events"` + indexes + single-column FKs
   (`institutionId → institutions`, `actorUserId → users`,
   `supportGrantId → support_grants`).
4. `ALTER TABLE "users"` add `mfaRecoveryCodes`, `mfaEnrolledAt`.
5. Non-empty-`purpose` CHECK: `ALTER TABLE "support_grants" ADD CONSTRAINT
   "support_grants_purpose_nonempty" CHECK (length(btrim("purpose")) > 0)`.
6. `DO $$` block: `ENABLE + FORCE` RLS and the policies from §2.4 (one SELECT policy) and
   §2.5 (one SELECT + one INSERT policy). No `TO postgres` policies.
6a. **Append-only trigger on `audit_events` (resolves MEDIUM finding 2, option b).** Add a
   `BEFORE UPDATE OR DELETE` trigger that unconditionally `RAISE EXCEPTION`s, so append-only
   is DB-enforced for **every** role — including the table owner / `postgres` (privileged)
   path, not just `campass_app`. A trigger binds the owner (unlike GRANTs, which the owner
   is exempt from), closing the hole where `privilegedPrisma` could `UPDATE`/`DELETE` an
   audit row. This is a hard integrity floor under the single-writer code convention.

   ```sql
   CREATE OR REPLACE FUNCTION "audit_events_append_only"()
     RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION 'audit_events is append-only: % is not permitted', TG_OP
       USING ERRCODE = 'restrict_violation';
   END;
   $$;

   CREATE TRIGGER "audit_events_no_update_delete"
     BEFORE UPDATE OR DELETE ON "audit_events"
     FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"();
   ```

   The trigger does **not** interfere with the §6.4 lazy-expiry path: that path mutates
   `support_grants` (status → EXPIRED), **not** `audit_events`, so grant expiry is
   unaffected. `audit_events` only ever receives `INSERT`s (the sole `recordAuditEvent`
   writer calls `create`), so the trigger never fires in normal operation; it only blocks a
   bug or a future stray `UPDATE`/`DELETE` on any role.
7. Guarded `campass_app` GRANT refresh (guard with
   `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='campass_app')`). Because the live B-1
   grant uses `GRANT … ON ALL TABLES` **and** `ALTER DEFAULT PRIVILEGES`, the two new tables
   inherit `SELECT, INSERT, UPDATE, DELETE` for `campass_app` by default. This step pins
   them:
   - `audit_events`: keep `SELECT, INSERT`; **`REVOKE UPDATE, DELETE … FROM "campass_app"`**
     (append-only for the tenant role, but transactional INSERT allowed).
   - `support_grants`: keep `SELECT`; **`REVOKE INSERT, UPDATE, DELETE … FROM "campass_app"`**
     (read-only transparency; only the platform path writes).

The old `audit_logs` table is **kept in place, read-only, as history** (see §4.5). No data
migration/backfill into `audit_events` in Phase 0 — the two coexist; new writes land in
`audit_events`, the old table is frozen. Lowest-risk choice; leaves the `audit_logs` RLS +
escape coverage already proven green untouched.

### 2.7 Edge cases (schema)

- **Grant for a suspended institution:** allowed to be *created* (support may need to
  investigate a suspended tenant), but the **access** path re-checks institution status and
  refuses while suspended, logging a `DENIED` audit event. Documented as a Phase-0 limitation.
  (There is **no** "security-incident grant" branch in Phase 0 — that is the deferred
  emergency path in `superadmin-security.md` §4.5 and is explicitly out of scope here.)
- **`expiresAt` in the past at creation:** rejected by zod (`expiresAt` must be `> now()`
  and `<= now() + MAX_TTL`).
- **Duplicate active grants** for the same (institution, operator): allowed; each access is
  still attributed to a specific `supportGrantId`. No uniqueness constraint — grants are an
  append-only authorization log.

---

## 3. Permission split (§2 of the spec)

All seven `platform.*` keys already exist in `@campusgate/shared/permissions.ts` and map to
`SUPER_ADMIN` in `ROLE_PERMISSIONS` (verified). Phase 0 keeps `SUPER_ADMIN` holding all
`platform.*` keys (the brief's explicit "do-not-over-engineer" instruction). The two
newly-*enforced* platform keys this phase are:

- `platform.support.grant` — guards create/activate/revoke-as-platform `SupportGrant`
  endpoints (§7).
- `platform.security.respond` — reserved; not newly enforced in Phase 0 beyond being held
  by `SUPER_ADMIN` (documented seam).

**One new tenant permission key is added (resolves finding 5 of the prior round):**
`admin.support.revoke` — "Tenant admin revokes a break-glass support grant into their
institution." It is added to the shared catalogue, seeded in the **new**
`superadmin_security_c` migration's permission + `role_permissions` seed, and mapped to the
tenant **ADMIN** template role in `ROLE_PERMISSIONS`. Rationale: a state-changing revoke of
a platform operator's access must NOT be gated on a read permission
(`campus_movement.audit.view` is defined as "Admin reads audit logs"). This is the one place
least-privilege outranks "do not over-engineer" — read authority and revoke authority are
separated. See §7.2.

> **Catalogue-sync note — corrected (resolves current-round HIGH finding 1).** The previous
> draft claimed the catalogue-sync meta-test "stays green because both sides change
> together." That is **false** and would break the build. `catalogue-sync.test.ts` is
> hard-pinned to `MIGRATION_DIR = "20261018171747_identity_rbac_b2"` and asserts
> **set-equality** between `@campusgate/shared` (`PERMISSION_KEYS` and every
> `(roleKey, permissionKey)` pair in `ROLE_PERMISSIONS`) and the seed inside **that one
> frozen migration file**. `admin.support.revoke` is seeded in a *third* file
> (`superadmin_security_c`), so adding the key to shared while leaving the pinned test
> reading only `identity_rbac_b2` makes set-equality fail (`admin.support.revoke` and
> `ADMIN::admin.support.revoke` present in shared, absent in the frozen file).
>
> **Chosen fix — option (a): generalize the test; leave the frozen migration untouched.**
> `catalogue-sync.test.ts` is updated (test files are NOT frozen — only B-1 and
> identity_rbac_b2 migration SQL are) to read AND concatenate the `INSERT INTO "permissions"`
> and `INSERT INTO "role_permissions"` seed blocks from **all** migrations that seed them —
> currently `20261018171747_identity_rbac_b2` **and** the new `superadmin_security_c` — then
> assert set-equality of the **union** against shared. Concretely, `MIGRATION_DIR` becomes a
> `SEEDING_MIGRATION_DIRS` array, `extractPermissionKeys()` / `extractRolePermissionPairs()`
> run per-file and the results are unioned (de-duplicated, still asserting no intra-file
> duplicates), and the final set-equality compares the union to `PERMISSION_KEYS` /
> `ROLE_PERMISSIONS`. The frozen `identity_rbac_b2/migration.sql` is byte-for-byte unchanged;
> only the test logic and the new migration's seed change. This test file is added to §10
> "Modified" (it was previously, incorrectly, not called out as needing a logic change). No
> `platform.*` key changes.
>
> Option (b) — drop `admin.support.revoke` and gate the tenant revoke on the existing
> `campus_movement.audit.view` (read==revoke authority), recording the least-privilege debt
> as deferred — was **rejected**: on an auth/security-critical path, letting a read
> permission authorize a state-changing revoke of a platform operator's access is exactly
> the privilege conflation finding 5 of the prior round told us to remove. Option (a) costs
> one test-logic generalization and keeps least-privilege intact.

---

## 4. Audit-action catalogue + the single writer

### 4.1 Catalogue shape (`packages/shared/src/audit-actions.ts`)

A string-keyed registry living alongside `permissions.ts`, exported from the shared index:

```ts
export interface AuditActionDef {
  key: string;     // "<module>.<action>"
  module: string;  // "campus_movement" | "admin" | "platform" | ...
  description: string;
}

export const AUDIT_ACTIONS = [
  // campus_movement.*
  { key: "campus_movement.pass.requested", module: "campus_movement", description: "Student requested a gate pass" },
  { key: "campus_movement.pass.approved",  module: "campus_movement", description: "Pass approved" },
  { key: "campus_movement.pass.rejected",  module: "campus_movement", description: "Pass rejected" },
  { key: "campus_movement.pass.cancelled", module: "campus_movement", description: "Pass cancelled by requester" },
  { key: "campus_movement.pass.revoked",   module: "campus_movement", description: "Pass revoked by staff" },
  { key: "campus_movement.pass.expired",   module: "campus_movement", description: "Pass auto-expired" },
  { key: "campus_movement.pass.override",  module: "campus_movement", description: "Emergency/allowance override applied to a pass" },
  { key: "campus_movement.gate.exit",      module: "campus_movement", description: "Gate exit scanned" },
  { key: "campus_movement.gate.return",    module: "campus_movement", description: "Gate return scanned" },
  { key: "campus_movement.shift.created",  module: "campus_movement", description: "Guard shift created" },
  { key: "campus_movement.shift.started",  module: "campus_movement", description: "Guard shift started" },
  { key: "campus_movement.shift.ended",    module: "campus_movement", description: "Guard shift ended" },
  { key: "campus_movement.emergency.declared", module: "campus_movement", description: "Emergency declared" },
  { key: "campus_movement.emergency.resolved", module: "campus_movement", description: "Emergency resolved" },
  // admin.* (identity + configuration)
  { key: "admin.user.created",     module: "admin", description: "Institution user created" },
  { key: "admin.user.updated",     module: "admin", description: "Institution user updated" },
  { key: "admin.user.deactivated", module: "admin", description: "Institution user deactivated" },
  { key: "admin.user.reactivated", module: "admin", description: "Institution user reactivated" },
  { key: "admin.students.imported", module: "admin", description: "Bulk student import" },
  { key: "admin.gate.created",     module: "admin", description: "Gate created" },
  { key: "admin.gate.updated",     module: "admin", description: "Gate updated" },
  { key: "admin.department.created", module: "admin", description: "Department created" },
  { key: "admin.department.updated", module: "admin", description: "Department updated" },
  { key: "admin.reason.created",   module: "admin", description: "Pass reason created" },
  { key: "admin.reason.updated",   module: "admin", description: "Pass reason updated" },
  { key: "admin.allowance_policy.updated", module: "admin", description: "Allowance policy updated" },
  { key: "admin.institution_config.updated", module: "admin", description: "Institution config updated" },
  { key: "admin.academic_calendar.updated",  module: "admin", description: "Academic calendar updated" },
  // platform.* (new in this phase)
  { key: "platform.institution.created",   module: "platform", description: "Institution created (platform)" },
  { key: "platform.institution.status_changed", module: "platform", description: "Institution status changed" },
  { key: "platform.support_grant.created",   module: "platform", description: "Support grant created" },
  { key: "platform.support_grant.activated", module: "platform", description: "Support grant activated" },
  { key: "platform.support_grant.accessed",  module: "platform", description: "Tenant data accessed under a support grant" },
  { key: "platform.support_grant.revoked",   module: "platform", description: "Support grant revoked" },
  { key: "platform.support_grant.expired",   module: "platform", description: "Support grant expired" },
  { key: "platform.mfa.enrolled",  module: "platform", description: "Platform MFA enrolled" },
  { key: "platform.mfa.step_up",   module: "platform", description: "Platform MFA step-up assertion" },
] as const satisfies readonly AuditActionDef[];

export type AuditActionKey = (typeof AUDIT_ACTIONS)[number]["key"];
export const AUDIT_ACTION_KEYS = AUDIT_ACTIONS.map((a) => a.key);
export const AUDIT_ACTION_KEY_SET = new Set<string>(AUDIT_ACTION_KEYS);
```

This is one source of truth. Unlike permissions it does **not** need a migration mirror
(there is no pg enum and no seeded rows for audit actions), so no catalogue-sync *migration*
test is required for it — but see the mapping test in §4.5.

> **Namespace note (resolves current-round NIT finding 4).** The audit-action keys
> `platform.institution.created` / `platform.institution.status_changed` are **singular**
> (`institution`) and live in the audit-action catalogue above. They are a **separate
> namespace** from the **plural** permission key `platform.institutions.manage` in
> `permissions.ts`. No relationship is implied between the two: one names an audited event,
> the other authorizes an operation. The singular/plural difference is intentional and not a
> typo.

### 4.2 Why a string action validated in the writer (not a pg enum)

Per spec §6.2: a pg enum forces an enum migration for every new module action. A validated
string keyed `<module>.<action>` lets future modules add actions by appending to the shared
catalogue only. Validation is centralized in the writer (§4.3); a key not in
`AUDIT_ACTION_KEY_SET` is a programming error and **throws** (unknown keys never persist
silently and are never coerced into a bad row).

### 4.3 The single writer (`apps/api/src/services/audit.ts`)

The writer accepts an **optional transaction client** so that tenant actions can write their
audit row inside the business `tx` (atomic, as today), while platform / pre-tenant paths
pass no `tx` and the writer falls back to `privilegedPrisma`.

```ts
import { prisma, privilegedPrisma, type AuditResult, type Prisma } from "@campusgate/db";
import { AUDIT_ACTION_KEY_SET, type AuditActionKey } from "@campusgate/shared";

export interface AuditInput {
  action: AuditActionKey;
  result: AuditResult;              // SUCCESS | DENIED | ERROR
  actorUserId: string;
  actorRoleKey: string;             // request.auth.roles[0] snapshot, or "SUPER_ADMIN"
  institutionId?: string | null;    // null => pure platform action
  actorMembershipId?: string | null;
  resourceType: string;
  resourceId?: string | null;
  supportGrantId?: string | null;
  requestRef?: string | null;       // Fastify request.id
  metadata?: Record<string, unknown>;
}

/**
 * Record an audit event.
 *  - Pass `tx` (a withTenant transaction client) for a TENANT action: the row is written
 *    inside the business transaction as campass_app, atomic with the mutation. RLS policy
 *    `audit_events_tenant_insert` requires institutionId === the active tenant GUC, which
 *    holds because the caller sets institutionId from request.auth.institutionId.
 *  - Omit `tx` for PLATFORM / pre-tenant / cross-tenant actions: the row is written on
 *    privilegedPrisma (bypasses RLS), which is required for institutionId === null rows.
 */
export async function recordAuditEvent(
  input: AuditInput,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  if (!AUDIT_ACTION_KEY_SET.has(input.action)) {
    throw new Error(`recordAuditEvent: unknown action key "${input.action}"`);
  }
  const client = tx ?? privilegedPrisma;
  await client.auditEvent.create({
    data: {
      action: input.action,
      result: input.result,
      actorUserId: input.actorUserId,
      actorRoleKey: input.actorRoleKey,
      institutionId: input.institutionId ?? null,
      actorMembershipId: input.actorMembershipId ?? null,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      supportGrantId: input.supportGrantId ?? null,
      requestRef: input.requestRef ?? null,
      metadata: sanitizeMetadata(input.metadata),
    },
  });
}
```

Key decisions:

- **Tenant actions stay transactional (resolves finding 4, option a).** Because `campass_app`
  now has INSERT on `audit_events` (append-only; UPDATE/DELETE revoked), the existing
  in-`tx` write pattern is **preserved**: the audit row and the business mutation commit
  atomically, exactly as today. The migrated call sites keep passing the `tx` they already
  hold. This maintains spec §6.3's append-only guarantee without the integrity regression
  the previous draft introduced. A tenant action can only ever write a row for its own
  institution (policy `audit_events_tenant_insert` `WITH CHECK institutionId = GUC`) and can
  never update/delete one.
- **Platform / pre-tenant writes use `privilegedPrisma`** (no `tx`), which is required for
  `institutionId = null` rows (login, institution create, grant lifecycle) and must not fail
  closed. Writing on the bypass role is correct: there is no tenant GUC and the row is
  legitimately platform-scoped.
- **`sanitizeMetadata`** relays only an allow-list of scalar fields and truncates strings; it
  never copies whole records or any field named like a secret (`password`, `token`,
  `secret`, `mfa*`, `qr*`). Enforces spec §6.3.
- **Failure behavior differs by caller.** For a *tenant business action*, the audit insert is
  part of the business `tx`; if it fails, the whole transaction rolls back (atomic — the
  business mutation does not commit without its audit row). For *platform best-effort*
  observational writes (e.g. a `DENIED` audit on a rejected login), failures are caught and
  logged at `error` without failing the user's request. For **break-glass access** (§6.3),
  the audit write is awaited and a failure aborts the read (500, result discarded).

### 4.4 Call-site migration — complete inventory + full enum→string mapping

**Verified inventory (resolves current-round HIGH finding 2).** `tx.auditLog.create(...)`
occurrences in **production** source (grep of `apps/api/src` excluding `__tests__`), pinned
by line against the live source. The previous draft listed a phantom
`services/allowance-engine.ts` row and a total of "~29" — that is **wrong**: there is NO
`auditLog.create` anywhere under `apps/api/src/services/**`; the only service-layer override
write lives in a **test file** (`services/__tests__/allowance-integration.test.ts:422`, a
mocked `prisma.auditLog.create`) and is not migrated. The real production total is **28, all
in `routes/**`**:

| File | Count | Line refs |
|---|---|---|
| `routes/admin.ts` | 17 | 437, 511, 647, 687, 722, 756, 852, 1036, 1230, 1351, 1394, 1474, 1535, 1614, 1663, 1729, 1790 |
| `routes/guard.ts` | 5 | 139, 194, 273, 464, 600 |
| `routes/hod.ts` | 4 | 219, 287, 359, 444 |
| `routes/student.ts` | 2 | 214, 301 |
| **Total** | **28** | all under `routes/**` |

There is **no service-layer audit write to migrate.** The only `EMERGENCY_OVERRIDE` audit
writes in production are at **`hod.ts:219`** and **`admin.ts:1790`** — inside the two
`/emergency-override` route handlers — and are **already counted** in the hod ×4 and admin
×17 totals above. The `EMERGENCY_OVERRIDE → campus_movement.pass.override` mapping is
therefore exercised by two route-handler sites, not a service.

After migration, a test asserts `tx.auditLog.create` has **zero** occurrences in
`apps/api/src/routes/**` (expected `28 → 0`); the assertion scope may also cover
`apps/api/src/services/**` (harmlessly, since it starts at 0 there) to guard against a
future straggler (§9.1). No production site is silently left writing to the frozen
`audit_logs`.

**Field mapping** (old `audit_logs` row → `recordAuditEvent` input):

| old `audit_logs` | new `audit_events` | note |
|---|---|---|
| `actorId` | `actorUserId` | same user id |
| `institutionId` | `institutionId` | from `request.auth.institutionId` (tenant) |
| `action` (enum) | `action` (string) | via the full table below |
| `targetId` | `resourceId` | |
| `targetType` | `resourceType` | |
| `metadata` | `metadata` | run through `sanitizeMetadata` |
| — | `result` | `SUCCESS` for existing happy-path writes (`DENIED`/`ERROR` where a handler already branches on failure) |
| — | `actorRoleKey` | `request.auth.roles[0] ?? request.user.role` (one expression; `"SUPER_ADMIN"` for platform actors — see finding 6) |
| — | `actorMembershipId` | `request.auth.membershipId` |
| — | `requestRef` | `request.id` |

**Complete `AuditAction` enum → catalogue-key mapping (resolves finding 3).** The live enum
has exactly **28** values (verified in `schema.prisma`). Every one maps to exactly one
catalogue key:

| Legacy `AuditAction` | New action string |
|---|---|
| `PASS_REQUESTED` | `campus_movement.pass.requested` |
| `PASS_APPROVED` | `campus_movement.pass.approved` |
| `PASS_REJECTED` | `campus_movement.pass.rejected` |
| `PASS_CANCELLED` | `campus_movement.pass.cancelled` |
| `PASS_REVOKED` | `campus_movement.pass.revoked` |
| `PASS_EXPIRED` | `campus_movement.pass.expired` |
| `GATE_EXIT` | `campus_movement.gate.exit` |
| `GATE_RETURN` | `campus_movement.gate.return` |
| `SHIFT_CREATED` | `campus_movement.shift.created` |
| `SHIFT_STARTED` | `campus_movement.shift.started` |
| `SHIFT_ENDED` | `campus_movement.shift.ended` |
| `EMERGENCY_DECLARED` | `campus_movement.emergency.declared` |
| `EMERGENCY_RESOLVED` | `campus_movement.emergency.resolved` |
| `EMERGENCY_OVERRIDE` | `campus_movement.pass.override` |
| `USER_CREATED` | `admin.user.created` |
| `USER_UPDATED` | `admin.user.updated` |
| `USER_DEACTIVATED` | `admin.user.deactivated` |
| `USER_REACTIVATED` | `admin.user.reactivated` |
| `BULK_IMPORT` | `admin.students.imported` |
| `GATE_CREATED` | `admin.gate.created` |
| `GATE_UPDATED` | `admin.gate.updated` |
| `DEPARTMENT_CREATED` | `admin.department.created` |
| `DEPARTMENT_UPDATED` | `admin.department.updated` |
| `REASON_CREATED` | `admin.reason.created` |
| `REASON_UPDATED` | `admin.reason.updated` |
| `ALLOWANCE_POLICY_UPDATED` | `admin.allowance_policy.updated` |
| `INSTITUTION_CONFIG_UPDATED` | `admin.institution_config.updated` |
| `ACADEMIC_CALENDAR_UPDATED` | `admin.academic_calendar.updated` |

This mapping is captured as a `LEGACY_AUDIT_ACTION_MAP: Record<AuditAction, AuditActionKey>`
constant in `audit-actions.ts`, and a unit test asserts (a) every one of the 28 enum values
has exactly one target, (b) every target is in `AUDIT_ACTION_KEY_SET` (§9.1). Note
`EMERGENCY_OVERRIDE → campus_movement.pass.override` is the previously-ambiguous case, now
pinned. `SHIFT_*` map into `campus_movement.*` (shift scheduling is part of the campus
movement module); the three shift keys live in that module block in §4.1. The same
`LEGACY_AUDIT_ACTION_MAP` is reused by the Audit-Explorer `action` query-param
backward-compat translation (§7.5, resolving current-round finding 3).

**Read sites** change too:

- `routes/admin.ts` `GET /audit-logs` and the `hod.ts`/`student.ts` pass-timeline readers
  (`tx.auditLog.findMany`) switch to `tx.auditEvent.findMany` under `withTenant`
  (tenant-scoped). The timeline builder `services/pass-lifecycle.ts`, currently typed on the
  `AuditAction` enum, is updated to accept the string `action` + `AuditResult`; because the
  action strings changed, the timeline mapping updates in lockstep.
- **Deliberate read-semantics change (resolves current-round finding 4).** The live
  `GET /audit-logs` filters `where: { actor: { institutionId } }` — i.e. rows whose *actor*
  belongs to the tenant. The migrated reader **drops the `actor.institutionId` join filter**
  and instead relies on the event row's own `institutionId`, enforced by RLS policy
  `tenant_isolation_select` (`institutionId = GUC`) under `withTenant`. This is a deliberate
  behavior change, not an oversight: a break-glass access writes a row with
  `institutionId = A` but `actorUser.institutionId = PLATFORM`; the legacy actor-join filter
  would **exclude** it (hiding break-glass activity from the tenant), while the event-row
  filter **includes** it — which is exactly the §6.4/§4.3 transparency requirement. An
  implementer must NOT reintroduce the `actor.institutionId` join (doing so would re-hide
  break-glass rows). For `audit_events` the two filters cannot otherwise diverge, because the
  writer always sets `institutionId` from the active tenant context.

The old `audit_logs` table and its Prisma model are **retained** (so the frozen migration
and its escape coverage stay valid), but no new writes target it after this phase. A
follow-up phase may archive it.

### 4.5 Decision: new table vs. in-place generalization of `audit_logs`

Chosen: **new `audit_events` table**, old `audit_logs` kept as frozen history. Rejected
alternative: converting `audit_logs.action` from enum to text in place and adding nullable
columns. Reason: the live `audit_logs` has `institutionId NOT NULL` + a composite actor FK +
the standard tenant RLS policies, all proven by the escape suite; relaxing `institutionId` to
nullable and swapping the actor FK in place would mutate a frozen, escape-covered table and
risk the live tenant guarantees. A clean new table with its own (carefully different) RLS
posture is lower-risk and makes the platform/tenant split explicit. Answers brief ambiguity
(a)/(e).

---

## 5. MFA + step-up (§5 of the spec)

### 5.1 Decision: real TOTP via `otplib` (not a stub)

Phase 0 implements **real TOTP enrollment and verification** for platform accounts using
`otplib` (`authenticator`), because it fits cleanly on the existing `User.mfaEnabled /
mfaSecret` fields and the spec makes MFA mandatory for platform accounts *now*. WebAuthn is
explicitly deferred.

**Pinned `otplib` config (resolves finding 7):**

```ts
import { authenticator } from "otplib";
authenticator.options = { window: 1, step: 30 }; // window = ±1 step; step = 30s ⇒ ±30s skew
```

`window: 1` means one step of tolerance on each side; with `step: 30` that is ±30 seconds.
Every reference to clock-skew tolerance in this design means exactly this single config
(`{ window: 1, step: 30 }`), not two separate settings.

What is **real** vs. **policy stub** in Phase 0, named precisely:

- **Real in Phase 0:** TOTP secret generation, otpauth URI + QR for enrollment, 6-digit code
  verification with `{ window: 1, step: 30 }`, bcrypt-hashed single-use recovery codes, the
  mandatory-MFA gate for `platform.*` holders, and the step-up gate on `SupportGrant`
  create/activate.
- **Policy stub in Phase 0 (seam only):** step-up on the *other* high-risk actions in spec
  §5.2 (pass revoke, future refunds / result publish / institution suspend) — the
  `requireStepUp(...)` guard exists and is wired on `SupportGrant`, and is documented as the
  single attach-point those actions will use when their modules land. Marked in code with a
  `// PHASE-0 SEAM` comment, mirroring the `requireModuleActive` stub style in
  `authz-engine.ts`.

### 5.2 MFA enrollment / verification endpoints (`routes/mfa.ts`)

All under `/api/auth/mfa`, `preHandler: [authenticate]`:

- `POST /enroll/start` → `authenticator.generateSecret()`, stores it on `User.mfaSecret`
  **without** setting `mfaEnabled` yet, returns the otpauth URI + a `qrcode` data URL. Does
  not enable MFA until a code is verified.
- `POST /enroll/verify` `{ code }` → `authenticator.verify({ token: code, secret })`; on
  success sets `mfaEnabled = true`, `mfaEnrolledAt = now()`, generates
  **`RECOVERY_CODE_COUNT = 10`** recovery codes (returns plaintext **once**, stores bcrypt
  hashes in `mfaRecoveryCodes`), writes `platform.mfa.enrolled` (`SUCCESS`). On failure,
  `platform.mfa.step_up`/enroll `DENIED`, 400.

  **Recovery-code count + format (pinned — resolves current-round NIT finding 5).**
  `RECOVERY_CODE_COUNT = 10` (a named constant in `services/mfa.ts`). Each code is **10
  characters of Crockford base32** (alphabet `0-9A-Z` excluding `I L O U`), generated from a
  CSPRNG, displayed grouped as `XXXXX-XXXXX` for readability but stored/compared without the
  separator. The enrollment validator (§8.1) and the single-use test (§9.1) assert exactly 10
  codes are issued, each matching `^[0-9A-HJKMNP-TV-Z]{10}$` (case-insensitive, hyphen
  stripped), and that a consumed code's bcrypt hash is removed from `mfaRecoveryCodes` so it
  cannot be reused.
- `POST /verify` `{ code }` → used by the step-up flow (§5.3); returns a short-lived step-up
  assertion token.

All MFA reads/writes use `privilegedPrisma` (user is platform-wide, pre/non-tenant).

### 5.3 Mandatory-MFA policy gate + step-up seam + replay decision

- **Mandatory MFA for platform accounts:** a preHandler `requirePlatformMfa()` added to the
  `platformRoutes` plugin (which already `addHook("preHandler", requireSuperAdmin())`,
  verified in `routes/platform.ts`). It checks
  `privilegedPrisma.user.findUnique(...).mfaEnabled`; if a `platform.*` holder has not
  enrolled, every platform route except the MFA-enrollment endpoints returns
  `403 { error: "MFA enrollment required" }`. Enforces "platform = mandatory" without
  locking the operator out of enrollment.
- **Step-up for high-risk actions:** `requireStepUp()` preHandler. Mechanism: the client
  calls `POST /api/auth/mfa/verify { code }`; on success the server mints a short-lived
  (5-minute) **step-up token** — a signed JWT with claims
  `{ userId, jti, stepUp: true, action, exp }` — returned to the client, which sends it on
  the high-risk request in an `x-step-up` header. `requireStepUp(actionClass)` verifies
  signature, expiry, `userId === request.auth.userId`, `stepUp === true`, and
  `action === actionClass`. Reuses the existing `@fastify/jwt` signer; needs no new table;
  guarantees a *fresh MFA assertion at the moment of the action* regardless of the session
  token. Chosen over a DB-persisted "last step-up at" timestamp because it is stateless,
  self-expiring, and cannot be satisfied by an old session.
- **Replay-within-TTL decision (resolves finding 8):** the step-up token is **multi-use
  within its 5-minute TTL but bound to an action class** via the `action` claim (e.g.
  `"support_grant.create"`), which `requireStepUp(actionClass)` checks. This is an
  **explicitly accepted** Phase-0 decision: the TTL is short and the token cannot be replayed
  against a *different* action class, so a stolen grant-create step-up token cannot, say,
  authorize a future refund. Single-use (a consumed-`jti` store) is noted as the upgrade for
  money/results modules; the `jti` is already minted to make that a non-breaking addition.
- Step-up pairs with "re-check permission at the point of action" (identity-rbac §5.3):
  `requireStepUp("support_grant.create")` is layered **after**
  `requirePermission("platform.support.grant")` on grant create/activate, and the handler
  re-reads the grant/permission from the DB before mutating.

### 5.4 `scope` on a grant

`SupportGrant.scope` (optional JSON) is **advisory in Phase 0** — recorded and surfaced to
the tenant for transparency but not mechanically enforced (there is no per-module access
checking yet; the grant scopes to the whole tenant's RLS view). Stated as a Phase-0
limitation; enforcement arrives with the module-entitlement phase. Documented in §13(d).

### 5.5 Edge cases (MFA)

- **Lost authenticator:** recovery codes — `POST /verify` accepts a recovery code as an
  alternative to a TOTP code; a used code's bcrypt hash is removed from `mfaRecoveryCodes`.
- **Re-enroll:** `POST /enroll/start` overwrites `mfaSecret` but only `enroll/verify` flips
  `mfaEnabled`; a half-finished enroll never weakens existing enabled MFA.
- **Clock skew:** accepted within `{ window: 1, step: 30 }` (§5.1), i.e. ±30s.
- **Non-platform users:** MFA endpoints are available (spec allows optional MFA for tenant
  admins) but **not enforced** in Phase 0 beyond platform accounts.

---

## 6. Break-glass access path (§3, §4 of the spec)

### 6.1 Principle

A Super Admin has **no** standing tenant access (`request.tenant` is unset in
`authenticate`, verified). Break-glass is the *only* way a platform operator reads one
tenant's operational rows, and it works by setting `app.current_institution_id` to that one
tenant **under an ACTIVE grant**, on a `campass_app`-backed per-access transaction — never a
`BYPASSRLS` bypass, never standing access.

### 6.2 `withSupportGrant` helper — the GUC is a REAL enforcing layer (resolves HIGH finding 1)

The previous draft ran break-glass on `privilegedPrisma` and claimed the GUC provided a
second enforcement layer. Per §0 that is false: `postgres` bypasses RLS, so the GUC is inert
for it. **Fix chosen: option (A) — route break-glass reads through a dedicated
`campass_app`-backed connection with the tenant GUC set.** For `campass_app`
(`NOSUPERUSER NOBYPASSRLS`), the B-1 `tenant_isolation_*` policies genuinely apply, so the
GUC is a real DB-enforced layer — the same proven mechanism as an ordinary tenant request.

```ts
// packages/db/src/index.ts

// (1) Extend the module's global cache type (resolves finding 5a). Today it is typed
//     `{ prisma; privilegedPrisma }` only; add the new client so the global-reuse pattern
//     typechecks.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  privilegedPrisma: PrismaClient | undefined;
  breakGlassPrisma: PrismaClient | undefined; // NEW
};

// A dedicated campass_app-backed client used ONLY for grant-authorized break-glass reads.
// It is the SAME NOBYPASSRLS role as the runtime tenant client, so the tenant GUC enforces.
// It is NOT a standing session: a connection is used only inside withSupportGrant, per
// access, and only after the service layer has validated an ACTIVE grant.
//
// NOTE ON THE URL: this MUST be the campass_app (NOBYPASSRLS, 6543) URL — i.e. DATABASE_URL,
// the same role the runtime tenant client uses. The entire §6.2 safety argument rests on it.
// Because the same file documents DATABASE_URL as a *last-resort privileged fallback*, a
// misconfigured env could in principle point it at the postgres (BYPASSRLS) role — which
// would silently defeat break-glass scoping. The startup probe below makes that fail CLOSED.
const breakGlassPrisma =
  globalForPrisma.breakGlassPrisma ??
  new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL! } }, // campass_app URL (6543)
  });

if (process.env.NODE_ENV !== "production")
  globalForPrisma.breakGlassPrisma = breakGlassPrisma;

// (2) Fail-closed NOBYPASSRLS invariant (resolves finding 5b). The break-glass client's
//     safety depends on its role NOT bypassing RLS. Probe it on first use and refuse to run
//     if the connected role bypasses RLS, so a misconfigured DATABASE_URL throws instead of
//     silently leaking cross-tenant rows. Cached after the first successful check.
let breakGlassRoleVerified = false;
async function assertBreakGlassRoleIsRlsSubject(
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (breakGlassRoleVerified) return;
  const rows = await tx.$queryRawUnsafe<Array<{ rolbypassrls: boolean }>>(
    `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  );
  const bypasses = rows[0]?.rolbypassrls ?? true; // unknown => treat as unsafe
  if (bypasses) {
    throw new Error(
      "breakGlassPrisma connected as a BYPASSRLS role; refusing break-glass access. " +
        "DATABASE_URL must point at campass_app (NOBYPASSRLS).",
    );
  }
  breakGlassRoleVerified = true;
}

/**
 * Run `fn` as campass_app with the tenant GUC pinned to ONE institution, for a validated
 * break-glass grant. RLS enforces the scope (campass_app is NOBYPASSRLS); the service layer
 * still adds explicit `where institutionId` filters (defense in depth that is now genuine
 * because the GUC layer is real). READ-ONLY BY CONSTRUCTION — the transaction is opened
 * `SET TRANSACTION READ ONLY` as its FIRST statement, so Postgres itself rejects any write
 * DML inside `fn` (campass_app otherwise holds INSERT/UPDATE/DELETE on tenant tables via the
 * B-1 grants). Break-glass can never mutate tenant data, by mechanism, not convention.
 *
 * NOTE: audit writes that must happen for each break-glass access CANNOT run inside this
 * read-only transaction — they are written by a SEPARATE privileged `recordAuditEvent` call
 * (on `privilegedPrisma`, append path) AFTER `withSupportGrant` returns. See §6.3.
 */
export async function withSupportGrant<T>(
  institutionId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return breakGlassPrisma.$transaction(
    async (tx) => {
      // FIRST statement: make the whole tx read-only so any write by `fn` is rejected by
      // Postgres ("cannot execute ... in a read-only transaction"). Must precede set_config.
      await tx.$executeRawUnsafe(`SET TRANSACTION READ ONLY`);
      await assertBreakGlassRoleIsRlsSubject(tx); // fail-closed if role bypasses RLS
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_institution_id', $1, true)`,
        institutionId,
      );
      return fn(tx);
    },
    { maxWait: 15000, timeout: 30000 },
  );
}
```

**Read-only by construction (resolves current-round MEDIUM finding 3).** The first statement
inside every `withSupportGrant` transaction is `SET TRANSACTION READ ONLY`, so Postgres
rejects any `INSERT`/`UPDATE`/`DELETE` attempted inside `fn` with
`cannot execute … in a read-only transaction`. This replaces the earlier "read-only by
convention" claim with an enforced mechanism: even though `campass_app` holds write DML on
tenant tables (B-1 grants + `ALTER DEFAULT PRIVILEGES`), a break-glass write is now
**impossible by construction**, not merely undocumented-as-intended. `SET TRANSACTION READ
ONLY` is set as the first statement, before `set_config`, so it governs the entire explicit
transaction. Its compatibility with the Supavisor 6543 transaction pooler (inside an explicit
tx, exactly as `set_config(..., true)` was verified) is proven in the §9.2 #1 live-smoke
suite. **Ordering of the audit write:** the `platform.support_grant.accessed` audit row
**cannot** be written inside this read-only transaction (it is a write). It is written by a
**separate** `recordAuditEvent` call on `privilegedPrisma` (the append path, which the
§2.6 trigger allows for INSERT) *after* `withSupportGrant` returns the scoped read — the
read-only tenant read and the privileged audit insert are two distinct transactions, in that
order (§6.3).

**Fail-closed role invariant (resolves finding 5).** `breakGlassPrisma` adds a
`breakGlassPrisma?: PrismaClient` field to the module's `globalForPrisma` type, and the
first statement inside every `withSupportGrant` transaction is a
`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user` probe that **throws** unless
the connected role is NOBYPASSRLS (result cached per process after the first pass). This
turns the previously-implicit "DATABASE_URL happens to be campass_app" assumption into a
runtime guarantee: a deployment that misconfigures `DATABASE_URL` to the `postgres`
(BYPASSRLS) role gets a hard failure on the first break-glass access rather than a silent
cross-tenant leak. The §9.2 #1 filter-less-probe escape test is promoted to a **required
gate** (it would fail loudly if the GUC were ever inert), giving two independent defenses:
the runtime role probe and the escape test.

**Why this does not violate "no standing `campass_app` platform session" (`tenancy.md` §5.4).**
The invariant forbids a platform actor holding an *ambient, always-on* tenant session derived
from nothing. `withSupportGrant` is the opposite: a **per-access transaction**, opened only
inside the helper, only after the service layer has validated an ACTIVE, unexpired,
operator-bound grant for exactly one institution, and torn down at transaction end. The
authorization comes from the grant, not from a membership and not from a persistent session.
This is explicitly the mechanism `tenancy.md` §5.4 sanctions ("break-glass works by setting
`app.current_institution_id` to that one tenant … same mechanism, scoped to one institution …
does not use a `BYPASSRLS` role"). Using the NOBYPASSRLS `campass_app` role here is the only
way to honor *both* that sentence and the requirement that the GUC actually scope the read.

**Two genuine layers now:** (1) the DB-enforced RLS policy under the NOBYPASSRLS role +

(2) the service layer's mandatory explicit `where: { institutionId }` filter. To keep layer
(2) structurally non-optional, the single break-glass read proxy (§7.4) is the *only* code
that calls `withSupportGrant`, and it always injects `institutionId = grant.institutionId`
into every query; there is no general-purpose "run arbitrary query under a grant" API exposed
to handlers. An escape test (§9.2) proves a break-glass read of tenant A returns **zero** B
rows *through the real helper* (not through a GUC that does nothing).

### 6.3 Access flow (service layer, `services/support-grant.ts`)

```text
Super Admin calls a break-glass read endpoint with { grantId }
   |
Load grant on privilegedPrisma; assert: status ACTIVE, expiresAt > now,
   grantedToUserId == request.auth.userId, institution status re-checked (not suspended)
   |-- if invalid  -> recordAuditEvent(platform.support_grant.accessed, DENIED); 403
   |
withSupportGrant(grant.institutionId, tx => read the requested tenant rows
                                            with explicit where:{ institutionId })
   |
recordAuditEvent(platform.support_grant.accessed, SUCCESS,
   institutionId=grant.institutionId, supportGrantId=grantId,
   resourceType/resourceId describing what was read)   // on privilegedPrisma, awaited
   |
return the scoped data
```

Every single access writes one `platform.support_grant.accessed` audit row referencing the
grant and the tenant — satisfying "every data access under it is audited". **Transaction
ordering (resolves current-round MEDIUM finding 3):** the tenant read runs inside the
**read-only** `withSupportGrant` transaction on `breakGlassPrisma`; the audit insert is a
**separate** `recordAuditEvent` call on `privilegedPrisma` that runs *after*
`withSupportGrant` has returned the scoped data. The audit write cannot be folded into the
break-glass transaction because that transaction is `SET TRANSACTION READ ONLY` and would
reject the insert. The audit write is awaited **before** the endpoint responds; if it fails
the endpoint returns 500 and the (already-read) result is discarded (§7.4 / §13(d)). The
audit row itself is written on `privilegedPrisma` (platform actor, and the row carries the
granted `institutionId` + `supportGrantId` so the tenant sees it in their Explorer via policy
(1) of §2.5).

### 6.4 Auto-expiry

A grant is EXPIRED when `expiresAt <= now()`. Enforcement is **lazy + explicit**, no cron in
Phase 0:

- Every grant load in the access path treats `status === ACTIVE && expiresAt <= now()` as
  expired: it flips the row to `EXPIRED` and refuses the access (403). An expired grant can
  never authorize a read even if a sweeper has not run.
- `GET /api/platform/support-grants` opportunistically expires stale ACTIVE rows it
  encounters. A scheduled sweeper is a documented later addition.

**Conditional-write / single-expiry-audit guard (resolves current-round NIT finding 6).**
The expiry flip is a side-effecting write on a `GET` path, so under concurrent loads two
requests could both attempt it. To make the write idempotent and emit exactly one expiry
audit event, the flip is a **conditional `updateMany`** and the audit is written **only when
the update actually changed a row**:

```ts
const { count } = await privilegedPrisma.supportGrant.updateMany({
  where: { id, status: "ACTIVE", expiresAt: { lte: now } },
  data: { status: "EXPIRED" },
});
if (count === 1) {
  await recordAuditEvent({
    action: "platform.support_grant.expired",
    result: "SUCCESS",
    // ...institutionId, supportGrantId, actor...
  });
}
```

Only the request that wins the `WHERE status='ACTIVE' AND expiresAt<=now()` race gets
`count === 1` and writes the single `platform.support_grant.expired` row; a concurrent loser
gets `count === 0` and writes nothing. A double-flip is therefore harmless and produces
exactly one expiry audit event regardless of concurrency. (This `support_grants` update is
unaffected by the §2.6 `audit_events` append-only trigger, which is scoped to `audit_events`
only.)

---

## 7. Endpoints

All platform endpoints live in `routes/platform.ts` (already behind `requireSuperAdmin()`),
extended with `requirePlatformMfa()`. All read/write of `support_grants` is on
`privilegedPrisma`; break-glass tenant reads go through `withSupportGrant` (campass_app).

### 7.1 Create a grant

`POST /api/platform/support-grants`
`preHandler: [requirePermission("platform.support.grant"), requireStepUp("support_grant.create")]`
Body (zod `createSupportGrantSchema`): `{ institutionId, purpose, expiresAt, scope? }`.

- Validate: institution exists; `purpose` non-empty (≤ 500 chars); `expiresAt` in
  `(now, now + MAX_TTL]` (`MAX_TTL` default 4h, a named constant); `scope` optional object.
- Create with `status: ACTIVE`, `activatedAt: now()` (Phase 0 collapses REQUESTED→ACTIVE for
  the Super-Admin-initiated flow; REQUESTED stays in the enum for a future approval workflow).
  `grantedToUserId = request.auth.userId`.
- Audit `platform.support_grant.created` + `platform.support_grant.activated` (`SUCCESS`,
  `institutionId = target`, `supportGrantId`).
- Returns the grant.

### 7.2 Revoke a grant

- Platform: `DELETE /api/platform/support-grants/:id`
  `preHandler: [requirePermission("platform.support.grant")]` (revoke is lower-risk than
  create, so no step-up required — documented choice).
- Tenant admin: `POST /api/admin/support-grants/:id/revoke`
  `preHandler: [requirePermission("admin.support.revoke")]` — **the new, dedicated
  write permission (resolves finding 5)**, NOT the read permission. The handler loads the
  grant on `privilegedPrisma`, asserts `grant.institutionId === request.auth.institutionId`
  (a tenant admin can revoke only a grant into *their* tenant), sets `status REVOKED`,
  `revokedAt`, `revokedByUserId`, `revokedReason`. Audited `platform.support_grant.revoked`.

### 7.3 List grants

- Platform: `GET /api/platform/support-grants?institutionId=&status=` — privileged,
  cross-tenant listing for operators; opportunistic auto-expiry (§6.4).
- Tenant (transparency): `GET /api/admin/support-grants`
  `preHandler: [requirePermission("campus_movement.audit.view")]` — reads via `withTenant`
  (the `support_grants_tenant_read` RLS policy scopes to the caller's tenant), returning
  active + historical grants affecting that institution. (Read is correctly gated on the
  **read** permission; only the state-changing revoke in §7.2 uses `admin.support.revoke`.)

### 7.4 Break-glass read endpoint(s)

`GET /api/platform/support-grants/:id/tenant/...` — a small, explicit set of read-only proxies
(e.g. list the granted tenant's recent passes, audit events) that run through
`services/support-grant.ts` → `withSupportGrant`. Each:

1. Loads + validates the grant (ACTIVE, not expired, belongs to the caller, institution not
   suspended).
2. Reads inside `withSupportGrant` with explicit `where: { institutionId }` filters (the only
   caller of the helper; no arbitrary-query API).
3. Writes `platform.support_grant.accessed` (await before responding; failure ⇒ 500, discard
   result).

Phase 0 ships **one** such read proxy (the granted tenant's `audit_events` + a passes list)
as the proving ground; the pattern is documented for extension.

### 7.5 Audit Explorer endpoints (§6.4)

- Tenant admin: the migrated `GET /api/admin/audit-logs` (path **kept**, not renamed) reads
  `audit_events` via `withTenant` filtered by date / actor / action / resourceType / result.
  RLS policy (1) guarantees own-tenant only, including break-glass rows written into the
  tenant (transparency), via the event-row `institutionId` filter — **not** the legacy
  `actor.institutionId` join (see §4.4 "Read sites" and finding 4).

  **`action` query-param backward-compat (resolves current-round finding 3).** The live
  endpoint applies `where.action = action` against the `AuditAction` **enum** (values like
  `PASS_APPROVED`, `EMERGENCY_OVERRIDE`). The new store uses catalogue keys
  (`campus_movement.pass.approved`, …). Chosen fix — **option (a): accept BOTH forms during
  a deprecation window.** The handler normalizes the incoming `action` value:
  1. if it is already a valid catalogue key (`AUDIT_ACTION_KEY_SET.has(action)`), use it;
  2. else if it is a legacy enum value (`action in LEGACY_AUDIT_ACTION_MAP`), translate it to
     the catalogue key via `LEGACY_AUDIT_ACTION_MAP[action]` before querying;
  3. else `400 { error: "unknown action filter" }`.

  So a caller still passing `action=PASS_APPROVED` keeps working (translated), and a caller
  passing the new key works directly. No previously-valid filter value breaks. (Option (b)
  — a hard breaking change on the first-party UI only — was rejected because the brief
  forbids route breakage and the translation is a few lines reusing a map we already build.)

  **Response shape (pinned, resolves finding 3).** The JSON envelope keeps the field name
  **`logs`** and the `{ logs, pagination }` shape for UI-contract stability, but each item is
  now an `audit_events` row: `action` is a **string** catalogue key (was an enum),
  `result` (`SUCCESS|DENIED|ERROR`) is **new**, and the new columns (`actorRoleKey`,
  `resourceType`, `resourceId`, `supportGrantId`, `requestRef`, `metadata`, `timestamp`)
  are present. The actor is still surfaced via `include: { actorUser: { select: { id, email, role } } }`
  (renamed relation `actor → actorUser` per the model). The first-party admin UI is updated
  in lockstep for the string `action` + `result` fields; no third-party consumer depends on
  this endpoint (internal admin surface only).
- Super Admin: `GET /api/platform/audit-events?scope=platform|grant&grantId=` — privileged
  read; `scope=platform` ⇒ `where institutionId: null`; `scope=grant` ⇒ validates an ACTIVE
  grant and filters `institutionId: grant.institutionId` (never all tenants at once).

---

## 8. Error handling (concrete, per operation)

| Operation | Failure condition | Recoverable? | Caller receives | Logged |
|---|---|---|---|---|
| `recordAuditEvent` (tenant action, in-tx) | unknown action key | fatal | business tx rolls back; 500 | `error`; dev throws |
| `recordAuditEvent` (tenant action, in-tx) | DB insert fails | fatal (atomic) | **business tx rolls back** — mutation does not commit without its audit row | `error` |
| `recordAuditEvent` (platform best-effort) | DB insert fails | recoverable | request still succeeds | `error` with action/actor |
| break-glass access audit write | DB insert fails | fatal for that request | `500` + read result discarded | `error`; no tenant data returned |
| create grant | invalid body (purpose empty / bad `expiresAt`) | recoverable | `400` + zod flatten | `info` |
| create grant | institution not found | recoverable | `404` | `info` |
| create grant | missing step-up (or wrong action class) | recoverable | `401 { error: "Step-up required" }` | `info` + `platform.mfa.step_up` DENIED |
| create grant | missing `platform.support.grant` | recoverable | `403` | `info` (requirePermission) |
| platform route (any) | platform account without MFA | recoverable | `403 { error: "MFA enrollment required" }` | `info` |
| MFA verify | wrong/expired code | recoverable | `400 { error: "Invalid code" }` | `info` + `platform.mfa.step_up`/enroll DENIED |
| break-glass access | grant not ACTIVE / expired | recoverable | `403` + lazy-expire if due | `platform.support_grant.accessed` DENIED (+ `.expired` if flipped) |
| break-glass access | grant belongs to another operator | recoverable | `403` | DENIED audit |
| break-glass access | target institution suspended | recoverable | `403 { error: "Institution suspended" }` | DENIED audit |
| tenant revoke | grant not into caller's tenant | recoverable | `404` (prefer 404 to avoid existence disclosure) | `info` |
| migration | `campass_app` role absent | n/a (guarded) | migration still applies (grants skipped) | — |

Invariant ownership:

- **"Super Admin has zero standing tenant access"** — owned by `authenticate` (never sets
  `request.tenant` for `SUPER_ADMIN`) **and** the DB (no standing `campass_app` session for a
  platform actor; `withSupportGrant` is the only platform tenant-read path and requires a
  validated grant per access).
- **"Audit is append-only"** — owned by a DB `BEFORE UPDATE OR DELETE` trigger on
  `audit_events` that `RAISE EXCEPTION`s (§2.6 step 6a), which binds **every** role including
  the table owner / `postgres` privileged path — not merely the `campass_app` GRANT. The GRANT
  (`campass_app` has `SELECT, INSERT`; `UPDATE, DELETE` revoked) is a second layer for the
  tenant role, but the trigger is the true DB-enforced floor: unlike a GRANT, the owner is not
  exempt from it, so `privilegedPrisma` cannot `UPDATE`/`DELETE` an audit row either. The
  single `recordAuditEvent` writer only ever `create`s, so the trigger never fires in normal
  operation. (The §6.4 lazy-expiry path mutates `support_grants`, not `audit_events`, so the
  trigger does not block expiry.) Tenant rows are written transactionally (atomic with the
  business mutation); platform rows via `privilegedPrisma`.
- **"A tenant cannot forge/cross-label audit rows"** — owned by policy
  `audit_events_tenant_insert` (`WITH CHECK institutionId = GUC`), so a tenant can only insert
  rows for its own institution and never a NULL-institution platform row.
- **"A grant is single-tenant"** — owned by the schema (one `institutionId`) + the access path
  (GUC + explicit filter = one institution) + RLS under `campass_app`.
- **"A grant is time-limited"** — owned by the access path's lazy-expiry check (never trust
  `status` alone; always compare `expiresAt`).
- **"Tenant transparency"** — owned by `support_grants_tenant_read` + the tenant list endpoint.

### 8.1 Input validation (per external input)

- `purpose`: required, string, trimmed length `1..500`. Fail ⇒ 400. Also a DB CHECK.
- `expiresAt`: required ISO datetime, `> now()` and `<= now()+MAX_TTL`. Fail ⇒ 400.
- `scope`: optional object `{ modules?: string[]; resources?: string[] }`, each ≤ 50 entries;
  advisory only. Fail ⇒ 400.
- `institutionId` (create): required, must resolve to an existing `Institution`. Fail ⇒ 404.
- MFA `code`: required, string of 6 digits (TOTP) **or** a recovery-code format — 10 chars
  Crockford base32 `^[0-9A-HJKMNP-TV-Z]{10}$`, case-insensitive, hyphen/whitespace stripped
  before matching (§5.2, `RECOVERY_CODE_COUNT = 10`); mismatch ⇒ 400.
- Audit Explorer filters (`action`, `result`, `from`, `to`, `actorUserId`, pagination): all
  optional; `action` validated against `AUDIT_ACTION_KEY_SET` when present (unknown ⇒ 400);
  `result` ∈ enum; pagination clamped (`limit ≤ 100`) like the existing endpoint.
- Step-up `x-step-up` header: verified JWT; `userId` must equal `request.auth.userId`,
  `stepUp === true`, `action === actionClass`, not expired. Fail ⇒ 401.
- All IDs come from `request.auth`, never the body — same rule as the rest of the system.

---

## 9. Testing

### 9.1 Unit (mocked, fast)

- `recordAuditEvent`: validates action keys (unknown throws), maps fields, uses the passed
  `tx` when present else `privilegedPrisma`, `sanitizeMetadata` drops secret-like keys and
  truncates.
- audit-action catalogue: every key matches `^[a-z_]+(\.[a-z_]+)+$`; no duplicates;
  `AUDIT_ACTION_KEY_SET` equals `AUDIT_ACTION_KEYS`.
- **legacy mapping (finding 3):** `LEGACY_AUDIT_ACTION_MAP` has exactly one target for each of
  the 28 `AuditAction` enum values, and every target ∈ `AUDIT_ACTION_KEY_SET`.
- **no-stragglers (finding 2):** a source assertion that `tx.auditLog.create` has **zero**
  occurrences under `apps/api/src/routes/**` after migration (the live count is 28, all in
  `routes/**`; the scope may also include `apps/api/src/services/**`, which starts at 0, to
  guard against a future straggler).
- **append-only no-mutation source assertion (current-round MEDIUM finding 2):** a source
  assertion that `auditEvent.update`, `auditEvent.delete`, and `auditEvent.deleteMany` never
  appear anywhere under `apps/api/src` (the only writer is `recordAuditEvent`, which calls
  `create` only). This pairs with the DB `BEFORE UPDATE OR DELETE` trigger (§2.6 step 6a) so
  append-only is guarded at both the source-convention and DB-enforced layers.
- TOTP: enroll→verify happy path with `otplib` at `{ window: 1, step: 30 }` against a known
  secret; wrong code rejected; **exactly `RECOVERY_CODE_COUNT = 10` recovery codes are issued
  at enrollment, each matching `^[0-9A-HJKMNP-TV-Z]{10}$`**; recovery code single-use (a
  consumed code's hash is removed and a second use is rejected); step-up token mint/verify
  (expiry, `userId` binding, `stepUp` + `action` claim).
- `requirePlatformMfa` / `requireStepUp` guards: 403/401 shapes; wrong action-class rejected.
- grant state machine: lazy-expiry flips ACTIVE→EXPIRED when `expiresAt` passed; revoke
  transitions; operator-binding check.

### 9.2 Integration (live Supabase, extends the escape suite)

Added to a new `superadmin-security.integration` suite / the escape suite:

1. **Break-glass scope through the REAL helper (finding 1):** an ACTIVE grant for tenant A
   lets the Super Admin read A's rows via `withSupportGrant` (campass_app + GUC); the same
   call returns **zero** B rows. Proven two ways: (i) with the explicit filter, and (ii) the
   RLS layer alone — a deliberately filter-less probe inside the helper still returns only A's
   rows because `campass_app` is NOBYPASSRLS and the GUC enforces (this is the test that would
   have caught the previous draft's false claim). Each access wrote a
   `platform.support_grant.accessed` row with the right `supportGrantId`.
   **`SET TRANSACTION READ ONLY` pooler compatibility + write rejection (current-round MEDIUM
   finding 3):** this live-smoke case also confirms `SET TRANSACTION READ ONLY` as the first
   statement works over the Supavisor 6543 transaction pooler inside an explicit tx (the same
   context in which `set_config(..., true)` was verified), AND asserts that an attempted write
   inside `withSupportGrant` (e.g. an `UPDATE`/`INSERT` on a tenant table) is **rejected** by
   Postgres with `cannot execute … in a read-only transaction` — proving break-glass is
   read-only by construction, not convention.
2. **No standing access:** a Super Admin has no tenant read route without a grant;
   `withSupportGrant` is reachable only via the validated grant path.
3. **Audit tenant-insert + nullable-institution RLS (current-round HIGH finding 1):** as
   `campass_app`, exercise **three GUC states** on BOTH the SELECT policy and the INSERT
   `WITH CHECK`:
   - **foreign-tenant GUC (A set, probing B):** INSERT with `institutionId = A` **succeeds**
     (policy `audit_events_tenant_insert`); INSERT with `institutionId = B` or `NULL` is
     **rejected**; SELECT returns only A's rows and **zero** B / platform-`NULL` rows.
   - **empty-string GUC (`set_config('app.current_institution_id', '', true)`):** SELECT
     returns **zero** rows and INSERT of **any** row (including `institutionId = ''`) is
     **rejected** — because `nullif(current_setting(...), '')` collapses `''` to NULL, so the
     `=` comparison is NULL (not TRUE). This is the state the plain `=` policy could not
     prove fail-closed; the `nullif` wrapper makes it fail-closed.
   - **unset GUC (never set in this tx):** SELECT returns **zero** rows and INSERT of any row
     is **rejected** (fail-closed).
   All three assert zero rows on SELECT and rejection on the INSERT `WITH CHECK` for anything
   not matching a valid, matching non-empty tenant GUC.
4. **Append-only enforcement (current-round MEDIUM finding 2):** `campass_app` UPDATE/DELETE
   on `audit_events` is rejected by GRANT; INSERT/UPDATE/DELETE on `support_grants` rejected
   by GRANT. **Additionally, the `BEFORE UPDATE OR DELETE` trigger rejects an UPDATE and a
   DELETE on `audit_events` executed on the privileged (`postgres`/`privilegedPrisma`,
   BYPASSRLS owner) connection** — proving append-only binds even the owner, not just the
   tenant role. The test also confirms a privileged `UPDATE` on `support_grants` (the
   lazy-expiry path) still succeeds, i.e. the trigger is scoped to `audit_events` only.
5. **Tenant transparency:** as tenant A admin (via `withTenant`), `support_grants` SELECT
   returns only A's grants; B's grant is invisible.
6. **Grant expiry (current-round NIT finding 6):** a grant with past `expiresAt` cannot
   authorize a read (lazy expiry ⇒ 403 + `.expired` audit). The conditional `updateMany`
   (`WHERE status='ACTIVE' AND expiresAt<=now()`) is asserted idempotent: two concurrent
   loads of the same stale grant produce exactly **one** `platform.support_grant.expired`
   audit row (the `count === 1` winner writes it; the `count === 0` loser writes nothing).
7. **MFA mandatory:** a platform account without `mfaEnabled` is 403'd on every platform route
   except enrollment.
8. **Step-up:** create-grant without a fresh step-up token ⇒ 401; with a wrong-action-class
   token ⇒ 401; with the right one ⇒ success + create/activate audits.

### 9.3 Meta-test extension

The RLS meta-test (`tenant-escape.integration.test.ts` #6) and the `RLS_TABLES` helper gain
`audit_events` and `support_grants` for the `relrowsecurity/relforcerowsecurity = true`
assertion. The policy-name assertion is generalized to a **per-table expected-policy map**:

- `audit_events` → `{ tenant_isolation_select, audit_events_tenant_insert }`
- `support_grants` → `{ support_grants_tenant_read }`
- everything else → the standard `{ tenant_isolation_select, tenant_isolation_modify }`.

**No `*_platform_all` policy appears in the map** — per findings 1 & 2, those inert
`TO postgres` policies are not created, so the meta-test does not assert them. The map lists
only the load-bearing policies that bind `campass_app`. This keeps the "no tenant table
without RLS" guard intact while accommodating the platform-read/write-exception tables.

### 9.4 Regression

- Auth regression suite stays green (login/session/suspended-institution unchanged;
  `authenticate` gains no behavior change beyond MFA checks living in the platform plugin).
- GatePass E2E: all migrated audit writes still produce rows (now in `audit_events`,
  **still inside the tenant tx**) and the pass timeline renders from the new string actions.
- `catalogue-sync.test.ts` is **generalized** (finding 1): it now unions the permission /
  `role_permissions` seed from `identity_rbac_b2` **and** `superadmin_security_c` and asserts
  set-equality of that union against `@campusgate/shared`. With `admin.support.revoke` added
  to shared, `ROLE_PERMISSIONS.ADMIN`, and the new migration's seed, the union matches shared
  and the test passes. The frozen `identity_rbac_b2/migration.sql` is byte-for-byte unchanged.
  The test's self-check ("fails on injected drift") still holds against the union.

What is unit vs. integration: the writer, catalogues, legacy mapping, TOTP, guards, and the
grant state machine are **unit** (no DB). RLS behavior (including the campass_app break-glass
scope), GRANT enforcement, tenant transparency, nullable-institution isolation, and the
tenant-insert WITH CHECK are **integration** against live Supabase — they cannot be proven
with mocks.

---

## 10. Files touched

New:

- `packages/db/prisma/migrations/<ts>_superadmin_security_c/migration.sql`
- `packages/shared/src/audit-actions.ts` (catalogue + `LEGACY_AUDIT_ACTION_MAP`; export from `index.ts`)
- `apps/api/src/services/audit.ts` (writer + `sanitizeMetadata`)
- `apps/api/src/services/support-grant.ts` (grant lifecycle + break-glass access)
- `apps/api/src/services/mfa.ts` (TOTP enroll/verify, recovery codes, step-up token)
- `apps/api/src/routes/mfa.ts`
- `apps/api/src/middleware/step-up.ts` (`requireStepUp`, `requirePlatformMfa`)
- `apps/api/src/routes/__tests__/superadmin-security.integration.test.ts` + unit tests

Modified:

- `packages/db/prisma/schema.prisma` (two models, two enums, `User` MFA fields, back-relations)
- `packages/db/src/index.ts` (`withSupportGrant` + the `breakGlassPrisma` campass_app client
  + the `globalForPrisma` type extension + the NOBYPASSRLS fail-closed role probe — finding 5)
- `packages/shared/src/permissions.ts` (add `admin.support.revoke`; map to `ADMIN`)
- `apps/api/src/routes/platform.ts` (grant endpoints, platform audit explorer, MFA gate,
  institution create/status audit via `recordAuditEvent`)
- `apps/api/src/routes/admin.ts`, `hod.ts`, `guard.ts`, `student.ts` (audit call-site
  migration — keeping the in-`tx` write pattern — tenant grant endpoints + tenant audit explorer)
- `apps/api/src/services/pass-lifecycle.ts` (timeline typed on string action + `AuditResult`)
- `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` (`RLS_TABLES`, per-table
  policy map, teardown of new tables)
- `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts` (meta-test policy map)
- `apps/api/src/services/__tests__/catalogue-sync.test.ts` (**finding 1**: generalize from a
  single pinned `MIGRATION_DIR` to a `SEEDING_MIGRATION_DIRS` array; extract + **union** the
  permission / `role_permissions` seed from `identity_rbac_b2` **and** `superadmin_security_c`;
  assert set-equality of the union against `@campusgate/shared`. The frozen migration SQL is
  untouched; only this test's logic + the new migration's seed change.)
- `apps/api/package.json` (`otplib`, `qrcode` deps, pinned exact versions)
- `apps/api/.env.example` (no new secret — `PRIVILEGED_DATABASE_URL`/`DIRECT_URL` +
  `DATABASE_URL` already exist — but document the **role contract** break-glass depends on
  (resolves finding 7): `DATABASE_URL` MUST be the **campass_app** URL (NOBYPASSRLS, 6543),
  used by both the runtime tenant client and `breakGlassPrisma`; `PRIVILEGED_DATABASE_URL`
  (and the `DIRECT_URL` fallback) MUST be the **postgres** role (BYPASSRLS). Add a warning:
  pointing `DATABASE_URL` at the `postgres` role silently defeats BOTH tenant RLS and
  break-glass scoping — the §6.2 startup probe exists precisely to turn that misconfiguration
  into a hard failure rather than a silent leak.)

---

## 11. Sequencing (keep the app working at every step)

1. Add deps (`otplib`, `qrcode`, pinned). Build still green.
2. Add shared `audit-actions.ts` (+ `LEGACY_AUDIT_ACTION_MAP`) + `admin.support.revoke` to the
   permission catalogue + unit tests. Generalize `catalogue-sync.test.ts` to the
   `SEEDING_MIGRATION_DIRS` union (finding 1) in the **same** change so the build does not go
   red between adding the key to shared and seeding it in step 3. No runtime wiring yet.
3. Schema + migration (new tables, MFA fields, RLS, GRANT refresh with the targeted REVOKEs,
   `admin.support.revoke` permission seed + `role_permissions` ADMIN mapping, matching the
   seed-block markers the generalized catalogue-sync test parses). `prisma migrate dev`
   locally; `prisma generate`. Old `audit_logs` untouched → app still works. Catalogue-sync
   green (union now matches shared).
4. `recordAuditEvent` writer + `sanitizeMetadata` + unit tests. Not yet wired.
5. Migrate audit call sites route-by-route to `recordAuditEvent(..., tx)` (keeping the in-tx
   pattern) and readers to `audit_events`; run the relevant integration tests after each route
   group. GatePass E2E green throughout. Confirm the no-stragglers assertion.
6. MFA service + endpoints + guards; wire `requirePlatformMfa` on `platformRoutes`.
7. `SupportGrant` service + `withSupportGrant` (+ `breakGlassPrisma`) + platform/tenant
   endpoints + step-up on create.
8. Extend escape suite + meta-test (per-table policy map); full suite green.

Each step is independently committable and leaves the app runnable.

---

## 12. Constraints honored

- Work on `main`, no worktree; new migration only (B-1 + identity_rbac_b2 FROZEN, untouched). ✔
- Live tenancy + RBAC not broken: no changes to existing RLS policies, `withTenant`,
  `campass_app` tenant grants (only additive grants + targeted revokes on the **new** tables),
  the authz engine, the shim, or the legacy `role` claim. ✔
- New tables follow the tenancy checklist where tenant-readable (`audit_events` has
  `institutionId` + RLS + escape coverage; `support_grants` has a scoped read policy + escape
  coverage) and document their platform-write exception. ✔
- `campass_app` never gets `BYPASSRLS`; break-glass uses the NOBYPASSRLS `campass_app` role +
  GUC per access, not a bypass role. ✔
- Reuse the authz engine + permission catalogue; add exactly **one** new key
  (`admin.support.revoke`) for a least-privilege reason (finding 5); no `platform.*` change. ✔
- Secrets out of git; no push/deploy; no module entitlement/activation or §9 items. ✔

---

## 13. Resolved ambiguities (explicit)

**(a) Final schema + RLS/ownership + why.** `audit_events` and `support_grants` as in §2.
`audit_events` is tenant-readable (nullable `institutionId`, `=` SELECT policy) **and
tenant-writable in-tx** (INSERT policy with `WITH CHECK institutionId = GUC`,
`UPDATE/DELETE` revoked for append-only); platform rows (`institutionId null`) are written +
read on `privilegedPrisma` (bypasses RLS). `support_grants` is a platform table with a
SELECT-only tenant-read policy for transparency; platform writes go on `privilegedPrisma`. No
`TO postgres` policies (inert for a BYPASSRLS role). Chosen over mutating the frozen
`audit_logs` because in-place relaxation of a live, escape-covered table risks proven
guarantees.

**(b) Nullable-institutionId platform audit rows vs. fail-closed RLS.** Resolved in §2.5: the
`=` SELECT policy makes NULL platform rows invisible to tenants (correct, fail-closed).
Platform rows are served **only** by the privileged read path (`institutionId: null`, or a
grant-authorized single tenant). A permissive `IS NULL OR = GUC` policy is explicitly rejected
(it would leak all platform rows into any tenant).

**(c) Real TOTP vs. stub.** Phase 0 implements **real TOTP** (`otplib`,
`{ window: 1, step: 30 }`) enrollment + verification + bcrypt-hashed recovery codes +
mandatory-MFA gate for platform accounts + a stateless, action-class-bound step-up token,
concretely wired on `SupportGrant` create/activate. The **only** stub is attaching
`requireStepUp` to the *other* future high-risk actions (refunds, result publish, pass revoke,
institution suspend) — the guard exists and is documented as their attach-point
(`// PHASE-0 SEAM`).

**(d) Single-tenant scoped break-glass without standing bypass; every access audited.**
Resolved in §6: `withSupportGrant(institutionId, fn)` runs on a dedicated **`campass_app`
(NOBYPASSRLS)** per-access transaction that `set_config`s `app.current_institution_id` to the
one granted institution — so the GUC is a **genuine** RLS-enforcing layer, not the inert
no-op it would be on `privilegedPrisma`. The transaction is opened **`SET TRANSACTION READ
ONLY`** as its first statement (resolving current-round MEDIUM finding 3), so a break-glass
write is **rejected by Postgres by construction** — not merely "read-only by convention" —
even though `campass_app` holds write DML on tenant tables. The service layer also applies
explicit `where institutionId` filters (second, now-real layer) and is the sole caller of the
helper. The grant is validated (ACTIVE, unexpired, operator-bound, institution-active) before
every access; each access awaits a `platform.support_grant.accessed` audit write before
returning — written on a **separate privileged (append) transaction**, NOT inside the
read-only break-glass tx (a write cannot run in the read-only tx), in the order
"read-only tenant read in `breakGlassPrisma` tx → `recordAuditEvent` insert on
`privilegedPrisma`" — and a failed audit write aborts the read (500, discard). No `BYPASSRLS`
role; no *standing* `campass_app` session (per-access, grant-authorized transaction, justified
against `tenancy.md` §5.4); `request.tenant` is never set for a Super Admin. `scope` is
advisory in Phase 0 (§5.4).

**(e) Audit-action catalogue shape + migrated write sites.** String-keyed `<module>.<action>`
registry in `@campusgate/shared/src/audit-actions.ts`, validated in the single
`recordAuditEvent` writer (unknown key throws); no pg enum, no migration mirror. The complete
28-value `AuditAction → catalogue-key` table is in §4.4 (including the previously-ambiguous
`EMERGENCY_OVERRIDE → campus_movement.pass.override`), captured as `LEGACY_AUDIT_ACTION_MAP`
with a unit test proving 1:1 coverage. All **28** production `tx.auditLog.create` sites
(admin ×17, guard ×5, hod ×4, student ×2 — all in `routes/**`; there is NO service-layer
site) are migrated to `recordAuditEvent(..., tx)` **still inside the tenant tx**; readers
switch to `audit_events`. `EMERGENCY_OVERRIDE` is written at `hod.ts:219` and `admin.ts:1790`
(already inside the route counts) and maps to `campus_movement.pass.override`. The migrated
tenant reader filters on the event row's `institutionId` (not `actor.institutionId`), and the
`GET /audit-logs` `action` filter accepts both legacy enum values (translated via
`LEGACY_AUDIT_ACTION_MAP`) and catalogue keys for backward compatibility (findings 3, 4). Old
`audit_logs` kept frozen.

**(f) Verification plan matching the brief's live-smoke tests.** §9: break-glass scope proven
*through the real campass_app helper* (A-only, B-denied via both filter and RLS, audited),
no-standing-access, nullable-institution SELECT isolation + tenant-insert WITH CHECK across
the three GUC states (unset/empty-string/foreign), append-only enforcement (GRANT for the
tenant role **and** the `BEFORE UPDATE OR DELETE` trigger binding even the privileged owner),
read-only break-glass (`SET TRANSACTION READ ONLY` write-rejection),
tenant transparency, grant expiry (single-event idempotency), mandatory MFA, step-up — all
live-Supabase integration tests extending the escape suite, plus the RLS meta-test with a
per-table policy-name map (listing only load-bearing policies). Unit tests cover the writer,
catalogues, legacy mapping, TOTP, guards, and the grant state machine.

**Additional recorded micro-decisions:**

- REQUESTED→ACTIVE is collapsed at create for the Super-Admin-initiated flow; REQUESTED stays
  in the enum for a future approval workflow.
- Tenant-side **revoke** is gated on the **new** `admin.support.revoke` permission (not the
  read key); the tenant audit-explorer and grant **list** reads stay on
  `campus_movement.audit.view` (read authority). Read/write authority separated (finding 5).
- `SupportGrant.scope` is advisory (recorded + shown) in Phase 0; mechanical enforcement
  defers to the module-entitlement phase.
- Tenant audit writes remain **transactional** (in the business `tx`), preserving today's
  atomic guarantee; platform/pre-tenant writes go on `privilegedPrisma`. No best-effort
  post-commit regression (finding 4).
- Step-up tokens are **multi-use within a 5-minute TTL but action-class bound**; single-use
  `jti` consumption is the documented upgrade for money/results modules (finding 8).

---

## 14. Response to the PRIOR-round design-review findings (history)

> This section records how the *previous* review round (the one that produced the §0 RLS
> ground-truth rewrite, the `campass_app` break-glass fix, and the three-policy
> `audit_events` posture) was resolved. The CURRENT round's findings are answered in §15.

**Finding 1 (HIGH) — break-glass "two layers" false; `postgres` has BYPASSRLS.** **Addressed.**
Adopted fix **(A)**: break-glass reads now run on a dedicated `campass_app` (NOBYPASSRLS)
client `breakGlassPrisma` with the tenant GUC set (§6.2), so the GUC is a *real* enforcing
layer — the second layer is the mandatory service-layer `where institutionId` filter, and the
helper is the sole caller so the filter is structurally present. Justified against the
"no standing campass_app session" invariant (per-access, grant-authorized transaction,
`tenancy.md` §5.4). The false "owner is subject to policies" reasoning is removed from §6.2 and
replaced by §0's verified model. Added an escape test (§9.2 #1) proving A-only / zero-B
*through the real helper*, including a filter-less probe that relies on RLS alone.

**Finding 2 (MEDIUM) — inert `TO postgres` platform ALL policies.** **Addressed.** The
`*_platform_all` policies are **removed** — they are inert for a BYPASSRLS role. §0, §2.4, §2.5
now state the true model: platform writes/reads succeed because `privilegedPrisma` bypasses
RLS. Only the load-bearing tenant-binding policies remain
(`support_grants_tenant_read`; `tenant_isolation_select` + `audit_events_tenant_insert` on
`audit_events`). §9.3's expected-policy map no longer lists any inert policy.

**Finding 3 (MEDIUM) — enum→string mapping under-specified; `EMERGENCY_OVERRIDE` ambiguous.**
**Addressed.** §4.4 now contains the complete **28-value** mapping table (verified against the
live enum), with `EMERGENCY_OVERRIDE → campus_movement.pass.override`,
`BULK_IMPORT → admin.students.imported`, `ALLOWANCE_POLICY_UPDATED → admin.allowance_policy.updated`,
etc., captured as `LEGACY_AUDIT_ACTION_MAP`. §9.1 adds a unit test asserting 1:1 coverage and
that every target is a valid catalogue key.

**Finding 4 (MEDIUM) — best-effort post-commit audit weakens the atomic guarantee.**
**Addressed.** Adopted fix **(a)**: `campass_app` keeps `INSERT` on `audit_events`
(`UPDATE/DELETE` revoked for append-only), `recordAuditEvent` accepts an optional `tx`, and
tenant actions keep writing their audit row **inside the business transaction** — preserving
today's atomic commit. The `audit_events_tenant_insert` policy's `WITH CHECK institutionId = GUC`
makes this safe. The GRANT posture in §2.6 is reconciled (INSERT kept, UPDATE/DELETE revoked).
No accepted regression remains.

**Finding 5 (MEDIUM) — tenant revoke reuses a read permission.** **Addressed.** Added a
dedicated `admin.support.revoke` permission (§3), seeded in the migration and mapped to the
tenant ADMIN role; the tenant revoke endpoint (§7.2) is gated on it. Read endpoints keep
`campus_movement.audit.view`. Catalogue-sync stays green because both catalogue and seed change
together.

**Finding 6 (NIT) — guard.ts write count off by one.** **Addressed.** Re-ran the inventory:
`guard.ts` has **5** `tx.auditLog.create` sites (lines 139, 194, 273, 464, 600). §4.4 pins exact
counts/line refs per file (admin ×17, guard ×5, hod ×4, student ×2 = 28, all in `routes/**` —
corrected again this round under current-round finding 2, which removed a phantom
service-layer site), and §9.1 adds a no-stragglers assertion.

**Finding 7 (NIT) — TOTP window stated two ways.** **Addressed.** §5.1 pins
`authenticator.options = { window: 1, step: 30 }` (±30s) and §5.5 references that single config.

**Finding 8 (NIT) — step-up replay within TTL unspecified.** **Addressed.** §5.3 states the
decision: **multi-use within the 5-minute TTL but action-class bound** (an `action` claim
checked by `requireStepUp(actionClass)`); single-use `jti` consumption is the documented upgrade
for money/results modules.

**Finding 9 (NIT) — dangling security-incident-grant clause.** **Addressed.** The clause is
removed; §2.7 now states plainly that there is **no** security-incident grant branch in Phase 0
(it is the deferred `superadmin-security.md` §4.5 emergency path) — suspended-institution access
is simply refused with a `DENIED` audit.

---

## 15. Response to the CURRENT-round design-review findings

> Review verdict: CHANGES_REQUESTED (2 HIGH, 3 MEDIUM, 2 NIT). Each finding below was
> re-verified against live source before being resolved.

**Finding 1 (HIGH) — `admin.support.revoke` seed collides with the FROZEN
`identity_rbac_b2` catalogue-sync test.** **Addressed.** Verified: `catalogue-sync.test.ts`
hard-pins `MIGRATION_DIR = "20261018171747_identity_rbac_b2"` and asserts set-equality between
`@campusgate/shared` and the seed inside that one frozen file; seeding `admin.support.revoke`
in the new `superadmin_security_c` migration would break set-equality. The previous draft's
claim that the test "stays green because both sides change together" was false and is
**removed**. Adopted the review's option **(a)**: §3 now specifies generalizing the test to a
`SEEDING_MIGRATION_DIRS` array that reads AND unions the permission / `role_permissions` seed
from `identity_rbac_b2` **and** `superadmin_security_c`, asserting set-equality of the union
against shared. The frozen migration SQL is untouched (only test logic + the new migration's
seed change); the test file is added to §10 "Modified", §9.4 and §11 step 2 are updated to
generalize the test in the same change so the build never goes red. Option (b) (drop the key,
gate revoke on `campus_movement.audit.view`) was explicitly rejected to preserve least-privilege.

**Finding 2 (HIGH) — §4.4 inventory overstates production audit write sites; the
"override ×1 in a service" row does not exist.** **Addressed.** Verified by grep of
`apps/api/src` excluding `__tests__`: `auditLog.create` appears only in `admin.ts` (17),
`guard.ts` (5), `hod.ts` (4), `student.ts` (2) = **28**, all in `routes/**`; there is **no**
`auditLog.create` under `services/**` (the service-level override write exists only in a test
file, `services/__tests__/allowance-integration.test.ts:422`). §4.4 is corrected: the phantom
`services/allowance-engine.ts` row is dropped, the total is 28, and `EMERGENCY_OVERRIDE` is
noted as written at `hod.ts:219` and `admin.ts:1790` (already inside the route counts),
mapping to `campus_movement.pass.override`. §13(e), §9.1, and the prior-round §14-Finding-6
note are reconciled to 28/`routes/**`-only; expected post-migration count in `routes/**` is 0.

**Finding 3 (MEDIUM) — Audit Explorer `action` query-param format changes enum→catalogue-key
with no backward-compat story.** **Addressed.** Verified: live `admin.ts:1812` applies
`where.action = action` against the `AuditAction` enum and returns `{ logs, pagination }` with
`include: { actor }`. §7.5 now adopts option **(a)**: the migrated handler accepts BOTH forms —
a valid catalogue key is used directly, a legacy enum value is translated via
`LEGACY_AUDIT_ACTION_MAP` before querying, anything else ⇒ 400 — so no previously-valid filter
value breaks. The response envelope keeps the field name `logs` and `{ logs, pagination }`
shape; each item is now an `audit_events` row with a **string** `action`, a new `result`, the
new columns, and the actor via the renamed `actorUser` relation. The first-party admin UI
(the only consumer) is updated in lockstep; no third party depends on it. §4.4 records the map
reuse.

**Finding 4 (MEDIUM) — tenant audit read semantics change from actor.institutionId to
event.institutionId without naming the difference.** **Addressed.** Verified: the live reader
filters `where: { actor: { institutionId } }`. §4.4 "Read sites" and §7.5 now state
explicitly that the migrated reader **drops the `actor.institutionId` join** and filters on
the event row's own `institutionId` (enforced by RLS policy `tenant_isolation_select`); this
is **deliberate** and is precisely what surfaces break-glass rows (SUPER_ADMIN actor, tenant
`institutionId`) in the tenant Explorer per §6.4. An implementer is told not to reintroduce
the actor join. §13(e) echoes the decision.

**Finding 5 (MEDIUM) — `breakGlassPrisma`/`withSupportGrant`: `globalForPrisma` typing
unstated and DATABASE_URL role contract can fail open.** **Addressed.** Verified:
`globalForPrisma` is typed `{ prisma; privilegedPrisma }` only, and the same module documents
`DATABASE_URL` as a last-resort privileged fallback (fail-open risk). §6.2 now (a) extends
`globalForPrisma` with `breakGlassPrisma?: PrismaClient`, and (b) adds a fail-closed runtime
invariant: the first statement in every `withSupportGrant` transaction probes
`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user` and **throws** unless the
role is NOBYPASSRLS (cached after first pass), so a misconfigured `DATABASE_URL` fails closed
instead of silently bypassing RLS. The §9.2 #1 filter-less-probe escape test is promoted to a
required gate. §10 records the `index.ts` changes.

**Finding 6 (NIT) — `actorRoleKey` source named two ways.** **Addressed.** §4.4 field map now
pins a single expression: `actorRoleKey = request.auth.roles[0] ?? request.user.role`, noting
it is `"SUPER_ADMIN"` for platform actors.

**Finding 7 (NIT) — `.env.example` note should document the two distinct role URLs.**
**Addressed.** The §10 `.env.example` bullet now states the role contract explicitly:
`DATABASE_URL` = campass_app (NOBYPASSRLS, 6543), used by both the runtime tenant client and
`breakGlassPrisma`; `PRIVILEGED_DATABASE_URL`/`DIRECT_URL` = postgres (BYPASSRLS); plus a
warning that pointing `DATABASE_URL` at `postgres` silently defeats both tenant RLS and
break-glass scoping (tied to finding 5's startup probe).

---

## 16. Response to the LATEST-round design-review findings

> Review verdict: CHANGES_REQUESTED (1 HIGH, 2 MEDIUM, 3 NIT). The security spine is sound
> and unchanged; these are copy-ready fixes, no approach change. Each is baked into the
> sections cited.

**Finding 1 (HIGH) — nullable-`institutionId` `=` fail-closed unproven for empty-string/unset
GUC on the new tables.** **Addressed.** All three load-bearing policies on the new tables now
wrap the GUC in `nullif(current_setting('app.current_institution_id', true), '')` in BOTH
`USING` and `WITH CHECK`: `support_grants_tenant_read` (§2.4), and
`tenant_isolation_select` + `audit_events_tenant_insert` (§2.5). `nullif(..., '')` collapses
**both** an unset GUC (already NULL) and an empty-string GUC (`''`) to NULL, so
`"institutionId" = NULL` is NULL (never TRUE) — genuinely fail-closed in both states. §2.5
adds an explicit note that `withTenant`/`withSupportGrant` always `set_config` a validated
non-empty cuid, never `''`, so the wrapper is defense-in-depth. §9.2 #3 is extended to assert
**zero rows on SELECT and rejection on the INSERT `WITH CHECK`** for THREE GUC states — unset,
empty-string (`''`), and foreign-tenant — on both the SELECT policy and the INSERT.

**Finding 2 (MEDIUM) — append-only enforced only for `campass_app`; the privileged
`postgres` path can UPDATE/DELETE `audit_events`.** **Addressed, option (b).** §2.6 step 6a
adds a `BEFORE UPDATE OR DELETE` trigger on `audit_events` (`audit_events_append_only()`
`RAISE EXCEPTION`) that binds **every** role including the owner/privileged path, so
append-only is DB-enforced for all roles, not just the tenant GRANT. §8 "Invariant ownership"
is rewritten: the overstated "owned by the DB GRANT" claim is replaced — the trigger is the
true DB-enforced floor (the owner is not exempt from a trigger as it is from a GRANT), with
the GRANT as a second layer for the tenant role. It is stated that the §6.4 lazy-expiry path
mutates `support_grants`, **not** `audit_events`, so the trigger does not block expiry. §9.1
adds a source assertion that `auditEvent.update`/`.delete`/`.deleteMany` never appear in
`apps/api/src`, and §9.2 #4 adds a live test that a privileged `UPDATE`/`DELETE` on
`audit_events` is rejected by the trigger while the `support_grants` expiry update still
succeeds.

**Finding 3 (MEDIUM) — `withSupportGrant` "read-only by convention" but `campass_app` has
write DML.** **Addressed.** §6.2 opens the break-glass transaction with
`SET TRANSACTION READ ONLY` as the **first** statement (before `set_config`), so Postgres
rejects any write by construction; the "by convention" language in §6.2 and §13(d) is
replaced with this mechanism. The audit write that must happen during a break-glass access
**cannot** run inside the read-only tx, so §6.2/§6.3/§13(d) make the ordering explicit:
the read-only tenant read runs in the `breakGlassPrisma` tx, and the
`platform.support_grant.accessed` audit INSERT runs in a **separate** privileged
`recordAuditEvent` call afterward. §9.2 #1 adds a verification that a write inside
`withSupportGrant` is rejected (`cannot execute … in a read-only transaction`) and confirms
`SET TRANSACTION READ ONLY` works over the Supavisor 6543 transaction pooler inside the
explicit tx (live-smoke).

**Finding 4 (NIT) — singular audit-action `platform.institution.*` vs plural permission
`platform.institutions.manage`.** **Addressed.** §4.1 adds a one-line namespace note: the
singular audit-action keys are a separate namespace from the plural permission key; no
relationship is implied and the singular/plural difference is intentional.

**Finding 5 (NIT) — recovery-code count/format unspecified.** **Addressed.** `RECOVERY_CODE_COUNT
= 10` is pinned in §2.3, §5.2 and §8.1, with a concrete format — 10 characters of Crockford
base32 `^[0-9A-HJKMNP-TV-Z]{10}$`, CSPRNG-generated, shown grouped `XXXXX-XXXXX`, stored
bcrypt-hashed and compared hyphen-stripped. §9.1 asserts exactly 10 codes issued, each
matching the format, single-use (consumed hash removed, reuse rejected).

**Finding 6 (NIT) — lazy-expiry on `GET` lacks conditional-write/double-audit guard.**
**Addressed.** §6.4 makes the expiry flip a conditional
`updateMany({ where: { id, status: 'ACTIVE', expiresAt: { lte: now } }, data: { status:
'EXPIRED' } })` and writes the `platform.support_grant.expired` audit **only when
`count === 1`**, so concurrent GETs yield exactly one expiry event (the loser gets
`count === 0` and writes nothing). §9.2 #6 asserts the single-event idempotency under
concurrent loads.
