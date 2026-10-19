-- CAMPASS module entitlement / activation / dependency system (architecture.md §5).
--
-- Hand-authored (Prisma's diff does not model RLS, the composite FK, the targeted
-- GRANT refresh, the catalogue seed, or the backfill + invariant guard). ADDITIVE
-- ONLY: it creates ONE new type + ONE new table and seeds ONE new permission. It
-- NEVER alters the FROZEN B-1 (20261018110658_tenancy_isolation_rls),
-- identity_rbac_b2 (20261018171747_identity_rbac_b2), or superadmin_security
-- (20261019053533_superadmin_security) objects. campass_app stays NOSUPERUSER
-- NOBYPASSRLS — never granted BYPASSRLS here.
--
-- Ordering (mirrors superadmin_security):
--   1.  CREATE TYPE ModuleState;
--   2.  CREATE TABLE institution_modules + unique/indexes;
--   3.  composite tenant-root FK -> institutions(id);
--   4.  ENABLE + FORCE RLS + the fail-closed nullif-guarded policy pair;
--   5.  guarded campass_app GRANT (full DML — tenant writes here; no REVOKE);
--   6.  seed the ONE new permission (admin.modules.manage) + its ADMIN
--       role_permissions pair (same markers the catalogue-sync test parses);
--   7.  backfill campus_movement ENTITLED+ACTIVE for every non-PLATFORM institution;
--   8.  backfill invariant guard (aborts the deploy on a partial backfill).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Enum.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "ModuleState" AS ENUM ('ENTITLED', 'ACTIVE', 'SUSPENDED');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. institution_modules (TENANT-OWNED; institutionId is the ownership column).
--    One row per (institutionId, moduleKey); NOT_ENTITLED = absence of a row.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "institution_modules" (
    "id"                TEXT NOT NULL,
    "institutionId"     TEXT NOT NULL,
    "moduleKey"         TEXT NOT NULL,
    "state"             "ModuleState" NOT NULL DEFAULT 'ENTITLED',
    "entitledAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt"       TIMESTAMP(3),
    "suspendedAt"       TIMESTAMP(3),
    "settings"          JSONB,
    "entitledByUserId"  TEXT,
    "activatedByUserId" TEXT,
    "suspendedByUserId" TEXT,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "institution_modules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "institution_modules_institutionId_moduleKey_key" ON "institution_modules"("institutionId", "moduleKey");
CREATE UNIQUE INDEX "institution_modules_id_institutionId_key"        ON "institution_modules"("id", "institutionId");
CREATE INDEX        "institution_modules_institutionId_idx"           ON "institution_modules"("institutionId");

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Tenant-root FK. institutionId is the ownership column, so the FK is to the
--    tenant root institutions(id) — the same single-leg shape the other
--    tenant-owned tables (notifications / audit_events) use. ON DELETE RESTRICT
--    so an institution with module rows cannot be dropped out from under them.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "institution_modules"
  ADD CONSTRAINT "institution_modules_institution_same_tenant_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS. ENABLE + FORCE with the fail-closed nullif-guarded standard policy
--    pair {tenant_isolation_select, tenant_isolation_modify} — byte-for-byte the
--    superadmin_security house style. nullif(current_setting(...), '') fails
--    closed for BOTH an unset GUC and an empty-string GUC: "institutionId" = NULL
--    is NULL (not TRUE), so no row is visible and no WITH CHECK passes. NO
--    `TO postgres` policy (postgres bypasses RLS entirely — such a policy is
--    inert and misleading). The tenant has a FULL modify path here (activation /
--    suspension are tenant writes), unlike audit_events / support_grants.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  ALTER TABLE "institution_modules" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "institution_modules" FORCE  ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "tenant_isolation_select" ON "institution_modules";
  CREATE POLICY "tenant_isolation_select" ON "institution_modules"
    FOR SELECT
    USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

  DROP POLICY IF EXISTS "tenant_isolation_modify" ON "institution_modules";
  CREATE POLICY "tenant_isolation_modify" ON "institution_modules"
    FOR ALL
    USING     ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''))
    WITH CHECK ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. campass_app GRANT (guarded + idempotent). The live B-1 grant uses
--    GRANT ... ON ALL TABLES + ALTER DEFAULT PRIVILEGES, so the new table
--    inherits full DML by default. Pin it: the tenant role LEGITIMATELY needs
--    SELECT/INSERT/UPDATE/DELETE here because activation/suspension are tenant
--    writes — so no REVOKE (unlike audit_events / support_grants). Never BYPASSRLS.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "institution_modules" TO "campass_app";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Seed the ONE new permission (admin.modules.manage) + its ADMIN
--    role-permission pair, using the same seed-block shape + join + markers the
--    identity_rbac_b2 / superadmin_security seeds use so the generalized
--    catalogue-sync meta-test parses this block too. Both inserts are idempotent
--    (DO NOTHING on conflict). The ADMIN template role + permission catalogue
--    already exist.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_admin_modules_manage', 'admin.modules.manage', 'admin', 'Activate / suspend / view the institution''s modules')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('ADMIN', 'admin.modules.manage')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. CRITICAL BACKFILL. Every existing non-PLATFORM institution gets
--    campus_movement ENTITLED+ACTIVE (both entitledAt and activatedAt set) so the
--    real requireModuleActive does NOT 403 live GatePass traffic the moment the
--    guard is wired. Idempotent (ON CONFLICT on the unique pair). code <> 'PLATFORM'
--    is the deliberate sole definition of a tenant institution for Phase 0.
--    Backfilled rows get 'imod_' ids (backfill-only, semantically meaningless,
--    matching the identity_rbac_b2 'mbr_' precedent); runtime/seed rows get cuids.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "institution_modules"
  ("id","institutionId","moduleKey","state","entitledAt","activatedAt","updatedAt")
SELECT 'imod_' || gen_random_uuid()::text, i."id", 'campus_movement', 'ACTIVE',
       now(), now(), now()
FROM "institutions" i
WHERE i."code" <> 'PLATFORM'
ON CONFLICT ("institutionId","moduleKey") DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Backfill invariant guard. Abort the deploy if any non-PLATFORM institution
--    is left without an ACTIVE campus_movement row, so a partial backfill can
--    never ship a silently-403ing deploy (same RAISE EXCEPTION style the other
--    migrations use).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE missing INT;
BEGIN
  SELECT count(*) INTO missing
  FROM "institutions" i
  WHERE i."code" <> 'PLATFORM'
    AND NOT EXISTS (
      SELECT 1 FROM "institution_modules" m
      WHERE m."institutionId" = i."id"
        AND m."moduleKey" = 'campus_movement'
        AND m."state" = 'ACTIVE'
    );
  IF missing > 0 THEN
    RAISE EXCEPTION 'module-system backfill invariant violated: % institution(s) lack an ACTIVE campus_movement row; aborting deploy', missing;
  END IF;
END $$;
