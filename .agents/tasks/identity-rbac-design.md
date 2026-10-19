# CAMPASS Phase 0 — Identity & RBAC (B2) Technical Design

Status: implementation-ready. Repo root `c:\campusgate` (Turborepo monorepo, Windows/PowerShell). Branch `main`, no worktree. Auth-critical change.

Source of truth: `docs/identity-rbac.md` (§3–§8 built, §9 deferred), `docs/tenancy.md` (§4/§5/§8 checklist), `docs/superadmin-security.md` (platform vs tenant), `docs/database.md` (connection model), `docs/roadmap.md` (Phase 0 DoD). This document resolves the ambiguous edges those docs leave to implementation; where it is more specific than a doc, this wins for Phase 0.

Non-negotiable invariant carried from the live system: `campass_app` is `NOSUPERUSER NOBYPASSRLS`; the B-1 migration (`20261018110658_tenancy_isolation_rls`) is never edited; every tenant-owned table is RLS `ENABLE`+`FORCE` with `tenant_isolation_select` + `tenant_isolation_modify` policies keyed on `current_setting('app.current_institution_id', true)`, and is covered by the escape suite's `RLS_TABLES` meta-test.

---

## 1. Overview

Today identity is `User.institutionId` (single) + `User.role` enum (`STUDENT|HOD|GUARD|ADMIN|SUPER_ADMIN`), the JWT is `{userId, role, institutionId, jti}`, and routes guard with `requireRole`/`requireTenantRole`/`requireSuperAdmin` reading `request.user.role`. Tenant routes already run through `withTenant(institutionId, tx)`; auth-bootstrap and platform routes already run through `privilegedPrisma`.

This design introduces the membership/role/permission model and a central authorization engine, then migrates GatePass routes to permission guards **behind a compatibility shim** so the enum keeps working at every step. The move is strictly additive to the schema and strictly non-destructive to the live tenancy layer: `User.role` and `User.institutionId` are **kept** for the whole of Phase 0; no FK is dropped; no B-1 object is altered. One new versioned migration adds the RBAC tables (with the tenancy checklist applied to the tenant-owned ones), backfills one membership per user, seeds template roles + the permission catalogue, and wires the role↔permission map. The engine resolves `roles`/`permissions` at login into the JWT; the authenticate middleware (pre-tenant-context) loads membership state via `privilegedPrisma`; and `requirePermission` replaces `requireTenantRole` on GatePass routes while the shim maps the legacy enum onto the same permission sets so old guards and new guards agree during the transition.

Technology stack (LOCKED for Phase 0): PostgreSQL on Supabase; Prisma `6.19.3` (do not upgrade to the 8.x RC the deploy log advertises); Fastify + `@fastify/jwt` (HS256, 24h, per-session `jti`); TypeScript ESM across `apps/api`, `packages/db`, `packages/shared`; Zod in `@campusgate/shared`; Vitest for tests. No Redis/cache, no new external services. The permission catalogue is plain TypeScript constants in `packages/shared` (not a DB-driven registry) for Phase 0.

---

## 2. Schema additions (tenant-ownership decided per table)

All models live in `packages/db/prisma/schema.prisma`. New enums: `MembershipStatus { ACTIVE SUSPENDED }`. `User.accountStatus` already uses `AccountStatus`.

### 2.1 `User` — platform-wide, NOT tenant-owned (unchanged ownership)

`users` is already RLS-enabled under B-1 (it is tenant-owned today because every user belongs to one institution and the escape suite covers it). **We keep it exactly as is** — `role`, `institutionId`, the `(id, institutionId)` composite unique, and its RLS policies all stay. We only ADD nullable platform fields the identity model needs:

```prisma
model User {
  // ... all existing fields unchanged (role, institutionId kept for the shim) ...
  phone        String?                    // NEW schema column — the live User has none (identity-rbac §3 lists it conceptually; Phase 0 adds the actual column)
  mfaEnabled   Boolean  @default(false)   // modelled only; NOT wired this phase
  mfaSecret    String?                    // modelled only; NOT wired this phase
  memberships  InstitutionMembership[]
}
```

Rationale: the doc calls `User` platform-wide, but `users` is already an RLS tenant table in production and the authenticate/login paths already read it through `privilegedPrisma` (RLS-bypass). Flipping it to non-tenant now would mean dropping live RLS policies on a hot table for zero Phase 0 benefit and would break the escape-suite meta-test. We therefore leave `users` as-is and let the **membership** carry the tenant identity going forward. `mfaEnabled`/`mfaSecret` are modelled-only (§7 out-of-scope).

### 2.2 `InstitutionMembership` — TENANT-OWNED (RLS), full tenancy checklist

```prisma
model InstitutionMembership {
  id                 String           @id @default(cuid())
  userId             String
  institutionId      String
  membershipStatus   MembershipStatus @default(ACTIVE)
  departmentScope    String?          // optional dept limit; nullable; FK to departments(id, institutionId)
  permissionsVersion Int              @default(0)   // freshness counter (edge 2)
  createdAt          DateTime         @default(now())
  updatedAt          DateTime         @updatedAt

  user         User             @relation(fields: [userId], references: [id])
  institution  Institution      @relation(fields: [institutionId], references: [id])
  roles        MembershipRole[]

  @@unique([userId, institutionId])     // one membership per user per institution (Phase 0: one total)
  @@unique([id, institutionId])          // composite unique so children can reference it same-tenant
  @@index([institutionId])
  @@index([userId])
  @@map("institution_memberships")
}
```

Ownership = tenant-owned because a membership belongs to exactly one institution and "membership in one institution never implies another" is a tenancy invariant (identity-rbac §3). Checklist applied in the migration (§3): non-null `institutionId`; composite FK `(userId, institutionId) -> users(id, institutionId)` (`ON DELETE RESTRICT`, targeting the parent unique `users_id_institutionId_key` — added by B-1, present); composite FK `(departmentScope, institutionId) -> departments(id, institutionId)` (`ON DELETE RESTRICT`, MATCH SIMPLE, nullable, targeting the parent unique `departments_id_institutionId_key` — added by B-1, present — see delete-action decision below); `(id, institutionId)` composite unique; `institutionId -> institutions(id)` single-column tenant-root FK; index on `institutionId`; RLS ENABLE+FORCE + both standard policies; added to escape-suite `RLS_TABLES`.

**Delete-action decision for the `(departmentScope, institutionId)` composite FK (finding #1).** This is the one composite FK the design adds that B-1 did not already prove, and it must NOT use plain `ON DELETE SET NULL`. `institution_memberships.institutionId` is `NOT NULL` (the tenant key, set `NOT NULL` in §3.1 step 4). In PostgreSQL, `ON DELETE SET NULL` **without an explicit column list nulls every referencing column**, so deleting a referenced `departments` row would try to set `institution_memberships.institutionId = NULL` and abort against the `NOT NULL` constraint — wedging department deletion for any institution that has a membership with a `departmentScope`. PG15 does support the column-scoped form `ON DELETE SET NULL ("departmentScope")`, but there is no in-repo precedent for it, and the one B-1 composite FK that uses `SET NULL` (`gate_passes_approvedBy_same_tenant_fkey`, `(approvedById, institutionId) -> hod_profiles`) carries the identical latent hazard on its own NOT NULL `institutionId` leg (frozen, out of scope to change). To stay consistent with B-1's otherwise-uniform `ON DELETE RESTRICT` and avoid a syntax with no precedent, **this FK uses `ON DELETE RESTRICT`** (every other B-1 composite FK is `RESTRICT`). The application MUST clear `institution_memberships.departmentScope` (set it to NULL) for any membership scoped to a department **before** that department is deleted; a department delete that still has memberships pointing at it is rejected by the FK (fail-closed, not a silent tenant-key corruption). Phase 0 has no department-delete admin path that touches `departmentScope` (department management is `admin.departments.manage`, GET/POST only per §4 — no DELETE), so no pre-clear code is wired now; the constraint simply guarantees the invariant can never be violated silently. Plain `SET NULL` is explicitly NOT nullable-safe for a composite FK with a NOT NULL leg and is not used here.

FK enforcement note: Postgres enforces foreign keys at the table-owner level, **not** subject to RLS row visibility, so `departments` staying RLS `ENABLE`+`FORCE` (B-1 §7) does not affect this constraint and no change to `departments` RLS is implied or needed. MATCH SIMPLE is chosen deliberately: under MATCH SIMPLE the composite check is skipped whenever *any* FK column is NULL, and since `institutionId` is never NULL the check is skipped exactly when `departmentScope` is NULL — the intended "no department limit" case. MATCH FULL would instead reject a NULL `departmentScope` paired with a non-NULL `institutionId`, which is wrong for this optional scope, so MATCH SIMPLE is the correct and load-bearing choice.

### 2.3 `Permission` — GLOBAL, NOT tenant-owned, no RLS

```prisma
model Permission {
  id          String           @id @default(cuid())
  key         String           @unique   // "<module>.<resource?>.<action>"
  module      String
  description String
  roleLinks   RolePermission[]
  @@index([module])
  @@map("permissions")
}
```

Ownership = global. Permissions are the platform vocabulary (identity-rbac §6), identical across all institutions, seeded from the `packages/shared` catalogue. No `institutionId`, no RLS. Read via `privilegedPrisma` only (it is read pre-tenant-context at login / seed time).

### 2.4 `Role` — PLATFORM TEMPLATE (`institutionId` null) OR TENANT-OWNED (`institutionId` set)

```prisma
model Role {
  id            String           @id @default(cuid())
  key           String                      // "STUDENT","HOD","GUARD","ADMIN","SUPER_ADMIN","LIBRARIAN"...
  name          String
  institutionId String?                     // NULL = platform template; set = institution-custom
  institution   Institution?     @relation(fields: [institutionId], references: [id])
  permissions   RolePermission[]
  memberships   MembershipRole[]
  @@unique([key, institutionId])            // one "HOD" template globally; one "HOD" per institution if customised
  @@index([institutionId])
  @@map("roles")
}
```

Ownership = **dual, and deliberately NOT RLS-protected in Phase 0.** All five Phase 0 roles are platform templates (`institutionId = null`). The schema allows institution-custom roles (`institutionId` set) for later phases, but Phase 0 seeds **only templates** and never creates a tenant-owned role (self-service role editing is deferred, §9 of the doc / §7 here).

Decision — Role is NOT made an RLS table in Phase 0, even though it can hold an `institutionId`. Reasons: (a) every Phase 0 role is a template with `institutionId = null`, and an RLS `USING institutionId = current_setting(...)` policy evaluates null against `=` → fail-closed → **no template role would ever be visible**, breaking login resolution; (b) roles are resolved at login inside `privilegedPrisma` (pre-tenant-context), never inside a `withTenant` transaction, so RLS would add no protection on the path that actually reads them; (c) roles carry no tenant PII. When tenant-custom roles are built in a later phase, that phase adds a partial RLS policy (`institutionId IS NULL OR institutionId = current_setting(...)`) and extends the escape suite then — explicitly out of scope now. `Role` is therefore read only via `privilegedPrisma`.

### 2.5 `MembershipRole` — TENANT-OWNED (RLS), full tenancy checklist

```prisma
model MembershipRole {
  id            String                 @id @default(cuid())
  membershipId  String
  roleId        String
  institutionId String                 // denormalised tenant of the membership
  createdAt     DateTime               @default(now())
  updatedAt     DateTime               @updatedAt
  membership    InstitutionMembership  @relation(fields: [membershipId], references: [id])
  role          Role                   @relation(fields: [roleId], references: [id])
  @@unique([membershipId, roleId])
  @@index([institutionId])
  @@map("membership_roles")
}
```

Ownership = **tenant-owned (RLS).** It references a tenant-owned `InstitutionMembership`, so by the tenancy checklist it must carry `institutionId` and a **composite FK** `(membershipId, institutionId) -> institution_memberships(id, institutionId)` so a membership-role can never bind to another tenant's membership. It does **not** get a composite FK to `roles` (Role is global/template, has no stable `(id, institutionId)` to reference) — the `roleId` FK stays single-column, which is correct because template roles are shared. `createdAt`/`updatedAt` are carried for audit parity with the other new models. RLS ENABLE+FORCE + both policies; index on `institutionId`; added to `RLS_TABLES`. **No `@@unique([id, institutionId])` is added**: that composite unique exists only to be the target of a child's composite FK, and in Phase 0 nothing references `membership_roles` as a composite-FK parent. A later phase that adds such a child must add the composite unique then.

### 2.6 `RolePermission` — GLOBAL, NOT tenant-owned, no RLS

```prisma
model RolePermission {
  id           String     @id @default(cuid())
  roleId       String
  permissionId String
  role         Role       @relation(fields: [roleId], references: [id])
  permission   Permission @relation(fields: [permissionId], references: [id])
  @@unique([roleId, permissionId])
  @@map("role_permissions")
}
```

Ownership = global. It joins two global/template entities (`Role` template + `Permission`); a template role's permission set is the same for every institution. No `institutionId`, no RLS, read via `privilegedPrisma`. (When tenant-custom roles arrive later, their `RolePermission` rows still join a role scoped by the role's own `institutionId`; a later phase decides whether to tenant-scope this join — not now.)

