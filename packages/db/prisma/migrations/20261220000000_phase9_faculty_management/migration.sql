-- CAMPASS Phase 9.1 — Faculty Management (backend only): the FIRST module of
-- Phase 9 (Institutional operations). A gated ("booster") module layered on the
-- shared foundation. It adds ACADEMIC domain records that REFERENCE the single
-- authoritative faculty identity (faculty_profiles) and the existing academic
-- teaching assignments (faculty_assignments) — it never duplicates them. Scope:
-- qualifications, per-term workload (+ a per-institution policy), an append-only
-- teaching-history ledger, and a consolidated directory read. DISTINCT from HR
-- (Phase 9.2). No cross-module side effects.
--
-- Hand-authored (Prisma's diff models neither RLS, the composite same-tenant FKs,
-- the CHECKs, the append-only trigger, the targeted GRANT refresh, nor the
-- catalogue seed). STRICTLY ADDITIVE: it only CREATEs new objects + one additive
-- catalogue seed. It NEVER edits any pre-existing migration directory (the rule,
-- not a bare number: every prior dir stays byte-identical), never touches the
-- _prisma_migrations ledger, and campass_app stays NOSUPERUSER NOBYPASSRLS —
-- never granted BYPASSRLS.
--
-- FOUR new tenant-owned tables:
--   * faculty_qualifications   — mutable (editable-with-audit), standard RLS pair.
--   * faculty_workload_policies — mutable per-institution config, standard pair.
--   * faculty_workloads        — mutable (recompute-audited), standard pair.
--   * faculty_teaching_history — STRICTLY append-only (append-only RLS pair +
--                                unconditional-raise trigger), the immutable ledger.
-- Every table carries institutionId + (id, institutionId) composite unique +
-- (institutionId) index + composite same-tenant FKs incl. institutionId +
-- ENABLE+FORCE RLS.
--
-- Ordering (mirrors the exams slice-1/slice-2 lettered house style a–j):
--   a. CREATE TYPE the two new enums.
--   b. CREATE TABLE the four tables + PKs (history: createdAt only / append-only
--      class; the three mutable tables carry updatedAt NOT NULL).
--   c. (id,institutionId) unique + (institutionId)/query indexes + business uniques.
--   d. tenant-root institutionId -> institutions(id) RESTRICT on all four.
--   e. composite same-tenant FKs (each carries institutionId).
--   f. CHECKs.
--   g. ENABLE+FORCE RLS (standard pair on the three mutable; append-only pair on
--      the history table).
--   h. faculty_teaching_history_append_only() + BEFORE UPDATE OR DELETE trigger.
--   i. guarded + idempotent campass_app GRANT refresh.
--   j. catalogue seed: the five faculty.* permissions + the ADMIN/HOD/FACULTY
--      role_permissions pairs.

-- ─────────────────────────────────────────────────────────────────────────────
-- a. Enums.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "FacultyQualificationKind" AS ENUM ('DEGREE', 'CERTIFICATION', 'DIPLOMA', 'OTHER');
CREATE TYPE "FacultyTeachingHistoryChangeType" AS ENUM ('ASSIGNED', 'ENDED');

