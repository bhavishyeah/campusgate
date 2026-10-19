-- Super Admin & platform security (FEAT-001): AuditLog v2 + SupportGrant break-glass.
--
-- Hand-authored (Prisma's diff does not model RLS, the append-only trigger, the
-- CHECK, or the targeted GRANT/REVOKE refresh). ADDITIVE ONLY: it creates two
-- new tables, adds two columns to `users`, and NEVER alters the FROZEN B-1
-- (20261018110658_tenancy_isolation_rls) or identity_rbac_b2
-- (20261018171747_identity_rbac_b2) objects. campass_app stays NOSUPERUSER
-- NOBYPASSRLS — never granted BYPASSRLS here.
--
-- Ordering is load-bearing (design §2.6):
--   1.  CREATE TYPE AuditResult, SupportGrantStatus;
--   2.  CREATE TABLE support_grants + indexes + single-column FKs;
--   3.  CREATE TABLE audit_events + indexes + single-column FKs;
--   4.  ALTER users ADD mfaRecoveryCodes, mfaEnrolledAt;
--   5.  non-empty purpose CHECK;
--   2b. seed the ONE new permission (admin.support.revoke) + its ADMIN
--       role_permissions pair (same markers the catalogue-sync test parses);
--   6.  DO $$ ENABLE+FORCE RLS + the SELECT/INSERT policies (NO TO postgres);
--   6a. audit_events append-only trigger (binds EVERY role incl. the owner);
--   7.  guarded campass_app GRANT refresh with the targeted REVOKEs.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Enums.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "AuditResult" AS ENUM ('SUCCESS', 'DENIED', 'ERROR');
CREATE TYPE "SupportGrantStatus" AS ENUM ('REQUESTED', 'ACTIVE', 'EXPIRED', 'REVOKED');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. support_grants (PLATFORM table; institutionId is a plain FK to the ONE
--    target tenant, NOT a tenant-ownership column in the RLS sense). Single-
--    column FKs only.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "support_grants" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "grantedToUserId" TEXT NOT NULL,
    "purpose"         TEXT NOT NULL,
    "scope"           JSONB,
    "status"          "SupportGrantStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt"     TIMESTAMP(3),
    "expiresAt"       TIMESTAMP(3) NOT NULL,
    "revokedAt"       TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revokedReason"   TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_grants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_grants_institutionId_status_idx"   ON "support_grants"("institutionId", "status");
CREATE INDEX "support_grants_grantedToUserId_status_idx" ON "support_grants"("grantedToUserId", "status");

