-- CAMPASS Phase 3 — Class & Course Management (FEAT-001): the DB foundation.
--
-- Hand-authored (Prisma's diff does not model RLS, the composite same-tenant
-- FKs, the CHECK constraints, the append-only trigger, the targeted GRANT
-- refresh, or the catalogue seed). This migration only CREATEs new objects and
-- ADDs the FACULTY template role + classes.* permission seed; it NEVER ALTERs a
-- Phase-0/1/2 table's RLS, grant, or FK, and NEVER touches the _prisma_migrations
-- ledger. campass_app stays NOSUPERUSER NOBYPASSRLS — never granted BYPASSRLS.
--
-- It NEVER alters any of the EIGHT FROZEN migrations
-- (20260824143031_add_allowance_and_reliability_models, 20261018100917_init,
-- 20261018110658_tenancy_isolation_rls, 20261018171747_identity_rbac_b2,
-- 20261019053533_superadmin_security, 20261019093119_module_system,
-- 20261027111710_phase1_academics, 20261027161616_phase2_sis).
--
-- NINE new tenant-owned tables = EIGHT standard-RLS-pair (mutable) tables
-- (courses, subjects, class_sections, class_enrollments, faculty_profiles,
-- faculty_assignments, timetables, scheduled_classes) + ONE append-only table
-- (schedule_revisions). Every table carries institutionId + @@unique([id,
-- institutionId]) + @@index([institutionId]) + composite same-tenant FKs incl.
-- institutionId + ENABLE+FORCE RLS per tenancy.md §4/§5.
--
-- Ordering (design §11, mirrors phase2_sis sections a–j):
--   a. CREATE TYPE the nine new enums (§6.1);
--   b. CREATE TABLE the nine new tables + PKs;
--   c. unique + query indexes (each (id,institutionId), the business uniques,
--      every (institutionId) index + the §6 query indexes);
--   d. tenant-root FKs institutionId -> institutions(id) RESTRICT on all nine;
--   e. composite same-tenant FKs per §6.10 (RESTRICT / SET NULL as tabled);
--   f. CHECK constraints on scheduled_classes (time bounds + recurring/one-off XOR);
--   g. ENABLE+FORCE RLS on all nine (standard pair on the eight mutable tables,
--      append-only pair on schedule_revisions);
--   h. append-only function + BEFORE UPDATE OR DELETE trigger on schedule_revisions;
--   i. guarded campass_app GRANT refresh (full DML on the eight mutable tables;
--      SELECT,INSERT + REVOKE UPDATE,DELETE on schedule_revisions);
--   j. seed the seven classes.* permissions + role_permissions pairs (FACULTY
--      roles INSERT emitted BEFORE the permissions block — catalogue-sync parser).

-- ─────────────────────────────────────────────────────────────────────────────
-- a. Enums (§6.1).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "ClassSectionStatus"         AS ENUM ('PLANNED', 'ACTIVE', 'CLOSED', 'CANCELLED');
CREATE TYPE "EnrollmentStatus"           AS ENUM ('ENROLLED', 'DROPPED', 'COMPLETED');
CREATE TYPE "FacultyStatus"              AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "FacultyAssignmentRole"      AS ENUM ('PRIMARY', 'SUBSTITUTE', 'ASSISTANT');
CREATE TYPE "FacultyAssignmentStatus"    AS ENUM ('ACTIVE', 'ENDED');
CREATE TYPE "TimetableStatus"            AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "ScheduledClassStatus"       AS ENUM ('SCHEDULED', 'CANCELLED');
CREATE TYPE "DayOfWeek"                   AS ENUM ('SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT');
CREATE TYPE "ScheduleRevisionChangeType" AS ENUM ('TIMETABLE_CREATED', 'TIMETABLE_PUBLISHED', 'TIMETABLE_ARCHIVED', 'SCHEDULED_CLASS_ADDED', 'SCHEDULED_CLASS_UPDATED', 'SCHEDULED_CLASS_CANCELLED', 'FACULTY_REASSIGNED');