### 2.7 Ownership summary

| Table | Ownership | RLS? | In `RLS_TABLES` / escape suite? | Composite FKs added |
|---|---|---|---|---|
| `users` (modified) | tenant-owned (unchanged) | yes (unchanged) | yes (already) | unchanged |
| `institution_memberships` | tenant-owned | **yes (new)** | **add** | `(userId,instId)->users` (RESTRICT), `(departmentScope,instId)->departments` (RESTRICT, MATCH SIMPLE, nullable — not SET NULL, see §2.2) |
| `membership_roles` | tenant-owned | **yes (new)** | **add** | `(membershipId,instId)->institution_memberships` |
| `permissions` | global | no | no | none |
| `roles` | platform template / future tenant-custom | no (Phase 0) | no | none |
| `role_permissions` | global | no | no | none |

---

## 3. Migration + backfill + seed plan

One new versioned migration, hand-authored SQL (Prisma does not model composite FKs / RLS / GRANTs), created via `pnpm --filter @campusgate/db exec prisma migrate dev --name identity_rbac_b2` then the generated SQL replaced with the ordered script below. Deploy runs `prisma migrate deploy` (migrations execute as `postgres` via `DIRECT_URL`, per database.md). **Never** `db push`. The new tenant tables get their RLS + GRANTs **in this same migration** (database.md §4 rule). The migration must be reproducible on a fresh DB, so seeding of templates/permissions is done by the maintained `packages/db/src/seed.ts` (idempotent upserts), while the **backfill of existing users → memberships** runs as SQL inside the migration (it depends on live data, not seed data).

### 3.1 Migration SQL ordering (load-bearing)

