-- CAMPASS Phase 9.4 — Transport Management (backend only): the FOURTH module of
-- Phase 9 (Institutional operations). A gated ("booster") module layered on the
-- shared foundation, independent of Phase 9.1 (faculty_management), Phase 9.2
-- (HR) and Phase 9.3 (hostel). It models vehicles, drivers, routes + stops,
-- route-vehicle-driver assignments (one ACTIVE per route), student route
-- enrollment (one ACTIVE per student+route), per-vehicle maintenance requests,
-- and route schedules. transport_enrollments REFERENCES the single
-- authoritative student identity (student_profiles) via composite same-tenant
-- FK — it never duplicates student data.
--
-- Hand-authored (Prisma's diff models neither RLS, the composite same-tenant
-- FKs, the CHECKs, the forward-only lifecycle triggers, the targeted GRANT
-- refresh, nor the catalogue seed). STRICTLY ADDITIVE: it only CREATEs new
-- objects + one additive catalogue seed. It NEVER edits any pre-existing
-- migration directory (every prior dir stays byte-identical), never touches the
-- _prisma_migrations ledger, and campass_app stays NOSUPERUSER NOBYPASSRLS —
-- never granted BYPASSRLS.
--
-- EIGHT new tenant-owned tables (ALL mutable-with-audit; NO append-only table
-- this phase):
--   * transport_vehicles                     — mutable-with-audit, NO trigger.
--   * transport_drivers                      — mutable-with-audit, NO trigger.
--   * transport_routes                       — mutable-with-audit, NO trigger.
--   * transport_route_stops                  — mutable-with-audit, NO trigger.
--   * transport_route_assignments            — forward-only lifecycle (guard) +
--                                              the one-ACTIVE-per-route partial unique.
--   * transport_enrollments                  — forward-only lifecycle (guard) +
--                                              the one-ACTIVE-per-student-route partial unique.
--   * transport_vehicle_maintenance_requests — forward-only lifecycle (guard).
--   * transport_route_schedules              — mutable-with-audit, NO trigger.
-- Every table carries institutionId + (id, institutionId) composite unique +
-- (institutionId) index + composite same-tenant FKs incl. institutionId +
-- ENABLE+FORCE RLS.
--
-- Ordering (mirrors the hostel lettered house style a–j):
--   a. CREATE TYPE the eight new enums.
--   b. CREATE TABLE the eight tables + PKs (all carry updatedAt NOT NULL; there
--      is NO createdAt-only append-only table this phase).
--   c. (id,institutionId) unique + (institutionId)/query indexes + business
--      uniques + the two partial uniques.
--   d. tenant-root institutionId -> institutions(id) RESTRICT on all eight.
--   e. composite same-tenant FKs (each carries institutionId).
--   f. CHECKs.
--   g. ENABLE+FORCE RLS (standard pair on all eight; NO append-only pair).
--   h. three column-guard functions + their triggers.
--   i. guarded + idempotent campass_app GRANT refresh (NO DELETE).
--   j. catalogue seed: the TRANSPORT_MANAGER role row (BEFORE the permissions
--      block) + the eight transport.* permissions + the ADMIN/TRANSPORT_MANAGER/
--      STUDENT role_permissions pairs.

-- ─────────────────────────────────────────────────────────────────────────────
-- a. Enums.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "TransportVehicleType"       AS ENUM ('BUS', 'VAN', 'CAR', 'OTHER');
CREATE TYPE "TransportVehicleStatus"     AS ENUM ('ACTIVE', 'INACTIVE', 'MAINTENANCE');
CREATE TYPE "TransportDriverStatus"      AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "TransportRouteStatus"       AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "TransportAssignmentStatus"  AS ENUM ('ACTIVE', 'ENDED');
CREATE TYPE "TransportEnrollmentStatus"  AS ENUM ('ACTIVE', 'SUSPENDED', 'ENDED');
CREATE TYPE "TransportMaintenanceStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED');
CREATE TYPE "TransportDayOfWeek"         AS ENUM ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN');