-- ─────────────────────────────────────────────────────────────────────────────
-- b. New tenant-owned tables + PKs. Course.status / Subject.status reuse the
--    existing ProgramStatus enum (§6.2). schedule_revisions is append-only
--    (RLS/trigger/REVOKE below). createdAt DEFAULT CURRENT_TIMESTAMP; updatedAt
--    NOT NULL (set by the app via @updatedAt), mirroring the phase2_sis shape.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "courses" (
    "id"             TEXT NOT NULL,
    "institutionId"  TEXT NOT NULL,
    "programId"      TEXT NOT NULL,
    "academicTermId" TEXT,
    "name"           TEXT NOT NULL,
    "code"           TEXT NOT NULL,
    "description"    TEXT,
    "status"         "ProgramStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subjects" (
    "id"                  TEXT NOT NULL,
    "institutionId"       TEXT NOT NULL,
    "courseId"            TEXT NOT NULL,
    "name"                TEXT NOT NULL,
    "code"                TEXT NOT NULL,
    "credits"             INTEGER,
    "contactHoursPerWeek" INTEGER,
    "status"              "ProgramStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "class_sections" (
    "id"                TEXT NOT NULL,
    "institutionId"     TEXT NOT NULL,
    "programId"         TEXT NOT NULL,
    "academicSessionId" TEXT NOT NULL,
    "academicTermId"    TEXT NOT NULL,
    "label"             TEXT,
    "capacity"          INTEGER,
    "status"            "ClassSectionStatus" NOT NULL DEFAULT 'PLANNED',
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "class_sections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "class_enrollments" (
    "id"             TEXT NOT NULL,
    "institutionId"  TEXT NOT NULL,
    "classSectionId" TEXT NOT NULL,
    "studentId"      TEXT NOT NULL,
    "enrolledAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status"         "EnrollmentStatus" NOT NULL DEFAULT 'ENROLLED',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "class_enrollments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "faculty_profiles" (
    "id"            TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "departmentId"  TEXT,
    "status"        "FacultyStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "faculty_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "faculty_assignments" (
    "id"             TEXT NOT NULL,
    "institutionId"  TEXT NOT NULL,
    "facultyId"      TEXT NOT NULL,
    "subjectId"      TEXT NOT NULL,
    "classSectionId" TEXT,
    "academicTermId" TEXT NOT NULL,
    "role"           "FacultyAssignmentRole" NOT NULL DEFAULT 'PRIMARY',
    "status"         "FacultyAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "assignedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt"        TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "faculty_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "timetables" (
    "id"             TEXT NOT NULL,
    "institutionId"  TEXT NOT NULL,
    "academicTermId" TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "status"         "TimetableStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt"    TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timetables_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "scheduled_classes" (
    "id"             TEXT NOT NULL,
    "institutionId"  TEXT NOT NULL,
    "timetableId"    TEXT NOT NULL,
    "classSectionId" TEXT NOT NULL,
    "subjectId"      TEXT NOT NULL,
    "facultyId"      TEXT NOT NULL,
    "academicTermId" TEXT NOT NULL,
    "room"           TEXT,
    "dayOfWeek"      "DayOfWeek",
    "date"           TIMESTAMP(3),
    "startTime"      INTEGER NOT NULL,
    "endTime"        INTEGER NOT NULL,
    "period"         INTEGER,
    "status"         "ScheduledClassStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_classes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "schedule_revisions" (
    "id"                TEXT NOT NULL,
    "institutionId"     TEXT NOT NULL,
    "timetableId"       TEXT,
    "scheduledClassId"  TEXT,
    "academicTermId"    TEXT,
    "changeType"        "ScheduleRevisionChangeType" NOT NULL,
    "previousFacultyId" TEXT,
    "newFacultyId"      TEXT,
    "previousRoom"      TEXT,
    "newRoom"           TEXT,
    "previousStartTime" INTEGER,
    "newStartTime"      INTEGER,
    "previousEndTime"   INTEGER,
    "newEndTime"        INTEGER,
    "previousStatus"    TEXT,
    "newStatus"         TEXT,
    "actorUserId"       TEXT NOT NULL,
    "actorMembershipId" TEXT,
    "reason"            TEXT,
    "metadata"          JSONB,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_revisions_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- c. Unique + query indexes. Each table's (id, institutionId) composite unique
--    (anchors the composite same-tenant FKs); the business uniques; every
--    (institutionId) index + the §6 query indexes.
-- ─────────────────────────────────────────────────────────────────────────────
-- courses
CREATE UNIQUE INDEX "courses_institutionId_code_key" ON "courses"("institutionId", "code");
CREATE UNIQUE INDEX "courses_id_institutionId_key"    ON "courses"("id", "institutionId");
CREATE INDEX        "courses_institutionId_idx"       ON "courses"("institutionId");
CREATE INDEX        "courses_programId_idx"           ON "courses"("programId");

-- subjects
CREATE UNIQUE INDEX "subjects_institutionId_code_key" ON "subjects"("institutionId", "code");
CREATE UNIQUE INDEX "subjects_id_institutionId_key"   ON "subjects"("id", "institutionId");
CREATE INDEX        "subjects_institutionId_idx"      ON "subjects"("institutionId");
CREATE INDEX        "subjects_courseId_idx"           ON "subjects"("courseId");

-- class_sections
CREATE UNIQUE INDEX "class_sections_institutionId_programId_academicSessionId_academicTermId_label_key" ON "class_sections"("institutionId", "programId", "academicSessionId", "academicTermId", "label");
CREATE UNIQUE INDEX "class_sections_id_institutionId_key"                 ON "class_sections"("id", "institutionId");
CREATE INDEX        "class_sections_institutionId_idx"                    ON "class_sections"("institutionId");
CREATE INDEX        "class_sections_institutionId_academicTermId_idx"     ON "class_sections"("institutionId", "academicTermId");

-- class_enrollments
CREATE UNIQUE INDEX "class_enrollments_classSectionId_studentId_key" ON "class_enrollments"("classSectionId", "studentId");
CREATE UNIQUE INDEX "class_enrollments_id_institutionId_key"         ON "class_enrollments"("id", "institutionId");
CREATE INDEX        "class_enrollments_institutionId_idx"            ON "class_enrollments"("institutionId");
CREATE INDEX        "class_enrollments_institutionId_studentId_idx"  ON "class_enrollments"("institutionId", "studentId");
CREATE INDEX        "class_enrollments_classSectionId_idx"           ON "class_enrollments"("classSectionId");

-- faculty_profiles
CREATE UNIQUE INDEX "faculty_profiles_userId_key"          ON "faculty_profiles"("userId");
CREATE UNIQUE INDEX "faculty_profiles_id_institutionId_key" ON "faculty_profiles"("id", "institutionId");
CREATE INDEX        "faculty_profiles_institutionId_idx"    ON "faculty_profiles"("institutionId");

-- faculty_assignments
CREATE UNIQUE INDEX "faculty_assignments_id_institutionId_key"                  ON "faculty_assignments"("id", "institutionId");
CREATE INDEX        "faculty_assignments_institutionId_idx"                     ON "faculty_assignments"("institutionId");
CREATE INDEX        "faculty_assignments_institutionId_facultyId_status_idx"    ON "faculty_assignments"("institutionId", "facultyId", "status");
CREATE INDEX        "faculty_assignments_subjectId_idx"                         ON "faculty_assignments"("subjectId");

-- timetables
CREATE UNIQUE INDEX "timetables_id_institutionId_key"              ON "timetables"("id", "institutionId");
CREATE INDEX        "timetables_institutionId_idx"                 ON "timetables"("institutionId");
CREATE INDEX        "timetables_institutionId_academicTermId_idx"  ON "timetables"("institutionId", "academicTermId");

-- scheduled_classes
CREATE UNIQUE INDEX "scheduled_classes_id_institutionId_key"                            ON "scheduled_classes"("id", "institutionId");
CREATE INDEX        "scheduled_classes_institutionId_idx"                               ON "scheduled_classes"("institutionId");
CREATE INDEX        "scheduled_classes_institutionId_academicTermId_dayOfWeek_idx"      ON "scheduled_classes"("institutionId", "academicTermId", "dayOfWeek");
CREATE INDEX        "scheduled_classes_facultyId_idx"                                   ON "scheduled_classes"("facultyId");
CREATE INDEX        "scheduled_classes_classSectionId_idx"                              ON "scheduled_classes"("classSectionId");

-- schedule_revisions (append-only)
CREATE UNIQUE INDEX "schedule_revisions_id_institutionId_key"              ON "schedule_revisions"("id", "institutionId");
CREATE INDEX        "schedule_revisions_institutionId_idx"                 ON "schedule_revisions"("institutionId");
CREATE INDEX        "schedule_revisions_institutionId_timetableId_idx"     ON "schedule_revisions"("institutionId", "timetableId");
CREATE INDEX        "schedule_revisions_scheduledClassId_idx"              ON "schedule_revisions"("scheduledClassId");

-- ─────────────────────────────────────────────────────────────────────────────
-- d. Tenant-root FKs: institutionId -> institutions(id) ON DELETE RESTRICT on
--    all nine new tables (single-leg, the institution_modules / phase2_sis shape).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "courses"             ADD CONSTRAINT "courses_institutionId_fkey"             FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subjects"            ADD CONSTRAINT "subjects_institutionId_fkey"            FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "class_sections"      ADD CONSTRAINT "class_sections_institutionId_fkey"      FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "class_enrollments"   ADD CONSTRAINT "class_enrollments_institutionId_fkey"   FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "faculty_profiles"    ADD CONSTRAINT "faculty_profiles_institutionId_fkey"    FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "faculty_assignments" ADD CONSTRAINT "faculty_assignments_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "timetables"          ADD CONSTRAINT "timetables_institutionId_fkey"          FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "scheduled_classes"   ADD CONSTRAINT "scheduled_classes_institutionId_fkey"   FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "schedule_revisions"  ADD CONSTRAINT "schedule_revisions_institutionId_fkey"  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- e. Composite same-tenant FKs (tenancy.md §4, design §6.10). Each carries
--    institutionId so a child can never reference a parent in another tenant;
--    they reference the parents' existing (id, institutionId) uniques (Phase
--    0/1/2) and the new Phase-3 parents' own (id, institutionId) uniques from (c).
--    RESTRICT / SET NULL exactly as §6.10 tables. schedule_revisions.actorUserId
--    / actorMembershipId are recorded id columns with NO FK (§6.10 NIT-1).
-- ─────────────────────────────────────────────────────────────────────────────
-- courses
ALTER TABLE "courses"
  ADD CONSTRAINT "courses_program_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "programId") REFERENCES "programs"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "courses"
  ADD CONSTRAINT "courses_term_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicTermId") REFERENCES "academic_terms"("institutionId", "id")
  MATCH SIMPLE ON DELETE SET NULL ON UPDATE CASCADE;

-- subjects
ALTER TABLE "subjects"
  ADD CONSTRAINT "subjects_course_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "courseId") REFERENCES "courses"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- class_sections
ALTER TABLE "class_sections"
  ADD CONSTRAINT "class_sections_program_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "programId") REFERENCES "programs"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "class_sections"
  ADD CONSTRAINT "class_sections_session_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicSessionId") REFERENCES "academic_sessions"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "class_sections"
  ADD CONSTRAINT "class_sections_term_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicTermId") REFERENCES "academic_terms"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- class_enrollments
ALTER TABLE "class_enrollments"
  ADD CONSTRAINT "class_enrollments_section_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "classSectionId") REFERENCES "class_sections"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "class_enrollments"
  ADD CONSTRAINT "class_enrollments_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- faculty_profiles
ALTER TABLE "faculty_profiles"
  ADD CONSTRAINT "faculty_profiles_user_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "userId") REFERENCES "users"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "faculty_profiles"
  ADD CONSTRAINT "faculty_profiles_department_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "departmentId") REFERENCES "departments"("institutionId", "id")
  MATCH SIMPLE ON DELETE SET NULL ON UPDATE CASCADE;

-- faculty_assignments
ALTER TABLE "faculty_assignments"
  ADD CONSTRAINT "faculty_assignments_faculty_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "facultyId") REFERENCES "faculty_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "faculty_assignments"
  ADD CONSTRAINT "faculty_assignments_subject_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "subjectId") REFERENCES "subjects"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "faculty_assignments"
  ADD CONSTRAINT "faculty_assignments_section_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "classSectionId") REFERENCES "class_sections"("institutionId", "id")
  MATCH SIMPLE ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "faculty_assignments"
  ADD CONSTRAINT "faculty_assignments_term_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicTermId") REFERENCES "academic_terms"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- timetables
