-- CAMPASS Phase 1 — Shared Institutional Data (FEAT-001): academic sessions,
-- terms, programs, the generalized academic calendar, and the append-only
-- calendar-revision history.
--
-- Hand-authored (Prisma's diff does not model RLS, the composite same-tenant FKs,
-- the partial unique indexes, the append-only trigger, the targeted GRANT refresh,
-- or the catalogue seed). ADDITIVE ONLY: it creates five new enums + four new
-- tenant-owned tables, adds three nullable columns to the existing
-- academic_calendar_days (and swaps its single unique for two partial uniques),
-- and seeds four new permissions. It NEVER alters the FROZEN B-1
-- (20261018110658_tenancy_isolation_rls), identity_rbac_b2
-- (20261018171747_identity_rbac_b2), superadmin_security
-- (20261019053533_superadmin_security), or module_system
-- (20261019093119_module_system) objects. campass_app stays NOSUPERUSER
-- NOBYPASSRLS — never granted BYPASSRLS here.
--
-- Ordering (mirrors superadmin_security / module_system):
--   a.  CREATE TYPE the five enums;
--   b.  CREATE TABLE the four new tables + PKs/uniques/indexes;
--   c.  ALTER academic_calendar_days ADD COLUMN the three nullable columns;
--   d.  tenant-root FKs (-> institutions(id) RESTRICT) on all four + composite
--       same-tenant FKs (incl. institutionId) for the cross-tenant links;
--   e.  DROP the live single unique on academic_calendar_days + CREATE the two
--       partial unique indexes (institution-wide / department-scoped);
--   f.  partial unique academic_sessions_one_active_per_institution;
--   g.  ENABLE + FORCE RLS: the standard fail-closed pair on sessions/terms/
--       programs, and the append-only pair (select + insert, NO modify) on the
--       revision table;
--   h.  append-only function + BEFORE UPDATE OR DELETE trigger on the revisions;
--   i.  guarded campass_app GRANT refresh (full DML on the three mutable tables;
--       SELECT,INSERT on the revision table + REVOKE UPDATE,DELETE from it);
--   j.  seed the four academics.* permissions + role_permissions pairs with the
--       EXACT catalogue-sync markers.

-- ─────────────────────────────────────────────────────────────────────────────
-- a. Enums.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "AcademicSessionStatus" AS ENUM ('UPCOMING', 'ACTIVE', 'CLOSED');
CREATE TYPE "AcademicStructureType" AS ENUM ('SEMESTER', 'TRIMESTER', 'ANNUAL', 'CUSTOM');
CREATE TYPE "AcademicTermStatus" AS ENUM ('UPCOMING', 'ACTIVE', 'CLOSED');
CREATE TYPE "ProgramStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "ProgramDurationUnit" AS ENUM ('TERMS', 'YEARS');