-- ─────────────────────────────────────────────────────────────────────────────
-- b. New tenant-owned tables + PKs. All eight carry updatedAt NOT NULL (all
--    mutable/guarded — no append-only class this phase). Actor/provenance ids
--    (createdByUserId, reportedByUserId, assigneeUserId, userId) are recorded
--    ids with NO FK (the hostel/faculty createdByUserId precedent).
--    transport_vehicle_maintenance_requests DELIBERATELY has NO createdByUserId;
--    reportedByUserId is the creator actor (the hostel_maintenance_requests
--    precedent).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "transport_vehicles" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "registrationNo"  TEXT NOT NULL,
    "type"            "TransportVehicleType" NOT NULL,
    "seatCapacity"    INTEGER NOT NULL,
    "status"          "TransportVehicleStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transport_vehicles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transport_drivers" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "licenseNo"       TEXT NOT NULL,
    "phone"           TEXT,
    "userId"          TEXT,
    "status"          "TransportDriverStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transport_drivers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transport_routes" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "code"            TEXT NOT NULL,
    "status"          "TransportRouteStatus" NOT NULL DEFAULT 'ACTIVE',
    "feeAmount"       INTEGER,
    "createdByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transport_routes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transport_route_stops" (
    "id"                  TEXT NOT NULL,
    "institutionId"       TEXT NOT NULL,
    "routeId"             TEXT NOT NULL,
    "name"                TEXT NOT NULL,
    "sequence"            INTEGER NOT NULL,
    "landmark"            TEXT,
    "latitude"            DOUBLE PRECISION,
    "longitude"           DOUBLE PRECISION,
    "pickupOffsetMinutes" INTEGER,
    "createdByUserId"     TEXT NOT NULL,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transport_route_stops_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transport_route_assignments" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "routeId"         TEXT NOT NULL,
    "vehicleId"       TEXT NOT NULL,
    "driverId"        TEXT NOT NULL,
    "effectiveFrom"   TIMESTAMP(3) NOT NULL,
    "effectiveTo"     TIMESTAMP(3),
    "status"          "TransportAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transport_route_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transport_enrollments" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "studentId"       TEXT NOT NULL,
    "routeId"         TEXT NOT NULL,
    "stopId"          TEXT NOT NULL,
    "status"          "TransportEnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "enrolledAt"      TIMESTAMP(3) NOT NULL,
    "endedAt"         TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transport_enrollments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transport_vehicle_maintenance_requests" (
    "id"               TEXT NOT NULL,
    "institutionId"    TEXT NOT NULL,
    "vehicleId"        TEXT NOT NULL,
    "issue"            TEXT NOT NULL,
    "status"           "TransportMaintenanceStatus" NOT NULL DEFAULT 'OPEN',
    "assigneeUserId"   TEXT,
    "cost"             INTEGER,
    "reportedByUserId" TEXT NOT NULL,
    "resolutionNote"   TEXT,
    "resolvedAt"       TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transport_vehicle_maintenance_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transport_route_schedules" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "routeId"         TEXT NOT NULL,
    "stopId"          TEXT,
    "dayOfWeek"       "TransportDayOfWeek",
    "date"            TIMESTAMP(3),
    "departureTime"   INTEGER NOT NULL,
    "arrivalTime"     INTEGER,
    "createdByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transport_route_schedules_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- c. Unique + query indexes. (id, institutionId) anchors the composite
--    same-tenant FKs; (institutionId) + per-query indexes; the business uniques
--    (one registrationNo / licenseNo / code per institution; one sequence per
--    route); and the two partial uniques (one ACTIVE assignment per route; one
--    ACTIVE enrollment per student+route — the hostel one-ACTIVE precedent).
-- ─────────────────────────────────────────────────────────────────────────────
-- transport_vehicles
CREATE UNIQUE INDEX "transport_vehicles_id_institutionId_key"              ON "transport_vehicles"("id", "institutionId");
CREATE UNIQUE INDEX "transport_vehicles_institutionId_registrationNo_key"  ON "transport_vehicles"("institutionId", "registrationNo");
CREATE INDEX        "transport_vehicles_institutionId_idx"                 ON "transport_vehicles"("institutionId");

-- transport_drivers
CREATE UNIQUE INDEX "transport_drivers_id_institutionId_key"          ON "transport_drivers"("id", "institutionId");
CREATE UNIQUE INDEX "transport_drivers_institutionId_licenseNo_key"   ON "transport_drivers"("institutionId", "licenseNo");
CREATE INDEX        "transport_drivers_institutionId_idx"             ON "transport_drivers"("institutionId");

-- transport_routes
CREATE UNIQUE INDEX "transport_routes_id_institutionId_key"      ON "transport_routes"("id", "institutionId");
CREATE UNIQUE INDEX "transport_routes_institutionId_code_key"    ON "transport_routes"("institutionId", "code");
CREATE INDEX        "transport_routes_institutionId_idx"         ON "transport_routes"("institutionId");

-- transport_route_stops
CREATE UNIQUE INDEX "transport_route_stops_id_institutionId_key"                ON "transport_route_stops"("id", "institutionId");
CREATE UNIQUE INDEX "transport_route_stops_institutionId_routeId_sequence_key"  ON "transport_route_stops"("institutionId", "routeId", "sequence");
CREATE INDEX        "transport_route_stops_institutionId_idx"                   ON "transport_route_stops"("institutionId");
CREATE INDEX        "transport_route_stops_institutionId_routeId_idx"           ON "transport_route_stops"("institutionId", "routeId");

-- transport_route_assignments
CREATE UNIQUE INDEX "transport_route_assignments_id_institutionId_key"       ON "transport_route_assignments"("id", "institutionId");
CREATE INDEX        "transport_route_assignments_institutionId_idx"          ON "transport_route_assignments"("institutionId");
CREATE INDEX        "transport_route_assignments_institutionId_routeId_idx"  ON "transport_route_assignments"("institutionId", "routeId");
CREATE INDEX        "transport_route_assignments_institutionId_vehicleId_idx" ON "transport_route_assignments"("institutionId", "vehicleId");
-- One ACTIVE assignment per route (per tenant) — slot-shaped partial unique
-- backstop for the service-level one-active check (the hostel precedent).
CREATE UNIQUE INDEX "transport_route_assignments_one_active_per_route"
  ON "transport_route_assignments"("institutionId", "routeId") WHERE "status" = 'ACTIVE';

-- transport_enrollments
CREATE UNIQUE INDEX "transport_enrollments_id_institutionId_key"        ON "transport_enrollments"("id", "institutionId");
CREATE INDEX        "transport_enrollments_institutionId_idx"           ON "transport_enrollments"("institutionId");
CREATE INDEX        "transport_enrollments_institutionId_routeId_idx"   ON "transport_enrollments"("institutionId", "routeId");
CREATE INDEX        "transport_enrollments_institutionId_studentId_idx" ON "transport_enrollments"("institutionId", "studentId");
-- One ACTIVE enrollment per student+route (per tenant) — slot-shaped partial
-- unique backstop for the service-level one-active check (the hostel precedent).
CREATE UNIQUE INDEX "transport_enrollments_one_active_per_student_route"
  ON "transport_enrollments"("institutionId", "studentId", "routeId") WHERE "status" = 'ACTIVE';

-- transport_vehicle_maintenance_requests
CREATE UNIQUE INDEX "transport_vehicle_maintenance_requests_id_institutionId_key"       ON "transport_vehicle_maintenance_requests"("id", "institutionId");
CREATE INDEX        "transport_vehicle_maintenance_requests_institutionId_idx"          ON "transport_vehicle_maintenance_requests"("institutionId");
CREATE INDEX        "transport_vehicle_maintenance_requests_institutionId_vehicleId_idx" ON "transport_vehicle_maintenance_requests"("institutionId", "vehicleId");
CREATE INDEX        "transport_vehicle_maintenance_requests_institutionId_status_idx"   ON "transport_vehicle_maintenance_requests"("institutionId", "status");

-- transport_route_schedules
CREATE UNIQUE INDEX "transport_route_schedules_id_institutionId_key"      ON "transport_route_schedules"("id", "institutionId");
CREATE INDEX        "transport_route_schedules_institutionId_idx"         ON "transport_route_schedules"("institutionId");
CREATE INDEX        "transport_route_schedules_institutionId_routeId_idx" ON "transport_route_schedules"("institutionId", "routeId");

-- ─────────────────────────────────────────────────────────────────────────────
-- d. Tenant-root FKs.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "transport_vehicles"                     ADD CONSTRAINT "transport_vehicles_institutionId_fkey"                     FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport_drivers"                      ADD CONSTRAINT "transport_drivers_institutionId_fkey"                      FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport_routes"                       ADD CONSTRAINT "transport_routes_institutionId_fkey"                       FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport_route_stops"                  ADD CONSTRAINT "transport_route_stops_institutionId_fkey"                  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport_route_assignments"            ADD CONSTRAINT "transport_route_assignments_institutionId_fkey"            FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport_enrollments"                  ADD CONSTRAINT "transport_enrollments_institutionId_fkey"                  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport_vehicle_maintenance_requests" ADD CONSTRAINT "transport_vehicle_maintenance_requests_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport_route_schedules"              ADD CONSTRAINT "transport_route_schedules_institutionId_fkey"              FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- e. Composite same-tenant FKs (each carries institutionId so a child can never
--    reference a parent in another tenant). All ON DELETE RESTRICT ON UPDATE
--    CASCADE. transport_routes / transport_vehicles / transport_drivers /
--    transport_route_stops / student_profiles all carry the (institutionId, id)
--    composite unique these anchor on. transport_route_schedules->stop uses the
--    default MATCH SIMPLE so a NULL stopId is a no-op (no CHECK needed).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "transport_route_stops"
  ADD CONSTRAINT "transport_route_stops_route_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "routeId") REFERENCES "transport_routes"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "transport_route_assignments"
  ADD CONSTRAINT "transport_route_assignments_route_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "routeId") REFERENCES "transport_routes"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport_route_assignments"
  ADD CONSTRAINT "transport_route_assignments_vehicle_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "vehicleId") REFERENCES "transport_vehicles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport_route_assignments"
  ADD CONSTRAINT "transport_route_assignments_driver_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "driverId") REFERENCES "transport_drivers"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "transport_enrollments"
  ADD CONSTRAINT "transport_enrollments_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport_enrollments"
  ADD CONSTRAINT "transport_enrollments_route_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "routeId") REFERENCES "transport_routes"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport_enrollments"
  ADD CONSTRAINT "transport_enrollments_stop_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "stopId") REFERENCES "transport_route_stops"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "transport_vehicle_maintenance_requests"
  ADD CONSTRAINT "transport_vehicle_maintenance_requests_vehicle_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "vehicleId") REFERENCES "transport_vehicles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "transport_route_schedules"
  ADD CONSTRAINT "transport_route_schedules_route_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "routeId") REFERENCES "transport_routes"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport_route_schedules"
  ADD CONSTRAINT "transport_route_schedules_stop_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "stopId") REFERENCES "transport_route_stops"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- f. CHECKs. seatCapacity>=1; sequence>=1; pickupOffsetMinutes>=0; feeAmount>=0;
--    cost>=0; non-empty name/registrationNo/licenseNo/code/issue; schedule
--    exactly-one-of dayOfWeek/date; departureTime/arrivalTime in 0..1439;
--    assignment effectiveTo IS NULL OR effectiveTo >= effectiveFrom.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "transport_vehicles"
  ADD CONSTRAINT "transport_vehicles_seatCapacity_positive_check" CHECK ("seatCapacity" >= 1);
ALTER TABLE "transport_vehicles"
  ADD CONSTRAINT "transport_vehicles_registrationNo_nonempty_check" CHECK (char_length("registrationNo") >= 1);

ALTER TABLE "transport_drivers"
  ADD CONSTRAINT "transport_drivers_name_nonempty_check" CHECK (char_length("name") >= 1);
ALTER TABLE "transport_drivers"
  ADD CONSTRAINT "transport_drivers_licenseNo_nonempty_check" CHECK (char_length("licenseNo") >= 1);

ALTER TABLE "transport_routes"
  ADD CONSTRAINT "transport_routes_name_nonempty_check" CHECK (char_length("name") >= 1);
ALTER TABLE "transport_routes"
  ADD CONSTRAINT "transport_routes_code_nonempty_check" CHECK (char_length("code") >= 1);
ALTER TABLE "transport_routes"
  ADD CONSTRAINT "transport_routes_feeAmount_nonnegative_check" CHECK ("feeAmount" IS NULL OR "feeAmount" >= 0);

ALTER TABLE "transport_route_stops"
  ADD CONSTRAINT "transport_route_stops_name_nonempty_check" CHECK (char_length("name") >= 1);
ALTER TABLE "transport_route_stops"
  ADD CONSTRAINT "transport_route_stops_sequence_positive_check" CHECK ("sequence" >= 1);
ALTER TABLE "transport_route_stops"
  ADD CONSTRAINT "transport_route_stops_pickupOffsetMinutes_nonnegative_check" CHECK ("pickupOffsetMinutes" IS NULL OR "pickupOffsetMinutes" >= 0);

ALTER TABLE "transport_route_assignments"
  ADD CONSTRAINT "transport_route_assignments_dates_order_check" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");

ALTER TABLE "transport_vehicle_maintenance_requests"
  ADD CONSTRAINT "transport_vehicle_maintenance_requests_issue_nonempty_check" CHECK (char_length("issue") >= 1);
ALTER TABLE "transport_vehicle_maintenance_requests"
  ADD CONSTRAINT "transport_vehicle_maintenance_requests_cost_nonnegative_check" CHECK ("cost" IS NULL OR "cost" >= 0);

ALTER TABLE "transport_route_schedules"
  ADD CONSTRAINT "transport_route_schedules_one_of_day_date_check"
  CHECK ((("dayOfWeek" IS NOT NULL)::int + ("date" IS NOT NULL)::int) = 1);
ALTER TABLE "transport_route_schedules"
  ADD CONSTRAINT "transport_route_schedules_departureTime_range_check" CHECK ("departureTime" BETWEEN 0 AND 1439);
ALTER TABLE "transport_route_schedules"
  ADD CONSTRAINT "transport_route_schedules_arrivalTime_range_check" CHECK ("arrivalTime" IS NULL OR "arrivalTime" BETWEEN 0 AND 1439);

-- ─────────────────────────────────────────────────────────────────────────────
-- g. RLS. ENABLE + FORCE on all eight. All get the standard fail-closed
--    nullif-guarded pair {tenant_isolation_select, tenant_isolation_modify}
--    (NO append-only pair this phase). nullif(current_setting(
--    'app.current_institution_id', true), '') fails closed for both an unset and
--    an empty-string GUC.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  mutable_tables TEXT[] := ARRAY[
    'transport_vehicles', 'transport_drivers', 'transport_routes',
    'transport_route_stops', 'transport_route_assignments', 'transport_enrollments',
    'transport_vehicle_maintenance_requests', 'transport_route_schedules'
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
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- h. Triggers. Three column-guard functions (forward-only lifecycle + frozen
--    identity cols + DELETE forbidden), mirroring hostel_room_allocations_guard
--    / hostel_maintenance_requests_guard. The four mutable-with-audit tables
--    (transport_vehicles / transport_drivers / transport_routes /
--    transport_route_stops / transport_route_schedules) carry NO trigger
--    (legitimately editable; immutability is not an invariant).
-- ─────────────────────────────────────────────────────────────────────────────

-- h.1 transport_route_assignments column guard (forward-only: ACTIVE->ENDED;
--     terminal frozen; DELETE forbidden).
CREATE OR REPLACE FUNCTION "transport_route_assignments_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transport_route_assignments is forward-only: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- frozen identity columns.
  IF NEW."institutionId"   IS DISTINCT FROM OLD."institutionId"
  OR NEW."routeId"         IS DISTINCT FROM OLD."routeId"
  OR NEW."vehicleId"       IS DISTINCT FROM OLD."vehicleId"
  OR NEW."driverId"        IS DISTINCT FROM OLD."driverId"
  OR NEW."effectiveFrom"   IS DISTINCT FROM OLD."effectiveFrom"
  OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
  OR NEW."createdAt"       IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'immutable transport_route_assignments column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- forward-only transitions (plus the no-op self transition). Terminal (ENDED)
  -- is frozen because it is not a legal source below.
  IF NOT (
       (OLD."status" = 'ACTIVE' AND NEW."status" = 'ENDED')
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal transport_route_assignments status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "transport_route_assignments_guard"
  BEFORE UPDATE OR DELETE ON "transport_route_assignments"
  FOR EACH ROW EXECUTE FUNCTION "transport_route_assignments_guard"();

-- h.2 transport_enrollments column guard (forward-only: ACTIVE->SUSPENDED|ENDED,
--     SUSPENDED->ENDED; terminal frozen; DELETE forbidden).
CREATE OR REPLACE FUNCTION "transport_enrollments_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transport_enrollments is forward-only: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."institutionId"   IS DISTINCT FROM OLD."institutionId"
  OR NEW."studentId"       IS DISTINCT FROM OLD."studentId"
  OR NEW."routeId"         IS DISTINCT FROM OLD."routeId"
  OR NEW."stopId"          IS DISTINCT FROM OLD."stopId"
  OR NEW."enrolledAt"      IS DISTINCT FROM OLD."enrolledAt"
  OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
  OR NEW."createdAt"       IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'immutable transport_enrollments column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (
       (OLD."status" = 'ACTIVE'    AND NEW."status" = 'SUSPENDED')
    OR (OLD."status" = 'ACTIVE'    AND NEW."status" = 'ENDED')
    OR (OLD."status" = 'SUSPENDED' AND NEW."status" = 'ENDED')
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal transport_enrollments status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "transport_enrollments_guard"
  BEFORE UPDATE OR DELETE ON "transport_enrollments"
  FOR EACH ROW EXECUTE FUNCTION "transport_enrollments_guard"();

-- h.3 transport_vehicle_maintenance_requests column guard (forward-only:
--     OPEN->IN_PROGRESS->RESOLVED, OPEN|IN_PROGRESS->CANCELLED; terminal frozen;
--     DELETE forbidden).
CREATE OR REPLACE FUNCTION "transport_vehicle_maintenance_requests_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transport_vehicle_maintenance_requests is forward-only: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."institutionId"    IS DISTINCT FROM OLD."institutionId"
  OR NEW."vehicleId"        IS DISTINCT FROM OLD."vehicleId"
  OR NEW."reportedByUserId" IS DISTINCT FROM OLD."reportedByUserId"
  OR NEW."createdAt"        IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'immutable transport_vehicle_maintenance_requests column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (
       (OLD."status" = 'OPEN'        AND NEW."status" = 'IN_PROGRESS')
    OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" = 'RESOLVED')
    OR (OLD."status" = 'OPEN'        AND NEW."status" = 'CANCELLED')
    OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" = 'CANCELLED')
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal transport_vehicle_maintenance_requests status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "transport_vehicle_maintenance_requests_guard"
  BEFORE UPDATE OR DELETE ON "transport_vehicle_maintenance_requests"
  FOR EACH ROW EXECUTE FUNCTION "transport_vehicle_maintenance_requests_guard"();

-- ─────────────────────────────────────────────────────────────────────────────
-- i. campass_app GRANT refresh (guarded + idempotent). All eight tables get
--    SELECT, INSERT, UPDATE (NO DELETE — forward-only intent: the DB column
--    guards forbid DELETE anyway, and no route hard-deletes a transport row).
--    No append-only table this phase, so NO REVOKE needed. Never grant BYPASSRLS.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "transport_vehicles"                     TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "transport_drivers"                      TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "transport_routes"                       TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "transport_route_stops"                  TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "transport_route_assignments"            TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "transport_enrollments"                  TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "transport_vehicle_maintenance_requests" TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "transport_route_schedules"              TO "campass_app";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- j. Catalogue seed. The TRANSPORT_MANAGER template role row (institutionId =
--    NULL) is NEW (the WARDEN / ACCOUNTANT / LIBRARIAN precedent), so it IS
--    inserted here, BEFORE the permissions block (so its `, NULL)` tuple falls
--    outside the sliced permission span the catalogue-sync parser reads). Then
--    the eight transport.* permissions (each "module" = 'transport', matching
--    permissions.ts), then the role_permissions pairs. ROLE_PERMISSIONS lockstep:
--    ADMIN x7 staff keys, TRANSPORT_MANAGER x7 staff keys, STUDENT x
--    transport.view_own. Separation of duties: STUDENT never gets a staff key;
--    no staff role gets transport.view_own.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "roles" ("id","key","name","institutionId") VALUES
  ('role_transport_manager', 'TRANSPORT_MANAGER', 'Transport Manager', NULL)
ON CONFLICT DO NOTHING;

INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_transport_vehicles_manage',    'transport.vehicles.manage',    'transport', 'Create/update vehicles + vehicle status'),
  ('perm_transport_drivers_manage',     'transport.drivers.manage',     'transport', 'Create/update drivers + driver status'),
  ('perm_transport_routes_manage',      'transport.routes.manage',      'transport', 'Create/update routes + stops + schedules'),
  ('perm_transport_assignments_manage', 'transport.assignments.manage', 'transport', 'Assign/end route vehicle+driver assignments'),
  ('perm_transport_enrollments_manage', 'transport.enrollments.manage', 'transport', 'Enroll/suspend/end students on routes'),
  ('perm_transport_maintenance_manage', 'transport.maintenance.manage', 'transport', 'Create/advance/resolve vehicle maintenance requests'),
  ('perm_transport_view',               'transport.view',               'transport', 'Staff read of vehicles/drivers/routes/assignments/enrollments/maintenance + reports/export'),
  ('perm_transport_view_own',           'transport.view_own',           'transport', 'Student self-service: own enrollment + route/stop/schedule')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('ADMIN',             'transport.vehicles.manage'),
  ('ADMIN',             'transport.drivers.manage'),
  ('ADMIN',             'transport.routes.manage'),
  ('ADMIN',             'transport.assignments.manage'),
  ('ADMIN',             'transport.enrollments.manage'),
  ('ADMIN',             'transport.maintenance.manage'),
  ('ADMIN',             'transport.view'),
  ('TRANSPORT_MANAGER', 'transport.vehicles.manage'),
  ('TRANSPORT_MANAGER', 'transport.drivers.manage'),
  ('TRANSPORT_MANAGER', 'transport.routes.manage'),
  ('TRANSPORT_MANAGER', 'transport.assignments.manage'),
  ('TRANSPORT_MANAGER', 'transport.enrollments.manage'),
  ('TRANSPORT_MANAGER', 'transport.maintenance.manage'),
  ('TRANSPORT_MANAGER', 'transport.view'),
  ('STUDENT',           'transport.view_own')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