ALTER TABLE "timetables"
  ADD CONSTRAINT "timetables_term_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicTermId") REFERENCES "academic_terms"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- scheduled_classes
ALTER TABLE "scheduled_classes"
  ADD CONSTRAINT "scheduled_classes_timetable_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "timetableId") REFERENCES "timetables"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "scheduled_classes"
  ADD CONSTRAINT "scheduled_classes_section_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "classSectionId") REFERENCES "class_sections"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "scheduled_classes"
  ADD CONSTRAINT "scheduled_classes_subject_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "subjectId") REFERENCES "subjects"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "scheduled_classes"
  ADD CONSTRAINT "scheduled_classes_faculty_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "facultyId") REFERENCES "faculty_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "scheduled_classes"
  ADD CONSTRAINT "scheduled_classes_term_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicTermId") REFERENCES "academic_terms"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- f. CHECK constraints on scheduled_classes (design §6.9 / §11f). Integer-minute
--    time bounds + a strictly-positive duration + exactly-one-of recurring
--    (dayOfWeek) / one-off (date).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "scheduled_classes"
  ADD CONSTRAINT "scheduled_classes_startTime_bounds_check"
  CHECK ("startTime" >= 0 AND "startTime" < 1440);
ALTER TABLE "scheduled_classes"
  ADD CONSTRAINT "scheduled_classes_endTime_bounds_check"
  CHECK ("endTime" > 0 AND "endTime" <= 1440);
