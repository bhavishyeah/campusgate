-- CAMPASS Phase 9.3 — Hostel Management (backend only): the THIRD module of
-- Phase 9 (Institutional operations). A gated ("booster") module layered on the
-- shared foundation, independent of Phase 9.1 (faculty_management) and the
-- parallel HR module (Phase 9.2). It models residential buildings + rooms,
-- capacity-safe room allocation + transfer, immutable check-in/out events, a
-- forward-only hostel-leave workflow, per-room maintenance requests, and
-- deterministic (computed, never stored) occupancy. Every table REFERENCES the
-- single authoritative student identity (student_profiles) via composite
-- same-tenant FK — it never duplicates student data. No cross-module side
-- effects (no gate-pass, no fees coupling — design §C.9/§C.10).
--
-- Hand-authored (Prisma's diff models neither RLS, the composite same-tenant
-- FKs, the CHECKs, the forward-only / append-only triggers, the targeted GRANT
-- refresh, nor the catalogue seed). STRICTLY ADDITIVE: it only CREATEs new
-- objects + one additive catalogue seed. It NEVER edits any pre-existing
-- migration directory (every prior dir stays byte-identical), never touches the
-- _prisma_migrations ledger, and campass_app stays NOSUPERUSER NOBYPASSRLS —
-- never granted BYPASSRLS.
--
-- SIX new tenant-owned tables:
--   * hostel_buildings           — mutable-with-audit, standard RLS pair, NO trigger.
--   * hostel_rooms               — mutable-with-audit, standard RLS pair, NO trigger.
--   * hostel_room_allocations    — forward-only lifecycle (column-guard trigger) +
--                                  the one-ACTIVE-per-student partial unique.
--   * hostel_check_events        — STRICTLY append-only (append-only RLS pair +
--                                  unconditional-raise trigger), createdAt only.
--   * hostel_leave_applications  — forward-only lifecycle (column-guard trigger).
--   * hostel_maintenance_requests— forward-only lifecycle (column-guard trigger).
-- Every table carries institutionId + (id, institutionId) composite unique +
-- (institutionId) index + composite same-tenant FKs incl. institutionId +
-- ENABLE+FORCE RLS.
--
-- Ordering (mirrors the faculty_management lettered house style a–j):
--   a. CREATE TYPE the six new enums.
--   b. CREATE TABLE the six tables + PKs (append-only hostel_check_events:
--      createdAt only; the four mutable/guarded tables carry updatedAt NOT NULL).
--   c. (id,institutionId) unique + (institutionId)/query indexes + business
--      uniques + the one-ACTIVE-per-student partial unique.
--   d. tenant-root institutionId -> institutions(id) RESTRICT on all six.
--   e. composite same-tenant FKs (each carries institutionId).
--   f. CHECKs.
--   g. ENABLE+FORCE RLS (standard pair on the five mutable/guarded tables;
--      append-only pair on hostel_check_events).
--   h. three column-guard + one append-only function + their triggers.
--   i. guarded + idempotent campass_app GRANT refresh.
--   j. catalogue seed: the WARDEN role row (BEFORE the permissions block) + the
--      six hostel.* permissions + the ADMIN/WARDEN/STUDENT role_permissions pairs.

-- ─────────────────────────────────────────────────────────────────────────────
-- a. Enums.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "HostelBuildingType"      AS ENUM ('BOYS', 'GIRLS', 'MIXED', 'STAFF');
CREATE TYPE "HostelRoomStatus"        AS ENUM ('AVAILABLE', 'FULL', 'MAINTENANCE', 'CLOSED');
CREATE TYPE "HostelAllocationStatus"  AS ENUM ('ACTIVE', 'VACATED', 'TRANSFERRED');
CREATE TYPE "HostelCheckEventType"    AS ENUM ('CHECK_IN', 'CHECK_OUT');
CREATE TYPE "HostelLeaveStatus"       AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE "HostelMaintenanceStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED');