ALTER TABLE "support_grants"
  ADD CONSTRAINT "support_grants_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_grants"
  ADD CONSTRAINT "support_grants_grantedToUserId_fkey"
  FOREIGN KEY ("grantedToUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_grants"
  ADD CONSTRAINT "support_grants_revokedByUserId_fkey"
  FOREIGN KEY ("revokedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. audit_events (generic string action; institutionId NULLABLE for platform
--    rows). Single-column FKs: actorUserId -> users, institutionId ->
--    institutions, supportGrantId -> support_grants.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "audit_events" (
    "id"                TEXT NOT NULL,
    "institutionId"     TEXT,
    "actorUserId"       TEXT NOT NULL,
    "actorMembershipId" TEXT,
    "actorRoleKey"      TEXT NOT NULL,
    "action"            TEXT NOT NULL,
    "resourceType"      TEXT NOT NULL,
    "resourceId"        TEXT,
    "result"            "AuditResult" NOT NULL,
    "supportGrantId"    TEXT,
    "requestRef"        TEXT,
    "metadata"          JSONB,
    "timestamp"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_events_institutionId_timestamp_idx" ON "audit_events"("institutionId", "timestamp");
CREATE INDEX "audit_events_actorUserId_timestamp_idx"   ON "audit_events"("actorUserId", "timestamp");
CREATE INDEX "audit_events_action_timestamp_idx"        ON "audit_events"("action", "timestamp");
CREATE INDEX "audit_events_supportGrantId_idx"          ON "audit_events"("supportGrantId");

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_supportGrantId_fkey"
  FOREIGN KEY ("supportGrantId") REFERENCES "support_grants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. New MFA columns on users (nullable; modelled-only here, wired in a later
--    feature). mfaEnabled / mfaSecret already exist (identity_rbac_b2).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "users" ADD COLUMN "mfaRecoveryCodes" JSONB;
ALTER TABLE "users" ADD COLUMN "mfaEnrolledAt"    TIMESTAMP(3);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Non-empty purpose CHECK (a break-glass grant must state a purpose).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "support_grants"
  ADD CONSTRAINT "support_grants_purpose_nonempty" CHECK (length(btrim("purpose")) > 0);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2b. Seed the ONE new permission (admin.support.revoke) and its ADMIN
--     role-permission pair, using the same seed-block shape + join as the
--     identity_rbac_b2 seed so the generalized catalogue-sync meta-test parses
--     both blocks. Both inserts are idempotent (DO NOTHING on conflict). The
--     ADMIN template role and the permission catalogue already exist.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_admin_support_revoke', 'admin.support.revoke', 'admin', 'Tenant admin revokes a break-glass support grant into their institution')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('ADMIN', 'admin.support.revoke')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. RLS. ENABLE + FORCE on both new tables, with ONLY the load-bearing
--    campass_app (NOBYPASSRLS) policies. NO `TO postgres` policies — postgres
--    bypasses RLS entirely, so such a policy would be inert and misleading
--    (design §0/§2.4/§2.5). nullif(current_setting(...), '') fails closed for
--    BOTH an unset GUC (already NULL) and an empty-string GUC: "institutionId"
--    = NULL is NULL (not TRUE) so no row matches / WITH CHECK fails.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- support_grants: ENABLE + FORCE; tenants read ONLY their own grants (no
  -- modify policy — writes happen on the privileged bypass role).
  ALTER TABLE "support_grants" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "support_grants" FORCE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "support_grants_tenant_read" ON "support_grants";
  CREATE POLICY "support_grants_tenant_read" ON "support_grants"
    FOR SELECT
    USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

  -- audit_events: ENABLE + FORCE; tenants read ONLY their own rows (NULL
  -- platform rows never match "=" and stay invisible), and may INSERT ONLY a
  -- row for their active tenant (no UPDATE/DELETE policy => append-only for
  -- campass_app).
  ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "tenant_isolation_select" ON "audit_events";
  CREATE POLICY "tenant_isolation_select" ON "audit_events"
    FOR SELECT
    USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

  DROP POLICY IF EXISTS "audit_events_tenant_insert" ON "audit_events";
  CREATE POLICY "audit_events_tenant_insert" ON "audit_events"
    FOR INSERT
    WITH CHECK ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6a. Append-only trigger on audit_events. A BEFORE UPDATE OR DELETE trigger
--     binds EVERY role — including the table owner / postgres (privileged) path,
--     which GRANTs cannot restrict — so audit rows can only ever be inserted.
--     Does NOT touch support_grants (grant lazy-expiry mutates THAT table, not
--     audit_events), so §6.4 expiry is unaffected.
-- ─────────────────────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. campass_app GRANT refresh (guarded + idempotent). The live B-1 grant uses
--    GRANT ... ON ALL TABLES + ALTER DEFAULT PRIVILEGES, so the two new tables
--    inherit SELECT/INSERT/UPDATE/DELETE by default. Pin them:
--      - audit_events : keep SELECT, INSERT; REVOKE UPDATE, DELETE
--                       (append-only for the tenant role, transactional INSERT ok);
--      - support_grants: keep SELECT; REVOKE INSERT, UPDATE, DELETE
--                       (read-only transparency; only the platform path writes).
--    Never grant BYPASSRLS.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT ON "audit_events" TO "campass_app";
    REVOKE UPDATE, DELETE ON "audit_events" FROM "campass_app";

    GRANT SELECT ON "support_grants" TO "campass_app";
    REVOKE INSERT, UPDATE, DELETE ON "support_grants" FROM "campass_app";
  END IF;
END $$;