ALTER TABLE "scheduled_classes"
  ADD CONSTRAINT "scheduled_classes_start_before_end_check"
  CHECK ("startTime" < "endTime");
ALTER TABLE "scheduled_classes"
  ADD CONSTRAINT "scheduled_classes_day_xor_date_check"
  CHECK (("dayOfWeek" IS NULL) <> ("date" IS NULL));

-- ─────────────────────────────────────────────────────────────────────────────
-- g. RLS. ENABLE + FORCE on all nine. The eight mutable tables get the standard
--    fail-closed nullif-guarded pair {tenant_isolation_select,
--    tenant_isolation_modify}. schedule_revisions gets the APPEND-ONLY pair
--    {tenant_isolation_select, schedule_revisions_tenant_insert} with NO modify
--    / FOR ALL policy (the student_profile_history / audit_events house style).
--    nullif(current_setting('app.current_institution_id', true), '') fails closed
--    for both an unset and an empty-string GUC.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  mutable_tables TEXT[] := ARRAY[
    'courses', 'subjects', 'class_sections', 'class_enrollments',
    'faculty_profiles', 'faculty_assignments', 'timetables', 'scheduled_classes'
  ];
BEGIN
  -- Eight mutable tables: standard select + modify pair.
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

  -- schedule_revisions: append-only (SELECT + INSERT, NO modify).
  ALTER TABLE "schedule_revisions" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "schedule_revisions" FORCE  ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "tenant_isolation_select" ON "schedule_revisions";
  CREATE POLICY "tenant_isolation_select" ON "schedule_revisions"
    FOR SELECT
    USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

  DROP POLICY IF EXISTS "schedule_revisions_tenant_insert" ON "schedule_revisions";
  CREATE POLICY "schedule_revisions_tenant_insert" ON "schedule_revisions"
    FOR INSERT
    WITH CHECK ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- h. Append-only trigger on schedule_revisions. A BEFORE UPDATE OR DELETE trigger
