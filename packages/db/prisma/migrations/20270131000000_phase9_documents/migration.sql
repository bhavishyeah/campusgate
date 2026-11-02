-- CAMPASS Phase 9.7 — Document Management (backend only): the SEVENTH and FINAL
-- module of Phase 9 (and of the entire backend). A gated ("booster") module
-- layered on the shared foundation (User / Department / Institution),
-- INDEPENDENT of Phase 9.1-9.6 — no coupling in either direction. Large file
-- BLOBS live in OBJECT STORAGE (Supabase Storage) behind the ObjectStore adapter
-- seam; the relational DB stores only document METADATA — filename, content
-- type, size, sha256, ownership, access grants, a version chain, retention
-- state, and the tenant-prefixed storage key. StudentDocument (SIS) and
-- ApplicationDocument (admissions) are SEPARATE tables and are NOT touched.
--
-- Hand-authored (Prisma's diff models neither RLS, the composite same-tenant
-- FKs, the CHECKs, the append-only triggers, the lifecycle column guard, the
-- targeted GRANT refresh, nor the catalogue seed). STRICTLY ADDITIVE: it only
-- CREATEs new objects + one additive catalogue seed. It NEVER edits any
-- pre-existing migration directory (every prior dir stays byte-identical), never
-- touches the _prisma_migrations ledger, and campass_app stays NOSUPERUSER
-- NOBYPASSRLS — never granted BYPASSRLS.
--
-- SIX new tenant-owned tables:
--   THREE mutable/guarded (updatedAt NOT NULL):
--     * document_retention_policies — mutable-with-audit, NO trigger.
--     * documents                   — forward-only lifecycle column guard
--                                      (document_status_guard; ACTIVE ->
--                                      ARCHIVED -> PURGE_PENDING -> PURGED
--                                      terminal).
--     * document_access_grants      — mutable config (grant/revoke-with-audit),
--                                      NO trigger.
--   TWO append-only (createdAt/uploadedAt-only, NO updatedAt):
--     * document_versions           — append-only version chain.
--     * document_access_logs        — append-only download/access ledger.
-- Every table carries institutionId + (id, institutionId) composite unique +
-- (institutionId) index + composite same-tenant FKs incl. institutionId +
-- ENABLE+FORCE RLS.
--
-- Ordering (mirrors the service-requests lettered house style a-j):
--   a. CREATE TYPE the three new enums.
--   b. CREATE TABLE the six tables + PKs (three carry updatedAt NOT NULL; two
--      append-only are createdAt/uploadedAt-only; sizeBytes BIGINT).
--   c. (id,institutionId) unique + (institutionId)/query indexes + business
--      uniques (policies name; versions (documentId,version) + storageKey; the
--      two PARTIAL live-grant uniques WHERE revokedAt IS NULL).
--   d. tenant-root institutionId -> institutions(id) RESTRICT on all six.
--   e. composite same-tenant FKs (each carries institutionId; MATCH SIMPLE for
--      nullable retentionPolicyId / granteeUserId / granteeDepartmentId).
--   f. CHECKs.
--   g. ENABLE+FORCE RLS (standard pair on the three mutable/guarded; append-only
--      {tenant_isolation_select, <table>_tenant_insert} pair on the two ledgers).
--   h. two append-only triggers + the document_status_guard column guard.
--   i. guarded + idempotent campass_app GRANT refresh (SELECT,INSERT,UPDATE on
--      the three; SELECT,INSERT + REVOKE UPDATE,DELETE on the two append-only).
--   j. catalogue seed: the DOCUMENT_MANAGER role row (BEFORE the permissions
--      block) + the seven documents.* permissions + the 26 role_permissions
--      pairs.

-- ─────────────────────────────────────────────────────────────────────────────
-- a. Enums.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "DocumentStatus"       AS ENUM ('ACTIVE', 'ARCHIVED', 'PURGE_PENDING', 'PURGED');
CREATE TYPE "DocumentAccessLevel"  AS ENUM ('READ', 'MANAGE');
CREATE TYPE "DocumentAccessAction" AS ENUM ('DOWNLOAD_URL_MINTED');

