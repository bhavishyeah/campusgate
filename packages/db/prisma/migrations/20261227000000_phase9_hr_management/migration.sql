-- CAMPASS Phase 9.2 — HR Management (backend only): the SECOND module of Phase 9
-- (Institutional operations), running in PARALLEL with the hostel module on a
-- separate worktree/dir. A gated ("booster") module layered on the shared
-- foundation. It adds the EMPLOYMENT domain: employee records that REFERENCE the
-- authoritative tenant-owned User via a composite same-tenant FK (never
-- duplicating identity), employment contracts, a leave subsystem (policies +
-- forward-only applications; the balance is computed, NOT persisted), employee
-- attendance + shifts, and an immutable attendance-correction history ledger.
-- DISTINCT from Faculty Management (Phase 9.1, the ACADEMIC domain). No
-- cross-module side effects, no payroll/fees integration (salaryAmount is a
-- stored metadata field only).
--
-- Hand-authored (Prisma's diff models neither RLS, the composite same-tenant FKs,
-- the CHECKs, the column-guard / append-only triggers, the targeted GRANT
-- refresh, nor the catalogue seed). STRICTLY ADDITIVE: it only CREATEs new
-- objects + one additive catalogue seed. It NEVER edits any pre-existing
-- migration directory (the rule, not a bare number: every prior dir stays
-- byte-identical), never touches the _prisma_migrations ledger, and campass_app
-- stays NOSUPERUSER NOBYPASSRLS — never granted BYPASSRLS.
--
-- EIGHT new tenant-owned tables:
--   * hr_employees                    — mutable (editable-with-audit), standard pair.
--   * hr_contracts                    — versioned-append, column-guard (identity/
--                                       economic frozen; status forward-only; no DELETE).
--   * hr_leave_policies               — mutable config, standard pair.
--   * hr_leave_applications           — forward-only lifecycle, column-guard; no DELETE.
--   * hr_shifts                       — mutable config, standard pair.
--   * hr_employee_attendance          — mutable current state, standard pair.
--   * hr_employee_attendance_history  — STRICTLY append-only (append-only RLS pair +
--                                       unconditional-raise trigger), immutable ledger.
-- Every table carries institutionId + (id, institutionId) composite unique +
-- (institutionId) index + composite same-tenant FKs incl. institutionId +
-- ENABLE+FORCE RLS.
--
-- Ordering (mirrors the faculty_management / exams slice-1 lettered house style a–j):
--   a. CREATE TYPE the ten new enums.
--   b. CREATE TABLE the eight tables + PKs (history: createdAt only / append-only
--      class; the seven mutable/guarded tables carry updatedAt NOT NULL).
--   c. (id,institutionId) unique + (institutionId)/query indexes + business uniques.
--   d. tenant-root institutionId -> institutions(id) RESTRICT on all eight.
--   e. composite same-tenant FKs (each carries institutionId).
--   f. CHECKs.
--   g. ENABLE+FORCE RLS (standard pair on the seven mutable/guarded; append-only
--      pair on the history table).
--   h. hr_contracts_guard() + hr_leave_applications_guard() column guards +
--      hr_employee_attendance_history_append_only() unconditional-raise trigger.
--   i. guarded + idempotent campass_app GRANT refresh.
--   j. catalogue seed: the HR_MANAGER + EMPLOYEE additive roles FIRST, then the
--      seven hr.* permissions + the HR_MANAGER/ADMIN/EMPLOYEE role_permissions pairs.

-- ─────────────────────────────────────────────────────────────────────────────
-- a. Enums.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "HrEmploymentType"              AS ENUM ('PERMANENT', 'CONTRACT', 'PART_TIME');
CREATE TYPE "HrEmployeeStatus"              AS ENUM ('ACTIVE', 'INACTIVE', 'TERMINATED');
CREATE TYPE "HrContractType"                AS ENUM ('PERMANENT', 'FIXED_TERM', 'PROBATION', 'CONSULTANT');
CREATE TYPE "HrContractStatus"              AS ENUM ('ACTIVE', 'ENDED', 'SUPERSEDED');
CREATE TYPE "HrLeaveType"                   AS ENUM ('CASUAL', 'SICK', 'EARNED', 'UNPAID', 'OTHER');
CREATE TYPE "HrAccrualRule"                 AS ENUM ('ANNUAL_LUMP_SUM', 'MONTHLY_ACCRUAL');
CREATE TYPE "HrLeaveApplicationStatus"      AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE "HrAttendanceStatus"            AS ENUM ('PRESENT', 'ABSENT', 'ON_LEAVE', 'HALF_DAY');
CREATE TYPE "HrAttendanceSource"            AS ENUM ('MANUAL', 'DERIVED');
CREATE TYPE "HrAttendanceHistoryChangeType" AS ENUM ('RECORDED', 'CORRECTED');