--    binds EVERY role — including the table owner / postgres (privileged) path
--    GRANTs cannot restrict — so a revision row can only ever be inserted, never
--    rewritten (mirrors student_profile_history / audit_events).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "schedule_revisions_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'schedule_revisions is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "schedule_revisions_no_update_delete"
  BEFORE UPDATE OR DELETE ON "schedule_revisions"
  FOR EACH ROW EXECUTE FUNCTION "schedule_revisions_append_only"();

-- ─────────────────────────────────────────────────────────────────────────────
-- i. campass_app GRANT refresh (guarded + idempotent). The live grant uses
--    GRANT ... ON ALL TABLES + ALTER DEFAULT PRIVILEGES, so the nine new tables
--    inherit full DML by default. Pin them: the eight mutable tables legitimately
--    need full DML; schedule_revisions is append-only — keep SELECT, INSERT and
--    REVOKE UPDATE, DELETE. Never grant BYPASSRLS.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "courses"             TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "subjects"            TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "class_sections"      TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "class_enrollments"   TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "faculty_profiles"    TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "faculty_assignments" TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "timetables"          TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "scheduled_classes"   TO "campass_app";

    GRANT SELECT, INSERT ON "schedule_revisions" TO "campass_app";
    REVOKE UPDATE, DELETE ON "schedule_revisions" FROM "campass_app";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- j. Seed the seven classes.* permissions + their role_permissions pairs, using