-- ─────────────────────────────────────────────────────────────────────────────
-- b. New tenant-owned tables + PKs. The three mutable tables carry updatedAt NOT
--    NULL; faculty_teaching_history carries createdAt only (append-only class —
--    the marks_record_history precedent). createdByUserId / updatedByUserId /
--    recordedByUserId / sourceAssignmentId are recorded actor/source ids with NO
--    FK (the 8.1 createdByUserId + the reeval outcomePublicationId precedents).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "faculty_qualifications" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "facultyId"       TEXT NOT NULL,
    "kind"            "FacultyQualificationKind" NOT NULL DEFAULT 'DEGREE',
    "title"           TEXT NOT NULL,
    "issuingBody"     TEXT,
    "field"           TEXT,
    "year"            INTEGER,
    "documentRef"     TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "faculty_qualifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "faculty_workload_policies" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "maxWeeklyHours"  INTEGER NOT NULL,
    "updatedByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "faculty_workload_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "faculty_workloads" (
    "id"               TEXT NOT NULL,
    "institutionId"    TEXT NOT NULL,
    "facultyId"        TEXT NOT NULL,
    "academicTermId"   TEXT NOT NULL,
    "teachingHours"    INTEGER NOT NULL,
    "nonTeachingHours" INTEGER NOT NULL DEFAULT 0,
    "totalHours"       INTEGER NOT NULL,
    "overAllocated"    BOOLEAN NOT NULL DEFAULT false,
    "overrideReason"   TEXT,
    "lastReconciledAt" TIMESTAMP(3),
    "updatedByUserId"  TEXT NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "faculty_workloads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "faculty_teaching_history" (
    "id"                 TEXT NOT NULL,
    "institutionId"      TEXT NOT NULL,
    "facultyId"          TEXT NOT NULL,
    "subjectId"          TEXT NOT NULL,
    "classSectionId"     TEXT,
    "academicTermId"     TEXT NOT NULL,
    "sourceAssignmentId" TEXT,
    "role"               "FacultyAssignmentRole" NOT NULL,
    "changeType"         "FacultyTeachingHistoryChangeType" NOT NULL,
    "effectiveAt"        TIMESTAMP(3) NOT NULL,
    "recordedByUserId"   TEXT NOT NULL,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "faculty_teaching_history_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- c. Unique + query indexes. (id, institutionId) anchors the composite
--    same-tenant FKs; (institutionId) + per-query indexes; the business uniques
--    (faculty_workloads one row per (institution, faculty, term);
--    faculty_workload_policies one row per institution).
-- ─────────────────────────────────────────────────────────────────────────────
-- faculty_qualifications
CREATE UNIQUE INDEX "faculty_qualifications_id_institutionId_key"          ON "faculty_qualifications"("id", "institutionId");
CREATE INDEX        "faculty_qualifications_institutionId_idx"             ON "faculty_qualifications"("institutionId");
CREATE INDEX        "faculty_qualifications_institutionId_facultyId_idx"   ON "faculty_qualifications"("institutionId", "facultyId");

-- faculty_workload_policies
CREATE UNIQUE INDEX "faculty_workload_policies_id_institutionId_key"       ON "faculty_workload_policies"("id", "institutionId");
CREATE UNIQUE INDEX "faculty_workload_policies_institutionId_key"          ON "faculty_workload_policies"("institutionId");
CREATE INDEX        "faculty_workload_policies_institutionId_idx"          ON "faculty_workload_policies"("institutionId");

-- faculty_workloads
CREATE UNIQUE INDEX "faculty_workloads_id_institutionId_key"               ON "faculty_workloads"("id", "institutionId");
CREATE UNIQUE INDEX "faculty_workloads_institutionId_facultyId_academicTermId_key" ON "faculty_workloads"("institutionId", "facultyId", "academicTermId");
CREATE INDEX        "faculty_workloads_institutionId_idx"                  ON "faculty_workloads"("institutionId");
CREATE INDEX        "faculty_workloads_institutionId_facultyId_idx"        ON "faculty_workloads"("institutionId", "facultyId");
CREATE INDEX        "faculty_workloads_institutionId_academicTermId_idx"   ON "faculty_workloads"("institutionId", "academicTermId");

-- faculty_teaching_history
CREATE UNIQUE INDEX "faculty_teaching_history_id_institutionId_key"        ON "faculty_teaching_history"("id", "institutionId");
CREATE INDEX        "faculty_teaching_history_institutionId_idx"           ON "faculty_teaching_history"("institutionId");
CREATE INDEX        "faculty_teaching_history_institutionId_facultyId_idx" ON "faculty_teaching_history"("institutionId", "facultyId");
CREATE INDEX        "faculty_teaching_history_institutionId_facultyId_academicTermId_idx" ON "faculty_teaching_history"("institutionId", "facultyId", "academicTermId");

-- ─────────────────────────────────────────────────────────────────────────────
-- d. Tenant-root FKs.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "faculty_qualifications"     ADD CONSTRAINT "faculty_qualifications_institutionId_fkey"     FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "faculty_workload_policies"  ADD CONSTRAINT "faculty_workload_policies_institutionId_fkey"  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "faculty_workloads"          ADD CONSTRAINT "faculty_workloads_institutionId_fkey"          FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "faculty_teaching_history"   ADD CONSTRAINT "faculty_teaching_history_institutionId_fkey"   FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- e. Composite same-tenant FKs (each carries institutionId so a child can never
--    reference a parent in another tenant). All ON DELETE RESTRICT ON UPDATE
--    CASCADE. faculty_profiles / academic_terms / subjects / class_sections all
--    carry the (institutionId, id) composite unique these anchor on.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "faculty_qualifications"
  ADD CONSTRAINT "faculty_qualifications_faculty_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "facultyId") REFERENCES "faculty_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "faculty_workloads"
  ADD CONSTRAINT "faculty_workloads_faculty_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "facultyId") REFERENCES "faculty_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "faculty_workloads"
  ADD CONSTRAINT "faculty_workloads_term_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicTermId") REFERENCES "academic_terms"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "faculty_teaching_history"
  ADD CONSTRAINT "faculty_teaching_history_faculty_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "facultyId") REFERENCES "faculty_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "faculty_teaching_history"
  ADD CONSTRAINT "faculty_teaching_history_subject_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "subjectId") REFERENCES "subjects"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "faculty_teaching_history"
  ADD CONSTRAINT "faculty_teaching_history_section_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "classSectionId") REFERENCES "class_sections"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "faculty_teaching_history"
  ADD CONSTRAINT "faculty_teaching_history_term_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicTermId") REFERENCES "academic_terms"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- f. CHECKs. faculty_workloads total = teaching + non-teaching + non-negative
