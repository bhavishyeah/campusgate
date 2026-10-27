-- CAMPASS Phase 2 — Student Information System (FEAT-001): generalize the LIVE
-- student_profiles table in place (additive-only), add the append-only
-- student_profile_history table + the student_documents reference table, and
-- seed the students.* permission catalogue.
--
-- Hand-authored (Prisma's diff does not model RLS, the composite same-tenant FKs,
-- the append-only trigger, the targeted GRANT refresh, or the catalogue seed).
-- ADDITIVE ONLY on the live student_profiles table: it adds a defaulted status
-- column (the DEFAULT 'ACTIVE' backfills every existing row), a nullable
-- admissionDate, and three nullable structured-link columns; it NEVER recreates
-- the table, NEVER drops/renames the live free-text program / semester columns,
-- and does NOT touch the table's FROZEN B-1 RLS or campass_app grant (the new
-- columns inherit the existing institutionId-keyed policies + table grant).
--
-- It NEVER alters any of the SEVEN FROZEN migrations
-- (20260824143031_add_allowance_and_reliability_models, 20261018100917_init,
-- 20261018110658_tenancy_isolation_rls, 20261018171747_identity_rbac_b2,
-- 20261019053533_superadmin_security, 20261019093119_module_system,
-- 20261027111710_phase1_academics). campass_app stays NOSUPERUSER NOBYPASSRLS —
-- never granted BYPASSRLS here.
--
-- Ordering (design §10.1, mirrors phase1_academics):
--   a.  CREATE TYPE the three new enums;
--   b.  ALTER student_profiles ADD COLUMN the status (NOT NULL DEFAULT 'ACTIVE' —
--       the backfill), admissionDate, and three nullable link columns;
--   c.  CREATE TABLE student_profile_history + student_documents + PKs/uniques/
--       indexes;
--   d.  tenant-root FKs (-> institutions(id) RESTRICT) on both new tables;
--   e.  composite same-tenant FKs: drop student_profiles' three single-col Prisma
--       FKs + add composite (institutionId,<col>) FKs SET NULL to programs /
--       academic_sessions / academic_terms; history + documents studentProfileId
--       composite FKs -> student_profiles(institutionId,id) RESTRICT;
--   f.  CREATE the two new student_profiles indexes (inst,status)/(inst,programId);
--   g.  ENABLE + FORCE RLS: the standard fail-closed pair on student_documents,
--       the append-only pair (select + insert, NO modify) on
--       student_profile_history; student_profiles RLS is NOT touched;
--   h.  append-only function + BEFORE UPDATE OR DELETE trigger on the history;
--   i.  guarded campass_app GRANT refresh (full DML on student_documents;
--       SELECT,INSERT on student_profile_history + REVOKE UPDATE,DELETE from it);
--   j.  seed the six students.* permissions + students.view_own + role_permissions
--       pairs with the EXACT catalogue-sync markers.

-- ─────────────────────────────────────────────────────────────────────────────
-- a. Enums.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "StudentStatus" AS ENUM ('APPLICANT', 'ENROLLED', 'ACTIVE', 'ON_LEAVE', 'GRADUATED', 'WITHDRAWN', 'SUSPENDED');
CREATE TYPE "StudentHistoryChangeType" AS ENUM ('CREATED', 'STATUS_CHANGED', 'PROGRAM_CHANGED', 'ENROLLED', 'PROMOTED', 'TRANSFERRED', 'DEACTIVATED', 'UPDATED');
CREATE TYPE "StudentDocumentKind" AS ENUM ('ID_PROOF', 'PHOTO', 'TRANSCRIPT', 'CERTIFICATE', 'OTHER');