--    the same seed-block shape + join + markers the earlier seeds use so the
--    catalogue-sync meta-test parses this block too. The new FACULTY template
--    role INSERT is emitted BEFORE the "permissions" block (so no stray tuple /
--    ON CONFLICT marker falls inside the permission or role_permission slice the
--    parser carves out, and so the role_permissions join on r."key"='FACULTY'
--    AND r."institutionId" IS NULL resolves). ROLE_PERMISSIONS lockstep (§7/A4):
--    ADMIN=all 7; HOD=all 7; FACULTY=classes.view_own ONLY; STUDENT=classes.view_own.
-- ─────────────────────────────────────────────────────────────────────────────

-- FACULTY template role (institutionId NULL; deterministic id). Emitted FIRST.
INSERT INTO "roles" ("id","key","name","institutionId") VALUES
  ('role_template_faculty', 'FACULTY', 'Faculty', NULL)
ON CONFLICT DO NOTHING;

INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_classes_courses_manage',   'classes.courses.manage',   'classes', 'Create/update courses and subjects'),
  ('perm_classes_sections_manage',  'classes.sections.manage',  'classes', 'Create/update class sections'),
  ('perm_classes_enroll',           'classes.enroll',           'classes', 'Enroll / drop students in a section'),
  ('perm_classes_faculty_assign',   'classes.faculty.assign',   'classes', 'Create faculty profiles and assign/substitute faculty'),
  ('perm_classes_timetable_manage', 'classes.timetable.manage', 'classes', 'Create/edit/publish timetables and scheduled classes'),
  ('perm_classes_view',             'classes.view',             'classes', 'View courses/subjects/sections/timetables (staff read)'),
  ('perm_classes_view_own',         'classes.view_own',         'classes', 'Faculty/Student view own schedule only')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('ADMIN',   'classes.courses.manage'),
  ('ADMIN',   'classes.sections.manage'),
  ('ADMIN',   'classes.enroll'),
  ('ADMIN',   'classes.faculty.assign'),
  ('ADMIN',   'classes.timetable.manage'),
  ('ADMIN',   'classes.view'),
  ('ADMIN',   'classes.view_own'),
  ('HOD',     'classes.courses.manage'),
  ('HOD',     'classes.sections.manage'),
  ('HOD',     'classes.enroll'),
  ('HOD',     'classes.faculty.assign'),
  ('HOD',     'classes.timetable.manage'),
  ('HOD',     'classes.view'),
  ('HOD',     'classes.view_own'),
  ('FACULTY', 'classes.view_own'),
  ('STUDENT', 'classes.view_own')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