-- ─────────────────────────────────────────────────────────────────────────────
-- b. New tenant-owned tables + PKs. Three mutable/guarded carry updatedAt NOT
--    NULL; two append-only are createdAt/uploadedAt-only. Actor/provenance ids
--    (createdByUserId, revokedByUserId) + document.currentVersionId +
--    document_access_logs.versionId are recorded ids with NO FK (the
--    service-requests actor-id / pointer precedent). sizeBytes BIGINT.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "document_retention_policies" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "retentionDays"   INTEGER NOT NULL,
    "category"        TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_retention_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "documents" (
    "id"                TEXT NOT NULL,
    "institutionId"     TEXT NOT NULL,
    "title"             TEXT NOT NULL,
    "description"       TEXT,
    "category"          TEXT,
    "ownerUserId"       TEXT NOT NULL,
    "currentVersionId"  TEXT,
    "status"            "DocumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "retentionPolicyId" TEXT,
    "retainUntil"       TIMESTAMP(3),
    "createdByUserId"   TEXT NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- append-only (uploadedAt-only, NO updatedAt)
CREATE TABLE "document_versions" (
    "id"               TEXT NOT NULL,
    "institutionId"    TEXT NOT NULL,
    "documentId"       TEXT NOT NULL,
    "version"          INTEGER NOT NULL,
    "filename"         TEXT NOT NULL,
    "contentType"      TEXT NOT NULL,
    "sizeBytes"        BIGINT NOT NULL,
    "checksumSha256"   TEXT NOT NULL,
    "storageKey"       TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "uploadedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_access_grants" (
    "id"                  TEXT NOT NULL,
    "institutionId"       TEXT NOT NULL,
    "documentId"          TEXT NOT NULL,
    "granteeUserId"       TEXT,
    "granteeDepartmentId" TEXT,
    "accessLevel"         "DocumentAccessLevel" NOT NULL,
    "grantedByUserId"     TEXT NOT NULL,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,
    "revokedAt"           TIMESTAMP(3),
    "revokedByUserId"     TEXT,

    CONSTRAINT "document_access_grants_pkey" PRIMARY KEY ("id")
);

-- append-only (createdAt-only, NO updatedAt)
CREATE TABLE "document_access_logs" (
    "id"            TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "documentId"    TEXT NOT NULL,
    "versionId"     TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "action"        "DocumentAccessAction" NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_access_logs_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- c. Unique + query indexes. (id, institutionId) anchors the composite
--    same-tenant FKs; (institutionId) + per-query indexes; business uniques
--    (one policy name per institution; one (documentId, version) + one
--    storageKey per institution on versions). The two PARTIAL live-grant unique
--    indexes on document_access_grants permit re-granting after a revoke
--    (WHERE revokedAt IS NULL scopes uniqueness to the single live grant).
-- ─────────────────────────────────────────────────────────────────────────────
-- document_retention_policies
CREATE UNIQUE INDEX "document_retention_policies_id_institutionId_key" ON "document_retention_policies"("id", "institutionId");
CREATE UNIQUE INDEX "document_retention_policies_institutionId_name_key" ON "document_retention_policies"("institutionId", "name");
CREATE INDEX        "document_retention_policies_institutionId_idx" ON "document_retention_policies"("institutionId");

-- documents
CREATE UNIQUE INDEX "documents_id_institutionId_key" ON "documents"("id", "institutionId");
CREATE INDEX        "documents_institutionId_idx" ON "documents"("institutionId");
CREATE INDEX        "documents_institutionId_ownerUserId_idx" ON "documents"("institutionId", "ownerUserId");
CREATE INDEX        "documents_institutionId_status_idx" ON "documents"("institutionId", "status");
CREATE INDEX        "documents_institutionId_retentionPolicyId_idx" ON "documents"("institutionId", "retentionPolicyId");
CREATE INDEX        "documents_institutionId_retainUntil_idx" ON "documents"("institutionId", "retainUntil");

-- document_versions
CREATE UNIQUE INDEX "document_versions_id_institutionId_key" ON "document_versions"("id", "institutionId");
CREATE UNIQUE INDEX "document_versions_institutionId_document_version_key" ON "document_versions"("institutionId", "documentId", "version");
CREATE UNIQUE INDEX "document_versions_institutionId_storageKey_key" ON "document_versions"("institutionId", "storageKey");
CREATE INDEX        "document_versions_institutionId_idx" ON "document_versions"("institutionId");
CREATE INDEX        "document_versions_institutionId_document_idx" ON "document_versions"("institutionId", "documentId");

-- document_access_grants
CREATE UNIQUE INDEX "document_access_grants_id_institutionId_key" ON "document_access_grants"("id", "institutionId");
CREATE UNIQUE INDEX "document_access_grants_live_user_key"
  ON "document_access_grants"("institutionId", "documentId", "granteeUserId")
  WHERE "granteeUserId" IS NOT NULL AND "revokedAt" IS NULL;
CREATE UNIQUE INDEX "document_access_grants_live_dept_key"
  ON "document_access_grants"("institutionId", "documentId", "granteeDepartmentId")
  WHERE "granteeDepartmentId" IS NOT NULL AND "revokedAt" IS NULL;
CREATE INDEX        "document_access_grants_institutionId_idx" ON "document_access_grants"("institutionId");
CREATE INDEX        "document_access_grants_institutionId_document_idx" ON "document_access_grants"("institutionId", "documentId");
CREATE INDEX        "document_access_grants_institutionId_granteeUser_idx" ON "document_access_grants"("institutionId", "granteeUserId");
CREATE INDEX        "document_access_grants_institutionId_granteeDept_idx" ON "document_access_grants"("institutionId", "granteeDepartmentId");

-- document_access_logs
CREATE UNIQUE INDEX "document_access_logs_id_institutionId_key" ON "document_access_logs"("id", "institutionId");
CREATE INDEX        "document_access_logs_institutionId_idx" ON "document_access_logs"("institutionId");
CREATE INDEX        "document_access_logs_institutionId_document_idx" ON "document_access_logs"("institutionId", "documentId");
CREATE INDEX        "document_access_logs_institutionId_user_idx" ON "document_access_logs"("institutionId", "userId");
CREATE INDEX        "document_access_logs_institutionId_createdAt_idx" ON "document_access_logs"("institutionId", "createdAt");

-- ─────────────────────────────────────────────────────────────────────────────
-- d. Tenant-root FKs.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "document_retention_policies" ADD CONSTRAINT "document_retention_policies_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents"                   ADD CONSTRAINT "documents_institutionId_fkey"                   FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_versions"           ADD CONSTRAINT "document_versions_institutionId_fkey"           FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_access_grants"      ADD CONSTRAINT "document_access_grants_institutionId_fkey"      FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_access_logs"        ADD CONSTRAINT "document_access_logs_institutionId_fkey"        FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- e. Composite same-tenant FKs (each carries institutionId so a child can never
--    reference a parent in another tenant). All ON DELETE RESTRICT ON UPDATE
--    CASCADE. Nullable retentionPolicyId / granteeUserId / granteeDepartmentId
--    use MATCH SIMPLE so a NULL column is a no-op (the service-requests
--    nullable-assignee precedent). document.currentVersionId and all *ByUserId
--    recorded ids + document_access_logs.versionId carry NO FK.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_owner_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "ownerUserId") REFERENCES "users"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_retention_policy_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "retentionPolicyId") REFERENCES "document_retention_policies"("institutionId", "id") MATCH SIMPLE
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "document_versions"
  ADD CONSTRAINT "document_versions_document_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "documentId") REFERENCES "documents"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_versions"
  ADD CONSTRAINT "document_versions_uploaded_by_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "uploadedByUserId") REFERENCES "users"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "document_access_grants"
  ADD CONSTRAINT "document_access_grants_document_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "documentId") REFERENCES "documents"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_access_grants"
  ADD CONSTRAINT "document_access_grants_grantee_user_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "granteeUserId") REFERENCES "users"("institutionId", "id") MATCH SIMPLE
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_access_grants"
  ADD CONSTRAINT "document_access_grants_grantee_dept_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "granteeDepartmentId") REFERENCES "departments"("institutionId", "id") MATCH SIMPLE
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_access_grants"
  ADD CONSTRAINT "document_access_grants_granted_by_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "grantedByUserId") REFERENCES "users"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "document_access_logs"
  ADD CONSTRAINT "document_access_logs_document_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "documentId") REFERENCES "documents"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_access_logs"
  ADD CONSTRAINT "document_access_logs_user_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "userId") REFERENCES "users"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- f. CHECKs. Non-empty strings; retentionDays >= 1; sizeBytes >= 0; version >= 1;