-- ─────────────────────────────────────────────────────────────────────────────
-- b. New tenant-owned tables + PKs. The four mutable/guarded tables carry
--    updatedAt NOT NULL; hostel_check_events carries createdAt only (append-only
--    class — the marks_record_history / faculty_teaching_history precedent).
--    Actor/provenance ids (wardenUserId, createdByUserId, allocatedByUserId,
--    recordedByUserId, reportedByUserId, assigneeUserId, transferFromAllocationId)
--    are recorded ids with NO FK (the faculty createdByUserId precedent).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "hostel_buildings" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "type"            "HostelBuildingType" NOT NULL,
    "wardenUserId"    TEXT,
    "isActive"        BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hostel_buildings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hostel_rooms" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "buildingId"      TEXT NOT NULL,
    "roomNumber"      TEXT NOT NULL,
    "capacity"        INTEGER NOT NULL,
    "floor"           INTEGER,
    "status"          "HostelRoomStatus" NOT NULL DEFAULT 'AVAILABLE',
    "createdByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hostel_rooms_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hostel_room_allocations" (
    "id"                       TEXT NOT NULL,
    "institutionId"            TEXT NOT NULL,
    "roomId"                   TEXT NOT NULL,
    "studentId"                TEXT NOT NULL,
    "status"                   "HostelAllocationStatus" NOT NULL DEFAULT 'ACTIVE',
    "allocatedAt"              TIMESTAMP(3) NOT NULL,
    "vacatedAt"                TIMESTAMP(3),
    "allocatedByUserId"        TEXT NOT NULL,
    "transferFromAllocationId" TEXT,
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hostel_room_allocations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hostel_check_events" (
    "id"               TEXT NOT NULL,
    "institutionId"    TEXT NOT NULL,
    "allocationId"     TEXT NOT NULL,
    "studentId"        TEXT NOT NULL,
    "eventType"        "HostelCheckEventType" NOT NULL,
    "occurredAt"       TIMESTAMP(3) NOT NULL,
    "recordedByUserId" TEXT NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hostel_check_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hostel_leave_applications" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "studentId"       TEXT NOT NULL,
    "fromDate"        TIMESTAMP(3) NOT NULL,
    "toDate"          TIMESTAMP(3) NOT NULL,
    "reason"          TEXT NOT NULL,
    "status"          "HostelLeaveStatus" NOT NULL DEFAULT 'REQUESTED',
    "appliedByUserId" TEXT NOT NULL,
    "decidedByUserId" TEXT,
    "decidedAt"       TIMESTAMP(3),
    "decisionNote"    TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hostel_leave_applications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hostel_maintenance_requests" (
    "id"               TEXT NOT NULL,
    "institutionId"    TEXT NOT NULL,
    "roomId"           TEXT NOT NULL,
    "issue"            TEXT NOT NULL,
    "status"           "HostelMaintenanceStatus" NOT NULL DEFAULT 'OPEN',
    "assigneeUserId"   TEXT,
    "reportedByUserId" TEXT NOT NULL,
    "resolvedAt"       TIMESTAMP(3),
    "resolutionNote"   TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hostel_maintenance_requests_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- c. Unique + query indexes. (id, institutionId) anchors the composite
--    same-tenant FKs; (institutionId) + per-query indexes; the business uniques
--    (hostel_buildings one name per institution; hostel_rooms one roomNumber per
--    building per institution); and the partial unique one-ACTIVE allocation per
--    student (the library two-partial-unique precedent — slot-shaped invariant).
-- ─────────────────────────────────────────────────────────────────────────────
-- hostel_buildings
CREATE UNIQUE INDEX "hostel_buildings_id_institutionId_key"   ON "hostel_buildings"("id", "institutionId");
CREATE UNIQUE INDEX "hostel_buildings_institutionId_name_key" ON "hostel_buildings"("institutionId", "name");
CREATE INDEX        "hostel_buildings_institutionId_idx"      ON "hostel_buildings"("institutionId");

-- hostel_rooms
CREATE UNIQUE INDEX "hostel_rooms_id_institutionId_key"                    ON "hostel_rooms"("id", "institutionId");
CREATE UNIQUE INDEX "hostel_rooms_institutionId_buildingId_roomNumber_key" ON "hostel_rooms"("institutionId", "buildingId", "roomNumber");
CREATE INDEX        "hostel_rooms_institutionId_idx"                       ON "hostel_rooms"("institutionId");
CREATE INDEX        "hostel_rooms_institutionId_buildingId_idx"            ON "hostel_rooms"("institutionId", "buildingId");

-- hostel_room_allocations
CREATE UNIQUE INDEX "hostel_room_allocations_id_institutionId_key"     ON "hostel_room_allocations"("id", "institutionId");
CREATE INDEX        "hostel_room_allocations_institutionId_idx"        ON "hostel_room_allocations"("institutionId");
CREATE INDEX        "hostel_room_allocations_institutionId_roomId_idx" ON "hostel_room_allocations"("institutionId", "roomId");
CREATE INDEX        "hostel_room_allocations_institutionId_studentId_idx" ON "hostel_room_allocations"("institutionId", "studentId");
-- One ACTIVE allocation per student (per tenant) — slot-shaped partial unique
-- backstop for the service-level one-active check (the library precedent).
CREATE UNIQUE INDEX "hostel_room_allocations_one_active_per_student"
  ON "hostel_room_allocations"("institutionId", "studentId") WHERE "status" = 'ACTIVE';

-- hostel_check_events
CREATE UNIQUE INDEX "hostel_check_events_id_institutionId_key"       ON "hostel_check_events"("id", "institutionId");
CREATE INDEX        "hostel_check_events_institutionId_idx"          ON "hostel_check_events"("institutionId");
CREATE INDEX        "hostel_check_events_institutionId_allocationId_idx" ON "hostel_check_events"("institutionId", "allocationId");
CREATE INDEX        "hostel_check_events_institutionId_studentId_idx" ON "hostel_check_events"("institutionId", "studentId");

-- hostel_leave_applications
CREATE UNIQUE INDEX "hostel_leave_applications_id_institutionId_key"     ON "hostel_leave_applications"("id", "institutionId");
CREATE INDEX        "hostel_leave_applications_institutionId_idx"        ON "hostel_leave_applications"("institutionId");
CREATE INDEX        "hostel_leave_applications_institutionId_studentId_idx" ON "hostel_leave_applications"("institutionId", "studentId");
CREATE INDEX        "hostel_leave_applications_institutionId_status_idx" ON "hostel_leave_applications"("institutionId", "status");

-- hostel_maintenance_requests
CREATE UNIQUE INDEX "hostel_maintenance_requests_id_institutionId_key"     ON "hostel_maintenance_requests"("id", "institutionId");
CREATE INDEX        "hostel_maintenance_requests_institutionId_idx"        ON "hostel_maintenance_requests"("institutionId");
CREATE INDEX        "hostel_maintenance_requests_institutionId_roomId_idx" ON "hostel_maintenance_requests"("institutionId", "roomId");
CREATE INDEX        "hostel_maintenance_requests_institutionId_status_idx" ON "hostel_maintenance_requests"("institutionId", "status");

-- ─────────────────────────────────────────────────────────────────────────────
-- d. Tenant-root FKs.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "hostel_buildings"            ADD CONSTRAINT "hostel_buildings_institutionId_fkey"            FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hostel_rooms"                ADD CONSTRAINT "hostel_rooms_institutionId_fkey"                FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hostel_room_allocations"     ADD CONSTRAINT "hostel_room_allocations_institutionId_fkey"     FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hostel_check_events"         ADD CONSTRAINT "hostel_check_events_institutionId_fkey"         FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hostel_leave_applications"   ADD CONSTRAINT "hostel_leave_applications_institutionId_fkey"   FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hostel_maintenance_requests" ADD CONSTRAINT "hostel_maintenance_requests_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- e. Composite same-tenant FKs (each carries institutionId so a child can never
--    reference a parent in another tenant). All ON DELETE RESTRICT ON UPDATE
--    CASCADE. hostel_buildings / hostel_rooms / hostel_room_allocations /
--    student_profiles all carry the (institutionId, id) composite unique these
--    anchor on.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "hostel_rooms"
  ADD CONSTRAINT "hostel_rooms_building_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "buildingId") REFERENCES "hostel_buildings"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hostel_room_allocations"
  ADD CONSTRAINT "hostel_room_allocations_room_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "roomId") REFERENCES "hostel_rooms"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hostel_room_allocations"
  ADD CONSTRAINT "hostel_room_allocations_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hostel_check_events"
  ADD CONSTRAINT "hostel_check_events_allocation_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "allocationId") REFERENCES "hostel_room_allocations"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hostel_check_events"
  ADD CONSTRAINT "hostel_check_events_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hostel_leave_applications"
  ADD CONSTRAINT "hostel_leave_applications_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hostel_maintenance_requests"
  ADD CONSTRAINT "hostel_maintenance_requests_room_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "roomId") REFERENCES "hostel_rooms"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- f. CHECKs. Room capacity >= 1; leave toDate >= fromDate; non-empty
--    name/issue/reason.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "hostel_rooms"
  ADD CONSTRAINT "hostel_rooms_capacity_positive_check" CHECK ("capacity" >= 1);
ALTER TABLE "hostel_buildings"
  ADD CONSTRAINT "hostel_buildings_name_nonempty_check" CHECK (char_length("name") >= 1);
ALTER TABLE "hostel_leave_applications"
  ADD CONSTRAINT "hostel_leave_applications_dates_order_check" CHECK ("toDate" >= "fromDate");
ALTER TABLE "hostel_leave_applications"
  ADD CONSTRAINT "hostel_leave_applications_reason_nonempty_check" CHECK (char_length("reason") >= 1);
ALTER TABLE "hostel_maintenance_requests"
  ADD CONSTRAINT "hostel_maintenance_requests_issue_nonempty_check" CHECK (char_length("issue") >= 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- g. RLS. ENABLE + FORCE on all six. The five mutable/column-guard tables get
--    the standard fail-closed nullif-guarded pair {tenant_isolation_select,
--    tenant_isolation_modify}; hostel_check_events gets the append-only pair
--    {tenant_isolation_select, hostel_check_events_tenant_insert} (SELECT +
--    INSERT-only, NO modify — the marks_record_history precedent). nullif(
--    current_setting('app.current_institution_id', true), '') fails closed for
--    both an unset and an empty-string GUC.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  mutable_tables TEXT[] := ARRAY[
    'hostel_buildings', 'hostel_rooms', 'hostel_room_allocations',
    'hostel_leave_applications', 'hostel_maintenance_requests'
  ];
  append_only_tables TEXT[] := ARRAY[
    'hostel_check_events'
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
-- h. Triggers. Three column-guard functions (forward-only lifecycle + frozen
--    identity cols + DELETE forbidden), mirroring examinations_guard(); and one
--    append-only function (unconditional raise on UPDATE/DELETE), mirroring
--    faculty_teaching_history_append_only(). hostel_buildings + hostel_rooms
--    carry NO trigger (legitimately editable; immutability is not an invariant).
-- ─────────────────────────────────────────────────────────────────────────────

-- h.1 hostel_room_allocations column guard (forward-only: ACTIVE->VACATED|
--     TRANSFERRED; terminal frozen; DELETE forbidden).
CREATE OR REPLACE FUNCTION "hostel_room_allocations_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'hostel_room_allocations is forward-only: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- frozen identity columns (transferFromAllocationId is write-once at INSERT —
  -- freezing a column no UPDATE ever sets is defence-in-depth, the faculty
  -- sourceAssignmentId precedent).
  IF NEW."institutionId"            IS DISTINCT FROM OLD."institutionId"
  OR NEW."roomId"                   IS DISTINCT FROM OLD."roomId"
  OR NEW."studentId"                IS DISTINCT FROM OLD."studentId"
  OR NEW."allocatedAt"              IS DISTINCT FROM OLD."allocatedAt"
  OR NEW."allocatedByUserId"        IS DISTINCT FROM OLD."allocatedByUserId"
  OR NEW."transferFromAllocationId" IS DISTINCT FROM OLD."transferFromAllocationId"
  OR NEW."createdAt"                IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'immutable hostel_room_allocations column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- forward-only transitions (plus the no-op self transition). Terminal
  -- (VACATED/TRANSFERRED) is frozen because neither is a legal source below.
  IF NOT (
       (OLD."status" = 'ACTIVE' AND NEW."status" = 'VACATED')
    OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'TRANSFERRED')
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal hostel_room_allocations status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "hostel_room_allocations_guard"
  BEFORE UPDATE OR DELETE ON "hostel_room_allocations"
  FOR EACH ROW EXECUTE FUNCTION "hostel_room_allocations_guard"();

-- h.2 hostel_leave_applications column guard (forward-only: REQUESTED->
--     APPROVED|REJECTED|CANCELLED; terminal frozen; DELETE forbidden).
CREATE OR REPLACE FUNCTION "hostel_leave_applications_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'hostel_leave_applications is forward-only: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."institutionId"   IS DISTINCT FROM OLD."institutionId"
  OR NEW."studentId"       IS DISTINCT FROM OLD."studentId"
  OR NEW."fromDate"        IS DISTINCT FROM OLD."fromDate"
  OR NEW."toDate"          IS DISTINCT FROM OLD."toDate"
  OR NEW."reason"          IS DISTINCT FROM OLD."reason"
  OR NEW."appliedByUserId" IS DISTINCT FROM OLD."appliedByUserId"
  OR NEW."createdAt"       IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'immutable hostel_leave_applications column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (
       (OLD."status" = 'REQUESTED' AND NEW."status" = 'APPROVED')
    OR (OLD."status" = 'REQUESTED' AND NEW."status" = 'REJECTED')
    OR (OLD."status" = 'REQUESTED' AND NEW."status" = 'CANCELLED')
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal hostel_leave_applications status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "hostel_leave_applications_guard"
  BEFORE UPDATE OR DELETE ON "hostel_leave_applications"
  FOR EACH ROW EXECUTE FUNCTION "hostel_leave_applications_guard"();

-- h.3 hostel_maintenance_requests column guard (forward-only: OPEN->IN_PROGRESS->
--     RESOLVED, OPEN|IN_PROGRESS->CANCELLED; terminal frozen; DELETE forbidden).
CREATE OR REPLACE FUNCTION "hostel_maintenance_requests_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'hostel_maintenance_requests is forward-only: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."institutionId"    IS DISTINCT FROM OLD."institutionId"
  OR NEW."roomId"           IS DISTINCT FROM OLD."roomId"
  OR NEW."reportedByUserId" IS DISTINCT FROM OLD."reportedByUserId"
  OR NEW."createdAt"        IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'immutable hostel_maintenance_requests column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (
       (OLD."status" = 'OPEN'        AND NEW."status" = 'IN_PROGRESS')
    OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" = 'RESOLVED')
    OR (OLD."status" = 'OPEN'        AND NEW."status" = 'CANCELLED')
    OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" = 'CANCELLED')
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal hostel_maintenance_requests status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "hostel_maintenance_requests_guard"
  BEFORE UPDATE OR DELETE ON "hostel_maintenance_requests"
  FOR EACH ROW EXECUTE FUNCTION "hostel_maintenance_requests_guard"();

-- h.4 hostel_check_events (append-only — unconditional raise on UPDATE/DELETE;
--     binds the owner too, which GRANTs alone cannot). The faculty/marks history
--     precedent.
CREATE OR REPLACE FUNCTION "hostel_check_events_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'hostel_check_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "hostel_check_events_no_update_delete"
  BEFORE UPDATE OR DELETE ON "hostel_check_events"
  FOR EACH ROW EXECUTE FUNCTION "hostel_check_events_append_only"();

-- ─────────────────────────────────────────────────────────────────────────────
-- i. campass_app GRANT refresh (guarded + idempotent). The five mutable/
--    column-guard tables get SELECT, INSERT, UPDATE (NO DELETE — forward-only
--    intent: the DB column guards forbid DELETE anyway, and no route hard-deletes
--    a hostel row); hostel_check_events gets SELECT, INSERT only + REVOKE
--    UPDATE, DELETE (the append-only INSERT-only GRANT — marks_record_history
--    precedent). Never grant BYPASSRLS.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "hostel_buildings"            TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "hostel_rooms"                TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "hostel_room_allocations"     TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "hostel_leave_applications"   TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "hostel_maintenance_requests" TO "campass_app";

    GRANT SELECT, INSERT ON "hostel_check_events" TO "campass_app";
    REVOKE UPDATE, DELETE ON "hostel_check_events" FROM "campass_app";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- j. Catalogue seed. The WARDEN template role row (institutionId = NULL) is NEW
--    (the ACCOUNTANT / LIBRARIAN / ADMISSION_OFFICER precedent), so it IS
--    inserted here, BEFORE the permissions block (so its `, NULL)` tuple falls
--    outside the sliced permission span the catalogue-sync parser reads — the
--    fees-slice-1 ACCOUNTANT precedent). Then the six hostel.* permissions (each
--    "module" = 'hostel', matching permissions.ts), then the role_permissions
--    pairs. ROLE_PERMISSIONS lockstep (design §B.8): ADMIN x5 staff keys,
--    WARDEN x5 staff keys, STUDENT x hostel.view_own. Separation of duties:
--    STUDENT never gets a staff key; no staff role gets hostel.view_own.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "roles" ("id","key","name","institutionId") VALUES
  ('role_warden', 'WARDEN', 'Warden', NULL)
ON CONFLICT DO NOTHING;

INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_hostel_buildings_manage',   'hostel.buildings.manage',   'hostel', 'Create/update buildings + rooms; reduce capacity (guarded)'),
  ('perm_hostel_allocations_manage', 'hostel.allocations.manage', 'hostel', 'Allocate, transfer, vacate; record check-in/out'),
  ('perm_hostel_leave_manage',       'hostel.leave.manage',       'hostel', 'Warden/admin approve/reject hostel leave'),
  ('perm_hostel_maintenance_manage', 'hostel.maintenance.manage', 'hostel', 'Create/advance/resolve maintenance requests'),
  ('perm_hostel_view',               'hostel.view',               'hostel', 'Staff read of buildings/rooms/allocations/occupancy/leave/maintenance + reports/export'),
  ('perm_hostel_view_own',           'hostel.view_own',           'hostel', 'Student self-service: own allocation + room occupancy + apply/list/cancel own leave')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('ADMIN',   'hostel.buildings.manage'),
  ('ADMIN',   'hostel.allocations.manage'),
  ('ADMIN',   'hostel.leave.manage'),
  ('ADMIN',   'hostel.maintenance.manage'),
  ('ADMIN',   'hostel.view'),
  ('WARDEN',  'hostel.buildings.manage'),
  ('WARDEN',  'hostel.allocations.manage'),
  ('WARDEN',  'hostel.leave.manage'),
  ('WARDEN',  'hostel.maintenance.manage'),
  ('WARDEN',  'hostel.view'),
  ('STUDENT', 'hostel.view_own')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