-- ─────────────────────────────────────────────────────────────────────────────
-- b. Additive nullable/defaulted columns on the EXISTING student_profiles (the
--    table, its id/institutionId, RLS, and campass_app grant are FROZEN Phase-0
--    objects and stay). The status DEFAULT 'ACTIVE' is THE backfill: Postgres
--    fills every existing row at column-add time, so no separate UPDATE is
--    needed. The three link columns + admissionDate are nullable so existing
--    rows + every live GatePass/allowance/reliability read keep working
--    byte-for-byte.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "student_profiles" ADD COLUMN "status"            "StudentStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "student_profiles" ADD COLUMN "admissionDate"     TIMESTAMP(3);
ALTER TABLE "student_profiles" ADD COLUMN "programId"         TEXT;
ALTER TABLE "student_profiles" ADD COLUMN "academicSessionId" TEXT;
ALTER TABLE "student_profiles" ADD COLUMN "currentTermId"     TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- c. New tenant-owned tables. Each carries institutionId (ownership column) +
--    @@unique([id, institutionId]) + @@index([institutionId]) per tenancy.md §4.
--    student_profile_history is append-only (RLS/trigger/REVOKE below).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "student_profile_history" (
    "id"                   TEXT NOT NULL,
    "institutionId"        TEXT NOT NULL,
    "studentProfileId"     TEXT NOT NULL,
    "changeType"           "StudentHistoryChangeType" NOT NULL,
    "previousStatus"       "StudentStatus",
    "newStatus"            "StudentStatus",
    "previousProgramId"    TEXT,
    "newProgramId"         TEXT,
    "previousProgramText"  TEXT,
    "newProgramText"       TEXT,
    "previousSemester"     INTEGER,
    "newSemester"          INTEGER,
    "previousDepartmentId" TEXT,
    "newDepartmentId"      TEXT,
    "previousSessionId"    TEXT,
    "newSessionId"         TEXT,
    "previousTermId"       TEXT,
    "newTermId"            TEXT,
    "actorUserId"          TEXT NOT NULL,
    "actorMembershipId"    TEXT,
    "reason"               TEXT,
    "metadata"             JSONB,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_profile_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX        "student_profile_history_institutionId_idx"                  ON "student_profile_history"("institutionId");
CREATE INDEX        "student_profile_history_institutionId_studentProfileId_idx" ON "student_profile_history"("institutionId", "studentProfileId");
CREATE INDEX        "student_profile_history_studentProfileId_idx"               ON "student_profile_history"("studentProfileId");
CREATE UNIQUE INDEX "student_profile_history_id_institutionId_key"               ON "student_profile_history"("id", "institutionId");

CREATE TABLE "student_documents" (
    "id"               TEXT NOT NULL,
    "institutionId"    TEXT NOT NULL,
    "studentProfileId" TEXT NOT NULL,
    "kind"             "StudentDocumentKind" NOT NULL DEFAULT 'OTHER',
    "title"            TEXT NOT NULL,
    "storageKey"       TEXT NOT NULL,
    "contentType"      TEXT,
    "sizeBytes"        INTEGER,
    "uploadedByUserId" TEXT NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_documents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX        "student_documents_institutionId_idx"                  ON "student_documents"("institutionId");
CREATE INDEX        "student_documents_institutionId_studentProfileId_idx" ON "student_documents"("institutionId", "studentProfileId");
CREATE UNIQUE INDEX "student_documents_id_institutionId_key"               ON "student_documents"("id", "institutionId");

-- ─────────────────────────────────────────────────────────────────────────────
-- d. Tenant-root FKs: institutionId -> institutions(id) ON DELETE RESTRICT on
--    both new tables (single-leg, the institution_modules shape).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "student_profile_history"
  ADD CONSTRAINT "student_profile_history_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "student_documents"
  ADD CONSTRAINT "student_documents_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- e. Composite same-tenant FKs (tenancy.md §4). The three student_profiles link
--    columns (programId / academicSessionId / currentTermId) are NEW columns
--    added in section (b): Postgres does not auto-create a FK on ADD COLUMN, so
--    there is NO pre-existing single-column Prisma FK to drop (unlike Phase 1,
--    whose generalized columns pre-existed). We therefore ADD the composite FKs
--    INCLUDING institutionId directly, so a row can never reference a parent in
--    another tenant. All three links are informational -> ON DELETE SET NULL (a
--    closed session / retired program being referenced must not block). The two
--    new tables' studentProfileId -> student_profiles(institutionId,id) RESTRICT
--    (a student is never hard-deleted, so RESTRICT is safe + enforces same-tenant
--    history/documents).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_program_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "programId")
  REFERENCES "programs"("institutionId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_session_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicSessionId")
  REFERENCES "academic_sessions"("institutionId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_term_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "currentTermId")
  REFERENCES "academic_terms"("institutionId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "student_profile_history"
  ADD CONSTRAINT "student_profile_history_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentProfileId")
  REFERENCES "student_profiles"("institutionId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "student_documents"
  ADD CONSTRAINT "student_documents_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentProfileId")
  REFERENCES "student_profiles"("institutionId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- f. New indexes on student_profiles for the paginated status/program filters
--    (§3.3). The existing (institutionId) index + (id,institutionId) unique are
--    untouched.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX "student_profiles_institutionId_status_idx"    ON "student_profiles"("institutionId", "status");
CREATE INDEX "student_profiles_institutionId_programId_idx" ON "student_profiles"("institutionId", "programId");

-- ─────────────────────────────────────────────────────────────────────────────
-- g. RLS. ENABLE + FORCE on the two NEW tables. student_documents gets the
--    standard fail-closed nullif-guarded pair {tenant_isolation_select,
--    tenant_isolation_modify} (editable metadata — full modify path).
--    student_profile_history gets the APPEND-ONLY pair {tenant_isolation_select,
--    student_profile_history_tenant_insert} with NO modify / FOR ALL policy
--    (audit_events / academic_calendar_day_revisions house style).
--    nullif(current_setting('app.current_institution_id', true), '') fails closed
--    for both an unset and an empty-string GUC. student_profiles RLS is NOT
--    touched (it already has ENABLE+FORCE + the standard pair from FROZEN B-1).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- student_documents: standard pair.
  ALTER TABLE "student_documents" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "student_documents" FORCE  ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "tenant_isolation_select" ON "student_documents";
  CREATE POLICY "tenant_isolation_select" ON "student_documents"
    FOR SELECT
    USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

  DROP POLICY IF EXISTS "tenant_isolation_modify" ON "student_documents";
  CREATE POLICY "tenant_isolation_modify" ON "student_documents"
    FOR ALL
    USING     ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''))
    WITH CHECK ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

  -- student_profile_history: append-only (SELECT + INSERT, NO modify).
  ALTER TABLE "student_profile_history" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "student_profile_history" FORCE  ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "tenant_isolation_select" ON "student_profile_history";
  CREATE POLICY "tenant_isolation_select" ON "student_profile_history"
    FOR SELECT
    USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

  DROP POLICY IF EXISTS "student_profile_history_tenant_insert" ON "student_profile_history";
  CREATE POLICY "student_profile_history_tenant_insert" ON "student_profile_history"
    FOR INSERT
    WITH CHECK ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- h. Append-only trigger on student_profile_history. A BEFORE UPDATE OR DELETE
--    trigger binds EVERY role — including the table owner / postgres (privileged)
--    path that GRANTs cannot restrict — so a history row can only ever be
--    inserted, never rewritten (mirrors academic_calendar_day_revisions /
--    audit_events).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "student_profile_history_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'student_profile_history is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "student_profile_history_no_update_delete"
  BEFORE UPDATE OR DELETE ON "student_profile_history"
  FOR EACH ROW EXECUTE FUNCTION "student_profile_history_append_only"();

-- ─────────────────────────────────────────────────────────────────────────────
-- i. campass_app GRANT refresh (guarded + idempotent). The live B-1 grant uses
--    GRANT ... ON ALL TABLES + ALTER DEFAULT PRIVILEGES, so the two new tables
--    inherit full DML by default. Pin them: student_documents legitimately needs
--    full DML (editable reference metadata); student_profile_history is
--    append-only — keep SELECT, INSERT and REVOKE UPDATE, DELETE. Never grant
--    BYPASSRLS. student_profiles needs no new grant (existing table grant +
--    ALTER DEFAULT PRIVILEGES cover its new columns).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "student_documents" TO "campass_app";

    GRANT SELECT, INSERT ON "student_profile_history" TO "campass_app";
    REVOKE UPDATE, DELETE ON "student_profile_history" FROM "campass_app";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- j. Seed the six students.* permissions + students.view_own + their
--    role_permissions pairs, using the same seed-block shape + join + markers the
--    identity_rbac_b2 / superadmin_security / module_system / phase1_academics
--    seeds use so the generalized catalogue-sync meta-test parses this block too.
--    Both inserts are idempotent (DO NOTHING on conflict). ADMIN gains all six +
--    students.view_own; HOD gains view/update/enroll/promote + students.view_own;
--    STUDENT gains students.view_own. Template roles + catalogue already exist.
--    No backfill.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_students_view',       'students.view',       'students', 'View student records, detail and history (list/detail/history)'),
  ('perm_students_create',     'students.create',     'students', 'Create a student'),
  ('perm_students_update',     'students.update',     'students', 'Edit permitted fields; assign program; transfer; reactivate'),
  ('perm_students_enroll',     'students.enroll',     'students', 'Enroll a student into a session/term'),
  ('perm_students_promote',    'students.promote',    'students', 'Promote a student (advance term/semester)'),
  ('perm_students_deactivate', 'students.deactivate', 'students', 'Archive a student via status (withdraw/suspend/graduate/leave)'),
  ('perm_students_view_own',   'students.view_own',   'students', 'Student views only their own profile and academic info')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('ADMIN',   'students.view'),
  ('ADMIN',   'students.create'),
  ('ADMIN',   'students.update'),
  ('ADMIN',   'students.enroll'),
  ('ADMIN',   'students.promote'),
  ('ADMIN',   'students.deactivate'),
  ('ADMIN',   'students.view_own'),
  ('HOD',     'students.view'),
  ('HOD',     'students.update'),
  ('HOD',     'students.enroll'),
  ('HOD',     'students.promote'),
  ('HOD',     'students.view_own'),
  ('STUDENT', 'students.view_own')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
