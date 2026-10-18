-- Identity & RBAC B-2: membership / role / permission model.
--
-- Hand-authored (Prisma does not model composite FKs, partial unique indexes,
-- the (id, institutionId) composite uniques, RLS, or GRANTs natively, and its
-- diff would destructively drop/recreate the `role` column + the FROZEN B-1
-- composite FKs). The FROZEN B-1 migration (20261018110658_tenancy_isolation_rls)
-- is NOT touched. campass_app stays NOSUPERUSER NOBYPASSRLS — never granted
-- BYPASSRLS here.
--
-- Ordering is load-bearing (design §3.1):
--   0.  rename the legacy enum type Role -> UserRole IN PLACE (data-safe), add
--       the new nullable User columns;
--   1.  CREATE the 5 tables (institutionId NULLABLE on the two tenant tables so
--       the backfill can run);
--   2.  single-column FKs;
--   2a. partial unique index for template roles (institutionId IS NULL);
--   2b. seed catalogue -> template roles -> role_permissions (IN ORDER), each
--       ON CONFLICT DO NOTHING (hand-transcribed from @campusgate/shared);
--   3a. backfill one ACTIVE membership per non-superadmin, non-PLATFORM user;
--   3c. backfill exactly one membership-role per membership (users.role -> template);
--   4.  SET NOT NULL on both institutionId columns + the two DO $$ guards;
--   5.  (id, institutionId) composite unique + the three composite FKs + plain uniques;
--   6.  indexes;
--   7.  RLS ENABLE+FORCE + both tenant_isolation policies over the two tenant tables;
--   8.  idempotent campass_app GRANTs.
-- No CREATE EXTENSION (gen_random_uuid() is a core pg_catalog function on PG13+).

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Rename the legacy enum type IN PLACE (B-2 decision: model `Role` collides
--    with the `Role` enum in Prisma, so the enum is renamed to `UserRole`).
--    This is a pure rename — the enum values and every stored `users.role` value
--    are unchanged; no column is dropped or recreated, no data migration.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TYPE "Role" RENAME TO "UserRole";

-- New platform fields on users (nullable / defaulted; MFA fields modelled only).
ALTER TABLE "users" ADD COLUMN "phone"      TEXT;
ALTER TABLE "users" ADD COLUMN "mfaEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "mfaSecret"  TEXT;