-- ─────────────────────────────────────────────────────────────────────────────
-- b. New tenant-owned tables + PKs. The seven mutable/guarded tables carry
--    updatedAt NOT NULL; hr_employee_attendance_history carries createdAt only
--    (append-only class — the faculty_teaching_history / marks_record_history
--    precedent). createdByUserId / updatedByUserId / recordedByUserId /
--    reviewedByUserId / actorUserId / supersedesContractId are recorded actor/
--    source ids with NO FK (the 8.1 createdByUserId precedent).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "hr_employees" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "employeeNo"      TEXT NOT NULL,
    "designation"     TEXT,
    "employmentType"  "HrEmploymentType" NOT NULL,
    "departmentId"    TEXT,
    "joiningDate"     TIMESTAMP(3) NOT NULL,
    "status"          "HrEmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" TEXT NOT NULL,
    "updatedByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_employees_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hr_contracts" (
    "id"                   TEXT NOT NULL,
    "institutionId"        TEXT NOT NULL,
    "employeeId"           TEXT NOT NULL,
    "contractType"         "HrContractType" NOT NULL,
    "startDate"            TIMESTAMP(3) NOT NULL,
    "endDate"              TIMESTAMP(3),
    "termsMetadata"        JSONB,
    "salaryAmount"         BIGINT,
    "currency"             TEXT NOT NULL DEFAULT 'INR',
    "status"               "HrContractStatus" NOT NULL DEFAULT 'ACTIVE',
    "supersedesContractId" TEXT,
    "createdByUserId"      TEXT NOT NULL,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_contracts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hr_leave_policies" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "leaveType"       "HrLeaveType" NOT NULL,
    "annualQuotaDays" INTEGER NOT NULL,
    "accrualRule"     "HrAccrualRule" NOT NULL DEFAULT 'ANNUAL_LUMP_SUM',
    "active"          BOOLEAN NOT NULL DEFAULT true,
    "updatedByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_leave_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hr_leave_applications" (
    "id"               TEXT NOT NULL,
    "institutionId"    TEXT NOT NULL,
    "employeeId"       TEXT NOT NULL,
    "leaveType"        "HrLeaveType" NOT NULL,
    "startDate"        TIMESTAMP(3) NOT NULL,
    "endDate"          TIMESTAMP(3) NOT NULL,
    "days"             INTEGER NOT NULL,
    "periodYear"       INTEGER NOT NULL,
    "reason"           TEXT NOT NULL,
    "status"           "HrLeaveApplicationStatus" NOT NULL DEFAULT 'REQUESTED',
    "reviewedByUserId" TEXT,
    "reviewedAt"       TIMESTAMP(3),
    "reviewNote"       TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_leave_applications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hr_shifts" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "startMinute"     INTEGER NOT NULL,
    "endMinute"       INTEGER NOT NULL,
    "active"          BOOLEAN NOT NULL DEFAULT true,
    "updatedByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_shifts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hr_employee_attendance" (
    "id"               TEXT NOT NULL,
    "institutionId"    TEXT NOT NULL,
    "employeeId"       TEXT NOT NULL,
    "attendanceDate"   DATE NOT NULL,
    "status"           "HrAttendanceStatus" NOT NULL,
    "source"           "HrAttendanceSource" NOT NULL DEFAULT 'MANUAL',
    "shiftId"          TEXT,
    "recordedByUserId" TEXT NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_employee_attendance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hr_employee_attendance_history" (
    "id"                   TEXT NOT NULL,
    "institutionId"        TEXT NOT NULL,
    "employeeAttendanceId" TEXT NOT NULL,
    "changeType"           "HrAttendanceHistoryChangeType" NOT NULL,
    "previousStatus"       "HrAttendanceStatus",
    "newStatus"            "HrAttendanceStatus" NOT NULL,
    "actorUserId"          TEXT NOT NULL,
    "reason"               TEXT,
    "metadata"             JSONB,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_employee_attendance_history_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- c. Unique + query indexes. (id, institutionId) anchors the composite
--    same-tenant FKs; (institutionId) + per-query indexes; the business uniques
--    (one employee per user per tenant; employeeNo unique per tenant; one policy
--    per leave type; one shift name per tenant; one attendance row per
--    employee/day). The leave aggregate index (institutionId, employeeId,
--    leaveType, periodYear) and the staff-queue (institutionId, status).
-- ─────────────────────────────────────────────────────────────────────────────
-- hr_employees
CREATE UNIQUE INDEX "hr_employees_id_institutionId_key"              ON "hr_employees"("id", "institutionId");
CREATE UNIQUE INDEX "hr_employees_institutionId_userId_key"          ON "hr_employees"("institutionId", "userId");
CREATE UNIQUE INDEX "hr_employees_institutionId_employeeNo_key"      ON "hr_employees"("institutionId", "employeeNo");
CREATE INDEX        "hr_employees_institutionId_idx"                 ON "hr_employees"("institutionId");
CREATE INDEX        "hr_employees_institutionId_departmentId_idx"    ON "hr_employees"("institutionId", "departmentId");

-- hr_contracts
CREATE UNIQUE INDEX "hr_contracts_id_institutionId_key"              ON "hr_contracts"("id", "institutionId");
CREATE INDEX        "hr_contracts_institutionId_idx"                 ON "hr_contracts"("institutionId");
CREATE INDEX        "hr_contracts_institutionId_employeeId_idx"      ON "hr_contracts"("institutionId", "employeeId");

-- hr_leave_policies
CREATE UNIQUE INDEX "hr_leave_policies_id_institutionId_key"         ON "hr_leave_policies"("id", "institutionId");
CREATE UNIQUE INDEX "hr_leave_policies_institutionId_leaveType_key"  ON "hr_leave_policies"("institutionId", "leaveType");
CREATE INDEX        "hr_leave_policies_institutionId_idx"            ON "hr_leave_policies"("institutionId");

-- hr_leave_applications
CREATE UNIQUE INDEX "hr_leave_applications_id_institutionId_key"     ON "hr_leave_applications"("id", "institutionId");
CREATE INDEX        "hr_leave_applications_institutionId_idx"        ON "hr_leave_applications"("institutionId");
CREATE INDEX        "hr_leave_applications_institutionId_employeeId_idx" ON "hr_leave_applications"("institutionId", "employeeId");
CREATE INDEX        "hr_leave_applications_institutionId_employeeId_leaveType_periodYear_idx" ON "hr_leave_applications"("institutionId", "employeeId", "leaveType", "periodYear");
CREATE INDEX        "hr_leave_applications_institutionId_status_idx" ON "hr_leave_applications"("institutionId", "status");

-- hr_shifts
CREATE UNIQUE INDEX "hr_shifts_id_institutionId_key"                 ON "hr_shifts"("id", "institutionId");
CREATE UNIQUE INDEX "hr_shifts_institutionId_name_key"               ON "hr_shifts"("institutionId", "name");
CREATE INDEX        "hr_shifts_institutionId_idx"                    ON "hr_shifts"("institutionId");

-- hr_employee_attendance
CREATE UNIQUE INDEX "hr_employee_attendance_id_institutionId_key"    ON "hr_employee_attendance"("id", "institutionId");
CREATE UNIQUE INDEX "hr_employee_attendance_institutionId_employeeId_attendanceDate_key" ON "hr_employee_attendance"("institutionId", "employeeId", "attendanceDate");
CREATE INDEX        "hr_employee_attendance_institutionId_idx"       ON "hr_employee_attendance"("institutionId");
CREATE INDEX        "hr_employee_attendance_institutionId_employeeId_idx" ON "hr_employee_attendance"("institutionId", "employeeId");

-- hr_employee_attendance_history
CREATE UNIQUE INDEX "hr_employee_attendance_history_id_institutionId_key" ON "hr_employee_attendance_history"("id", "institutionId");
CREATE INDEX        "hr_employee_attendance_history_institutionId_idx"    ON "hr_employee_attendance_history"("institutionId");
CREATE INDEX        "hr_employee_attendance_history_institutionId_employeeAttendanceId_idx" ON "hr_employee_attendance_history"("institutionId", "employeeAttendanceId");

-- ─────────────────────────────────────────────────────────────────────────────
-- d. Tenant-root FKs. institutionId -> institutions(id) RESTRICT on all eight.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "hr_employees"                   ADD CONSTRAINT "hr_employees_institutionId_fkey"                   FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hr_contracts"                   ADD CONSTRAINT "hr_contracts_institutionId_fkey"                   FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hr_leave_policies"              ADD CONSTRAINT "hr_leave_policies_institutionId_fkey"              FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hr_leave_applications"          ADD CONSTRAINT "hr_leave_applications_institutionId_fkey"          FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hr_shifts"                      ADD CONSTRAINT "hr_shifts_institutionId_fkey"                      FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hr_employee_attendance"         ADD CONSTRAINT "hr_employee_attendance_institutionId_fkey"         FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hr_employee_attendance_history" ADD CONSTRAINT "hr_employee_attendance_history_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- e. Composite same-tenant FKs (each carries institutionId so a child can never
--    reference a parent in another tenant). All ON DELETE RESTRICT ON UPDATE
--    CASCADE. users / departments / hr_employees / hr_shifts /
--    hr_employee_attendance all carry the (institutionId, id) composite unique
--    these anchor on.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "hr_employees"
  ADD CONSTRAINT "hr_employees_user_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "userId") REFERENCES "users"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hr_employees"
  ADD CONSTRAINT "hr_employees_department_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "departmentId") REFERENCES "departments"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hr_contracts"
  ADD CONSTRAINT "hr_contracts_employee_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "employeeId") REFERENCES "hr_employees"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hr_leave_applications"
  ADD CONSTRAINT "hr_leave_applications_employee_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "employeeId") REFERENCES "hr_employees"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hr_employee_attendance"
  ADD CONSTRAINT "hr_employee_attendance_employee_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "employeeId") REFERENCES "hr_employees"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hr_employee_attendance"
  ADD CONSTRAINT "hr_employee_attendance_shift_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "shiftId") REFERENCES "hr_shifts"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hr_employee_attendance_history"
  ADD CONSTRAINT "hr_employee_attendance_history_attendance_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "employeeAttendanceId") REFERENCES "hr_employee_attendance"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- f. CHECKs (§4). employeeNo non-empty; contract currency = 'INR' and
--    salaryAmount non-negative when present; leave days >= 1, endDate >=
--    startDate, reason non-empty; shift minutes within 0..1439.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "hr_employees"
  ADD CONSTRAINT "hr_employees_employeeNo_nonempty_check" CHECK (char_length("employeeNo") >= 1);

ALTER TABLE "hr_contracts"
  ADD CONSTRAINT "hr_contracts_currency_inr_check" CHECK ("currency" = 'INR');
ALTER TABLE "hr_contracts"
  ADD CONSTRAINT "hr_contracts_salary_nonneg_check" CHECK ("salaryAmount" IS NULL OR "salaryAmount" >= 0);

ALTER TABLE "hr_leave_policies"
  ADD CONSTRAINT "hr_leave_policies_quota_nonneg_check" CHECK ("annualQuotaDays" >= 0);

ALTER TABLE "hr_leave_applications"
  ADD CONSTRAINT "hr_leave_applications_days_positive_check" CHECK ("days" >= 1);
ALTER TABLE "hr_leave_applications"
  ADD CONSTRAINT "hr_leave_applications_dates_check" CHECK ("endDate" >= "startDate");
ALTER TABLE "hr_leave_applications"
  ADD CONSTRAINT "hr_leave_applications_reason_nonempty_check" CHECK (char_length("reason") >= 1);

ALTER TABLE "hr_shifts"
  ADD CONSTRAINT "hr_shifts_minutes_range_check"
  CHECK ("startMinute" >= 0 AND "startMinute" <= 1439 AND "endMinute" >= 0 AND "endMinute" <= 1439);

-- ─────────────────────────────────────────────────────────────────────────────
-- g. RLS. ENABLE + FORCE on all eight. The seven mutable/guarded tables get the
--    standard fail-closed nullif-guarded pair {tenant_isolation_select,
--    tenant_isolation_modify} (the column guards enforce immutability at the row
--    level; RLS enforces tenancy); hr_employee_attendance_history gets the
--    append-only pair {tenant_isolation_select,
--    hr_employee_attendance_history_tenant_insert} (SELECT + INSERT-only, NO
--    modify — the faculty_teaching_history precedent). nullif(
--    current_setting('app.current_institution_id', true), '') fails closed for
--    both an unset and an empty-string GUC.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  mutable_tables TEXT[] := ARRAY[
    'hr_employees', 'hr_contracts', 'hr_leave_policies', 'hr_leave_applications',
    'hr_shifts', 'hr_employee_attendance'
  ];
  append_only_tables TEXT[] := ARRAY[
    'hr_employee_attendance_history'
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
--   h.1 hr_contracts_guard() column guard (versioned-append, §4.2): raise on
--       DELETE; freeze the identity/economic columns (institutionId, employeeId,
--       contractType, startDate, salaryAmount, currency); freeze a terminal
--       status (ENDED/SUPERSEDED); permit only ACTIVE->ENDED, ACTIVE->SUPERSEDED,
--       plus the no-op self-transition. endDate / termsMetadata stay mutable.
--   h.2 hr_leave_applications_guard() column guard (forward-only lifecycle, §4.3):
--       raise on DELETE; freeze the immutable columns (institutionId, employeeId,
--       leaveType, startDate, endDate, days, periodYear); freeze a terminal status
--       (APPROVED/REJECTED/CANCELLED); permit only REQUESTED->APPROVED|REJECTED|
--       CANCELLED, plus the no-op self-transition. reviewedByUserId/reviewedAt/
--       reviewNote stay mutable (set on the decision write).
--   h.3 hr_employee_attendance_history_append_only() unconditional raise on
--       UPDATE/DELETE (the faculty_teaching_history_append_only() precedent).
--   The five remaining tables carry NO trigger (legitimately editable).
-- ─────────────────────────────────────────────────────────────────────────────
-- h.1 hr_contracts column guard.
CREATE OR REPLACE FUNCTION "hr_contracts_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'hr_contracts is delete-protected'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- immutable identity/economic columns
  IF NEW."institutionId" IS DISTINCT FROM OLD."institutionId"
  OR NEW."employeeId"    IS DISTINCT FROM OLD."employeeId"
  OR NEW."contractType"  IS DISTINCT FROM OLD."contractType"
  OR NEW."startDate"     IS DISTINCT FROM OLD."startDate"
  OR NEW."salaryAmount"  IS DISTINCT FROM OLD."salaryAmount"
  OR NEW."currency"      IS DISTINCT FROM OLD."currency"
  THEN
    RAISE EXCEPTION 'immutable hr_contracts column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- terminal state frozen
  IF OLD."status" IN ('ENDED', 'SUPERSEDED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'terminal hr_contracts status is frozen'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- forward-only transitions (plus the no-op self transition)
  IF NOT (
       (OLD."status" = 'ACTIVE' AND NEW."status" = 'ENDED')
    OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'SUPERSEDED')
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal hr_contracts status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "hr_contracts_guard"
  BEFORE UPDATE OR DELETE ON "hr_contracts"
  FOR EACH ROW EXECUTE FUNCTION "hr_contracts_guard"();

-- h.2 hr_leave_applications column guard.
CREATE OR REPLACE FUNCTION "hr_leave_applications_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'hr_leave_applications is delete-protected'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- immutable columns
  IF NEW."institutionId" IS DISTINCT FROM OLD."institutionId"
  OR NEW."employeeId"    IS DISTINCT FROM OLD."employeeId"
  OR NEW."leaveType"     IS DISTINCT FROM OLD."leaveType"
  OR NEW."startDate"     IS DISTINCT FROM OLD."startDate"
  OR NEW."endDate"       IS DISTINCT FROM OLD."endDate"
  OR NEW."days"          IS DISTINCT FROM OLD."days"
  OR NEW."periodYear"    IS DISTINCT FROM OLD."periodYear"
  THEN
    RAISE EXCEPTION 'immutable hr_leave_applications column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- terminal state frozen
  IF OLD."status" IN ('APPROVED', 'REJECTED', 'CANCELLED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'terminal hr_leave_applications status is frozen'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- forward-only transitions (plus the no-op self transition)
  IF NOT (
       (OLD."status" = 'REQUESTED' AND NEW."status" = 'APPROVED')
    OR (OLD."status" = 'REQUESTED' AND NEW."status" = 'REJECTED')
    OR (OLD."status" = 'REQUESTED' AND NEW."status" = 'CANCELLED')
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal hr_leave_applications status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "hr_leave_applications_guard"
  BEFORE UPDATE OR DELETE ON "hr_leave_applications"
  FOR EACH ROW EXECUTE FUNCTION "hr_leave_applications_guard"();

-- h.3 hr_employee_attendance_history append-only trigger (unconditional raise on
--     UPDATE/DELETE — binds the owner too, which GRANTs alone cannot). Mirrored
--     verbatim from faculty_teaching_history_append_only().
CREATE OR REPLACE FUNCTION "hr_employee_attendance_history_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'hr_employee_attendance_history is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "hr_employee_attendance_history_no_update_delete"
  BEFORE UPDATE OR DELETE ON "hr_employee_attendance_history"
  FOR EACH ROW EXECUTE FUNCTION "hr_employee_attendance_history_append_only"();

-- ─────────────────────────────────────────────────────────────────────────────
-- i. campass_app GRANT refresh (guarded + idempotent). The mutable config/state
--    tables get SELECT, INSERT, UPDATE (+ DELETE on hr_shifts / hr_leave_policies
--    for staff cleanup of an erroneous config row); hr_contracts +
--    hr_leave_applications get SELECT, INSERT, UPDATE with NO DELETE (the column
--    guards forbid DELETE; the GRANT matches); hr_employee_attendance_history
--    gets SELECT, INSERT only + REVOKE UPDATE, DELETE (the append-only INSERT-only
--    GRANT — faculty_teaching_history precedent). Never grant BYPASSRLS.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE         ON "hr_employees"           TO "campass_app";
    GRANT SELECT, INSERT, UPDATE         ON "hr_contracts"           TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "hr_leave_policies"      TO "campass_app";
    GRANT SELECT, INSERT, UPDATE         ON "hr_leave_applications"  TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "hr_shifts"              TO "campass_app";
    GRANT SELECT, INSERT, UPDATE         ON "hr_employee_attendance" TO "campass_app";

    GRANT SELECT, INSERT ON "hr_employee_attendance_history" TO "campass_app";
    REVOKE UPDATE, DELETE ON "hr_employee_attendance_history" FROM "campass_app";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- j. Catalogue seed. The two NEW additive template roles HR_MANAGER + EMPLOYEE
--    (institutionId NULL) FIRST (the ACCOUNTANT precedent), then the seven hr.*
--    permissions, then the role_permissions pairs (HR_MANAGER + ADMIN get the six
--    staff keys; EMPLOYEE gets the self-scope hr.view_own). The block shapes
--    mirror the catalogue-sync parser's expectations (the permissions span is
--    sliced up to its ON CONFLICT clause; the role_permissions span up to its
--    `AS m(` VALUES alias). Separation of duties: STUDENT/FACULTY never get an
--    hr.* key; EMPLOYEE only gets hr.view_own; staff roles never get hr.view_own.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "roles" ("id","key","name","institutionId") VALUES
  ('role_hr_manager', 'HR_MANAGER', 'HR Manager', NULL),
  ('role_employee',   'EMPLOYEE',   'Employee',   NULL)
ON CONFLICT DO NOTHING;

INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_hr_employees_manage',  'hr.employees.manage', 'hr_management', 'Create/update employee records (staff)'),
  ('perm_hr_contracts_manage',  'hr.contracts.manage', 'hr_management', 'Create/supersede/end employment contracts (staff)'),
  ('perm_hr_leave_manage',      'hr.leave.manage',     'hr_management', 'Manage leave policies + approve/reject leave applications (staff)'),
  ('perm_hr_attendance_manage', 'hr.attendance.manage','hr_management', 'Manage shifts + record/correct employee attendance (staff)'),
  ('perm_hr_reports_view',      'hr.reports.view',     'hr_management', 'Read + export (XLSX) leave/attendance reports (staff)'),
  ('perm_hr_directory_view',    'hr.directory.view',   'hr_management', 'Read any employee''s records, contracts, leave, attendance, config (staff)'),
  ('perm_hr_view_own',          'hr.view_own',         'hr_management', 'Employee self-service read of OWN employment/contracts/leave/attendance; self-apply/cancel leave')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('HR_MANAGER', 'hr.employees.manage'),
  ('HR_MANAGER', 'hr.contracts.manage'),
  ('HR_MANAGER', 'hr.leave.manage'),
  ('HR_MANAGER', 'hr.attendance.manage'),
  ('HR_MANAGER', 'hr.reports.view'),
  ('HR_MANAGER', 'hr.directory.view'),
  ('ADMIN',      'hr.employees.manage'),
  ('ADMIN',      'hr.contracts.manage'),
  ('ADMIN',      'hr.leave.manage'),
  ('ADMIN',      'hr.attendance.manage'),
  ('ADMIN',      'hr.reports.view'),
  ('ADMIN',      'hr.directory.view'),
  ('EMPLOYEE',   'hr.view_own')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