--    hours; policy maxWeeklyHours > 0; qualification title non-empty.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "faculty_workloads"
  ADD CONSTRAINT "faculty_workloads_total_check" CHECK ("totalHours" = "teachingHours" + "nonTeachingHours");
ALTER TABLE "faculty_workloads"
  ADD CONSTRAINT "faculty_workloads_nonneg_check" CHECK ("teachingHours" >= 0 AND "nonTeachingHours" >= 0);
ALTER TABLE "faculty_workload_policies"
  ADD CONSTRAINT "faculty_workload_policies_max_positive_check" CHECK ("maxWeeklyHours" > 0);
ALTER TABLE "faculty_qualifications"
  ADD CONSTRAINT "faculty_qualifications_title_nonempty_check" CHECK (char_length("title") >= 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- g. RLS. ENABLE + FORCE on all four. The three mutable tables get the standard
--    fail-closed nullif-guarded pair {tenant_isolation_select,
--    tenant_isolation_modify}; faculty_teaching_history gets the append-only pair
--    {tenant_isolation_select, faculty_teaching_history_tenant_insert} (SELECT +
--    INSERT-only, NO modify — the marks_record_history precedent). nullif(
--    current_setting('app.current_institution_id', true), '') fails closed for
--    both an unset and an empty-string GUC.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  mutable_tables TEXT[] := ARRAY[
    'faculty_qualifications', 'faculty_workload_policies', 'faculty_workloads'
  ];
  append_only_tables TEXT[] := ARRAY[
    'faculty_teaching_history'
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
-- h. faculty_teaching_history append-only trigger (unconditional raise on
--    UPDATE/DELETE — binds the owner too, which GRANTs alone cannot). Mirrored
--    verbatim from marks_record_history_append_only(). The three mutable tables
--    carry NO trigger (legitimately editable; immutability is not an invariant).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "faculty_teaching_history_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'faculty_teaching_history is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "faculty_teaching_history_no_update_delete"
  BEFORE UPDATE OR DELETE ON "faculty_teaching_history"
  FOR EACH ROW EXECUTE FUNCTION "faculty_teaching_history_append_only"();

-- ─────────────────────────────────────────────────────────────────────────────
-- i. campass_app GRANT refresh (guarded + idempotent). The three mutable tables
--    get SELECT, INSERT, UPDATE (+ DELETE on faculty_qualifications for staff
--    removal of an erroneous record); faculty_teaching_history gets SELECT,
--    INSERT only + REVOKE UPDATE, DELETE (the append-only INSERT-only GRANT —
--    marks_record_history precedent). Never grant BYPASSRLS.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "faculty_qualifications"    TO "campass_app";
    GRANT SELECT, INSERT, UPDATE         ON "faculty_workload_policies" TO "campass_app";
    GRANT SELECT, INSERT, UPDATE         ON "faculty_workloads"         TO "campass_app";

    GRANT SELECT, INSERT ON "faculty_teaching_history" TO "campass_app";
    REVOKE UPDATE, DELETE ON "faculty_teaching_history" FROM "campass_app";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- j. Catalogue seed. The five faculty.* permissions + the role_permissions pairs
--    (ADMIN + HOD get the four staff keys; FACULTY gets the self-service
--    faculty.view_own). The block shapes mirror the catalogue-sync parser's
--    expectations (the permissions span is sliced up to its ON CONFLICT clause;
--    the role_permissions span up to its `AS m(` VALUES alias). Separation of
--    duties: FACULTY never gets a staff .manage/.directory.view key; staff never
--    gets the SELF-scope faculty.view_own.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_faculty_qualifications_manage', 'faculty.qualifications.manage',   'faculty_management', 'Create/update/delete + list faculty qualifications (staff)'),
  ('perm_faculty_workload_manage',       'faculty.workload.manage',         'faculty_management', 'Create/update/recompute workload + manage workload policy (staff)'),
  ('perm_faculty_teaching_history_manage','faculty.teaching_history.manage','faculty_management', 'Reconcile/append + read teaching history (staff)'),
  ('perm_faculty_directory_view',        'faculty.directory.view',          'faculty_management', 'Read any faculty member''s consolidated academic profile (staff)'),
  ('perm_faculty_view_own',              'faculty.view_own',                'faculty_management', 'Faculty self-service read of OWN profile/workload/history/qualifications')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('ADMIN',   'faculty.qualifications.manage'),
  ('ADMIN',   'faculty.workload.manage'),
  ('ADMIN',   'faculty.teaching_history.manage'),
  ('ADMIN',   'faculty.directory.view'),
  ('HOD',     'faculty.qualifications.manage'),
  ('HOD',     'faculty.workload.manage'),
  ('HOD',     'faculty.teaching_history.manage'),
  ('HOD',     'faculty.directory.view'),
  ('FACULTY', 'faculty.view_own')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
