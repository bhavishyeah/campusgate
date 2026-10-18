# CAMPASS Database: Neon → Supabase, Migrations, Phase 0 Schema

> Owning doc for decisions **D5 (host = Supabase)** and **D7 (versioned migrations)**.
> The isolation mechanics (RLS, app role, composite FKs) are specified in
> [`tenancy.md`](./tenancy.md); this doc covers the **move**, the **connection
> strategy**, the **migration workflow**, and the **Phase 0 schema additions**.

> **Status (2026-10-18):** the Neon → Supabase move and versioned-migration adoption are
> **DONE** (committed `42ba4db`). Connection strategy, pooler ports, and the RLS app-role
> mechanics are **VERIFIED** (see [`tenancy.md`](./tenancy.md) spike results). Remaining
> **⚠ VERIFY** tags below are limited to backup/PITR capabilities, which are operational
> decisions to confirm when the backup plan is finalized.

---

## 1. Where we are

- **Host today:** Neon (live, online). SSL with `rejectUnauthorized: false` in the
  one-off `migrate-neon.ts` script.
- **Schema management today:** `prisma db push --accept-data-loss` runs in the deploy
  (`railway.toml`). This is **unsafe for an ERP** — it can drop data and keeps no
  migration history. Replacing it is decision **D7**.
- **Prisma connection today:** a single `DATABASE_URL`; the app connects as the DB owner
  (effectively superuser on managed Postgres).

---

## 2. Target connection strategy (Supabase) — VERIFIED & IN USE

Supabase exposes these connection paths. The ERP uses **both**. **Verified working**
against project `vybsvmvcdmoomuoxvmbc`:

> **Network note (this environment):** the **direct** host `db.<ref>.supabase.co:5432`
> is **IPv6-only and unreachable** on the current network. We therefore use the
> **session pooler** (same pooler host, port **5432**, IPv4) as `DIRECT_URL` for
> migrations. The **transaction pooler** (port 6543) is `DATABASE_URL` for runtime.

| Purpose | Connection | Port | Prisma field |
|---|---|---|---|
| **App runtime** (many short-lived queries, tenant-scoped via `campass_app`) | Transaction pooler (Supavisor) | 6543 | `DATABASE_URL` (+ **required** `?pgbouncer=true`) |
| **Migrations / DDL** (one long session) | Session pooler (IPv4 fallback for IPv6-only direct) | 5432 | `directUrl` |
| **Privileged runtime** (auth-bootstrap + platform/Super-Admin reads, RLS-bypass `postgres`) | Session pooler | 5432 | `PRIVILEGED_DATABASE_URL` (B-2; falls back to `DIRECT_URL` then `DATABASE_URL` if unset) |

> **⚠ KNOWN ISSUE (observed during B-2 live testing).** The privileged runtime client
> uses the **session pooler on port 5432**, and the `authenticate` middleware calls it on
> **every** request. On the current (IPv6-constrained) network, port 5432 is **slow and
> intermittently unreachable** (6–12s response times, occasional `P1001 Can't reach
> database server`), while the transaction pooler (6543) is consistently fast. Logins and
> tenant-scoped reads succeed, but authenticated requests occasionally 500 on a 5432 blip.
> **Mitigations to evaluate (later):** (a) route the privileged client's identity lookups
> through a 6543-style pooled connection where session-level features aren't needed;
> (b) add a short Prisma connection retry/backoff for P1001 on the privileged client;
> (c) in production (Railway, not IPv6-constrained) confirm whether 5432 is reliable — this
> may be a local-network artifact. Does NOT affect correctness or isolation; it is a
> reliability/latency concern on this network.