-- ─────────────────────────────────────────────────────────────────────────────
-- b. New tenant-owned tables. Each carries institutionId (ownership column) +
--    @@unique([id, institutionId]) + @@index([institutionId]) per tenancy.md §4.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "academic_sessions" (
    "id"            TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "structureType" "AcademicStructureType" NOT NULL,
    "status"        "AcademicSessionStatus" NOT NULL DEFAULT 'UPCOMING',
    "startDate"     TIMESTAMP(3) NOT NULL,
    "endDate"       TIMESTAMP(3) NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "academic_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX        "academic_sessions_institutionId_idx"         ON "academic_sessions"("institutionId");
CREATE INDEX        "academic_sessions_institutionId_status_idx"  ON "academic_sessions"("institutionId", "status");
CREATE UNIQUE INDEX "academic_sessions_institutionId_name_key"    ON "academic_sessions"("institutionId", "name");
CREATE UNIQUE INDEX "academic_sessions_id_institutionId_key"      ON "academic_sessions"("id", "institutionId");

CREATE TABLE "academic_terms" (
    "id"                TEXT NOT NULL,
    "institutionId"     TEXT NOT NULL,
    "academicSessionId" TEXT NOT NULL,
    "name"              TEXT NOT NULL,
    "ordinal"           INTEGER NOT NULL,
    "status"            "AcademicTermStatus" NOT NULL DEFAULT 'UPCOMING',
    "startDate"         TIMESTAMP(3) NOT NULL,
    "endDate"           TIMESTAMP(3) NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "academic_terms_pkey" PRIMARY KEY ("id")
);

CREATE INDEX        "academic_terms_institutionId_idx"               ON "academic_terms"("institutionId");
CREATE INDEX        "academic_terms_academicSessionId_idx"           ON "academic_terms"("academicSessionId");
CREATE UNIQUE INDEX "academic_terms_academicSessionId_ordinal_key"   ON "academic_terms"("academicSessionId", "ordinal");
CREATE UNIQUE INDEX "academic_terms_id_institutionId_key"            ON "academic_terms"("id", "institutionId");

CREATE TABLE "programs" (
    "id"            TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "departmentId"  TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "code"          TEXT NOT NULL,
    "duration"      INTEGER NOT NULL,
    "durationUnit"  "ProgramDurationUnit" NOT NULL DEFAULT 'TERMS',
    "status"        "ProgramStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX        "programs_institutionId_idx"      ON "programs"("institutionId");
CREATE INDEX        "programs_departmentId_idx"       ON "programs"("departmentId");
CREATE UNIQUE INDEX "programs_institutionId_code_key" ON "programs"("institutionId", "code");
CREATE UNIQUE INDEX "programs_id_institutionId_key"   ON "programs"("id", "institutionId");

-- academic_calendar_day_revisions: append-only history. calendarDayId /
-- academicSessionId / academicTermId / departmentId are SNAPSHOT columns (plain
-- nullable strings, NO live FK) so a revision outlives the row / session / term
-- it describes — mirroring how audit_events keeps single-column actor refs.
CREATE TABLE "academic_calendar_day_revisions" (
    "id"                TEXT NOT NULL,
    "institutionId"     TEXT NOT NULL,
    "calendarDayId"     TEXT,
    "date"              TIMESTAMP(3) NOT NULL,
    "departmentId"      TEXT,
    "previousDayType"   "AcademicDayType",
    "newDayType"        "AcademicDayType",
    "previousNote"      TEXT,
    "newNote"           TEXT,
    "changeType"        TEXT NOT NULL,
    "actorUserId"       TEXT NOT NULL,
    "academicSessionId" TEXT,
    "academicTermId"    TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academic_calendar_day_revisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX        "academic_calendar_day_revisions_institutionId_idx"      ON "academic_calendar_day_revisions"("institutionId");
CREATE INDEX        "academic_calendar_day_revisions_institutionId_date_idx" ON "academic_calendar_day_revisions"("institutionId", "date");
CREATE INDEX        "academic_calendar_day_revisions_calendarDayId_idx"      ON "academic_calendar_day_revisions"("calendarDayId");
CREATE UNIQUE INDEX "academic_calendar_day_revisions_id_institutionId_key"   ON "academic_calendar_day_revisions"("id", "institutionId");

-- ─────────────────────────────────────────────────────────────────────────────
-- c. Additive nullable columns on the EXISTING academic_calendar_days (the table,
--    its institutionId, RLS, and campass_app grant are FROZEN Phase-0 objects and
--    stay). All nullable so existing rows remain valid and the allowance-engine's
--    `findMany({ where: { institutionId, date } })` keeps working byte-for-byte.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "academic_calendar_days" ADD COLUMN "departmentId"      TEXT;
ALTER TABLE "academic_calendar_days" ADD COLUMN "academicSessionId" TEXT;
ALTER TABLE "academic_calendar_days" ADD COLUMN "academicTermId"    TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- d. Foreign keys.
--    Tenant-root FKs: institutionId -> institutions(id) ON DELETE RESTRICT on all
--    four new tables (single-leg, the institution_modules shape). Composite
--    same-tenant FKs INCLUDING institutionId make it physically impossible for a
--    row to reference a parent in another tenant (tenancy.md §4): terms->sessions
--    and programs->departments RESTRICT (ownership); the two live-link columns on
--    academic_calendar_days use SET NULL for session/term (informational) and
--    RESTRICT for department (scope, not silently orphaned). The revision table's
--    snapshot columns get NO FK (§4.3).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "academic_sessions"
  ADD CONSTRAINT "academic_sessions_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "academic_terms"
  ADD CONSTRAINT "academic_terms_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "academic_terms"
  ADD CONSTRAINT "academic_terms_session_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicSessionId")
  REFERENCES "academic_sessions"("institutionId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "programs"
  ADD CONSTRAINT "programs_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "programs"
  ADD CONSTRAINT "programs_department_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "departmentId")
  REFERENCES "departments"("institutionId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "academic_calendar_day_revisions"
  ADD CONSTRAINT "academic_calendar_day_revisions_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "academic_calendar_days"
  ADD CONSTRAINT "acd_department_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "departmentId")
  REFERENCES "departments"("institutionId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "academic_calendar_days"
  ADD CONSTRAINT "acd_session_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicSessionId")
  REFERENCES "academic_sessions"("institutionId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "academic_calendar_days"
  ADD CONSTRAINT "acd_term_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicTermId")
  REFERENCES "academic_terms"("institutionId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- e. Calendar uniqueness swap (Decision D). The live single unique allows ONE
--    entry per (institution, date); department-scoped entries must coexist with
--    the institution-wide row. Replace it with two partial uniques: one for the
--    institution-wide (departmentId IS NULL) case (NULL is distinct in a plain
--    unique, so a partial index is required to keep "at most one"), one for the
--    department-scoped case. This DROP targets an index the Phase-0 table owns;
--    it does NOT edit any FROZEN migration file.
-- ─────────────────────────────────────────────────────────────────────────────
DROP INDEX "academic_calendar_days_institutionId_date_key";

CREATE UNIQUE INDEX "academic_calendar_days_inst_date_institutionwide"
  ON "academic_calendar_days" ("institutionId", "date")
  WHERE "departmentId" IS NULL;

CREATE UNIQUE INDEX "academic_calendar_days_inst_date_dept"
  ON "academic_calendar_days" ("institutionId", "date", "departmentId")
  WHERE "departmentId" IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- f. At most one ACTIVE session per institution (§3.3). A partial unique index
--    is the structural backstop under concurrent activations; the service gives
--    the friendly 409.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "academic_sessions_one_active_per_institution"
  ON "academic_sessions" ("institutionId")
  WHERE "status" = 'ACTIVE';

-- ─────────────────────────────────────────────────────────────────────────────
-- g. RLS. ENABLE + FORCE on all four. academic_sessions / academic_terms /
--    programs get the standard fail-closed nullif-guarded pair
--    {tenant_isolation_select, tenant_isolation_modify} (module_system house
--    style — the tenant has a full modify path). academic_calendar_day_revisions
--    gets the APPEND-ONLY pair {tenant_isolation_select, *_tenant_insert} with NO
--    modify / FOR ALL policy (audit_events house style). nullif(current_setting(
--    'app.current_institution_id', true), '') fails closed for both an unset and
--    an empty-string GUC. NO `TO postgres` policy (postgres bypasses RLS).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- academic_sessions
  ALTER TABLE "academic_sessions" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "academic_sessions" FORCE  ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "tenant_isolation_select" ON "academic_sessions";
  CREATE POLICY "tenant_isolation_select" ON "academic_sessions"
    FOR SELECT
    USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

  DROP POLICY IF EXISTS "tenant_isolation_modify" ON "academic_sessions";
  CREATE POLICY "tenant_isolation_modify" ON "academic_sessions"
    FOR ALL
    USING     ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''))
    WITH CHECK ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

  -- academic_terms
  ALTER TABLE "academic_terms" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "academic_terms" FORCE  ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "tenant_isolation_select" ON "academic_terms";
  CREATE POLICY "tenant_isolation_select" ON "academic_terms"
    FOR SELECT
    USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

  DROP POLICY IF EXISTS "tenant_isolation_modify" ON "academic_terms";
  CREATE POLICY "tenant_isolation_modify" ON "academic_terms"
    FOR ALL
    USING     ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''))
    WITH CHECK ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

  -- programs
  ALTER TABLE "programs" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "programs" FORCE  ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "tenant_isolation_select" ON "programs";
  CREATE POLICY "tenant_isolation_select" ON "programs"
    FOR SELECT
    USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

  DROP POLICY IF EXISTS "tenant_isolation_modify" ON "programs";
  CREATE POLICY "tenant_isolation_modify" ON "programs"
    FOR ALL
    USING     ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''))
    WITH CHECK ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

  -- academic_calendar_day_revisions: append-only (SELECT + INSERT, NO modify).
  ALTER TABLE "academic_calendar_day_revisions" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "academic_calendar_day_revisions" FORCE  ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "tenant_isolation_select" ON "academic_calendar_day_revisions";
  CREATE POLICY "tenant_isolation_select" ON "academic_calendar_day_revisions"
    FOR SELECT
    USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

  DROP POLICY IF EXISTS "academic_calendar_day_revisions_tenant_insert" ON "academic_calendar_day_revisions";
  CREATE POLICY "academic_calendar_day_revisions_tenant_insert" ON "academic_calendar_day_revisions"
    FOR INSERT
    WITH CHECK ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- h. Append-only trigger on academic_calendar_day_revisions. A BEFORE UPDATE OR