-- New enum for membership lifecycle.
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. CREATE the 5 tables. institutionId on the two tenant-owned tables is
--    NULLABLE initially so the step-3 backfill can populate it before SET NOT NULL.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "permissions" (
    "id"          TEXT NOT NULL,
    "key"         TEXT NOT NULL,
    "module"      TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

CREATE TABLE "roles" (
    "id"            TEXT NOT NULL,
    "key"           TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "institutionId" TEXT,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "role_permissions" (
    "id"           TEXT NOT NULL,
    "roleId"       TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "institution_memberships" (
    "id"                 TEXT NOT NULL,
    "userId"             TEXT NOT NULL,
    "institutionId"      TEXT,
    "membershipStatus"   "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "departmentScope"    TEXT,
    "permissionsVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "institution_memberships_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "membership_roles" (
    "id"            TEXT NOT NULL,
    "membershipId"  TEXT NOT NULL,
    "roleId"        TEXT NOT NULL,
    "institutionId" TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "membership_roles_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Single-column FKs. Global/template joins stay single-column; the tenant
--    composite FKs are added in step 5 (after backfill + SET NOT NULL).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "role_permissions"
  ADD CONSTRAINT "role_permissions_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "role_permissions"
  ADD CONSTRAINT "role_permissions_permissionId_fkey"
  FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Unique required by the step-2b role_permissions ON CONFLICT (roleId, permissionId).
ALTER TABLE "role_permissions"
  ADD CONSTRAINT "role_permissions_roleId_permissionId_key" UNIQUE ("roleId", "permissionId");

ALTER TABLE "membership_roles"
  ADD CONSTRAINT "membership_roles_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "institution_memberships"
  ADD CONSTRAINT "institution_memberships_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- roles.institutionId -> institutions(id); NULL = platform template (SET NULL so
-- deleting a future tenant-custom role's institution degrades it to a template
-- rather than blocking; Phase 0 seeds only templates).
ALTER TABLE "roles"
  ADD CONSTRAINT "roles_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2a. Template-role uniqueness: a plain UNIQUE(key, institutionId) does NOT stop
--     two ('HOD', NULL) template rows (NULLs are distinct). Enforce one template
--     per key with a partial unique index. Keep the Prisma composite unique
--     (roles_key_institutionId_key) for the future tenant-custom case.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "roles_key_institutionId_key" ON "roles"("key", "institutionId");
CREATE UNIQUE INDEX "roles_key_template_unique"   ON "roles"("key") WHERE "institutionId" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2b. Seed the permission catalogue, the five template roles, and the
--     role->permission map, IN ORDER (permissions -> roles -> role_permissions):
--     role_permissions has single-column FKs to BOTH roles and permissions, so it
--     must be inserted last. These are global/template tables (no RLS), so plain
--     inserts as `postgres` are correct. Hand-transcribed from
--     @campusgate/shared PERMISSIONS (§4) + ROLE_PERMISSIONS (§5); the
--     catalogue-sync meta-test asserts set-equality against this block.
--     Deterministic ids (perm_/role_ prefixes) so the inserts are reproducible.
-- ─────────────────────────────────────────────────────────────────────────────

-- (i) permissions (39 keys: 18 campus_movement + 14 admin + 7 platform)
INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_campus_movement_pass_request',         'campus_movement.pass.request',          'campus_movement', 'Student creates a gate pass'),
  ('perm_campus_movement_pass_cancel',          'campus_movement.pass.cancel',           'campus_movement', 'Student cancels own pending pass'),
  ('perm_campus_movement_pass_view_own',        'campus_movement.pass.view_own',         'campus_movement', 'Student views own passes, history, timeline and summary'),
  ('perm_campus_movement_pass_view_department', 'campus_movement.pass.view_department',  'campus_movement', 'HOD views department requests, detail, timeline and stats'),
  ('perm_campus_movement_pass_approve',         'campus_movement.pass.approve',          'campus_movement', 'HOD approves a gate pass'),
  ('perm_campus_movement_pass_reject',          'campus_movement.pass.reject',           'campus_movement', 'HOD rejects a gate pass'),
  ('perm_campus_movement_pass_revoke',          'campus_movement.pass.revoke',           'campus_movement', 'HOD or Admin revokes a gate pass'),
  ('perm_campus_movement_pass_override',        'campus_movement.pass.override',         'campus_movement', 'Emergency override of a gate pass'),
  ('perm_campus_movement_gate_verify',          'campus_movement.gate.verify',           'campus_movement', 'Guard verifies a pass QR code'),
  ('perm_campus_movement_gate_mark_exit',       'campus_movement.gate.mark_exit',        'campus_movement', 'Guard marks a student exit'),
  ('perm_campus_movement_gate_mark_return',     'campus_movement.gate.mark_return',      'campus_movement', 'Guard marks a student return'),
  ('perm_campus_movement_gate_lookup',          'campus_movement.gate.lookup',           'campus_movement', 'Guard manual lookup and gate activity'),
  ('perm_campus_movement_shift_manage_own',     'campus_movement.shift.manage_own',      'campus_movement', 'Guard starts, ends and views own shift'),
  ('perm_campus_movement_emergency_view',       'campus_movement.emergency.view',        'campus_movement', 'View the active emergency'),
  ('perm_campus_movement_emergency_declare',    'campus_movement.emergency.declare',     'campus_movement', 'Admin declares an emergency'),
  ('perm_campus_movement_emergency_resolve',    'campus_movement.emergency.resolve',     'campus_movement', 'Admin resolves an emergency'),
  ('perm_campus_movement_analytics_view',       'campus_movement.analytics.view',        'campus_movement', 'Admin views dashboard stats and analytics'),
  ('perm_campus_movement_audit_view',           'campus_movement.audit.view',            'campus_movement', 'Admin reads audit logs'),
  ('perm_admin_users_view',                     'admin.users.view',                      'admin',           'View institution users'),
  ('perm_admin_users_create',                   'admin.users.create',                    'admin',           'Create institution users'),
  ('perm_admin_users_approve',                  'admin.users.approve',                   'admin',           'Approve pending institution users'),
  ('perm_admin_users_deactivate',               'admin.users.deactivate',                'admin',           'Deactivate institution users'),
  ('perm_admin_users_reactivate',               'admin.users.reactivate',                'admin',           'Reactivate institution users'),
  ('perm_admin_students_import',                'admin.students.import',                 'admin',           'Bulk import students'),
  ('perm_admin_students_export',                'admin.students.export',                 'admin',           'Export students (authorized and audited)'),
  ('perm_admin_departments_manage',             'admin.departments.manage',              'admin',           'Manage institution departments'),
  ('perm_admin_gates_manage',                   'admin.gates.manage',                    'admin',           'Manage gates and gate health'),
  ('perm_admin_shifts_manage',                  'admin.shifts.manage',                   'admin',           'Manage guard shift scheduling'),
  ('perm_admin_reasons_manage',                 'admin.reasons.manage',                  'admin',           'Manage pass reasons'),
  ('perm_admin_allowance_policy_manage',        'admin.allowance_policy.manage',         'admin',           'Manage the allowance policy'),
  ('perm_admin_institution_config_manage',      'admin.institution_config.manage',       'admin',           'Manage institution configuration'),
  ('perm_admin_academic_calendar_manage',       'admin.academic_calendar.manage',        'admin',           'Manage the academic calendar'),
  ('perm_platform_institutions_manage',         'platform.institutions.manage',          'platform',        'List, create and manage institution status'),
  ('perm_platform_analytics_view',              'platform.analytics.view',               'platform',        'View platform-wide aggregate analytics'),
  ('perm_platform_onboarding',                  'platform.onboarding',                   'platform',        'Platform onboarding (enforcement arrives with its phase)'),
  ('perm_platform_entitlements_manage',         'platform.entitlements.manage',          'platform',        'Manage module entitlements (enforcement arrives with its phase)'),
  ('perm_platform_subscriptions_manage',        'platform.subscriptions.manage',         'platform',        'Manage subscriptions (enforcement arrives with its phase)'),
  ('perm_platform_support_grant',               'platform.support.grant',                'platform',        'Grant support access (enforcement arrives with its phase)'),
  ('perm_platform_security_respond',            'platform.security.respond',             'platform',        'Respond to security events (enforcement arrives with its phase)')
ON CONFLICT ("key") DO NOTHING;

-- (ii) template roles (institutionId NULL; deterministic ids)
INSERT INTO "roles" ("id","key","name","institutionId") VALUES
  ('role_template_student',     'STUDENT',     'Student',     NULL),
  ('role_template_guard',       'GUARD',       'Guard',       NULL),
  ('role_template_hod',         'HOD',         'HOD',         NULL),
  ('role_template_admin',       'ADMIN',       'Admin',       NULL),
  ('role_template_super_admin', 'SUPER_ADMIN', 'Super Admin', NULL)
ON CONFLICT DO NOTHING;

-- (iii) role_permissions (the §5 map; 44 (roleKey, permissionKey) pairs).
--       Resolve ids by join so this stays correct even if a row already exists.
INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  -- STUDENT
  ('STUDENT',     'campus_movement.pass.request'),
  ('STUDENT',     'campus_movement.pass.cancel'),
  ('STUDENT',     'campus_movement.pass.view_own'),
  ('STUDENT',     'campus_movement.emergency.view'),
  -- GUARD
  ('GUARD',       'campus_movement.gate.verify'),
  ('GUARD',       'campus_movement.gate.mark_exit'),
  ('GUARD',       'campus_movement.gate.mark_return'),
  ('GUARD',       'campus_movement.gate.lookup'),
  ('GUARD',       'campus_movement.shift.manage_own'),
  ('GUARD',       'campus_movement.emergency.view'),
  -- HOD
  ('HOD',         'campus_movement.pass.view_department'),
  ('HOD',         'campus_movement.pass.approve'),
  ('HOD',         'campus_movement.pass.reject'),
  ('HOD',         'campus_movement.pass.revoke'),
  ('HOD',         'campus_movement.pass.override'),
  ('HOD',         'campus_movement.emergency.view'),
  -- ADMIN (all admin.* + the 7 campus_movement keys)
  ('ADMIN',       'admin.users.view'),
  ('ADMIN',       'admin.users.create'),
  ('ADMIN',       'admin.users.approve'),
  ('ADMIN',       'admin.users.deactivate'),
  ('ADMIN',       'admin.users.reactivate'),
  ('ADMIN',       'admin.students.import'),
  ('ADMIN',       'admin.students.export'),
  ('ADMIN',       'admin.departments.manage'),
  ('ADMIN',       'admin.gates.manage'),
  ('ADMIN',       'admin.shifts.manage'),
  ('ADMIN',       'admin.reasons.manage'),
  ('ADMIN',       'admin.allowance_policy.manage'),
  ('ADMIN',       'admin.institution_config.manage'),
  ('ADMIN',       'admin.academic_calendar.manage'),
  ('ADMIN',       'campus_movement.pass.revoke'),
  ('ADMIN',       'campus_movement.pass.override'),
  ('ADMIN',       'campus_movement.emergency.declare'),
  ('ADMIN',       'campus_movement.emergency.resolve'),
  ('ADMIN',       'campus_movement.emergency.view'),
  ('ADMIN',       'campus_movement.analytics.view'),
  ('ADMIN',       'campus_movement.audit.view'),
  -- SUPER_ADMIN (all platform.*; NO campus_movement.* or admin.*)
  ('SUPER_ADMIN', 'platform.institutions.manage'),
  ('SUPER_ADMIN', 'platform.analytics.view'),
  ('SUPER_ADMIN', 'platform.onboarding'),
  ('SUPER_ADMIN', 'platform.entitlements.manage'),
  ('SUPER_ADMIN', 'platform.subscriptions.manage'),
  ('SUPER_ADMIN', 'platform.support.grant'),
  ('SUPER_ADMIN', 'platform.security.respond')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3a. Backfill one ACTIVE membership per existing TENANT user. SUPER_ADMIN users
--     are excluded (no tenant membership); any user attached to the PLATFORM
--     institution is also excluded (so a non-superadmin on PLATFORM never gets a
--     tenant membership). gen_random_uuid()::text ids with a mbr_ prefix.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "institution_memberships" ("id","userId","institutionId","membershipStatus","permissionsVersion","createdAt","updatedAt")
SELECT 'mbr_' || gen_random_uuid()::text, u."id", u."institutionId", 'ACTIVE', 0, now(), now()
FROM "users" u
WHERE u."role" <> 'SUPER_ADMIN'
  AND u."institutionId" <> (SELECT "id" FROM "institutions" WHERE "code" = 'PLATFORM');

-- ─────────────────────────────────────────────────────────────────────────────
-- 3c. Backfill exactly one membership-role per membership, binding each user's
--     legacy role enum to the matching template role (institutionId IS NULL).
--     institutionId is denormalised from the membership so step 4 SET NOT NULL holds.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "membership_roles" ("id","membershipId","roleId","institutionId","createdAt","updatedAt")
SELECT 'mrl_' || gen_random_uuid()::text, m."id", r."id", m."institutionId", now(), now()
FROM "institution_memberships" m
JOIN "users" u ON u."id" = m."userId"
JOIN "roles"  r ON r."key" = u."role"::text AND r."institutionId" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. SET NOT NULL on both tenant keys + the two fail-closed guards.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "institution_memberships" ALTER COLUMN "institutionId" SET NOT NULL;
ALTER TABLE "membership_roles"        ALTER COLUMN "institutionId" SET NOT NULL;

-- Null-tenant guard (mirrors B-1 §2b).
DO $$
DECLARE
  cnt BIGINT;
BEGIN
  SELECT count(*) INTO cnt FROM "institution_memberships" WHERE "institutionId" IS NULL;
  IF cnt > 0 THEN
    RAISE EXCEPTION 'identity_rbac_b2 backfill invariant violated: % membership(s) have a NULL institutionId; aborting deploy', cnt;
  END IF;
  SELECT count(*) INTO cnt FROM "membership_roles" WHERE "institutionId" IS NULL;
  IF cnt > 0 THEN
    RAISE EXCEPTION 'identity_rbac_b2 backfill invariant violated: % membership-role(s) have a NULL institutionId; aborting deploy', cnt;
  END IF;
END $$;

-- Exactly-one-membership-role guard (count <> 1 aborts loudly, naming a sample row).
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. (id, institutionId) composite unique on institution_memberships + the three
--    composite FKs that carry institutionId (so a child can never bind to another
--    tenant's parent) + plain uniques. All ON DELETE RESTRICT (B-1's uniform
--    convention); the departmentScope FK is MATCH SIMPLE + nullable (the check is
--    skipped exactly when departmentScope is NULL) and RESTRICT (NOT SET NULL — a
--    composite SET NULL would null the NOT NULL institutionId leg, §2.2).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "institution_memberships"
  ADD CONSTRAINT "institution_memberships_id_institutionId_key" UNIQUE ("id", "institutionId");

ALTER TABLE "institution_memberships"
  ADD CONSTRAINT "institution_memberships_user_same_tenant_fkey"
  FOREIGN KEY ("userId", "institutionId") REFERENCES "users"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "institution_memberships"
  ADD CONSTRAINT "institution_memberships_departmentScope_same_tenant_fkey"
  FOREIGN KEY ("departmentScope", "institutionId") REFERENCES "departments"("id", "institutionId")
  MATCH SIMPLE ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "membership_roles"
  ADD CONSTRAINT "membership_roles_membership_same_tenant_fkey"
  FOREIGN KEY ("membershipId", "institutionId") REFERENCES "institution_memberships"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Plain uniques (match the Prisma @@unique declarations).
ALTER TABLE "institution_memberships"
  ADD CONSTRAINT "institution_memberships_userId_institutionId_key" UNIQUE ("userId", "institutionId");
ALTER TABLE "membership_roles"
  ADD CONSTRAINT "membership_roles_membershipId_roleId_key" UNIQUE ("membershipId", "roleId");

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Indexes (match the Prisma @@index declarations).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX "institution_memberships_institutionId_idx" ON "institution_memberships"("institutionId");
CREATE INDEX "institution_memberships_userId_idx"        ON "institution_memberships"("userId");
CREATE INDEX "membership_roles_institutionId_idx"        ON "membership_roles"("institutionId");
CREATE INDEX "permissions_module_idx"                    ON "permissions"("module");
CREATE INDEX "roles_institutionId_idx"                   ON "roles"("institutionId");

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. RLS on the two tenant-owned tables (reuse the exact B-1 pattern).
--    permissions / roles / role_permissions get NO RLS (global/template).
--    current_setting(..., true) returns NULL when unset => "=" yields no rows
--    => fail-closed.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  rls_tables TEXT[] := ARRAY['institution_memberships','membership_roles'];
BEGIN
  FOREACH t IN ARRAY rls_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS "tenant_isolation_select" ON %I', t);
    EXECUTE format(
      'CREATE POLICY "tenant_isolation_select" ON %I FOR SELECT '
      || 'USING ("institutionId" = current_setting(''app.current_institution_id'', true))',
      t);

    EXECUTE format('DROP POLICY IF EXISTS "tenant_isolation_modify" ON %I', t);
    EXECUTE format(
      'CREATE POLICY "tenant_isolation_modify" ON %I FOR ALL '
      || 'USING ("institutionId" = current_setting(''app.current_institution_id'', true)) '
      || 'WITH CHECK ("institutionId" = current_setting(''app.current_institution_id'', true))',
      t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. campass_app GRANTs (idempotent). The role ALREADY EXISTS in Supabase
--    (NOSUPERUSER NOBYPASSRLS). Never create it or set a password here; never
--    grant BYPASSRLS. Guard so the migration still applies where it is absent.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT USAGE ON SCHEMA public TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "campass_app";
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "campass_app";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "campass_app";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO "campass_app";
  END IF;
END $$;