Prisma schema shape (target):

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")   // pooled, for the running app
  directUrl = env("DIRECT_URL")     // direct, for prisma migrate / db commands
}
```

**Why two:** a transaction pooler is efficient for app traffic but does not support all
session-level/DDL operations; migrations need a direct session. Prisma's `directUrl`
exists precisely for this.

### 2.1 Interaction with RLS session variables — VERIFIED

[`tenancy.md`](./tenancy.md) sets `app.current_institution_id` with
`set_config(..., true)` **inside a transaction**. **Proven in the spike** against the
transaction pooler (6543):

- The pooled URL runs in **transaction** mode; a transaction is pinned to one backend
  for its duration, so the GUC is isolated between pooled clients. ✅
- `set_config('app.current_institution_id', $1, true)` as the first statement of a
  Prisma `$transaction` correctly applied to subsequent queries in that transaction. ✅
- A request with the GUC unset returned **zero** rows (fail-closed). ✅

Session-scoped plain `SET` (outside a transaction) is NOT safe under the transaction
pooler — always use `set_config(..., true)` inside `$transaction`.

### 2.2 The dedicated app role — VERIFIED

Per [`tenancy.md`](./tenancy.md) §5.1, RLS is worthless if Prisma connects as a role that
bypasses it. **Proven in the spike:** as `postgres`, RLS was fully bypassed; as a
`NOSUPERUSER NOBYPASSRLS` role, isolation held perfectly.

- Create a dedicated role `campass_app`: `NOSUPERUSER NOBYPASSRLS NOCREATEDB
  NOCREATEROLE` with `LOGIN`. (Exact SQL + grants in [`tenancy.md`](./tenancy.md) §5.1.)
- Grant it only DML on application tables + `USAGE` on schema/sequences; no ownership,
  no DDL. Use `ALTER DEFAULT PRIVILEGES` so future tables are covered.
- The app's **runtime** `DATABASE_URL` authenticates as this role via the pooler
  (`campass_app.<project-ref>` username convention, verified working).
- **Migrations** use the privileged `postgres`/owner connection (`DIRECT_URL`), capable
  of DDL and of creating/altering RLS policies.
- **Decision 3b:** the role is created in Supabase and its credentials supplied as the
  runtime `DATABASE_URL`. The migration that introduces RLS also runs the role-creation
  SQL (idempotently) so a fresh environment is reproducible.

---

## 3. Neon → Supabase migration (runbook)

A careful, reversible move. Treat production data as precious; the live Neon DB stays
the source of truth until cutover is verified.

> Pre-req: decisions D2/D3/D4 schema changes (§5) can land **either** on Neon first then
> move, **or** as part of the Supabase cutover. Recommended: **move first onto Supabase
> with the current schema, verify parity, then apply Phase 0 schema changes via
> versioned migrations.** This separates "did the move work" from "did the refactor
> work."

### 3.1 Prepare

- [ ] Create the Supabase project; capture pooled + direct connection strings. ⚠ VERIFY
- [ ] Create/confirm the `campass_app` non-`BYPASSRLS` role (§2.2). ⚠ VERIFY
- [ ] Put `DATABASE_URL` (pooled) and `DIRECT_URL` (direct) in env for `apps/api` and
      `packages/db` (do not commit secrets; update `.env.example` only).
- [ ] Take a fresh **backup/export of Neon** (logical dump).

### 3.2 Move the schema + data

- [ ] Export from Neon with `pg_dump` (schema + data) — plain SQL or custom format.
- [ ] Import into Supabase via the **direct** connection (`DIRECT_URL`) using
      `pg_restore`/`psql`. ⚠ VERIFY any Supabase-specific pre-existing objects/roles that
      a raw restore might conflict with (e.g. Supabase-managed schemas); restore only the
      application schema (`public`) as needed.
- [ ] Verify row counts per table match Neon.

### 3.3 Switch Prisma to versioned migrations (D7)

- [ ] Replace `prisma db push --accept-data-loss` in `railway.toml`/deploy with
      `prisma migrate deploy`.
- [ ] Baseline the existing schema as the first migration so migration history starts
      clean against the restored DB (`prisma migrate resolve`/baseline flow). ⚠ VERIFY the
      exact baselining commands for an already-populated DB.
- [ ] Retire the ad-hoc `migrate-neon.ts` / `seed-neon.ts` scripts in favor of the Prisma
      migration pipeline + the maintained seed.

### 3.4 Cutover + verify

- [ ] Point a staging instance of `apps/api` at Supabase; run the app smoke tests and the
      cross-tenant escape suite ([`tenancy.md`](./tenancy.md) §7).
- [ ] Verify auth/login, session revocation, a full GatePass workflow, analytics.
- [ ] Switch production env to Supabase; keep Neon read-only as a rollback for a defined
      window.
- [ ] Decommission Neon after the rollback window closes and backups are confirmed.

### 3.5 Rollback

If cutover fails: repoint env back to Neon (kept read-only/intact), investigate, retry.
Because the move is "copy then switch," rollback is a config change, not a data recovery.

---

## 4. Migration workflow going forward (D7)

- **Never** `db push --accept-data-loss` against a database with real data.
- All schema changes are **versioned Prisma migrations** committed to the repo.
- `prisma migrate dev` locally (against docker-compose Postgres or a dev Supabase
  project); `prisma migrate deploy` in CI/CD.
- RLS policies, custom roles, composite FKs, and the `(id, institutionId)` composite
  uniques are DDL that Prisma does not model natively — include them as **raw SQL inside
  migrations** (Prisma supports custom SQL in migration files). Keep a single source of
  truth: the migration files.
- A migration that adds a tenant-owned table must, in the same migration, add its
  `institutionId`, composite FKs, and RLS policies (enforced by the checklist in
  [`tenancy.md`](./tenancy.md) §8 and a CI meta-test).

---

## 5. Phase 0 schema additions (DB-ready)

These are the structural changes Phase 0 introduces. Written here so the DB is "ready
for the future" as requested; **implemented in a later session**, not now.

### 5.1 Tenancy (from [`tenancy.md`](./tenancy.md))

- Add non-null `institutionId` to every tenant-owned table currently missing it
  (`student_profiles`, `hod_profiles`, `guard_profiles`, `gate_passes`, `gate_events`,
  `guard_gate_assignments`, `emergency_overrides`, `reliability_score_snapshots`,
  `notifications`, `audit_logs`). Backfill from the existing join.
- Add `(id, institutionId)` composite uniques to referenced tenant tables.
- Replace single-column FKs between tenant tables with **composite FKs** including
  `institutionId`.
- `ENABLE` + `FORCE` RLS and add the standard SELECT + ALL policies on every tenant-owned
  table.
- Index `institutionId` (and composite indexes where filtered alongside other columns).

### 5.2 Identity / RBAC (from [`identity-rbac.md`](./identity-rbac.md))

- `InstitutionMembership` (tenant-owned: `userId`, `institutionId`, `membershipStatus`,
  optional `departmentScope`).
- `Role` (`key`, `name`, nullable `institutionId` for platform templates).
- `Permission` (`key` = `<module>.<action>`, `module`, `description`).
- `MembershipRole` (membership ↔ role) and `RolePermission` (role ↔ permission) joins.
- `User` gains platform-wide fields (`phone`, `mfaEnabled`, `mfaSecret?`, recovery
  codes).
- Seed the five legacy enum roles as template roles; migrate each user's
  `(institutionId, role)` into a single membership + role (compatibility shim in
  [`identity-rbac.md`](./identity-rbac.md) §8).
- Optional `permissionsVersion` per membership for permission-freshness (§5.3 there).

### 5.3 Super Admin / security (from [`superadmin-security.md`](./superadmin-security.md))

- `SupportGrant` (platform table: `institutionId`, `grantedToUserId`, `purpose`,
  `scope?`, `status`, `requestedAt/activatedAt/expiresAt/revokedAt`, `revokedByUserId`,
  `revokedReason`).
- **AuditLog v2** — new `AuditEvent` table with: `institutionId?`, `actorUserId`,
  `actorMembershipId?`, `actorRoleKey`, `action` (**string**, validated against the
  catalogue — not a Postgres enum), `resourceType`, `resourceId`, `result`,
  `supportGrantId?`, `requestRef?`, `metadata` JSON, `timestamp`. Migrate/retire the old
  enum-based `audit_logs` (or map it in as history). Tenant-scoped under RLS.
- Ensure `security_events.institutionId` is reliably populated.

### 5.4 Module system (from [`architecture.md`](./architecture.md) §5)

- `ModuleEntitlement` (platform grants a module to an institution:
  `institutionId`, `moduleKey`, `status`, timestamps).
- `ModuleActivation` (institution turns it on: `institutionId`, `moduleKey`, `status`,
  config/`settings` JSON, `activatedAt`). (Entitlement + activation may be one table with
  a richer state enum — decide at implementation; the **states** in
  [`architecture.md`](./architecture.md) §5.2 are the contract.)
- A module dependency map (seed data or config) validated at activation time.

> **Do not** build Phase 1+ module tables (SIS, attendance, fees, …) in Phase 0. They
> are documented per phase in [`roadmap.md`](./roadmap.md) and added when their phase is
> built, each following the tenancy checklist.

---

## 6. Backup, recovery, reliability (placeholders to finalize)

Values are operational decisions; recorded as placeholders so they are not forgotten.

- **Backups:** Supabase automated backups ⚠ VERIFY (frequency, retention by plan) +
  periodic independent logical dumps stored off-platform. Backup access restricted.
- **RPO (max acceptable data loss):** _TBD_ (e.g. ≤ 24h via daily backup; tighter with
  PITR if the plan supports it ⚠ VERIFY).
- **RTO (max acceptable restore time):** _TBD_.
- **Restore testing:** schedule periodic test restores. *A backup never restored is not
  a proven recovery mechanism.*
- **Reliability monitoring:** API availability, error rates, DB health, migration
  failures, notification/payment-reconciliation failures (per module as they ship).

---

## 7. Checklist (DB move + Phase 0 readiness)

- [ ] Supabase project created; pooled + direct URLs captured. ⚠ VERIFY ports/modes.
- [ ] `campass_app` non-`BYPASSRLS` role in use for runtime; privileged role for
      migrations. ⚠ VERIFY.
- [ ] `datasource` uses `url` (pooled) + `directUrl` (direct).
- [ ] Data moved from Neon; row counts verified; Neon kept as rollback.
- [ ] Deploy uses `prisma migrate deploy`; `db push --accept-data-loss` removed.
- [ ] Existing schema baselined as first migration.
- [ ] RLS session-variable approach verified under the pooler.
- [ ] Phase 0 schema changes authored as versioned migrations incl. raw SQL for RLS /
      composite FKs / custom role grants.
- [ ] Backup + restore-test plan with RPO/RTO filled in.

---

## Changelog

| Date | Change |
|---|---|
| 2026-10-18 | Initial database doc: Neon→Supabase runbook, pooled/direct connection strategy, versioned-migration workflow (D7), dedicated app role, RLS/pooler interaction notes, Phase 0 schema additions (tenancy, RBAC, SupportGrant, AuditLog v2, module system), backup/RPO/RTO placeholders. Supabase specifics flagged ⚠ VERIFY. |
| 2026-10-18 | Move executed (commit `42ba4db`): on Supabase, versioned migrations live, `db push --accept-data-loss` removed. Connection strategy VERIFIED (session pooler used for `DIRECT_URL` due to IPv6-only direct host). App-role + RLS/pooler mechanics VERIFIED via spike (see tenancy.md). Remaining ⚠ VERIFY limited to backup/PITR. |
