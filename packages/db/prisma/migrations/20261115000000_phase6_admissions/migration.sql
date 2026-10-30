-- CAMPASS Phase 6 — Admissions: the DB foundation.
--
-- Hand-authored (Prisma's diff does not model RLS, the composite same-tenant
-- FKs, the partial unique index, the CHECK constraints, the append-only trigger,
-- the targeted GRANT refresh, or the catalogue seed). This migration only
-- CREATEs new objects; it NEVER ALTERs a Phase-0/1/2/3/4/5 table's RLS, grant,
-- or FK, and NEVER touches the _prisma_migrations ledger. campass_app stays
-- NOSUPERUSER NOBYPASSRLS — never granted BYPASSRLS.
--
-- It NEVER alters any of the ELEVEN FROZEN migrations
-- (20260824143031_add_allowance_and_reliability_models, 20261018100917_init,
-- 20261018110658_tenancy_isolation_rls, 20261018171747_identity_rbac_b2,
-- 20261019053533_superadmin_security, 20261019093119_module_system,
-- 20261027111710_phase1_academics, 20261027161616_phase2_sis,
-- 20261028000000_phase3_classes, 20261101000000_phase4_attendance,
-- 20261108000000_phase5_library).
--
-- SEVEN new tenant-owned tables = SIX standard-RLS-pair (mutable) tables
-- (admission_campaigns, admission_campaign_programs, applications,
-- application_documents, admission_offers, enrollments) + ONE append-only table
-- (application_reviews). Every table carries institutionId + (id, institutionId)
-- composite unique + (institutionId) index + composite same-tenant FKs incl.
-- institutionId + ENABLE+FORCE RLS.
--
-- Ordering (design §5/§9, mirrors phase5_library sections a–j):
--   a. CREATE TYPE the four new enums;
--   b. CREATE TABLE the seven new tables + PKs (updatedAt NOT NULL on all except
--      application_reviews, which is append-only);
--   c. (id,institutionId) uniques; business uniques; the §5 query indexes; the
--      raw-SQL partial unique admission_offers_one_live_per_application;
--   d. tenant-root FKs institutionId -> institutions(id) RESTRICT on all seven;
--   e. composite same-tenant FKs incl. institutionId;
--   f. CHECK constraints (non-empty campaign name, applicationNumber, document
--      reference);
--   g. ENABLE+FORCE RLS (standard select+modify pair on the six mutable tables;
--      append-only SELECT + INSERT-only pair on application_reviews);
--   h. append-only function + BEFORE UPDATE OR DELETE trigger on
--      application_reviews;
--   i. guarded campass_app GRANT refresh (full DML on the six mutable tables;
--      SELECT,INSERT + REVOKE UPDATE,DELETE on application_reviews);
--   j. PLACEHOLDER for the admissions.* catalogue seed (permissions/roles/
--      role_permissions) — filled by FEAT-002.

