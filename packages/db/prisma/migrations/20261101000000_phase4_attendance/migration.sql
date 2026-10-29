-- CAMPASS Phase 4 — Attendance: the DB foundation.
--
-- Hand-authored (Prisma's diff does not model RLS, the composite same-tenant
-- FKs, the three-column term-integrity FK, the CHECK constraint, the append-only
-- trigger, the targeted GRANT refresh, or the catalogue seed). This migration
-- only CREATEs new objects (+ one additive UNIQUE on scheduled_classes) and ADDs
-- the attendance.* permission seed; it NEVER ALTERs a Phase-0/1/2/3 table's RLS,
-- grant, or FK, and NEVER touches the _prisma_migrations ledger. campass_app
-- stays NOSUPERUSER NOBYPASSRLS — never granted BYPASSRLS.
--
-- It NEVER alters any of the NINE FROZEN migrations
-- (20260824143031_add_allowance_and_reliability_models, 20261018100917_init,
-- 20261018110658_tenancy_isolation_rls, 20261018171747_identity_rbac_b2,
-- 20261019053533_superadmin_security, 20261019093119_module_system,
-- 20261027111710_phase1_academics, 20261027161616_phase2_sis,
-- 20261028000000_phase3_classes).
--
-- FOUR new tenant-owned tables = THREE standard-RLS-pair (mutable) tables
-- (attendance_sessions, attendance_records, attendance_corrections) + ONE
-- append-only table (attendance_record_history). Every table carries
-- institutionId + (id, institutionId) composite unique + (institutionId) index +
-- composite same-tenant FKs incl. institutionId + ENABLE+FORCE RLS.
--
-- Ordering (design §10, mirrors phase3_classes sections a–j):
--   a. CREATE TYPE the four new enums;
--   b. CREATE TABLE the four new tables + PKs;
--   c. unique + query indexes (each (id,institutionId), the business uniques,
--      every (institutionId) index + the §3 query indexes, the additive
--      scheduled_classes (institutionId, id, academicTermId) UNIQUE, the partial
--      one-pending-correction UNIQUE);
--   d. tenant-root FKs institutionId -> institutions(id) RESTRICT on all four;
--   e. composite same-tenant FKs (incl. the three-column session->class->term FK);
--   f. CHECK constraint on attendance_corrections (reason non-empty);
--   g. ENABLE+FORCE RLS on all four (standard pair on the three mutable tables,
--      append-only pair on attendance_record_history);
--   h. append-only function + BEFORE UPDATE OR DELETE trigger on history;
--   i. guarded campass_app GRANT refresh (full DML on the three mutable tables;
--      SELECT,INSERT + REVOKE UPDATE,DELETE on attendance_record_history);
--   j. seed the five attendance.* permissions + role_permissions pairs (the nine
--      (role,key) pairs; FACULTY template role already exists — not re-inserted).

-- ─────────────────────────────────────────────────────────────────────────────
-- a. Enums.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "AttendanceSessionStatus"           AS ENUM ('OPEN', 'SUBMITTED', 'FINALIZED');
CREATE TYPE "AttendanceStatus"                   AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'EXCUSED');
CREATE TYPE "AttendanceCorrectionReviewStatus"  AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "AttendanceRecordHistoryChangeType" AS ENUM ('MARKED', 'CORRECTED');