--    checksumSha256 64-hex; grant XOR grantee.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "document_retention_policies"
  ADD CONSTRAINT "document_retention_policies_name_nonempty_check" CHECK (char_length("name") >= 1);
ALTER TABLE "document_retention_policies"
  ADD CONSTRAINT "document_retention_policies_retentionDays_positive_check" CHECK ("retentionDays" >= 1);

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_title_nonempty_check" CHECK (char_length("title") >= 1);

ALTER TABLE "document_versions"
  ADD CONSTRAINT "document_versions_version_positive_check" CHECK ("version" >= 1);
ALTER TABLE "document_versions"
  ADD CONSTRAINT "document_versions_filename_nonempty_check" CHECK (char_length("filename") >= 1);
ALTER TABLE "document_versions"
  ADD CONSTRAINT "document_versions_contentType_nonempty_check" CHECK (char_length("contentType") >= 1);
ALTER TABLE "document_versions"
  ADD CONSTRAINT "document_versions_sizeBytes_nonnegative_check" CHECK ("sizeBytes" >= 0);
ALTER TABLE "document_versions"
  ADD CONSTRAINT "document_versions_checksum_hex_check" CHECK ("checksumSha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "document_versions"
  ADD CONSTRAINT "document_versions_storageKey_nonempty_check" CHECK (char_length("storageKey") >= 1);

ALTER TABLE "document_access_grants"
  ADD CONSTRAINT "document_access_grants_grantee_xor_check"
  CHECK (("granteeUserId" IS NOT NULL) <> ("granteeDepartmentId" IS NOT NULL));

-- ─────────────────────────────────────────────────────────────────────────────
-- g. RLS. ENABLE + FORCE on all six. The three mutable/guarded get the standard
--    fail-closed nullif-guarded pair {tenant_isolation_select,
--    tenant_isolation_modify}. The two append-only ledgers get the append-only
--    pair {tenant_isolation_select, <table>_tenant_insert} (NO modify policy).
--    nullif(current_setting('app.current_institution_id', true), '') fails closed
--    for both an unset and an empty-string GUC.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  mutable_tables TEXT[] := ARRAY[
    'document_retention_policies', 'documents', 'document_access_grants'
  ];
  append_only_tables TEXT[] := ARRAY[
    'document_versions', 'document_access_logs'
  ];
BEGIN
  FOREACH t IN ARRAY mutable_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS "tenant_isolation_select" ON %I', t);
    EXECUTE format(
      'CREATE POLICY "tenant_isolation_select" ON %I FOR SELECT '
      || 'USING ("institutionId" = nullif(current_setting(''app.current_institution_id'', true), ''''))',
      t);

    EXECUTE format('DROP POLICY IF EXISTS "tenant_isolation_modify" ON %I', t);
    EXECUTE format(
      'CREATE POLICY "tenant_isolation_modify" ON %I FOR ALL '
      || 'USING ("institutionId" = nullif(current_setting(''app.current_institution_id'', true), '''')) '
      || 'WITH CHECK ("institutionId" = nullif(current_setting(''app.current_institution_id'', true), ''''))',
      t);
  END LOOP;

  FOREACH t IN ARRAY append_only_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS "tenant_isolation_select" ON %I', t);
    EXECUTE format(
      'CREATE POLICY "tenant_isolation_select" ON %I FOR SELECT '
      || 'USING ("institutionId" = nullif(current_setting(''app.current_institution_id'', true), ''''))',
      t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT '
      || 'WITH CHECK ("institutionId" = nullif(current_setting(''app.current_institution_id'', true), ''''))',
      t || '_tenant_insert', t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- h. Triggers.
--
--   h.1 The two append-only tables mirror the service-requests ledger shape: a
--       <table>_append_only() plpgsql function raising restrict_violation, bound
--       by a BEFORE UPDATE OR DELETE ... FOR EACH ROW trigger (binds the owner
--       too — GRANTs alone cannot restrict the owner).
--   h.2 documents forward-only terminal-enforcing lifecycle column guard.
-- ─────────────────────────────────────────────────────────────────────────────

-- h.1 document_versions
CREATE OR REPLACE FUNCTION "document_versions_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document_versions is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;$$;
CREATE TRIGGER "document_versions_no_update_delete"
  BEFORE UPDATE OR DELETE ON "document_versions"
  FOR EACH ROW EXECUTE FUNCTION "document_versions_append_only"();

-- h.1 document_access_logs
CREATE OR REPLACE FUNCTION "document_access_logs_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document_access_logs is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;$$;
CREATE TRIGGER "document_access_logs_no_update_delete"
  BEFORE UPDATE OR DELETE ON "document_access_logs"
  FOR EACH ROW EXECUTE FUNCTION "document_access_logs_append_only"();

-- h.2 documents forward-only terminal-enforcing lifecycle column guard (§12).
--     Legal edges (plus the no-op self transition): ACTIVE->ARCHIVED,
--     ACTIVE->PURGE_PENDING, ARCHIVED->ACTIVE, ARCHIVED->PURGE_PENDING,
--     PURGE_PENDING->PURGED. PURGED is TERMINAL (no legal source edge out of it).
--     Freezes the identity columns (institutionId, ownerUserId, createdAt) via
--     IS DISTINCT FROM; forbids DELETE. Byte-for-byte the service-requests guard
--     idiom.
CREATE OR REPLACE FUNCTION "document_status_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'documents is guarded: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- frozen identity columns.
  IF NEW."institutionId" IS DISTINCT FROM OLD."institutionId"
  OR NEW."ownerUserId"   IS DISTINCT FROM OLD."ownerUserId"
  OR NEW."createdAt"     IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'immutable documents column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- Enumerated forward-only transitions (plus the no-op self transition). PURGED
  -- is terminal because it is not a legal source state below.
  IF NOT (
       (OLD."status" = 'ACTIVE'        AND NEW."status" = 'ARCHIVED')
    OR (OLD."status" = 'ACTIVE'        AND NEW."status" = 'PURGE_PENDING')
    OR (OLD."status" = 'ARCHIVED'      AND NEW."status" = 'ACTIVE')
    OR (OLD."status" = 'ARCHIVED'      AND NEW."status" = 'PURGE_PENDING')
    OR (OLD."status" = 'PURGE_PENDING' AND NEW."status" = 'PURGED')
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal documents status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "document_status_guard"
  BEFORE UPDATE OR DELETE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION "document_status_guard"();

-- ─────────────────────────────────────────────────────────────────────────────
-- i. campass_app GRANT refresh (guarded + idempotent). The three mutable/guarded
--    tables get SELECT, INSERT, UPDATE (NO DELETE — the documents guard forbids
--    DELETE anyway, and policies/grants are never hard-deleted, only
--    updated/revoked). The two append-only ledgers get SELECT, INSERT and an
--    explicit REVOKE UPDATE, DELETE (the service-requests ledger precedent).
--    Never grant BYPASSRLS.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "document_retention_policies" TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "documents"                   TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "document_access_grants"      TO "campass_app";

    GRANT SELECT, INSERT ON "document_versions"    TO "campass_app";
    GRANT SELECT, INSERT ON "document_access_logs" TO "campass_app";
    REVOKE UPDATE, DELETE ON "document_versions"    FROM "campass_app";
    REVOKE UPDATE, DELETE ON "document_access_logs" FROM "campass_app";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- j. Catalogue seed. The DOCUMENT_MANAGER template role row (institutionId =
--    NULL) is NEW (the SERVICE_AGENT / INVENTORY_MANAGER / WARDEN precedent), so
--    it IS inserted here, BEFORE the permissions block (so its `, NULL)` tuple
--    falls outside the sliced permission span the catalogue-sync parser reads).
--    Then the seven documents.* permissions (each "module" = 'documents',
--    matching permissions.ts), then the role_permissions pairs. ROLE_PERMISSIONS
--    lockstep (26 pairs): ADMIN x5 (download + the four admin keys),
--    DOCUMENT_MANAGER x5 (download + the four admin keys), FACULTY x4
--    (upload_own, view_own, download, grants.manage), and documents.download for
--    each of the 12 remaining non-applicant tenant roles (STUDENT, ACCOUNTANT,
--    LIBRARIAN, WARDEN, ADMISSION_OFFICER, HR_MANAGER, EMPLOYEE,
--    TRANSPORT_MANAGER, INVENTORY_MANAGER, SERVICE_AGENT, GUARD, HOD). APPLICANT
--    gets NO documents.* pair. The template-role predicate r."institutionId" IS
--    NULL matches the platform template rows.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "roles" ("id","key","name","institutionId") VALUES
  ('role_document_manager', 'DOCUMENT_MANAGER', 'Document Manager', NULL)
ON CONFLICT DO NOTHING;

INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_documents_upload_own',      'documents.upload_own',      'documents', 'Upload a new document + a new version of OWN docs (owner self)'),
  ('perm_documents_view_own',        'documents.view_own',        'documents', 'List/view/download OWN docs + manage grants on OWN docs (owner self)'),
  ('perm_documents_download',        'documents.download',        'documents', 'Baseline-reachability key (every non-applicant tenant role); the TRUE gate is the record-level canAccessDocument active-grant check'),
  ('perm_documents_grants_manage',   'documents.grants.manage',   'documents', 'Grant/revoke access on a doc the caller owns, MANAGE-holds, or admins'),
  ('perm_documents_admin_view_all',  'documents.admin.view_all',  'documents', 'See ALL tenant documents + versions; run the aggregate report + XLSX export'),
  ('perm_documents_retention_manage','documents.retention.manage','documents', 'Manage retention policies; archive/unarchive/purge-request/purge any doc'),
  ('perm_documents_audit_view',      'documents.audit.view',      'documents', 'Read the per-document access-log DETAIL ledger')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('ADMIN',             'documents.download'),
  ('ADMIN',             'documents.grants.manage'),
  ('ADMIN',             'documents.admin.view_all'),
  ('ADMIN',             'documents.retention.manage'),
  ('ADMIN',             'documents.audit.view'),
  ('DOCUMENT_MANAGER',  'documents.download'),
  ('DOCUMENT_MANAGER',  'documents.grants.manage'),
  ('DOCUMENT_MANAGER',  'documents.admin.view_all'),
  ('DOCUMENT_MANAGER',  'documents.retention.manage'),
  ('DOCUMENT_MANAGER',  'documents.audit.view'),
  ('FACULTY',           'documents.upload_own'),
  ('FACULTY',           'documents.view_own'),
  ('FACULTY',           'documents.download'),
  ('FACULTY',           'documents.grants.manage'),
  ('STUDENT',           'documents.download'),
  ('ACCOUNTANT',        'documents.download'),
  ('LIBRARIAN',         'documents.download'),
  ('WARDEN',            'documents.download'),
  ('ADMISSION_OFFICER', 'documents.download'),
  ('HR_MANAGER',        'documents.download'),
  ('EMPLOYEE',          'documents.download'),
  ('TRANSPORT_MANAGER', 'documents.download'),
  ('INVENTORY_MANAGER', 'documents.download'),
  ('SERVICE_AGENT',     'documents.download'),
  ('GUARD',             'documents.download'),
  ('HOD',               'documents.download')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