-- ─────────────────────────────────────────────────────────────────────────────
-- a. Enums.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "AdmissionCampaignStatus"   AS ENUM ('DRAFT', 'OPEN', 'CLOSED');
CREATE TYPE "ApplicationStatus"         AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'DOCUMENTS_REQUIRED', 'ELIGIBLE', 'SHORTLISTED', 'OFFERED', 'ACCEPTED', 'ENROLLED', 'REJECTED', 'WITHDRAWN');
CREATE TYPE "ApplicationReviewDecision" AS ENUM ('RECOMMEND_ELIGIBLE', 'RECOMMEND_REJECT', 'REQUEST_DOCUMENTS', 'SHORTLIST', 'NOTE');
CREATE TYPE "AdmissionOfferStatus"      AS ENUM ('ISSUED', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- ─────────────────────────────────────────────────────────────────────────────
-- b. New tenant-owned tables + PKs. createdAt DEFAULT CURRENT_TIMESTAMP; updatedAt
--    NOT NULL on the six mutable tables; application_reviews has no updatedAt
--    (append-only).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "admission_campaigns" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "status"          "AdmissionCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "intakeSessionId" TEXT,
    "targetProgramId" TEXT,
    "openAt"          TIMESTAMP(3),
    "closeAt"         TIMESTAMP(3),
    "config"          JSONB NOT NULL DEFAULT '{}',
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admission_campaigns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "admission_campaign_programs" (
    "id"            TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "campaignId"    TEXT NOT NULL,
    "programId"     TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admission_campaign_programs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "applications" (
    "id"                 TEXT NOT NULL,
    "institutionId"      TEXT NOT NULL,
    "campaignId"         TEXT NOT NULL,
    "applicantUserId"    TEXT NOT NULL,
    "programId"          TEXT NOT NULL,
    "status"             "ApplicationStatus" NOT NULL DEFAULT 'DRAFT',
    "applicationNumber"  TEXT NOT NULL,
    "submittedAt"        TIMESTAMP(3),
    "withdrawnAt"        TIMESTAMP(3),
    "rejectedAt"         TIMESTAMP(3),
    "formData"           JSONB NOT NULL DEFAULT '{}',
    "interviewAt"        TIMESTAMP(3),
    "applicationFeeRef"  TEXT,
    "applicationFeePaid" BOOLEAN NOT NULL DEFAULT false,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "application_documents" (
    "id"               TEXT NOT NULL,
    "institutionId"    TEXT NOT NULL,
    "applicationId"    TEXT NOT NULL,
    "docType"          TEXT NOT NULL,
    "reference"        TEXT NOT NULL,
    "fileName"         TEXT,
    "contentType"      TEXT,
    "verified"         BOOLEAN NOT NULL DEFAULT false,
    "verifiedByUserId" TEXT,
    "verifiedAt"       TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "application_reviews" (
    "id"             TEXT NOT NULL,
    "institutionId"  TEXT NOT NULL,
    "applicationId"  TEXT NOT NULL,
    "reviewerUserId" TEXT NOT NULL,
    "decision"       "ApplicationReviewDecision" NOT NULL,
    "notes"          TEXT,
    "reviewedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_reviews_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "admission_offers" (
    "id"               TEXT NOT NULL,
    "institutionId"    TEXT NOT NULL,
    "applicationId"    TEXT NOT NULL,
    "offeredProgramId" TEXT NOT NULL,
    "status"           "AdmissionOfferStatus" NOT NULL DEFAULT 'ISSUED',
    "offeredAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"        TIMESTAMP(3),
    "acceptedAt"       TIMESTAMP(3),
    "declinedAt"       TIMESTAMP(3),
    "expiredAt"        TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admission_offers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "enrollments" (
    "id"                TEXT NOT NULL,
    "institutionId"     TEXT NOT NULL,
    "applicationId"     TEXT NOT NULL,
    "studentProfileId"  TEXT NOT NULL,
    "academicSessionId" TEXT NOT NULL,
    "enrolledAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enrolledByUserId"  TEXT NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- c. Unique + query indexes. Each table's (id, institutionId) composite unique
--    (anchors the composite same-tenant FKs); the business uniques; every
--    (institutionId) index + the §5 query indexes; the raw-SQL partial unique
--    (Prisma cannot express partial indexes, so it is hand-authored here).
-- ─────────────────────────────────────────────────────────────────────────────
-- admission_campaigns
CREATE UNIQUE INDEX "admission_campaigns_id_institutionId_key"   ON "admission_campaigns"("id", "institutionId");
CREATE UNIQUE INDEX "admission_campaigns_institutionId_name_key" ON "admission_campaigns"("institutionId", "name");
CREATE INDEX        "admission_campaigns_institutionId_idx"      ON "admission_campaigns"("institutionId");
CREATE INDEX        "admission_campaigns_institutionId_status_idx" ON "admission_campaigns"("institutionId", "status");

-- admission_campaign_programs
CREATE UNIQUE INDEX "admission_campaign_programs_id_institutionId_key"                 ON "admission_campaign_programs"("id", "institutionId");
CREATE UNIQUE INDEX "admission_campaign_programs_institutionId_campaignId_programId_key" ON "admission_campaign_programs"("institutionId", "campaignId", "programId");
CREATE INDEX        "admission_campaign_programs_institutionId_idx"                     ON "admission_campaign_programs"("institutionId");
CREATE INDEX        "admission_campaign_programs_institutionId_campaignId_idx"          ON "admission_campaign_programs"("institutionId", "campaignId");

-- applications
CREATE UNIQUE INDEX "applications_id_institutionId_key"                           ON "applications"("id", "institutionId");
CREATE UNIQUE INDEX "applications_institutionId_applicationNumber_key"            ON "applications"("institutionId", "applicationNumber");
CREATE UNIQUE INDEX "applications_institutionId_campaignId_applicantUserId_key"   ON "applications"("institutionId", "campaignId", "applicantUserId");
CREATE INDEX        "applications_institutionId_idx"                              ON "applications"("institutionId");
CREATE INDEX        "applications_institutionId_status_idx"                       ON "applications"("institutionId", "status");
CREATE INDEX        "applications_institutionId_campaignId_status_idx"            ON "applications"("institutionId", "campaignId", "status");
CREATE INDEX        "applications_institutionId_applicantUserId_idx"              ON "applications"("institutionId", "applicantUserId");

-- application_documents
CREATE UNIQUE INDEX "application_documents_id_institutionId_key"              ON "application_documents"("id", "institutionId");
CREATE INDEX        "application_documents_institutionId_idx"                 ON "application_documents"("institutionId");
CREATE INDEX        "application_documents_institutionId_applicationId_idx"   ON "application_documents"("institutionId", "applicationId");

-- application_reviews (append-only)
CREATE UNIQUE INDEX "application_reviews_id_institutionId_key"              ON "application_reviews"("id", "institutionId");
CREATE INDEX        "application_reviews_institutionId_idx"                 ON "application_reviews"("institutionId");
CREATE INDEX        "application_reviews_institutionId_applicationId_idx"   ON "application_reviews"("institutionId", "applicationId");

-- admission_offers
CREATE UNIQUE INDEX "admission_offers_id_institutionId_key"              ON "admission_offers"("id", "institutionId");
CREATE INDEX        "admission_offers_institutionId_idx"                 ON "admission_offers"("institutionId");
CREATE INDEX        "admission_offers_institutionId_applicationId_idx"   ON "admission_offers"("institutionId", "applicationId");
CREATE INDEX        "admission_offers_institutionId_status_idx"          ON "admission_offers"("institutionId", "status");
-- At most one live offer per application (design §5) — Prisma cannot express a partial index.
CREATE UNIQUE INDEX "admission_offers_one_live_per_application" ON "admission_offers"("institutionId", "applicationId") WHERE "status" IN ('ISSUED', 'ACCEPTED');

-- enrollments
CREATE UNIQUE INDEX "enrollments_id_institutionId_key"                    ON "enrollments"("id", "institutionId");
CREATE UNIQUE INDEX "enrollments_institutionId_applicationId_key"         ON "enrollments"("institutionId", "applicationId");
CREATE INDEX        "enrollments_institutionId_idx"                       ON "enrollments"("institutionId");
CREATE INDEX        "enrollments_institutionId_studentProfileId_idx"      ON "enrollments"("institutionId", "studentProfileId");
CREATE INDEX        "enrollments_institutionId_applicationId_idx"         ON "enrollments"("institutionId", "applicationId");

-- ─────────────────────────────────────────────────────────────────────────────
-- d. Tenant-root FKs: institutionId -> institutions(id) ON DELETE RESTRICT on
--    all seven new tables.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "admission_campaigns"         ADD CONSTRAINT "admission_campaigns_institutionId_fkey"         FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admission_campaign_programs" ADD CONSTRAINT "admission_campaign_programs_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "applications"                ADD CONSTRAINT "applications_institutionId_fkey"                FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "application_documents"       ADD CONSTRAINT "application_documents_institutionId_fkey"       FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "application_reviews"         ADD CONSTRAINT "application_reviews_institutionId_fkey"         FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admission_offers"            ADD CONSTRAINT "admission_offers_institutionId_fkey"            FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "enrollments"                 ADD CONSTRAINT "enrollments_institutionId_fkey"                 FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- e. Composite same-tenant FKs (tenancy.md §4, design §5). Each carries
--    institutionId so a child can never reference a parent in another tenant.
--    applicantUserId -> users(institutionId, id); studentProfileId ->
--    student_profiles(institutionId, id). verifiedByUserId / reviewerUserId /
--    enrolledByUserId are recorded actor ids with NO FK.
-- ─────────────────────────────────────────────────────────────────────────────
-- admission_campaigns -> academic_sessions (nullable intake) / programs (nullable target)
ALTER TABLE "admission_campaigns"
  ADD CONSTRAINT "admission_campaigns_session_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "intakeSessionId") REFERENCES "academic_sessions"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admission_campaigns"
  ADD CONSTRAINT "admission_campaigns_target_program_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "targetProgramId") REFERENCES "programs"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- admission_campaign_programs -> admission_campaigns / programs
ALTER TABLE "admission_campaign_programs"
  ADD CONSTRAINT "admission_campaign_programs_campaign_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "campaignId") REFERENCES "admission_campaigns"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admission_campaign_programs"
  ADD CONSTRAINT "admission_campaign_programs_program_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "programId") REFERENCES "programs"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- applications -> admission_campaigns / users (applicant) / programs
ALTER TABLE "applications"
  ADD CONSTRAINT "applications_campaign_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "campaignId") REFERENCES "admission_campaigns"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "applications"
  ADD CONSTRAINT "applications_applicant_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "applicantUserId") REFERENCES "users"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "applications"
  ADD CONSTRAINT "applications_program_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "programId") REFERENCES "programs"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- application_documents -> applications
ALTER TABLE "application_documents"
  ADD CONSTRAINT "application_documents_application_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "applicationId") REFERENCES "applications"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- application_reviews -> applications
ALTER TABLE "application_reviews"
  ADD CONSTRAINT "application_reviews_application_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "applicationId") REFERENCES "applications"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- admission_offers -> applications / programs (offered)
ALTER TABLE "admission_offers"
  ADD CONSTRAINT "admission_offers_application_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "applicationId") REFERENCES "applications"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admission_offers"
  ADD CONSTRAINT "admission_offers_offered_program_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "offeredProgramId") REFERENCES "programs"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- enrollments -> applications / student_profiles / academic_sessions
ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_application_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "applicationId") REFERENCES "applications"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentProfileId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_session_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicSessionId") REFERENCES "academic_sessions"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- f. CHECK constraints (design §5): a campaign name, an applicationNumber, and a
--    document reference are non-empty.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "admission_campaigns"
  ADD CONSTRAINT "admission_campaigns_name_nonempty_check"
  CHECK (char_length("name") >= 1);
ALTER TABLE "applications"
  ADD CONSTRAINT "applications_application_number_nonempty_check"
  CHECK (char_length("applicationNumber") >= 1);
ALTER TABLE "application_documents"
  ADD CONSTRAINT "application_documents_reference_nonempty_check"
  CHECK (char_length("reference") >= 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- g. RLS. ENABLE + FORCE on all seven. The six mutable tables get the standard
--    fail-closed nullif-guarded pair {tenant_isolation_select,
--    tenant_isolation_modify}. application_reviews gets the APPEND-ONLY pair
--    {tenant_isolation_select, application_reviews_tenant_insert} with NO modify /
--    FOR ALL policy (the attendance_record_history / schedule_revisions /
--    audit_events house style). nullif(current_setting('app.current_institution_id',
--    true), '') fails closed for both an unset and an empty-string GUC.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  mutable_tables TEXT[] := ARRAY[
    'admission_campaigns', 'admission_campaign_programs', 'applications',
    'application_documents', 'admission_offers', 'enrollments'
  ];
BEGIN
  -- Six mutable tables: standard select + modify pair.
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

  -- application_reviews: append-only (SELECT + INSERT, NO modify).
  ALTER TABLE "application_reviews" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "application_reviews" FORCE  ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "tenant_isolation_select" ON "application_reviews";
  CREATE POLICY "tenant_isolation_select" ON "application_reviews"
    FOR SELECT
    USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

  DROP POLICY IF EXISTS "application_reviews_tenant_insert" ON "application_reviews";
  CREATE POLICY "application_reviews_tenant_insert" ON "application_reviews"
    FOR INSERT
    WITH CHECK ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- h. Append-only trigger on application_reviews. A BEFORE UPDATE OR DELETE
--    trigger binds EVERY role — including the table owner / postgres path GRANTs
--    cannot restrict — so a review row can only ever be inserted, never rewritten
--    (mirrors attendance_record_history / schedule_revisions / audit_events).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "application_reviews_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'application_reviews is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "application_reviews_no_update_delete"
  BEFORE UPDATE OR DELETE ON "application_reviews"
  FOR EACH ROW EXECUTE FUNCTION "application_reviews_append_only"();

-- ─────────────────────────────────────────────────────────────────────────────
-- i. campass_app GRANT refresh (guarded + idempotent). The six mutable tables
--    legitimately need full DML; application_reviews is append-only — keep
--    SELECT, INSERT and REVOKE UPDATE, DELETE. Never grant BYPASSRLS.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "admission_campaigns"         TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "admission_campaign_programs" TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "applications"                TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "application_documents"       TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "admission_offers"            TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "enrollments"                 TO "campass_app";

    GRANT SELECT, INSERT ON "application_reviews" TO "campass_app";
    REVOKE UPDATE, DELETE ON "application_reviews" FROM "campass_app";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- j. PLACEHOLDER — admissions.* catalogue seed.
--
--    FEAT-002 fills THIS section with the pinned literal markers (the same
--    seed-block shape + join the Phase 4/5 seeds use so catalogue-sync.test.ts
--    parses it): the NEW APPLICANT + ADMISSION_OFFICER template "roles" rows
--    (institutionId = NULL), the admissions.* "permissions" rows
--    (ON CONFLICT ("key") DO NOTHING), and the "role_permissions" pairs
--    (INSERT ... SELECT ... FROM (VALUES ...) AS m("roleKey","permKey") JOIN
--    "roles" r ... JOIN "permissions" p ... ON CONFLICT ("roleId","permissionId")
--    DO NOTHING). Intentionally left empty by FEAT-001.