-- ─────────────────────────────────────────────────────────────────────────────
-- b. New tenant-owned tables + PKs. createdAt DEFAULT CURRENT_TIMESTAMP; updatedAt
--    NOT NULL on the three mutable tables; attendance_record_history has no
--    updatedAt (append-only).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "attendance_sessions" (
    "id"                 TEXT NOT NULL,
    "institutionId"      TEXT NOT NULL,
    "scheduledClassId"   TEXT NOT NULL,
    "academicTermId"     TEXT NOT NULL,
    "date"               TIMESTAMP(3) NOT NULL,
    "status"             "AttendanceSessionStatus" NOT NULL DEFAULT 'OPEN',
    "markedByFacultyId"  TEXT NOT NULL,
    "submissionDeadline" TIMESTAMP(3),
    "submittedAt"        TIMESTAMP(3),
    "finalizedAt"        TIMESTAMP(3),
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "attendance_records" (
    "id"                  TEXT NOT NULL,
    "institutionId"       TEXT NOT NULL,
    "attendanceSessionId" TEXT NOT NULL,
    "studentId"           TEXT NOT NULL,
    "status"              "AttendanceStatus" NOT NULL,
    "markedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "attendance_corrections" (
    "id"                 TEXT NOT NULL,
    "institutionId"      TEXT NOT NULL,
    "attendanceRecordId" TEXT NOT NULL,
    "requestedByUserId"  TEXT NOT NULL,
    "reason"             TEXT NOT NULL,
    "requestedStatus"    "AttendanceStatus" NOT NULL,
    "priorStatus"        "AttendanceStatus" NOT NULL,
    "reviewStatus"       "AttendanceCorrectionReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedByUserId"   TEXT,
    "reviewedAt"         TIMESTAMP(3),
    "reviewNote"         TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_corrections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "attendance_record_history" (
    "id"                 TEXT NOT NULL,
    "institutionId"      TEXT NOT NULL,
    "attendanceRecordId" TEXT NOT NULL,
    "changeType"         "AttendanceRecordHistoryChangeType" NOT NULL,
    "previousStatus"     "AttendanceStatus",
    "newStatus"          "AttendanceStatus" NOT NULL,
    "correctionId"       TEXT,
    "actorUserId"        TEXT NOT NULL,
    "actorMembershipId"  TEXT,
    "reason"             TEXT,
    "metadata"           JSONB,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_record_history_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- c. Unique + query indexes. Each table's (id, institutionId) composite unique
--    (anchors the composite same-tenant FKs); the business uniques; every
--    (institutionId) index + the §3 query indexes. Plus the ADDITIVE
--    scheduled_classes (institutionId, id, academicTermId) UNIQUE (the FK target
--    for the three-column term-integrity FK, design §3.2 — created here in the
--    Phase 4 dir, not by editing the frozen Phase 3 dir) and the partial
--    one-pending-correction UNIQUE.
-- ─────────────────────────────────────────────────────────────────────────────
-- attendance_sessions
CREATE UNIQUE INDEX "attendance_sessions_scheduledClassId_date_key"        ON "attendance_sessions"("scheduledClassId", "date");
CREATE UNIQUE INDEX "attendance_sessions_id_institutionId_key"             ON "attendance_sessions"("id", "institutionId");
CREATE INDEX        "attendance_sessions_institutionId_idx"                ON "attendance_sessions"("institutionId");
CREATE INDEX        "attendance_sessions_institutionId_academicTermId_date_idx" ON "attendance_sessions"("institutionId", "academicTermId", "date");
CREATE INDEX        "attendance_sessions_markedByFacultyId_idx"            ON "attendance_sessions"("markedByFacultyId");
CREATE INDEX        "attendance_sessions_scheduledClassId_idx"             ON "attendance_sessions"("scheduledClassId");

-- attendance_records
CREATE UNIQUE INDEX "attendance_records_attendanceSessionId_studentId_key" ON "attendance_records"("attendanceSessionId", "studentId");
CREATE UNIQUE INDEX "attendance_records_id_institutionId_key"              ON "attendance_records"("id", "institutionId");
CREATE INDEX        "attendance_records_institutionId_idx"                 ON "attendance_records"("institutionId");
CREATE INDEX        "attendance_records_institutionId_studentId_idx"       ON "attendance_records"("institutionId", "studentId");
CREATE INDEX        "attendance_records_attendanceSessionId_idx"           ON "attendance_records"("attendanceSessionId");

-- attendance_corrections
CREATE UNIQUE INDEX "attendance_corrections_id_institutionId_key"          ON "attendance_corrections"("id", "institutionId");
CREATE INDEX        "attendance_corrections_institutionId_idx"             ON "attendance_corrections"("institutionId");
CREATE INDEX        "attendance_corrections_institutionId_reviewStatus_idx" ON "attendance_corrections"("institutionId", "reviewStatus");
CREATE INDEX        "attendance_corrections_attendanceRecordId_idx"        ON "attendance_corrections"("attendanceRecordId");
-- One open PENDING correction per record (design §8.1).
CREATE UNIQUE INDEX "attendance_corrections_one_pending" ON "attendance_corrections"("institutionId", "attendanceRecordId") WHERE "reviewStatus" = 'PENDING';

-- attendance_record_history (append-only)
CREATE UNIQUE INDEX "attendance_record_history_id_institutionId_key"       ON "attendance_record_history"("id", "institutionId");
CREATE INDEX        "attendance_record_history_institutionId_idx"          ON "attendance_record_history"("institutionId");
CREATE INDEX        "attendance_record_history_institutionId_attendanceRecordId_idx" ON "attendance_record_history"("institutionId", "attendanceRecordId");
CREATE INDEX        "attendance_record_history_attendanceRecordId_idx"     ON "attendance_record_history"("attendanceRecordId");

-- Additive FK target on scheduled_classes (three-column term integrity, design §3.2/§10e).
CREATE UNIQUE INDEX "scheduled_classes_institutionId_id_academicTermId_key" ON "scheduled_classes"("institutionId", "id", "academicTermId");

-- ─────────────────────────────────────────────────────────────────────────────
-- d. Tenant-root FKs: institutionId -> institutions(id) ON DELETE RESTRICT on
--    all four new tables.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "attendance_sessions"        ADD CONSTRAINT "attendance_sessions_institutionId_fkey"        FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendance_records"         ADD CONSTRAINT "attendance_records_institutionId_fkey"         FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendance_corrections"     ADD CONSTRAINT "attendance_corrections_institutionId_fkey"     FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendance_record_history"  ADD CONSTRAINT "attendance_record_history_institutionId_fkey"  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- e. Composite same-tenant FKs (tenancy.md §4, design §3/§10e). Each carries
--    institutionId so a child can never reference a parent in another tenant.
--    The attendance_sessions -> scheduled_classes link is a THREE-COLUMN FK
--    (institutionId, scheduledClassId, academicTermId) so a denormalized-term
--    mismatch is impossible by construction (design §3.2, MEDIUM-4). The
--    requestedByUserId / reviewedByUserId / actorUserId / correctionId columns
--    are recorded ids with NO FK.
-- ─────────────────────────────────────────────────────────────────────────────
-- attendance_sessions
ALTER TABLE "attendance_sessions"
  ADD CONSTRAINT "attendance_sessions_class_term_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "scheduledClassId", "academicTermId")
  REFERENCES "scheduled_classes"("institutionId", "id", "academicTermId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendance_sessions"
  ADD CONSTRAINT "attendance_sessions_faculty_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "markedByFacultyId") REFERENCES "faculty_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- attendance_records
ALTER TABLE "attendance_records"
  ADD CONSTRAINT "attendance_records_session_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "attendanceSessionId") REFERENCES "attendance_sessions"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendance_records"
  ADD CONSTRAINT "attendance_records_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- attendance_corrections
ALTER TABLE "attendance_corrections"
  ADD CONSTRAINT "attendance_corrections_record_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "attendanceRecordId") REFERENCES "attendance_records"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- attendance_record_history
ALTER TABLE "attendance_record_history"
  ADD CONSTRAINT "attendance_record_history_record_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "attendanceRecordId") REFERENCES "attendance_records"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- f. CHECK constraint: a correction must carry a non-empty reason (design §8.1).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "attendance_corrections"
  ADD CONSTRAINT "attendance_corrections_reason_nonempty_check"
  CHECK (char_length("reason") >= 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- g. RLS. ENABLE + FORCE on all four. The three mutable tables get the standard
--    fail-closed nullif-guarded pair {tenant_isolation_select,
--    tenant_isolation_modify}. attendance_record_history gets the APPEND-ONLY
--    pair {tenant_isolation_select, attendance_record_history_tenant_insert} with
--    NO modify / FOR ALL policy (the schedule_revisions / audit_events house
--    style). nullif(current_setting('app.current_institution_id', true), '') fails
--    closed for both an unset and an empty-string GUC.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  mutable_tables TEXT[] := ARRAY[
    'attendance_sessions', 'attendance_records', 'attendance_corrections'
  ];
BEGIN
  -- Three mutable tables: standard select + modify pair.
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

  -- attendance_record_history: append-only (SELECT + INSERT, NO modify).
  ALTER TABLE "attendance_record_history" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "attendance_record_history" FORCE  ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "tenant_isolation_select" ON "attendance_record_history";
  CREATE POLICY "tenant_isolation_select" ON "attendance_record_history"
    FOR SELECT
    USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

  DROP POLICY IF EXISTS "attendance_record_history_tenant_insert" ON "attendance_record_history";
  CREATE POLICY "attendance_record_history_tenant_insert" ON "attendance_record_history"
    FOR INSERT
    WITH CHECK ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- h. Append-only trigger on attendance_record_history. A BEFORE UPDATE OR DELETE
--    trigger binds EVERY role — including the table owner / postgres path GRANTs
--    cannot restrict — so a history row can only ever be inserted, never
--    rewritten (mirrors schedule_revisions / audit_events).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "attendance_record_history_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'attendance_record_history is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "attendance_record_history_no_update_delete"
  BEFORE UPDATE OR DELETE ON "attendance_record_history"
  FOR EACH ROW EXECUTE FUNCTION "attendance_record_history_append_only"();

-- ─────────────────────────────────────────────────────────────────────────────
-- i. campass_app GRANT refresh (guarded + idempotent). The three mutable tables
--    legitimately need full DML; attendance_record_history is append-only — keep
--    SELECT, INSERT and REVOKE UPDATE, DELETE. Never grant BYPASSRLS.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "attendance_sessions"    TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "attendance_records"     TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "attendance_corrections" TO "campass_app";

    GRANT SELECT, INSERT ON "attendance_record_history" TO "campass_app";
    REVOKE UPDATE, DELETE ON "attendance_record_history" FROM "campass_app";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- j. Seed the five attendance.* permissions + their role_permissions pairs, using
--    the same seed-block shape + join + markers the earlier seeds use so the
--    catalogue-sync meta-test parses this block too. The FACULTY template role
--    already exists (seeded by phase3_classes) — NOT re-inserted. ROLE_PERMISSIONS
--    lockstep (design §5.2): the nine (role,key) pairs; GUARD/SUPER_ADMIN none.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_attendance_view',      'attendance.view',      'attendance', 'Staff read of sessions/records/reports (HOD dept-scoped, ADMIN whole-tenant)'),
  ('perm_attendance_mark',      'attendance.mark',      'attendance', 'Faculty opens a session, marks records, submits, finalizes — assigned classes only (record-level scope)'),
  ('perm_attendance_correct',   'attendance.correct',   'attendance', 'Review (approve/reject) a correction request'),
  ('perm_attendance_export',    'attendance.export',    'attendance', 'Export attendance (authorized and audited)'),
  ('perm_attendance_view_own',  'attendance.view_own',  'attendance', 'Student reads only their own attendance')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('STUDENT', 'attendance.view_own'),
  ('FACULTY', 'attendance.mark'),
  ('FACULTY', 'attendance.view_own'),
  ('HOD',     'attendance.view'),
  ('HOD',     'attendance.correct'),
  ('HOD',     'attendance.export'),
  ('ADMIN',   'attendance.view'),
  ('ADMIN',   'attendance.correct'),
  ('ADMIN',   'attendance.export')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