1. `CREATE TABLE` for `permissions`, `roles`, `role_permissions`, `institution_memberships`, `membership_roles` (columns per §2; `institutionId` on the two tenant tables created **NULLABLE** initially so backfill can run).
2. Single-column FKs: `membership_roles.roleId -> roles(id)`; `role_permissions.roleId -> roles(id)`, `role_permissions.permissionId -> permissions(id)`; `institution_memberships.institutionId -> institutions(id)`; `roles.institutionId -> institutions(id)`.

   **2a. Template-role uniqueness (finding #6).** A plain `UNIQUE("key","institutionId")` does NOT prevent two `('HOD', NULL)` template rows in Postgres (NULLs are distinct under a standard unique index), and a Prisma composite `upsert` through a NULL column can insert a duplicate rather than match. Because the shim requires exactly one template role per key, add a **partial unique index** in this migration:
   ```sql
   CREATE UNIQUE INDEX "roles_key_template_unique" ON "roles" ("key") WHERE "institutionId" IS NULL;
   ```
   Keep the Prisma `@@unique([key, institutionId])` (constraint `roles_key_institutionId_key`) for the future tenant-custom case. The seed and any template lookup resolve templates via `findFirst({ where: { key, institutionId: null } })` + create-if-absent, never a NULL composite upsert (§3.2).

   **2b. Seed the template roles, permission catalogue, and role→permission map IN THE MIGRATION** (so the step-3c backfill join has something to join to without the seed script). **Intra-step insert order is load-bearing (finding #6)** and MUST be: (i) `permissions` FIRST (the permission catalogue rows from §4, `ON CONFLICT (key) DO NOTHING`); (ii) `roles` next (the five template roles, `institutionId = NULL`, deterministic ids, `ON CONFLICT DO NOTHING` against `roles_key_template_unique`); (iii) `role_permissions` LAST (the §5 links, `ON CONFLICT (roleId, permissionId) DO NOTHING`) — `role_permissions` has single-column FKs to **both** `roles` and `permissions` (added in step 2), so it must be inserted after both or the FK insert fails. These are global/template tables (no RLS), so plain inserts as `postgres` are correct. The seed script repeats these as idempotent upserts for fresh/dev DBs.

   **Enforced sync between the migration SQL and the TypeScript catalogue (finding #3).** The in-migration `INSERT` block is a hand-transcribed, frozen copy of `packages/shared/src/permissions.ts` (§4) + the §5 role→permission map; `migration.sql` cannot *derive* from a TypeScript `as const` array, and once applied it is immutable. Without a mechanism, a later edit to `permissions.ts` or the §5 map that is not mirrored into this migration would leave a freshly-migrated DB (before the seed runs) resolving permissions from a stale set — the exact catalogue drift this design is otherwise careful about. "Both derive from the same source" is therefore replaced by an **enforced sync**: a CI meta-test (same class of CI meta-test the escape suite already relies on for RLS) parses the permission keys and the `(roleKey, permissionKey)` pairs embedded in this migration's `migration.sql` and asserts they are **set-equal** to the set derived from `PERMISSIONS` (imported from `@campusgate/shared`) plus the §5 `ROLE_PERMISSIONS` map, failing the build on any drift. The test is pinned to this specific migration file by name (it only guards the Phase-0 catalogue migration; later catalogue additions ship as new migrations with their own rows and the test is updated to union them). This test is a required deliverable (§9/§11). The seed uses the same `@campusgate/shared` source directly, so once the meta-test is green all three — migration SQL, seed, and signed-token permission resolution — provably agree.
3. **Backfill memberships (3a) and membership-roles (3c)** for existing users.

   **3a.** One `ACTIVE` membership per existing tenant user. **Id format: `gen_random_uuid()::text` with a `mbr_` prefix.** `gen_random_uuid()` is a core `pg_catalog` function on Postgres 13+ (verified available on the target Supabase instance — `pgcrypto` and `uuid-ossp` are additionally confirmed installed by a live query on the instance, though that is not load-bearing since core `pg_catalog` availability is sufficient), so **no `CREATE EXTENSION` line is added to this migration**. Note on id style: every existing table (and every new RBAC model in §2) defaults its id to **cuid generated by Prisma** (`@default(cuid())`), **not** a DB-level function — there is no `gen_random_uuid()` default or `dbgenerated(...)` anywhere in the schema today. This backfill deliberately mints ids in **raw SQL** instead (ordinary application inserts into these tables keep `@default(cuid())`), and `gen_random_uuid()::text` with a `mbr_`/`mrl_` prefix is a collision-safe, homogeneous choice for these migration-inserted rows. The two id styles on one column — `gen_random_uuid()::text` for the one-time migration backfill rows, cuid for all later Prisma inserts — is a documented, intentional split, not an accident; no DB-level id default is added to the new tables. Nothing references these rows by a client-known value, so cuid parity is unnecessary.
   ```sql
   INSERT INTO "institution_memberships" ("id","userId","institutionId","membershipStatus","permissionsVersion","createdAt","updatedAt")
   SELECT 'mbr_' || gen_random_uuid()::text, u."id", u."institutionId", 'ACTIVE', 0, now(), now()
   FROM "users" u
   WHERE u."role" <> 'SUPER_ADMIN'
     AND u."institutionId" <> (SELECT "id" FROM "institutions" WHERE "code" = 'PLATFORM');
   ```
   SUPER_ADMIN users are **excluded** — they get no tenant membership (superadmin-security §2/§3). The second predicate **also excludes any non-superadmin user attached to the PLATFORM institution** (finding #11): excluding only `role <> 'SUPER_ADMIN'` would mint a tenant membership into the platform institution if such a user ever existed. Both predicates are applied so the backfill is correct regardless of role↔institution drift. (If `code = 'PLATFORM'` returns no row on a fresh DB with no platform institution, the subquery is NULL and `<> NULL` excludes nothing — acceptable, because then no user sits on PLATFORM anyway.)

   **3c.** Attach exactly one membership-role per membership, binding each user's legacy `role` enum to the matching template role created in step 2b:
   ```sql
   INSERT INTO "membership_roles" ("id","membershipId","roleId","institutionId")
   SELECT 'mrl_' || gen_random_uuid()::text, m."id", r."id", m."institutionId"
   FROM "institution_memberships" m
   JOIN "users" u ON u."id" = m."userId"
   JOIN "roles"  r ON r."key" = u."role"::text AND r."institutionId" IS NULL;
   ```
   This joins `users.role` → the template `roles.key` (`institutionId IS NULL`), so a migrated DB resolves every tenant user's permissions with no seed dependency. `institutionId` is denormalised from the membership. The `membership_roles.institutionId` is set here (non-null) so step 4's `SET NOT NULL` holds.
4. `ALTER TABLE ... SET NOT NULL` on `institution_memberships.institutionId` and `membership_roles.institutionId` after backfill; a `DO $$ ... RAISE EXCEPTION` guard (mirroring B-1 §2b) fails loudly if any membership row has a null tenant, and a second guard asserts every membership has **exactly one** membership-role.

   **Exactly-one guard SQL + message (finding #5).** The prose "exactly one membership-role per membership" must be enforced as exactly one, not merely "at least one" — a `NOT EXISTS` check only catches zero-role memberships and would pass silently for a membership that somehow got two roles (e.g. a future re-run or data quirk). The guard therefore counts memberships whose membership-role count is `<> 1` and aborts with an actionable, row-identifying message mirroring B-1's descriptive `RAISE EXCEPTION`:
   ```sql
   DO $$
   DECLARE bad_count bigint; sample_id text; sample_n bigint;
   BEGIN
     SELECT count(*) INTO bad_count FROM (
       SELECT m."id" AS mid, count(mr."id") AS n
       FROM "institution_memberships" m
       LEFT JOIN "membership_roles" mr ON mr."membershipId" = m."id"
       GROUP BY m."id" HAVING count(mr."id") <> 1
     ) x;
     IF bad_count > 0 THEN
       SELECT mid, n INTO sample_id, sample_n FROM (
         SELECT m."id" AS mid, count(mr."id") AS n
         FROM "institution_memberships" m
         LEFT JOIN "membership_roles" mr ON mr."membershipId" = m."id"
         GROUP BY m."id" HAVING count(mr."id") <> 1
         LIMIT 1
       ) y;
       RAISE EXCEPTION 'identity_rbac_b2 backfill invariant violated: % membership(s) do not have exactly one membership-role (e.g. membershipId=% has % role(s)); aborting deploy', bad_count, sample_id, sample_n;
     END IF;
   END $$;
   ```
   Because the backfill (step 3a/3c) mints exactly one membership per non-superadmin user and exactly one membership-role per membership, a correct run leaves `bad_count = 0`. A membership that matched no template role (count 0) or somehow got two (count 2) fails the deploy loudly with the offending `membershipId` and count, rather than shipping a fail-closed auth hole or a silent over-grant.
5. `(id, institutionId)` composite uniques: `institution_memberships_id_institutionId_key`. Composite FKs (each naming its existing parent unique): `institution_memberships(userId,institutionId)->users(id,institutionId)` (`ON DELETE RESTRICT`, target `users_id_institutionId_key` — B-1, present), `institution_memberships(departmentScope,institutionId)->departments(id,institutionId)` (`ON DELETE RESTRICT`, MATCH SIMPLE, nullable, target `departments_id_institutionId_key` — B-1, present — **not** `SET NULL`: a plain composite `SET NULL` would null the NOT NULL `institutionId` leg and abort department deletes; `RESTRICT` matches B-1's uniform convention and the app clears `departmentScope` before a department delete, per §2.2 finding #1), `membership_roles(membershipId,institutionId)->institution_memberships(id,institutionId)` (`ON DELETE RESTRICT`). FK enforcement is owner-level and unaffected by `departments`' RLS; MATCH SIMPLE skips the check only when `departmentScope` is NULL (§2.2). Plain unique `membership_roles(membershipId,roleId)`, `institution_memberships(userId,institutionId)`.
6. Indexes on `institutionId` for both tenant tables and `userId` on memberships; `permissions.module`; `roles.institutionId`.
7. RLS: reuse the exact B-1 `DO $$ FOREACH` pattern but over `ARRAY['institution_memberships','membership_roles']` — `ENABLE`+`FORCE` + `tenant_isolation_select` + `tenant_isolation_modify` keyed on `current_setting('app.current_institution_id', true)`.
8. GRANTs: reuse the exact B-1 idempotent `DO $$ IF EXISTS (pg_roles ... 'campass_app')` block so `campass_app` gets DML on the new tables (ALTER DEFAULT PRIVILEGES already covers future tables, but re-grant explicitly to be safe). **Never** create the role or set a password; **never** grant BYPASSRLS.

The membership→role link for **existing users is created inside this migration** (step 3c below), NOT deferred to the seed. Reason (verified against `database.md` §3.3): the deploy pipeline swaps `prisma db push` for `prisma migrate deploy`; the seed is NOT stated to run in the same deploy step, so coupling an auth-critical backfill to a separate seed process would leave every migrated GatePass route 403-ing all tenant users in any environment where the seed did not run (§7 flips those routes to `requirePermission`, and a membership with no roles resolves to empty `permissions` → fail-closed deny). Creating the memberships AND their membership-roles in the migration makes a migrated DB self-consistent for the auth path with no deploy window. The migration seeds the **template roles and the permission catalogue it needs for the backfill join** as part of its SQL (step 2b below); the `packages/db/src/seed.ts` script remains idempotent and covers fresh/dev DBs and demo users, but deploy correctness no longer depends on it.

### 3.2 Seed plan (`packages/db/src/seed.ts`, idempotent, extends existing)

The migration (§3.1 steps 2b/3a/3c) is the source of correctness for deploy; the seed is now responsible for **fresh/dev databases built from `migrate deploy` with no pre-existing user rows** and for the **demo users** the seed itself creates. Everything the seed does is idempotent and safe to re-run on top of a migrated DB.

- Upsert the **catalogue permissions** from `@campusgate/shared` (§4) — `prisma.permission.upsert({ where: { key }, ... })` for every entry (matches the migration's `ON CONFLICT (key) DO NOTHING` rows).
- Resolve the **five template roles** (`institutionId: null`) with **find-first-then-create, NOT a NULL composite upsert** (finding #6): `const existing = await prisma.role.findFirst({ where: { key, institutionId: null } }); if (!existing) await prisma.role.create({ data: { key, name, institutionId: null } });`. A composite `upsert` through `institutionId: null` can insert a duplicate under Postgres NULL semantics; the partial unique index `roles_key_template_unique` (§3.1 step 2a) would then reject the second insert, so the find/create keeps the seed idempotent and never trips the index. `STUDENT`, `HOD`, `GUARD`, `ADMIN` are tenant-usable templates; `SUPER_ADMIN` is a **platform** role (template, never attached to any tenant membership).
- Upsert `role_permissions` from the template→permission map (§5) — for each template role, link exactly its mapped permission keys (`upsert` on `(roleId, permissionId)`).
- For each seeded demo user, ensure a membership (idempotent `upsert` on `(userId, institutionId)`), then `membership_roles.upsert` on `(membershipId, roleId)` binding to the template role matching the user's `user.role` enum — **except** `superadmin@campusgate.local`, which gets **no** membership and **no** membership-role.
- Existing seeded users (`admin@demo.edu`, `hod.bca@demo.edu`, `guard@demo.edu`, `bhavishya@demo.edu`) keep their `role` enum (shim depends on it) and additionally gain a membership + membership-role. `superadmin@campusgate.local` stays platform-only.

Verification after migrate (and again after seed on a fresh DB): membership count == non-superadmin, non-PLATFORM user count; every membership has exactly one membership-role (also asserted by the §3.1 step-4 guard inside the migration itself); superadmin has zero memberships; `SELECT count(*)` of each new RLS table shows the B-1 meta-test (escape suite test 6) passes once `RLS_TABLES` is extended.

---

## 4. Permission catalogue (location + keys derived from real routes)

Location: `packages/shared/src/permissions.ts`, re-exported from `packages/shared/src/index.ts`. Plain `as const` TypeScript so both `apps/api` (engine, seed) and future `apps/web` share one registry. Shape:

```ts
export interface PermissionDef { key: string; module: string; description: string; }
export const PERMISSIONS = [ /* entries below */ ] as const satisfies readonly PermissionDef[];
export type PermissionKey = (typeof PERMISSIONS)[number]["key"];
export const PERMISSION_KEYS = PERMISSIONS.map(p => p.key);
```

Campus Movement module key = `campus_movement`. Keys derived from the actual routes read (`student.ts`, `hod.ts`, `guard.ts`, `admin.ts`, `platform.ts`):

**`campus_movement.*` (student + pass lifecycle + guard gate ops + emergency):**
- `campus_movement.pass.request` — student creates a gate pass (`POST /student/gate-pass`).
- `campus_movement.pass.cancel` — student cancels own pending pass (`POST /student/gate-pass/:id/cancel`).
- `campus_movement.pass.view_own` — student dashboard/active-pass/history/timeline/summary/reliability/allowance (`GET /student/*`).
- `campus_movement.pass.view_department` — HOD views department requests/detail/timeline/summary/stats (`GET /hod/requests*`, `/hod/stats`).
- `campus_movement.pass.approve` — HOD approves (`POST /hod/approve`).
- `campus_movement.pass.reject` — HOD rejects (`POST /hod/reject`).
- `campus_movement.pass.revoke` — HOD and Admin revoke (`POST /hod/revoke`, `POST /admin/passes/:id/revoke`). **High-risk → a true per-action DB re-check + step-up is a deferred Phase 0 gap (§6.4, §10); Phase 0 enforces it as a normal `requirePermission` set check.**
- `campus_movement.pass.override` — emergency override (`POST /hod/emergency-override`, `POST /admin/emergency-override`).
- `campus_movement.gate.verify` — guard verifies QR (`POST /guard/verify`).
- `campus_movement.gate.mark_exit` — guard marks exit (`POST /guard/mark-exit`).
- `campus_movement.gate.mark_return` — guard marks return (`POST /guard/mark-return`).
- `campus_movement.gate.lookup` — guard manual lookup / activity (`GET /guard/lookup`, `/guard/activity`).
- `campus_movement.shift.manage_own` — guard start/end own shift, view current (`POST /guard/shift/start|end`, `GET /guard/shift/current`).
- `campus_movement.emergency.view` — view active emergency (student/hod/guard/admin `GET /emergency/active`).
- `campus_movement.emergency.declare` — admin declares (`POST /admin/emergency/declare`). **High-risk → per-action DB re-check + step-up deferred (§6.4, §10); Phase 0 enforces it as a normal `requirePermission` set check.**
- `campus_movement.emergency.resolve` — admin resolves (`POST /admin/emergency/:id/resolve`).
- `campus_movement.analytics.view` — admin dashboard stats + analytics (`GET /admin/stats`, `/admin/analytics`).
- `campus_movement.audit.view` — admin reads audit logs (`GET /admin/audit-logs`).

**Admin configuration/identity actions (institution administration — `admin.*`):**
- `admin.users.view` / `admin.users.create` / `admin.users.approve` / `admin.users.deactivate` / `admin.users.reactivate` — `/admin/users*`.
- `admin.students.import` / `admin.students.export` — `/admin/students/bulk-import`, `/admin/students/export(.xlsx)`. **Export is authorized + audited.**
- `admin.departments.manage` — `/admin/departments` GET/POST.
- `admin.gates.manage` — `/admin/gates*` GET/POST + gate health.
- `admin.shifts.manage` — `/admin/guard-shifts` GET/POST (shift scheduling, `createGuardShiftSchema`).
- `admin.reasons.manage` — `/admin/reasons` GET/POST.
- `admin.allowance_policy.manage` — `/admin/allowance-policy` GET/PUT.
- `admin.institution_config.manage` — `/admin/institution-config` GET/PUT.
- `admin.academic_calendar.manage` — `/admin/academic-calendar*` GET/PUT/DELETE.

**Platform permissions (SUPER_ADMIN only; NOT tenant permissions — superadmin-security §2):**
- `platform.institutions.manage` — `/platform/institutions*` list/create/status (`platform.ts`).
- `platform.analytics.view` — `/platform/stats` (aggregates only).
- (`platform.onboarding`, `platform.entitlements.manage`, `platform.subscriptions.manage`, `platform.support.grant`, `platform.security.respond` are catalogued as keys for the SUPER_ADMIN platform role but their routes land in the Super Admin & module phases — included in the catalogue so the SUPER_ADMIN role maps cleanly; their enforcement arrives with those phases.)

These keys are the Phase 0 catalogue. New modules extend `PERMISSIONS` (roadmap phase-completion gate).

---

## 5. Template role → permission map (the shim's backbone)

Seeded `role_permissions`. These are chosen so **every current enum check maps exactly onto the permissions the role already exercises** — the shim (§8) resolves the enum to this same set, so no existing route loses or gains access on day one.

This map is the single machine-readable source of truth for the role→permission relationship. It lives beside the catalogue in `packages/shared/src/permissions.ts` as `export const ROLE_PERMISSIONS: Record<string, readonly PermissionKey[]>` (keys = the five template role keys; values = the permission keys below), re-exported from `index.ts`. The seed (§3.2), the login resolver (§6.1), and the CI catalogue-sync meta-test (§3.1 step 2b, finding #3) all read `ROLE_PERMISSIONS`; the in-migration `role_permissions` `INSERT` (§3.1 step 2b) is the hand-transcribed copy the meta-test checks against it. The permission lists below ARE `ROLE_PERMISSIONS`.

- **STUDENT** → `campus_movement.pass.request`, `.pass.cancel`, `.pass.view_own`, `.emergency.view`.
- **GUARD** → `campus_movement.gate.verify`, `.gate.mark_exit`, `.gate.mark_return`, `.gate.lookup`, `.shift.manage_own`, `.emergency.view`.
- **HOD** → `campus_movement.pass.view_department`, `.pass.approve`, `.pass.reject`, `.pass.revoke`, `.pass.override`, `.emergency.view`.
- **ADMIN** → all `admin.*` keys, plus `campus_movement.pass.revoke`, `.pass.override`, `.emergency.declare`, `.emergency.resolve`, `.emergency.view`, `.analytics.view`, `.audit.view`.
- **SUPER_ADMIN** (platform role) → all `platform.*` keys. **No `campus_movement.*` or `admin.*`** — it has zero standing tenant access, matching the live `requireTenantRole` rejection of SUPER_ADMIN.

---

## 6. JWT shape, authenticate pipeline, and the central engine

### 6.1 Target JWT + legacy-claim transition (edge 1)

During the transition the token carries **both** shapes. This is the canonical signed payload, and it is identical in §6.2, §6.3, §11 (payload types), and §12:

```
{ userId, membershipId, institutionId, roles, permissions, permissionsVersion, role, jti }
```

- `membershipId` — the user's single active membership (null for SUPER_ADMIN, who has no membership; platform routes don't read it).
- `institutionId` — derived from the membership. For SUPER_ADMIN it is `user.institutionId` (the PLATFORM institution), carried **for logging only** and NEVER fed to `app.current_institution_id` (§6.3 invariant). For a tenant actor it is the membership's institution and is the ONLY source fed to `app.current_institution_id`.
- `roles` — resolved role keys for the membership (e.g. `["HOD"]`); for SUPER_ADMIN, `["SUPER_ADMIN"]`.
- `permissions` — resolved permission-key array for the membership's roles, computed at login via the shared `resolvePermissions(roles)` helper (§6.2 step 2): it flattens `roles[].role.permissions[].permission.key` into a **de-duplicated, sorted** array. The same helper serves the authenticate re-resolve path, so the token set and any re-resolved set are byte-identical (finding #4). `roles` is likewise de-duplicated and sorted for stable comparison.
- `permissionsVersion` — the membership's `permissionsVersion` integer at login, compared in `authenticate` for freshness (edge 2, §6.2). For SUPER_ADMIN (no membership) it is `null` (there is no membership version to track; the platform permission set is static and the freshness check is skipped for the super-admin branch).
- `role` — the **retained legacy enum claim** (identity-rbac §8). Kept so `requireRole`/`requireTenantRole`/`requireSuperAdmin` continue to function unchanged for any route not yet migrated.
- `jti` — unchanged session-revocation mechanism.

Coexistence rule: login (`auth.ts`) populates all fields; migrated routes read `permissions`; un-migrated routes read `role`; the shim (§8) guarantees the two never disagree because both derive from the same template-role map. **Removal of the legacy `role` claim is a LATER step, not this one** — it happens only after *every* route uses `requirePermission` and nothing reads `request.user.role`. Phase 0 leaves `role` in the token and in `users`.

Token size: `permissions` for the largest role (ADMIN, ~20 keys) is well under JWT/header limits; no compression needed.

### 6.2 Permission freshness (edge 2) — DECISION

Chosen strategy: **short token (existing 24h) + a `permissionsVersion` integer on the membership, checked cheaply in `authenticate`, combined with session revocation on sensitive changes.** Justification: the JWT already carries resolved `permissions` for hot-path speed; the risk is a stale token after an admin edits a role. We:

1. Stamp the membership's current `permissionsVersion` into the token at login as the top-level `permissionsVersion` claim of the canonical signed payload (§6.1). SUPER_ADMIN has no membership, so its token carries `permissionsVersion: null` and this check does not apply.
2. In `authenticate`, the membership load (already happening, §6.3) selects `permissionsVersion`; if the token's `permissionsVersion` claim `!=` the membership's current version, treat the token's `permissions` as stale and **re-resolve** from the DB (via `privilegedPrisma`) for this request, overwriting `request.auth.permissions`. This is one extra integer compare on an already-fetched row — no extra round-trip in the common (matching) case. For a super-admin request (`permissionsVersion === null`, no membership), the compare is skipped entirely.

   **Re-resolution must yield a byte-identical set to login (finding #4).** The re-resolve path flattens `roles[].role.permissions[].permission.key` into a **de-duplicated, sorted** (`[...new Set(keys)].sort()`) array, which is exactly the same normalization the login-time resolver in §6.1 applies when it computes the `permissions` claim. Both paths therefore produce byte-identical arrays for the same underlying roles — a multi-role user whose roles share a permission gets one copy, in stable order, whether the token fast-path or the re-resolve path serves the request. Making both paths go through one shared normalization helper (a single `resolvePermissions(roles)` function used by login and by the re-resolve branch) is the concrete way to guarantee this; the design requires that single helper rather than two independent flatten sites.
3. On a sensitive permission/role change (future admin UI, deferred), the writer increments `membership.permissionsVersion` **and** may revoke affected sessions (reusing `jti`), forcing a fresh login. Phase 0 has no self-service role editing, so the increment path is dormant but the mechanism is in place and cheap.

Rejected alternatives: pure session-revoke-only (forces re-login for every change, too blunt); pure short-token-no-version (up to 24h of stale permissions on a privilege *reduction* — unacceptable for an auth-critical system). The version check closes the reduction gap immediately while keeping the hot path a set lookup.

### 6.3 Authenticate middleware pipeline (edge 3) — uses `privilegedPrisma`, never `withTenant`

`apps/api/src/middleware/auth.ts`. The membership/role/permission reads happen **before** any tenant context exists (the middleware is what *derives* `institutionId`), so they MUST run on `privilegedPrisma` — identical to how the middleware already loads the session + user today, and consistent with B-2. Running them inside `withTenant` would be a chicken-and-egg (no tenant set yet) and, worse, `institution_memberships`/`membership_roles` are RLS tables that would fail-closed (zero rows) without a tenant GUC. This is stated explicitly and is load-bearing.

Pipeline (extends the current one, keeping every existing check):

```
jwtVerify (signature, expiry)                                   [existing]
  -> if jti: session exists && !revoked (privilegedPrisma)      [existing, kept]
  -> load user: accountStatus ACTIVE? (privilegedPrisma)        [existing, kept]
  -> institution.status ACTIVE? (not SUSPENDED)                 [existing, kept]
  -> NEW: if not SUPER_ADMIN: load membership by (userId, institutionId) via privilegedPrisma,
          select { id, membershipStatus, permissionsVersion, roles -> role.key, role.permissions.permission.key };
          membershipStatus ACTIVE? else 403.
  -> NEW: permissionsVersion check (§6.2): token.version != db.version -> re-resolve permissions from the loaded rows.
  -> NEW: attach request.auth = { userId, membershipId, institutionId, roles, permissions, permissionsVersion }
  -> TENANT ACTOR ONLY: attach request.tenant = { institutionId }   (the value withTenant consumes)
  -> keep request.user = { userId, role (legacy), institutionId, jti }  so old guards still read it
```

**SUPER_ADMIN tenant-context invariant (load-bearing).** A SUPER_ADMIN request MUST NOT enter `withTenant` and MUST NOT have `request.tenant` set. Verified against `packages/db/src/seed.ts`: `superadmin@campusgate.local` is created with `institutionId = platformInstitution.id` (the `code: "PLATFORM"` institution) — it is a **real, resolvable institution id, not null**. If that id were ever fed to `app.current_institution_id`, a tenant-scoped query would silently scope to the PLATFORM institution's rows — a cross-tenant hole that contradicts `superadmin-security.md` §2/§3 ("zero standing tenant access"). The PLATFORM institution id is therefore NEVER used as a tenant GUC.

Concretely, for SUPER_ADMIN (no membership):
- `request.auth = { userId, membershipId: null, institutionId: <PLATFORM id>, roles: ["SUPER_ADMIN"], permissions: <platform keys>, permissionsVersion: null }`. The `institutionId` here is retained **for logging/audit only**.
- `request.tenant` is left **`undefined`** — it is NOT set for super admins. The membership load and the `permissionsVersion` compare are skipped (there is no membership).
- `request.user.role = "SUPER_ADMIN"` as today. Platform routes keep using `privilegedPrisma` and `requireSuperAdmin`, so no GUC is ever read on a super-admin surface.

**Enforcement of the invariant — the honest Phase-0 posture (finding #1).** There is deliberately NO claim of a gate "at the `withTenant` call site": verified against `packages/db/src/index.ts`, `withTenant(institutionId, fn)` is an **exported standalone function** with no access to `request`, `request.tenant`, or `request.auth` — its tenant id is passed by each handler from a local `const { institutionId } = request.user` (e.g. `guard.ts`). There is no single "tenant-transaction wiring in the request pipeline" where a role assertion could live, so the design does not assert one. The invariant is instead enforced by three mechanisms that are **already true** of the code, layered defense-in-depth:

1. **`requireSuperAdmin()` keeps platform routes OFF tenant routes.** Platform routes (`platform.ts`) are gated by `requireSuperAdmin()` and use `privilegedPrisma`; they never call `withTenant`. A SUPER_ADMIN operates only on this surface.
2. **`requirePermission` 403s a SUPER_ADMIN on every migrated tenant route.** A SUPER_ADMIN holds **no tenant membership** and therefore **no `campus_movement.*` / `admin.*` permission** (§5: the SUPER_ADMIN role maps only to `platform.*`). So on any tenant route, the per-route `requirePermission(key)` check fails the set-membership test and returns 403 **before the handler runs** — exactly as today's `requireTenantRole` already rejects a SUPER_ADMIN. The handler's `withTenant` call is never reached.
3. **`request.tenant`/`institutionId` is left unset for a SUPER_ADMIN (secondary guard).** Per the pipeline above, `request.tenant` is `undefined` for a super admin (the PLATFORM `institutionId` is retained on `request.auth` for logging only and is never fed to `app.current_institution_id`). Even if some future tenant route were ever reached by a super admin, there is no tenant id to open a `withTenant` transaction with, so no tenant transaction is attempted and nothing scopes to the PLATFORM institution's rows.

These three are the Phase-0 enforcement and they require no new code. **Optional future hardening (NOT Phase 0):** a thin guarded tenant-tx wrapper (e.g. `tenantTx(req, fn)` that reads `req.tenant`/`req.auth`, throws a fail-closed 500 for a SUPER_ADMIN or a missing tenant, then calls `withTenant`) could centralise the assertion if the handlers are later refactored to call it instead of `withTenant` directly. That refactor is out of Phase-0 scope and is mentioned only as a possible later hardening — the Phase-0 posture is the three points above. Sanctioned tenant access for a platform actor is a separate future break-glass `SupportGrant` path (out of scope, §10).

Error handling for the new steps (concrete):
- Membership not found for a non-superadmin user → `401 Unauthorized` (token references an identity with no active membership; recoverable by re-login after admin fixes membership). Logged at `warn` with `userId` (no PII beyond id).
- `membershipStatus === SUSPENDED` → `403 { error: "Membership suspended" }` (fatal for the request; recoverable when re-activated). Logged at `info`.
- DB error loading membership → `500`; do **not** leak details to the client; logged at `error` with the stack. Fail-closed: no `request.auth` attached, request rejected.
- Version mismatch re-resolve DB error → treat as `500` fail-closed (never fall back to the stale token for a privilege decision).

### 6.4 Central authz engine API

New file `apps/api/src/services/authz-engine.ts` (the existing `authz.ts` tenant-lookup helpers stay). API:

```ts
// pure predicate over the resolved claims on the request
export function can(auth: RequestAuth, permission: PermissionKey): boolean
  // => auth.permissions.includes(permission)

// Fastify preHandler guard; 403 if missing permission.
// Does NOT authenticate: it assumes a single top-level `authenticate` preHandler hook
// has already populated request.auth (see §7). It is a pure can(request.auth, permission) check.
export function requirePermission(permission: PermissionKey): preHandler
  // => if (!request.auth) log at ERROR (route + permission key) then 401 (defensive; authenticate hook should have set it);
  //    else if (!can(request.auth, permission)) log at INFO then 403; else pass

// module-active guard — STUBBED PERMISSIVE no-op for Phase 0 (module system is a later phase)
export function requireModuleActive(moduleKey: string): preHandler
  // Phase 0: resolves immediately (always allow); assumes authenticate ran via the top-level hook. Documented as a stub.
  // MUST carry the exact in-code marker comment:
  //   // PHASE-0 STUB: permits all; real module-activation enforcement lands in the module-entitlement phase
  // so that wiring it onto a real module route later is a visible, deliberate change, not a silent permit-all.

// record-level scope — DOCUMENTED FUTURE STUB, not implemented now
// export function canOnResource(auth, permission, resource): Promise<boolean>
//   Phase 0: not exported/called. GatePass's existing department/ownership checks
//   (getHodInTenant + departmentId filter, getStudentInTenant ownership) remain the
//   record-level enforcement for now; canOnResource formalises them in a later phase.
```

**Authentication ownership — stated once (finding #2).** Real starting state (verified against the route files and `middleware/auth.ts`): today each GatePass route file installs a **single top-level `requireTenantRole("<ROLE>")` hook** (and `platform.ts` a `requireSuperAdmin()`), and `requireTenantRole`/`requireRole`/`requireSuperAdmin` each **call `authenticate` internally** before doing their role check — so authentication is currently owned *by the role guard*, not by a separate `authenticate` hook. No GatePass route file carries a bare top-level `authenticate` hook today; only `notifications.ts` does (and it is not flipped — §7). The flip therefore **replaces** that single role hook with a single top-level bare `authenticate` hook, and moves the access decision to a per-route `requirePermission(key)`. After the flip, `authenticate` runs **exactly once** per request via that top-level hook, and `requirePermission` does **NOT** call `authenticate` itself; it is a pure `can(request.auth, permission)` check that assumes `authenticate` has already populated `request.auth`. This deliberately avoids the double-`authenticate` regression that would arise from leaving a role guard (which authenticates internally) in place alongside an `authenticate` call inside `requirePermission` (which would re-run `jwtVerify`, the `session.findFirst`, the `user.findUnique`, the membership load, and the `permissionsVersion` compare, plus a second `lastActiveAt` write, on every hot-path request) — and equally avoids the opposite error of adding `requirePermission` with no `authenticate` hook at all (every request would 401 defensively). §6.4 and §7 agree on this model: a top-level `authenticate` hook (added in each flip, replacing the role hook) owns authentication; per-route `requirePermission` owns only the authorization set-check. (As a defensive guard, if `request.auth` is somehow unset when `requirePermission` runs, it returns 401 rather than throwing — but in correct wiring the top-level hook guarantees it is set.)

**High-risk actions and the §5.3 "re-check at point of action" — scoped honestly (finding #7).** `identity-rbac.md` §5.3 and `superadmin-security.md` §5.2 define a point-of-action re-check as re-checking the permission **against the database at the moment of the action**, paired with step-up auth — a defense against a stale or forged token for the riskiest actions. The §6.2 `permissionsVersion` check is **not** that: in the common case (`token.version == db.version`) it performs no DB permission lookup, so it is a login-freshness mechanism, not an independent at-action DB re-check. These are different guarantees and this design does not equate them. For Phase 0:
- The authenticate-time version check (§6.2) is the only freshness mechanism; `requirePermission` for `campus_movement.pass.revoke` and `.emergency.declare` is a normal set-membership check against `request.auth.permissions` like every other key — there is no bespoke per-action query.
- A true per-action DB permission re-check and step-up/MFA for the high-risk keys are **deferred and listed as an accepted Phase 0 gap (§10)**. MFA is modelled-only (`mfaEnabled`/`mfaSecret`), never wired, per scope.
This is the honest Phase 0 posture: isolation (RLS) + login-time resolution + the version freshness check, without overstating a §5.3 at-action re-check the phase does not build.

Error/validation for the engine:
- `requirePermission` reached with `request.auth` unset (would only happen if the top-level `authenticate` hook is missing/misordered on the file) → `401` defensively; it is a wiring bug, not a normal path. **Logged at `error`** (finding #3 — a silent 401 on a misconfiguration is hard to diagnose) with the route path (`request.routeOptions.url` / method) and the permission key being checked, since by the design's own model this branch can only occur when the top-level `authenticate` hook is missing or misordered — exactly the misconfiguration this log is meant to surface. The top-level hook is what owns authentication (finding #2), so in correct wiring `request.auth` is always populated before `requirePermission` runs.
- authenticated but `!can(...)` → `403 { error: "Forbidden: missing permission <key>" }` (do not echo the user's whole permission set). Logged at `info`.
- `requireModuleActive` Phase 0 → never denies; logs nothing. It MUST carry the loud marker comment above (finding #6) and be pinned by a unit test asserting it currently permits every request (§9), so replacing the stub with real enforcement is a deliberate, test-breaking change rather than an invisible behavior flip.
- `can()` input: `permission` is a compile-time `PermissionKey`; at runtime it is a plain array `includes`, no external input, no validation needed.

---

## 7. Compatibility shim (edge 3 continued) + which routes migrate first

The shim is the §5 template-role→permission map, materialised two ways:
1. **At login**, resolving the enum-derived membership roles into `permissions` (so the token has both `role` and the matching `permissions`).
2. **For un-migrated routes**, `requireRole`/`requireTenantRole` keep reading `request.user.role` unchanged.

Because both the legacy guard and `requirePermission` are backed by the same map, a route can be flipped from `requireTenantRole("HOD")` to `requirePermission("campus_movement.pass.approve")` with no behavioural change for a correctly-seeded HOD. The shim stays until the legacy `role` claim is removed (a later step).

**Per-route migration map (makes the "no access change" claim mechanically checkable — finding #8).** Verified against the current route files: every GatePass route group installs **exactly one top-level** `app.addHook("preHandler", requireTenantRole("<ROLE>"))` (or `requireSuperAdmin()` for platform) and no route mixes a second role hook or an in-handler role check — record-level checks are ownership/department filters, not role gates. So the current guard for every route in a file is that file's single role, and each flip replaces the file's single top-level `requireTenantRole(ROLE)` hook with a single top-level `authenticate` hook (authentication ownership — finding #2) plus a per-route `requirePermission(key)` that assumes `request.auth` is already set and performs no second authentication. The table below is the authoritative flip checklist; the template role that holds each key (per §5) is the role whose users must keep access:

| Route | Current guard | New guard | Template role holding the key |
|---|---|---|---|
| `POST /guard/verify` | `requireTenantRole("GUARD")` | `requirePermission("campus_movement.gate.verify")` | GUARD |
| `POST /guard/mark-exit` | `requireTenantRole("GUARD")` | `requirePermission("campus_movement.gate.mark_exit")` | GUARD |
| `POST /guard/mark-return` | `requireTenantRole("GUARD")` | `requirePermission("campus_movement.gate.mark_return")` | GUARD |
| `GET /guard/lookup`, `GET /guard/activity` | `requireTenantRole("GUARD")` | `requirePermission("campus_movement.gate.lookup")` | GUARD |
| `POST /guard/shift/start`, `POST /guard/shift/end`, `GET /guard/shift/current` | `requireTenantRole("GUARD")` | `requirePermission("campus_movement.shift.manage_own")` | GUARD |
| `GET /guard/emergency/active` | `requireTenantRole("GUARD")` | `requirePermission("campus_movement.emergency.view")` | GUARD |
| `POST /student/gate-pass` | `requireTenantRole("STUDENT")` | `requirePermission("campus_movement.pass.request")` | STUDENT |
| `POST /student/gate-pass/:passId/cancel` | `requireTenantRole("STUDENT")` | `requirePermission("campus_movement.pass.cancel")` | STUDENT |
| `GET /student/dashboard`, `/active-pass`, `/history`, `/gate-pass/:id/timeline`, `/gate-pass/:id/summary`, `/reliability`, `/allowance`, `/reasons` | `requireTenantRole("STUDENT")` | `requirePermission("campus_movement.pass.view_own")` | STUDENT |
| `GET /student/emergency/active` | `requireTenantRole("STUDENT")` | `requirePermission("campus_movement.emergency.view")` | STUDENT |
| `GET /hod/requests`, `/requests/:id`, `/requests/:id/reliability`, `/requests/:id/allowance`, `/requests/:id/timeline`, `/requests/:id/summary`, `GET /hod/stats` | `requireTenantRole("HOD")` | `requirePermission("campus_movement.pass.view_department")` | HOD |
| `POST /hod/approve` | `requireTenantRole("HOD")` | `requirePermission("campus_movement.pass.approve")` | HOD |
| `POST /hod/reject` | `requireTenantRole("HOD")` | `requirePermission("campus_movement.pass.reject")` | HOD |
| `POST /hod/revoke` | `requireTenantRole("HOD")` | `requirePermission("campus_movement.pass.revoke")` | HOD |
| `POST /hod/emergency-override` | `requireTenantRole("HOD")` | `requirePermission("campus_movement.pass.override")` | HOD |
| `GET /hod/emergency/active` | `requireTenantRole("HOD")` | `requirePermission("campus_movement.emergency.view")` | HOD |
| `admin.*` routes (`/admin/users*`, `/students/*`, `/departments`, `/gates*`, `/guard-shifts`, `/reasons`, `/allowance-policy`, `/institution-config`, `/academic-calendar*`, `/audit-logs`, `/stats`, `/analytics`) | `requireTenantRole("ADMIN")` | `requirePermission("<the §4 admin.* / campus_movement.* key for that route>")` | ADMIN |
| `POST /admin/passes/:id/revoke` | `requireTenantRole("ADMIN")` | `requirePermission("campus_movement.pass.revoke")` | ADMIN |
| `POST /admin/emergency-override` | `requireTenantRole("ADMIN")` | `requirePermission("campus_movement.pass.override")` | ADMIN |
| `POST /admin/emergency/declare` | `requireTenantRole("ADMIN")` | `requirePermission("campus_movement.emergency.declare")` | ADMIN |
| `POST /admin/emergency/:id/resolve` | `requireTenantRole("ADMIN")` | `requirePermission("campus_movement.emergency.resolve")` | ADMIN |
| `GET /admin/emergency/active` | `requireTenantRole("ADMIN")` | `requirePermission("campus_movement.emergency.view")` | ADMIN |
| `platform.*` (`platform.ts`) | `requireSuperAdmin()` | **unchanged — stays `requireSuperAdmin()`** | SUPER_ADMIN |
| `notifications.ts` (all routes) | `authenticate` (bare, per-user scope) | **unchanged — stays bare `authenticate`, no role gate** | n/a |

**`notifications.ts` is intentionally OUT of the Phase-0 permission-flip scope (finding #5).** Verified against the file: it installs `app.addHook("preHandler", authenticate)` — a bare `authenticate` hook with **no** role gate — and every notification route is scoped to the authenticated user (per-user filtering). It has no `requireTenantRole` to flip and therefore gains **no** `requirePermission` guard in Phase 0; its per-user filtering is unchanged. Listing it here makes the route inventory exhaustive: every route file (`guard`, `student`, `hod`, `admin`, `platform`, `notifications`) is now accounted for.

The implementer MUST complete the per-route `admin.*` key column against `admin.ts` while flipping that group (the §4 catalogue lists every admin key and its route). A route whose current role holds the new key in §5 keeps access exactly; a mismatch in this table is the single place an off-by-one would show. **Each route-group flip MUST carry a before/after auth-regression assertion** (§9): a request from the role that holds the key still succeeds, and a request from a role that does not hold it still 403s — the same outcomes as under the old `requireTenantRole`. This makes the "no access change" claim a test, not an assertion.

Migration order for GatePass (the Phase 0 proving ground) — flip guards **one route group at a time**, re-running the api suite after each:
1. **Guard routes** (`guard.ts`) first — smallest, clearest permission mapping (`gate.verify/mark_exit/mark_return/lookup`, `shift.manage_own`), and highest operational value to prove the engine on the physical gate flow. **Replace** the single top-level `app.addHook("preHandler", requireTenantRole("GUARD"))` (which authenticates internally) with a single top-level `app.addHook("preHandler", authenticate)` **plus** per-route `requirePermission(...)`. There is no pre-existing bare `authenticate` hook to "keep" here — the role hook is removed and the `authenticate` hook is added in its place, so authentication still runs exactly once.
2. **Student routes** (`student.ts`) — `pass.request`, `pass.cancel`, `pass.view_own`, `emergency.view`.
3. **HOD routes** (`hod.ts`) — `pass.view_department`, `pass.approve`, `pass.reject`, `pass.revoke`, `pass.override`.
4. **Admin routes** (`admin.ts`) — `admin.*` + `campus_movement.*` admin keys last (largest surface).
5. **Platform routes** (`platform.ts`) stay on `requireSuperAdmin` for Phase 0 (platform permission enforcement is a Super Admin-phase concern); they are already correct and RLS-independent.

Record-level scope (HOD limited to their department, student to their own passes) is **unchanged** — it stays in the handlers via `getHodInTenant`/`getStudentInTenant` + the existing `departmentId`/`studentId` filters inside `withTenant`. `requirePermission` is coarse (does this role hold the action); the tenant client + those filters remain the fine-grained guard until `canOnResource` is built.

Invariant ownership: coarse action-level authz is owned by the engine (`requirePermission`); tenant isolation is owned by the DB (RLS) + `withTenant`; record-level scope is owned (for now) by the handler queries. These layers are independent and each is enforced at its own level — matching tenancy §6.3's "both layers" principle.

---

## 8. Edge cases

- **SUPER_ADMIN login** — no membership row exists; login/authenticate must branch on `role === "SUPER_ADMIN"` and skip the membership load, setting `membershipId: null`, `permissionsVersion: null`, and platform `roles`/`permissions`. It must also leave `request.tenant` **unset** — the PLATFORM `institutionId` on the super-admin user is never fed to `app.current_institution_id` (§6.3 invariant). A membership lookup returning null for a non-superadmin is an error (§6.3); for a superadmin it is expected.
- **User with a membership but no membership-role** — this transient window is **eliminated**: the migration creates the membership AND its membership-role in the same transaction (§3.1 steps 3a/3c), and the §3.1 step-4 exactly-one guard aborts the deploy if any membership has other than exactly one role (count 0 or 2+), naming the offending `membershipId`. The deploy therefore never ships a tenant user with an empty role set. Were the state to arise anyway (e.g. a future bug), it resolves fail-closed — empty `roles`/`permissions`, every `requirePermission` denies, while legacy `requireRole` still passes on `user.role` — and the central authz treats it as a deny, not a crash. Documented so it is not mistaken for a bug.
- **Stale token after permission reduction** — closed by the `permissionsVersion` check (§6.2) on the next request.
- **Pending/inactive account** — existing `accountStatus !== ACTIVE` check is kept ahead of the membership load; a `PENDING_APPROVAL` student never reaches membership resolution.
- **Suspended institution** — existing check kept; unchanged.
- **Template role read under a (hypothetical) tenant context** — never happens because roles are only read via `privilegedPrisma` at login/seed; §2.4 explains why Role is not RLS.
- **Backfill orphan** — a user whose `institutionId` points at a missing institution → the `SET NOT NULL`/FK step fails the migration loudly (mirrors B-1 §2b); must be fixed in data before deploy.

---

## 9. Testability

- **Unit (mocked `@campusgate/db`, no DB):** `can()` predicate; `resolvePermissions(roles)` produces a de-duplicated, sorted array and yields the identical set for a multi-role input whether called by login or the re-resolve path (finding #4); the template-role→permission map resolution (given roles → expected permission set); `requirePermission` preHandler returns 403 on missing permission and passes on present (mock `request.auth`); **`requireModuleActive` permit-all pin (finding #6):** a test asserting the Phase-0 stub currently allows every request, so replacing it with real enforcement breaks this test deliberately; authenticate's SUPER_ADMIN branch vs membership branch; the `permissionsVersion` mismatch → re-resolve path (mock two versions, assert the re-resolved array equals the login-time array byte-for-byte).
- **CI meta-test (no DB — static parse):** **catalogue-sync test (finding #3)** — parse the permission keys and `(roleKey, permissionKey)` pairs embedded in the `identity_rbac_b2` `migration.sql` and assert set-equality against `PERMISSIONS` + `ROLE_PERMISSIONS` imported from `@campusgate/shared`; fail the build on any drift. This is the enforced sync that lets the migration-seeded catalogue, the seed, and the signed-token permission set provably agree.
- **Integration (real Supabase, campass_app):** extend the escape suite — add `institution_memberships` and `membership_roles` to `RLS_TABLES` so test 6 (meta RLS) covers them; add a read-escape and a spoofed-tenant-insert test for `membership_roles` (tenant A cannot see B's membership-role; cannot insert a membership-role stamped B's `institutionId`). The escape harness teardown MUST be extended in the same change (verified against `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`), because the new `RESTRICT` composite FKs otherwise block the existing `user`/`department`/`institution` deletes and orphaned rows fail the `countRemainingTestRows() === 0` assertion across runs:
  - In `cleanup()`, add `adminClient.membershipRole.deleteMany({ where })` and `adminClient.institutionMembership.deleteMany({ where })` **before** the `user`, `department`, and `institution` deletes (child-first: membership_roles → institution_memberships → … → user/department/institution), respecting the new `RESTRICT` composite FKs (`membership_roles(membershipId,institutionId)->institution_memberships`, `institution_memberships(userId,institutionId)->users`). The existing `{ institutionId: { startsWith: PREFIX } }` filter applies unchanged since both new tables carry `institutionId`.
  - In `countRemainingTestRows()`, add `adminClient.institutionMembership.count({ where })` and `adminClient.membershipRole.count({ where })` to the counted set.
  - If the new escape tests seed memberships/membership-roles under an `ESCAPE_TEST_` institution, add them to `seedTenant()` so their ids are captured under `PREFIX` (same deterministic-id pattern as the other seeded rows) and cleaned by the prefix filter.
  - Add an auth-regression test group: login issues a token with `permissions` and `permissionsVersion`; a migrated guard route (e.g. `/guard/verify`) accepts a GUARD token and 403s a STUDENT token; SUPER_ADMIN still 403s on tenant routes and 200s on `/platform/stats`; session revocation still blocks.
- **GatePass end-to-end regression** on the new foundation after each route group is flipped (existing api suite, must stay green).
- **Hard-to-test flags:** `permissionsVersion` increment-on-change has no Phase 0 writer (self-service editing deferred), so only the *read/compare* path is tested now; the increment path gets tests with the admin role-editing feature. This is an accepted, documented gap, not a design weakness — the mechanism is in place.

A design note on testability of the engine: keeping `can()` a pure function over `request.auth` (not a DB call) is deliberate — it makes authorization unit-testable without a database and keeps the hot path fast. The one DB-touching concern (freshness) is isolated to `authenticate`, where it piggybacks on an already-fetched row.

---

## 10. Explicitly out of scope (NOT built)

Per identity-rbac §9 and the task: multi-institution switching UX; self-service role/permission editing UI; SSO/OIDC; delegated admin beyond `departmentScope`; module entitlement/activation tables (separate later phase — `requireModuleActive` is a permissive no-op stub now); MFA enforcement (`mfaEnabled` default false + nullable `mfaSecret` modelled only, not wired); `canOnResource` (documented future stub, not exported). **The identity-rbac §5.3 / superadmin-security §5.2 "re-check at point of action against the DB" + step-up auth for high-risk keys (`campus_movement.pass.revoke`, `.emergency.declare`) is an accepted Phase 0 gap** — Phase 0 enforces those keys as ordinary `requirePermission` set checks plus the §6.2 login-freshness version check, and a genuine at-action DB re-check lands with the step-up/MFA phase (finding #7). The legacy `role` claim removal is a later step. `Role` RLS / tenant-custom roles are deferred to the phase that builds role editing.

---

## 11. Files touched (implementation map)

- `packages/db/prisma/schema.prisma` — add `MembershipStatus` enum; `User` fields (`phone`, `mfaEnabled`, `mfaSecret`, `memberships`); models `InstitutionMembership`, `Role`, `Permission`, `MembershipRole`, `RolePermission`; `Institution`/`Department` back-relations.
- `packages/db/prisma/migrations/<ts>_identity_rbac_b2/migration.sql` — hand-authored per §3.1: tables; `roles_key_template_unique` partial unique index (step 2a); in-migration seeding of template roles + permission catalogue + role→permission map (step 2b); membership backfill with `gen_random_uuid()::text` ids excluding SUPER_ADMIN and PLATFORM-institution users (step 3a); membership-role backfill joining `users.role`→template role (step 3c); `SET NOT NULL` + the two `DO $$ RAISE EXCEPTION` guards (step 4); composite uniques/FKs, indexes, RLS, GRANTs. New migration only; B-1 (`20261018110658_tenancy_isolation_rls`) untouched.
- `packages/db/src/seed.ts` — permissions + template roles + role_permissions + per-user membership/membership-role (superadmin excluded) per §3.2.
- `packages/shared/src/permissions.ts` + `index.ts` export — catalogue `PERMISSIONS` (§4) AND the `ROLE_PERMISSIONS` role→permission map (§5), the single source both the seed, the login resolver, and the catalogue-sync meta-test read.
- `apps/api/src/middleware/auth.ts` — extend `FastifyJWT` payload/user types with `membershipId`/`roles`/`permissions`/`permissionsVersion` (keep `role`); extend `authenticate` per §6.3; keep `requireRole`/`requireTenantRole`/`requireSuperAdmin`.
- `apps/api/src/routes/auth.ts` — login resolves membership roles → `roles`/`permissions`/`permissionsVersion` and signs the dual-shape token; SUPER_ADMIN branch.
- `apps/api/src/services/authz-engine.ts` — `can`, `requirePermission`, `requireModuleActive` (stub carrying the `// PHASE-0 STUB: permits all` marker, finding #6), the shared `resolvePermissions(roles)` normalizer (de-dup + sort, used by login and the authenticate re-resolve path, finding #4); `canOnResource` documented-only.
- `apps/api/src/routes/{guard,student,hod,admin}.ts` — flip guards to `requirePermission` in the order of §7 (platform.ts unchanged).
- `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` — add `institution_memberships` + `membership_roles` to `RLS_TABLES`; extend `cleanup()` with child-first `membershipRole`/`institutionMembership` deletes ordered before the `user`/`department`/`institution` deletes; add both tables to `countRemainingTestRows()`; extend `seedTenant()` if the new escape tests seed memberships (per §9). `tenant-escape.integration.test.ts` — add membership-role read-escape + spoofed-insert cases; new auth-regression/engine unit tests, including the `requireModuleActive` permit-all pin (finding #6) and the `resolvePermissions` dedup/sort/identity tests (finding #4).
- **New CI meta-test** (finding #3) — a unit/CI test (e.g. `packages/db/src/__tests__/catalogue-sync.test.ts` or alongside the api unit tests) that reads the `identity_rbac_b2` `migration.sql`, extracts its embedded permission keys and `(roleKey, permissionKey)` pairs, and asserts set-equality against `PERMISSIONS` + `ROLE_PERMISSIONS` from `@campusgate/shared`, failing the build on drift.

---

## 12. Decisions on the five ambiguous edges (summary)

1. **JWT transition** — the single canonical signed payload is `{ userId, membershipId, institutionId, roles, permissions, permissionsVersion, role, jti }` (target claims + the retained legacy `role`); both the permission set and the legacy enum derive from the same role→permission map so they never disagree; `permissionsVersion` is `null` for SUPER_ADMIN; `role` removal is a later step, not Phase 0.
2. **Permission freshness** — short 24h token + `permissionsVersion Int @default(0)` on the membership, **carried in the signed payload as `permissionsVersion`** and compared in `authenticate` against the already-fetched membership row (re-resolve on mismatch, fail-closed on error), plus session-revoke-on-sensitive-change as the dormant-but-ready backstop. The super-admin branch has no membership, so `permissionsVersion` is `null` and the freshness compare is skipped.
3. **Shim vs RLS** — membership/role/permission reads are pre-tenant-context and run on `privilegedPrisma`, never `withTenant` (consistent with B-2; RLS tables would fail-closed without a tenant GUC). Made explicit in §6.3.
4. **RBAC ownership** — `InstitutionMembership` and `MembershipRole` are tenant-owned (RLS + composite FKs + escape-suite coverage, full checklist in the same migration); `Permission` and `RolePermission` are global; `Role` is a platform template (and NOT RLS in Phase 0, because all Phase 0 roles are `institutionId = null` templates read only via privilegedPrisma, and an RLS `=` policy would fail-closed on null). `campass_app` never gets BYPASSRLS; the B-1 migration is never changed.
5. **Backfill + seed** — one `ACTIVE` membership per existing tenant user **and its membership-role, both created in the migration SQL** (not the seed), excluding SUPER_ADMIN users and any user attached to the PLATFORM institution; ids are `gen_random_uuid()::text` with `mbr_`/`mrl_` prefixes (a core `pg_catalog` function on Postgres 13+, no `CREATE EXTENSION` needed; existing tables default ids to cuid via Prisma, so these backfill rows are deliberately minted in raw SQL and the two id styles on the column are an intentional one-time split — §3.1 step 3a). The migration also seeds the five enum values as platform template roles (STUDENT/HOD/GUARD/ADMIN tenant-usable, SUPER_ADMIN platform-only with no tenant membership), the `campus_movement.*` + `admin.*` + `platform.*` catalogue, and the role→permission map, guarded by the `roles_key_template_unique` partial index so template keys are unique under NULL `institutionId`; a post-backfill `RAISE EXCEPTION` guard aborts the deploy if any membership has other than **exactly one** membership-role (count 0 or 2+), naming the offending `membershipId` (§3.1 step 4). The seed repeats all template/catalogue work idempotently for fresh/dev DBs and demo users (find-first-then-create for templates). `User.role` and `User.institutionId` are kept for the transition.

---

## 13. Responses to the design reviews

### 13.0 Round 1 review (verdict CHANGES_REQUESTED: 2 HIGH, 6 MEDIUM, 3 NIT)

All HIGH and MEDIUM findings are addressed; the three NITs are also addressed.

1. **HIGH — `permissionsVersion` missing from canonical JWT shape. ADDRESSED.** The canonical signed payload in §6.1 now includes `permissionsVersion`, and §6.2, §6.3 (pipeline + SUPER_ADMIN branch), §11 (payload types), and §12 items 1–2 all list it consistently. SUPER_ADMIN carries `permissionsVersion: null` and the freshness compare is skipped for the super-admin branch.
2. **HIGH — SUPER_ADMIN institutionId = PLATFORM, tenant-context hazard. ADDRESSED.** §6.3 now states the invariant explicitly (verified against `seed.ts`: the super admin sits on the real PLATFORM institution, not null): a SUPER_ADMIN request never enters `withTenant`, `request.tenant` is left `undefined`, the PLATFORM id is retained for logging only and never fed to `app.current_institution_id`. (The round-1 claim of a `withTenant`-wiring assertion was **superseded by round-3 finding #1** — see §13.2 — because no central `withTenant` call site exists; the honest three-mechanism enforcement in §6.3 is now authoritative.) §6.1, §8, and §12 reconciled.
3. **MEDIUM — escape-suite teardown. ADDRESSED.** §9 and §11 now specify extending `cleanup()` with child-first `membershipRole`/`institutionMembership` deletes ordered before user/department/institution (respecting the new RESTRICT composite FKs), adding both tables to `countRemainingTestRows()`, and extending `seedTenant()` if the new tests seed memberships.
4. **MEDIUM — membership→role depends on seed, not migration; deploy window. ADDRESSED (option a).** Verified against `database.md` §3.3 that deploy runs `migrate deploy` only (seed not stated). The membership-role backfill is now done **inside the migration** (§3.1 step 3c) by joining `users.role`→the template role, with a post-backfill guard that aborts if any membership lacks a role; the seed is demoted to fresh/dev + demo-user duty. No deploy window.
5. **MEDIUM — ambiguous backfill id. ADDRESSED.** §3.1 step 3a fixes the format to `gen_random_uuid()::text` with a `mbr_` prefix (and `mrl_` for membership-roles); the "either is fine" language is removed. (The availability justification was tightened in round 3 finding #3 — §13.2 — and corrected again in round 4 finding #1 to state only that `gen_random_uuid()` is a core `pg_catalog` function; existing ids are cuid via Prisma, so the backfill minting raw-SQL ids is an intentional one-time split, not a mirror of any existing DB default.)
6. **MEDIUM — template-role uniqueness under NULL institutionId. ADDRESSED.** §3.1 step 2a adds the partial unique index `roles_key_template_unique ON roles (key) WHERE "institutionId" IS NULL`; §3.2 switches template resolution to `findFirst(key, institutionId:null)` + create-if-absent instead of a NULL composite upsert.
7. **MEDIUM — point-of-action re-check conflated with version check. ADDRESSED (scoped down).** §6.4 no longer equates the §6.2 version check with a §5.3 at-action DB re-check; it states they are different guarantees, enforces the high-risk keys as ordinary `requirePermission` checks in Phase 0, and §10 lists the genuine at-action DB re-check + step-up as an accepted Phase 0 gap. §4 annotations updated.
8. **MEDIUM — "no access change" not mechanically verifiable. ADDRESSED.** §7 adds a per-route migration table (route | current guard | new `requirePermission` | template role), verified against the route files (every group has a single top-level role hook, no mixed guards), and requires a before/after auth-regression assertion per route-group flip.
9. **NIT — MembershipRole timestamps / unique note. ADDRESSED.** §2.5 adds `createdAt`/`updatedAt` and a note that `(id, institutionId)` is intentionally omitted because nothing references `membership_roles` as a composite-FK parent in Phase 0.
10. **NIT — User.phone label. ADDRESSED.** §2.1 labels `phone` as a new schema column (the live `User` has none), distinct from the conceptual listing in identity-rbac §3.
11. **NIT — backfill assumes no non-superadmin on PLATFORM. ADDRESSED.** §3.1 step 3a adds the second predicate excluding users whose `institutionId` is the PLATFORM institution, in addition to `role <> 'SUPER_ADMIN'`.

Scope confirmed unchanged: identity-rbac §3–§8 only; no §9 deferred items, no module entitlement/activation tables, MFA modelled-only; `User.role`/`User.institutionId` kept; the two tenant-owned RBAC tables keep `institutionId` + composite FKs + RLS + policies + escape-suite coverage; authenticate RBAC reads use `privilegedPrisma`; `campass_app` never gets BYPASSRLS; the B-1 migration is never changed.

### 13.1 Round 2 review (verdict CHANGES_REQUESTED: 1 HIGH, 2 MEDIUM, 3 NIT)

All HIGH and MEDIUM findings are resolved; all three NITs are resolved. Every change is local and within the locked scope — no §9 deferred item, no entitlement/activation table, no MFA wiring, no change to the B-1 migration, no BYPASSRLS on `campass_app`.

1. **HIGH — `departmentScope` composite FK `ON DELETE SET NULL` fails against the NOT NULL `institutionId` leg. RESOLVED (option b).** Confirmed against the real B-1 migration (`20261018110658_tenancy_isolation_rls`): every B-1 composite FK is `ON DELETE RESTRICT` except `gate_passes_approvedBy_same_tenant_fkey`, which uses `SET NULL` and carries the identical latent NOT-NULL-leg hazard (frozen, out of scope to change). The design now gives `(departmentScope, institutionId) -> departments(id, institutionId)` **`ON DELETE RESTRICT`** (consistent with B-1's uniform convention, no reliance on the PG15 column-scoped `SET NULL ("departmentScope")` syntax which has no in-repo precedent), and requires the application to clear `departmentScope` before a department delete. §2.2 (expanded decision block), §3.1 step 5, and the §2.7 table are all updated, and every "nullable-safe `SET NULL`" description is removed. Phase 0 has no department-DELETE route, so no pre-clear code is wired now; the FK guarantees the invariant can never break silently.
2. **MEDIUM — RLS/FK interaction on `departments` and MATCH SIMPLE semantics left implicit. RESOLVED.** §2.2 now states that FK enforcement is owner-level and not subject to RLS, so `departments` remaining RLS-forced does not affect the constraint and no change to `departments` RLS is implied; and that MATCH SIMPLE is chosen deliberately so a NULL `departmentScope` (no department limit) skips the composite check while `institutionId` is always present (MATCH FULL would wrongly reject that case). §3.1 step 5 echoes this.
3. **MEDIUM — in-migration permission catalogue duplicated from `packages/shared` with no enforced sync. RESOLVED (alternative: enforced CI meta-test).** Keeping the catalogue in the migration preserves the no-deploy-window guarantee established in step 3c (deploy runs `migrate deploy` only; the seed is not guaranteed to run). "Both derive from the same source" is replaced by an **enforced sync**: a CI meta-test (§3.1 step 2b, §9, §11) parses the permission keys and `(roleKey, permissionKey)` pairs embedded in the `identity_rbac_b2` `migration.sql` and asserts set-equality against `PERMISSIONS` + the new `ROLE_PERMISSIONS` map imported from `@campusgate/shared`, failing the build on drift. §5 now defines `ROLE_PERMISSIONS` as the single machine-readable source the seed, the login resolver, and the meta-test all read.
4. **NIT — re-resolved permissions set dedup/ordering unspecified. RESOLVED.** §6.2 step 2 now requires the re-resolve path to produce a de-duplicated, sorted array via a shared `resolvePermissions(roles)` helper that login (§6.1) also uses, so the token fast-path and the re-resolve path yield byte-identical sets; `roles` is likewise de-duplicated and sorted. A unit test pins this identity (§9).
5. **NIT — step-4 guard only checks "at least one"; exception message unspecified. RESOLVED (option b).** §3.1 step 4 now carries concrete SQL asserting **exactly one** membership-role per membership (`GROUP BY ... HAVING count(*) <> 1` must be 0) and a descriptive `RAISE EXCEPTION` naming the offending `membershipId` and its role count, mirroring B-1's guards. §8 and §3.2 verification text reconciled to "exactly one (count 0 or 2+ aborts)".
6. **NIT — `requireModuleActive` permissive stub lacks a fail-closed marker/test. RESOLVED.** §6.4 now mandates the exact in-code marker comment (`// PHASE-0 STUB: permits all; real module-activation enforcement lands in the module-entitlement phase`) and §9/§11 require a unit test pinning its current permit-all behavior, so replacing the stub with real enforcement is a visible, test-breaking change.

### 13.2 Round 3 review (verdict CHANGES_REQUESTED: 1 HIGH, 2 MEDIUM, 3 NIT)

All findings are resolved. Every change is local and within the locked scope — no §9 deferred item, no entitlement/activation table, no MFA wiring, no change to the B-1 migration, no BYPASSRLS on `campass_app`; `User.role`/`User.institutionId` are kept for the shim.

1. **HIGH — SUPER_ADMIN enforcement "at the `withTenant` call site" describes a point that does not exist. RESOLVED (option b — honest posture).** Confirmed against `packages/db/src/index.ts`: `withTenant(institutionId, fn)` is a standalone exported function invoked ad-hoc in each handler with a local `institutionId`, with no access to `request`/`request.tenant`/`request.auth` — there is no central "tenant-transaction wiring in the request pipeline" where a role assertion could live. §6.3's "Enforcement of the invariant" paragraph is rewritten to drop the non-existent call-site gate and state the three mechanisms that are **already true** of the code: (i) `requireSuperAdmin()` keeps platform routes off tenant routes; (ii) on every migrated tenant route, `requirePermission` 403s a SUPER_ADMIN because it holds no tenant membership and therefore no `campus_movement.*`/`admin.*` permission (the handler's `withTenant` is never reached); (iii) `request.tenant`/`institutionId` is left unset for a SUPER_ADMIN, so no tenant transaction can be opened even if a tenant route were somehow reached. A guarded `tenantTx(req, fn)` wrapper is mentioned only as **optional future hardening, out of Phase-0 scope** — the Phase-0 posture is the three points. The superseded round-1 claim is annotated in §13.0 item 2.
2. **MEDIUM — double `authenticate()` per migrated request / contradictory ownership. RESOLVED.** Authentication ownership is now stated **once**: each migrated route file **replaces** its single top-level `requireTenantRole(...)` hook (which authenticates internally today) with a single top-level bare `authenticate` hook, and `requirePermission` does **NOT** call `authenticate` — it is a pure `can(request.auth, key)` check that assumes `request.auth` is already populated. §6.4 (engine API + the "Authentication ownership" paragraph + the error-handling bullet) and §7 (intro + the per-route flip steps, which now say "replace the role hook with a bare `authenticate` hook") agree, eliminating the doubled `jwtVerify`/`session.findFirst`/`user.findUnique`/membership-load/version-compare and the second `lastActiveAt` write on the hot path.
3. **MEDIUM — `gen_random_uuid()` "built into Supabase (no extension needed)" stated as fact without precedent. RESOLVED.** §3.1 step 3a (and §11, §12 item 5) now state only the true facts: `gen_random_uuid()` resolves from `pg_catalog` (Postgres 13+ core, no `CREATE EXTENSION` required), so the backfill keeps `gen_random_uuid()::text` with no extension line. No change of approach (ids and prefixes unchanged).
4. **NIT — composite-FK parent uniques not named. RESOLVED.** §2.2 and §3.1 step 5 now name the existing parent uniques each new composite FK targets: `users_id_institutionId_key` and `departments_id_institutionId_key` (both added by B-1, present). (`membership_roles`'s composite FK targets `institution_memberships_id_institutionId_key`, created in this same migration at step 5.)
5. **NIT — `notifications.ts` outside the §7 inventory. RESOLVED.** §7 adds a `notifications.ts` row to the route table and a note: it installs a bare `authenticate` hook (per-user scope, no role gate), is intentionally OUT of the Phase-0 permission-flip scope, gains no `requirePermission` guard, and its per-user filtering is unchanged — making the route inventory exhaustive (`guard`, `student`, `hod`, `admin`, `platform`, `notifications`).
6. **NIT — step-2b intra-step insert order not pinned. RESOLVED.** §3.1 step 2b now pins the load-bearing intra-step order: (i) `permissions` FIRST, (ii) `roles` next, (iii) `role_permissions` LAST (it has single-column FKs to both `roles` and `permissions`, so it must come after both or the insert fails).

Prior-round resolved items kept without regression: the `(departmentScope, institutionId)` composite FK stays `ON DELETE RESTRICT` (never `SET NULL` on a composite with the NOT NULL `institutionId` leg; §2.2 / §3.1 step 5 / §2.7); `permissionsVersion` remains in the canonical JWT shape (§6.1/§6.2/§6.3/§11/§12); the escape-suite teardown extension for the new tenant tables remains specified (§9/§11).

### 13.3 Round 4 review (verdict CHANGES_REQUESTED: 0 HIGH, 2 MEDIUM, 1 NIT)

Round 4 was a document-only review; all three findings are factual-accuracy corrections to "verified against the code / schema" claims — neither the id scheme nor the authentication-ownership model changed, only the text describing the current state. All are resolved; every change is local and within the locked scope (no §9 deferred item, no entitlement/activation table, no MFA wiring, no change to the B-1 migration, no BYPASSRLS on `campass_app`; `User.role`/`User.institutionId` kept).

1. **MEDIUM — false premise: the schema does NOT use `gen_random_uuid()::text` as its id default. RESOLVED (text only, no approach change).** Confirmed: every model in `schema.prisma` uses `@default(cuid())`, and the `init` + `tenancy_isolation_rls` migrations declare every id column as `TEXT NOT NULL` with no DB-level default — ids are cuid generated by Prisma, not a DB function. The false "consistent with existing schema defaults / the existing B-1 schema already uses `gen_random_uuid()::text`" clause is removed from §3.1 step 3a, §12 item 5, and §13.2 finding #3 (and the §13.1 item-5 cross-reference). The id scheme is unchanged (`gen_random_uuid()::text` with `mbr_`/`mrl_` prefixes, no `CREATE EXTENSION`); the justification now states only the true facts: `gen_random_uuid()` is a core `pg_catalog` function on Postgres 13+, existing ids default to cuid via Prisma, and this backfill deliberately mints ids in raw SQL — the two id styles on one column (raw-SQL backfill rows vs. future cuid Prisma inserts) are a documented, intentional one-time split; no DB-level id default is added to the new tables. The unverifiable `pgcrypto`/`uuid-ossp` "installed on the live DB" claim is reframed as a non-load-bearing live-query observation, since core `pg_catalog` availability is the claim that matters.
2. **MEDIUM — asserted a top-level `authenticate` hook "already carries / pattern in use today"; the live route files do not have one. RESOLVED (text only).** Confirmed: `guard/student/hod/admin.ts` each install exactly one top-level `requireTenantRole(...)` hook (`platform.ts` one `requireSuperAdmin()`), and `requireTenantRole`/`requireRole`/`requireSuperAdmin` call `authenticate` internally — so authentication is owned by the role guard today, not by a bare `authenticate` hook (only `notifications.ts` carries one). §6.4's "Authentication ownership" paragraph now describes this real starting state and states the flip **replaces** the role hook with a bare top-level `authenticate` hook (plus per-route `requirePermission`), calling out both failure modes it prevents (keeping the role guard → double authenticate; omitting the hook → 401s). §7's guard-first flip step changes "keep a top-level `authenticate` hook" to "replace the role hook with a bare `authenticate` hook" (the §7 intro already said "replaces"). §13.2 finding #2 wording corrected from "keeps ... the existing top-level-hook pattern" to "replaces the role hook with a bare `authenticate` hook." The end-state model (one top-level `authenticate`; `requirePermission` never re-authenticates) is unchanged.
3. **NIT — `requirePermission` defensive-401 path had no specified log level. RESOLVED.** §6.4's error-handling bullet (and the engine-API inline comment) now specify this branch logs at **`error`** with the route path and the permission key, since it can only occur when the top-level `authenticate` hook is missing or misordered — exactly the wiring misconfiguration the log is meant to surface.

Prior-round resolved items kept without regression: honest three-mechanism SUPER_ADMIN posture with no `withTenant`-call-site gate (§6.3); `(departmentScope, institutionId)` composite FK `ON DELETE RESTRICT` (§2.2/§3.1 step 5/§2.7); `permissionsVersion` in the canonical JWT shape; escape-suite teardown extension specified (§9/§11); NIT #4 parent-unique names, NIT #5 `notifications.ts` inventory row, and NIT #6 intra-step insert order all retained.