--    DELETE trigger binds EVERY role — including the table owner / postgres
--    (privileged) path that GRANTs cannot restrict — so a revision can only ever
--    be inserted, never rewritten (mirrors audit_events_append_only).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "academic_calendar_day_revisions_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'academic_calendar_day_revisions is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "academic_calendar_day_revisions_no_update_delete"
  BEFORE UPDATE OR DELETE ON "academic_calendar_day_revisions"
  FOR EACH ROW EXECUTE FUNCTION "academic_calendar_day_revisions_append_only"();

-- ─────────────────────────────────────────────────────────────────────────────
-- i. campass_app GRANT refresh (guarded + idempotent). The live B-1 grant uses
--    GRANT ... ON ALL TABLES + ALTER DEFAULT PRIVILEGES, so the four new tables
--    inherit full DML by default. Pin them: sessions/terms/programs legitimately
--    need full DML (tenant writes); the revision table is append-only — keep
--    SELECT, INSERT and REVOKE UPDATE, DELETE. Never grant BYPASSRLS.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "academic_sessions" TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "academic_terms"    TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "programs"          TO "campass_app";

    GRANT SELECT, INSERT ON "academic_calendar_day_revisions" TO "campass_app";
    REVOKE UPDATE, DELETE ON "academic_calendar_day_revisions" FROM "campass_app";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- j. Seed the four new academics.* permissions + their role_permissions pairs,
--    using the same seed-block shape + join + markers the identity_rbac_b2 /
--    superadmin_security / module_system seeds use so the generalized
--    catalogue-sync meta-test parses this block too. Both inserts are idempotent
--    (DO NOTHING on conflict). ADMIN gains all four; STUDENT, GUARD, HOD each gain
--    academics.view. Template roles + catalogue already exist. No backfill.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_academics_sessions_manage', 'academics.sessions.manage', 'academics', 'Manage academic sessions and terms (create, update, activate, close)'),
  ('perm_academics_programs_manage', 'academics.programs.manage', 'academics', 'Manage academic programs'),
  ('perm_academics_calendar_manage', 'academics.calendar.manage', 'academics', 'Manage academic calendar entries'),
  ('perm_academics_view',           'academics.view',            'academics', 'View academic sessions, terms, programs and calendar')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('ADMIN',   'academics.sessions.manage'),
  ('ADMIN',   'academics.programs.manage'),
  ('ADMIN',   'academics.calendar.manage'),
  ('ADMIN',   'academics.view'),
  ('STUDENT', 'academics.view'),
  ('GUARD',   'academics.view'),
  ('HOD',     'academics.view')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
