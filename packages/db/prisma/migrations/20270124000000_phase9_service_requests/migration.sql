-- CAMPASS Phase 9.6 — Service Requests Management (backend only): the SIXTH
-- module of Phase 9 (Institutional operations). A gated ("booster") module
-- layered on the shared foundation (User / Department / Institution),
-- INDEPENDENT of Phase 9.1 (faculty_management), 9.2 (HR), 9.3 (hostel), 9.4
-- (transport) and 9.5 (inventory) — no coupling in either direction. It models
-- predefined request types + data-driven form field definitions, a FIXED
-- enumerated request lifecycle (NOT a generic/configurable workflow engine: no
-- user-defined states, no rules DSL), assignment to a User, an approval gate, a
-- derived SLA (dueAt stored at raise, breach derived at read), an append-only
-- comments/activity ledger, and one-per-request feedback. Requester and assignee
-- reference the single authoritative User identity via composite same-tenant FKs
-- — never duplicated.
--
-- Hand-authored (Prisma's diff models neither RLS, the composite same-tenant
-- FKs, the CHECKs, the append-only triggers, the lifecycle column guard, the
-- targeted GRANT refresh, nor the catalogue seed). STRICTLY ADDITIVE: it only
-- CREATEs new objects + one additive catalogue seed. It NEVER edits any
-- pre-existing migration directory (every prior dir stays byte-identical), never
-- touches the _prisma_migrations ledger, and campass_app stays NOSUPERUSER
-- NOBYPASSRLS — never granted BYPASSRLS.
--
-- FIVE new tenant-owned tables:
--   THREE mutable/guarded (updatedAt NOT NULL):
--     * service_request_types             — mutable-with-audit, NO trigger.
--     * service_request_field_definitions — mutable-with-audit, NO trigger
--                                            (handler enforces frozen-once-
--                                            requests-exist, design §6/§9).
--     * service_requests                  — enumerated-transition terminal-
--                                            enforcing lifecycle column guard
--                                            (§5; CLOSED/REJECTED/CANCELLED
--                                            terminal; dueAt NOT NULL).
--   TWO append-only (createdAt-only, NO updatedAt):
--     * service_request_activities        — append-only comments/activity ledger.
--     * service_request_feedback          — append-only, one-per-request.
-- Every table carries institutionId + (id, institutionId) composite unique +
-- (institutionId) index + composite same-tenant FKs incl. institutionId +
-- ENABLE+FORCE RLS.
--
-- Ordering (mirrors the inventory lettered house style a–j):
--   a. CREATE TYPE the four new enums.
--   b. CREATE TABLE the five tables + PKs (three carry updatedAt NOT NULL; two
--      append-only are createdAt-only).
--   c. (id,institutionId) unique + (institutionId)/query indexes + business
--      uniques (types code; field (type,fieldKey); feedback (serviceRequestId)).
--   d. tenant-root institutionId -> institutions(id) RESTRICT on all five.
--   e. composite same-tenant FKs (each carries institutionId; MATCH SIMPLE for
--      nullable assignee / default department).
--   f. CHECKs.
--   g. ENABLE+FORCE RLS (standard pair on the three mutable/guarded; append-only
--      {tenant_isolation_select, <table>_tenant_insert} pair on the two ledgers).
--   h. two append-only triggers + the service_request_status_guard column guard.
--   i. guarded + idempotent campass_app GRANT refresh (SELECT,INSERT,UPDATE on
--      the three; SELECT,INSERT + REVOKE UPDATE,DELETE on the two append-only).
--   j. catalogue seed: the SERVICE_AGENT role row (BEFORE the permissions block)
--      + the six service_requests.* permissions + the ADMIN/SERVICE_AGENT/STUDENT
--      role_permissions pairs.

-- ─────────────────────────────────────────────────────────────────────────────
-- a. Enums.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "ServiceRequestFieldType"    AS ENUM ('TEXT', 'NUMBER', 'DATE', 'SELECT');
CREATE TYPE "ServiceRequestPriority"     AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
CREATE TYPE "ServiceRequestStatus"       AS ENUM ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_APPROVAL', 'RESOLVED', 'CLOSED', 'REJECTED', 'CANCELLED');
CREATE TYPE "ServiceRequestActivityKind" AS ENUM ('STATUS_CHANGE', 'COMMENT', 'ASSIGNMENT', 'APPROVAL');

-- ─────────────────────────────────────────────────────────────────────────────
-- b. New tenant-owned tables + PKs. Three mutable/guarded carry updatedAt NOT
--    NULL; two append-only are createdAt-only. Actor/provenance ids
--    (createdByUserId, actorUserId) are recorded ids with NO FK (the
--    transport/hostel/inventory precedent). requesterUserId / assigneeUserId /
--    feedback.requesterUserId DO carry composite FKs (authoritative identity).
--    service_requests.dueAt is NOT NULL (always computed at raise); fieldValues
--    is jsonb; field definition options is text[].
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "service_request_types" (
    "id"                          TEXT NOT NULL,
    "institutionId"               TEXT NOT NULL,
    "name"                        TEXT NOT NULL,
    "code"                        TEXT NOT NULL,
    "category"                    TEXT NOT NULL,
    "description"                 TEXT,
    "defaultAssigneeRole"         TEXT,
    "defaultAssigneeDepartmentId" TEXT,
    "slaTargetHours"              INTEGER NOT NULL,
    "requiresApproval"            BOOLEAN NOT NULL DEFAULT false,
    "isActive"                    BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId"             TEXT NOT NULL,
    "createdAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_request_types_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_request_field_definitions" (
    "id"                   TEXT NOT NULL,
    "institutionId"        TEXT NOT NULL,
    "serviceRequestTypeId" TEXT NOT NULL,
    "fieldKey"             TEXT NOT NULL,
    "label"                TEXT NOT NULL,
    "dataType"             "ServiceRequestFieldType" NOT NULL,
    "required"             BOOLEAN NOT NULL DEFAULT false,
    "options"              TEXT[],
    "sortOrder"            INTEGER NOT NULL DEFAULT 0,
    "createdByUserId"      TEXT NOT NULL,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_request_field_definitions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_requests" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "requestTypeId"   TEXT NOT NULL,
    "requesterUserId" TEXT NOT NULL,
    "title"           TEXT NOT NULL,
    "description"     TEXT,
    "priority"        "ServiceRequestPriority" NOT NULL DEFAULT 'NORMAL',
    "fieldValues"     JSONB NOT NULL,
    "status"          "ServiceRequestStatus" NOT NULL DEFAULT 'OPEN',
    "assigneeUserId"  TEXT,
    "dueAt"           TIMESTAMP(3) NOT NULL,
    "resolutionNote"  TEXT,
    "raisedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt"      TIMESTAMP(3),
    "closedAt"        TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_requests_pkey" PRIMARY KEY ("id")
);

-- append-only (createdAt-only, NO updatedAt)
CREATE TABLE "service_request_activities" (
    "id"               TEXT NOT NULL,
    "institutionId"    TEXT NOT NULL,
    "serviceRequestId" TEXT NOT NULL,
    "kind"             "ServiceRequestActivityKind" NOT NULL,
    "actorUserId"      TEXT NOT NULL,
    "fromStatus"       "ServiceRequestStatus",
    "toStatus"         "ServiceRequestStatus",
    "body"             TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_request_activities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_request_feedback" (
    "id"               TEXT NOT NULL,
    "institutionId"    TEXT NOT NULL,
    "serviceRequestId" TEXT NOT NULL,
    "requesterUserId"  TEXT NOT NULL,
    "rating"           INTEGER NOT NULL,
    "comment"          TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_request_feedback_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- c. Unique + query indexes. (id, institutionId) anchors the composite
--    same-tenant FKs; (institutionId) + per-query indexes; the business uniques
--    (one code per institution on types; one fieldKey per type; one feedback per
--    request).
-- ─────────────────────────────────────────────────────────────────────────────
-- service_request_types
CREATE UNIQUE INDEX "service_request_types_id_institutionId_key" ON "service_request_types"("id", "institutionId");
CREATE UNIQUE INDEX "service_request_types_institutionId_code_key" ON "service_request_types"("institutionId", "code");
CREATE INDEX        "service_request_types_institutionId_idx" ON "service_request_types"("institutionId");

-- service_request_field_definitions
CREATE UNIQUE INDEX "service_request_field_definitions_id_institutionId_key" ON "service_request_field_definitions"("id", "institutionId");
CREATE UNIQUE INDEX "service_request_field_definitions_type_fieldKey_key" ON "service_request_field_definitions"("institutionId", "serviceRequestTypeId", "fieldKey");
CREATE INDEX        "service_request_field_definitions_institutionId_idx" ON "service_request_field_definitions"("institutionId");
CREATE INDEX        "service_request_field_definitions_institutionId_type_idx" ON "service_request_field_definitions"("institutionId", "serviceRequestTypeId");

-- service_requests
CREATE UNIQUE INDEX "service_requests_id_institutionId_key" ON "service_requests"("id", "institutionId");
CREATE INDEX        "service_requests_institutionId_idx" ON "service_requests"("institutionId");
CREATE INDEX        "service_requests_institutionId_status_idx" ON "service_requests"("institutionId", "status");
CREATE INDEX        "service_requests_institutionId_requesterUserId_idx" ON "service_requests"("institutionId", "requesterUserId");
CREATE INDEX        "service_requests_institutionId_assigneeUserId_idx" ON "service_requests"("institutionId", "assigneeUserId");
CREATE INDEX        "service_requests_institutionId_requestTypeId_idx" ON "service_requests"("institutionId", "requestTypeId");
CREATE INDEX        "service_requests_institutionId_dueAt_idx" ON "service_requests"("institutionId", "dueAt");

-- service_request_activities
CREATE UNIQUE INDEX "service_request_activities_id_institutionId_key" ON "service_request_activities"("id", "institutionId");
CREATE INDEX        "service_request_activities_institutionId_idx" ON "service_request_activities"("institutionId");
CREATE INDEX        "service_request_activities_institutionId_request_idx" ON "service_request_activities"("institutionId", "serviceRequestId");

-- service_request_feedback
CREATE UNIQUE INDEX "service_request_feedback_id_institutionId_key" ON "service_request_feedback"("id", "institutionId");
CREATE UNIQUE INDEX "service_request_feedback_institutionId_request_key" ON "service_request_feedback"("institutionId", "serviceRequestId");
CREATE INDEX        "service_request_feedback_institutionId_idx" ON "service_request_feedback"("institutionId");

-- ─────────────────────────────────────────────────────────────────────────────
-- d. Tenant-root FKs.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "service_request_types"             ADD CONSTRAINT "service_request_types_institutionId_fkey"             FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_request_field_definitions" ADD CONSTRAINT "service_request_field_definitions_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_requests"                  ADD CONSTRAINT "service_requests_institutionId_fkey"                  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_request_activities"        ADD CONSTRAINT "service_request_activities_institutionId_fkey"        FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_request_feedback"          ADD CONSTRAINT "service_request_feedback_institutionId_fkey"          FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- e. Composite same-tenant FKs (each carries institutionId so a child can never
--    reference a parent in another tenant). All ON DELETE RESTRICT ON UPDATE
--    CASCADE. Nullable assignee / default department use MATCH SIMPLE so a NULL
--    column is a no-op (the inventory custody-user precedent).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "service_request_types"
  ADD CONSTRAINT "service_request_types_default_department_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "defaultAssigneeDepartmentId") REFERENCES "departments"("institutionId", "id") MATCH SIMPLE
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "service_request_field_definitions"
  ADD CONSTRAINT "service_request_field_definitions_type_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "serviceRequestTypeId") REFERENCES "service_request_types"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "service_requests"
  ADD CONSTRAINT "service_requests_type_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "requestTypeId") REFERENCES "service_request_types"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_requests"
  ADD CONSTRAINT "service_requests_requester_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "requesterUserId") REFERENCES "users"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_requests"
  ADD CONSTRAINT "service_requests_assignee_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "assigneeUserId") REFERENCES "users"("institutionId", "id") MATCH SIMPLE
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "service_request_activities"
  ADD CONSTRAINT "service_request_activities_request_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "serviceRequestId") REFERENCES "service_requests"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "service_request_feedback"
  ADD CONSTRAINT "service_request_feedback_request_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "serviceRequestId") REFERENCES "service_requests"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_request_feedback"
  ADD CONSTRAINT "service_request_feedback_requester_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "requesterUserId") REFERENCES "users"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- f. CHECKs. Non-empty strings; slaTargetHours >= 1; field option-shape (SELECT
--    => non-empty options, non-SELECT => null/empty options); sortOrder >= 0;
--    feedback rating 1..5.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "service_request_types"
  ADD CONSTRAINT "service_request_types_name_nonempty_check" CHECK (char_length("name") >= 1);
ALTER TABLE "service_request_types"
  ADD CONSTRAINT "service_request_types_code_nonempty_check" CHECK (char_length("code") >= 1);
ALTER TABLE "service_request_types"
  ADD CONSTRAINT "service_request_types_category_nonempty_check" CHECK (char_length("category") >= 1);
ALTER TABLE "service_request_types"
  ADD CONSTRAINT "service_request_types_slaTargetHours_positive_check" CHECK ("slaTargetHours" >= 1);

ALTER TABLE "service_request_field_definitions"
  ADD CONSTRAINT "service_request_field_definitions_fieldKey_nonempty_check" CHECK (char_length("fieldKey") >= 1);
ALTER TABLE "service_request_field_definitions"
  ADD CONSTRAINT "service_request_field_definitions_label_nonempty_check" CHECK (char_length("label") >= 1);
ALTER TABLE "service_request_field_definitions"
  ADD CONSTRAINT "service_request_field_definitions_sortOrder_nonnegative_check" CHECK ("sortOrder" >= 0);
ALTER TABLE "service_request_field_definitions"
  ADD CONSTRAINT "service_request_field_definitions_options_shape_check"
  CHECK (
    ("dataType" = 'SELECT' AND array_length("options", 1) >= 1)
    OR ("dataType" <> 'SELECT' AND ("options" IS NULL OR array_length("options", 1) IS NULL))
  );

ALTER TABLE "service_requests"
  ADD CONSTRAINT "service_requests_title_nonempty_check" CHECK (char_length("title") >= 1);

ALTER TABLE "service_request_feedback"
  ADD CONSTRAINT "service_request_feedback_rating_range_check" CHECK ("rating" BETWEEN 1 AND 5);

-- ─────────────────────────────────────────────────────────────────────────────
-- g. RLS. ENABLE + FORCE on all five. The three mutable/guarded get the standard
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
    'service_request_types', 'service_request_field_definitions', 'service_requests'
  ];
  append_only_tables TEXT[] := ARRAY[
    'service_request_activities', 'service_request_feedback'
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
--   h.1 The two append-only tables mirror the inventory ledger shape: a
--       <table>_append_only() plpgsql function raising restrict_violation, bound
--       by a BEFORE UPDATE OR DELETE ... FOR EACH ROW trigger (binds the owner
--       too — GRANTs alone cannot restrict the owner).
--   h.2 service_requests enumerated-transition terminal-enforcing column guard.
-- ─────────────────────────────────────────────────────────────────────────────

-- h.1 service_request_activities
CREATE OR REPLACE FUNCTION "service_request_activities_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'service_request_activities is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;$$;
CREATE TRIGGER "service_request_activities_no_update_delete"
  BEFORE UPDATE OR DELETE ON "service_request_activities"
  FOR EACH ROW EXECUTE FUNCTION "service_request_activities_append_only"();

-- h.1 service_request_feedback
CREATE OR REPLACE FUNCTION "service_request_feedback_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'service_request_feedback is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;$$;
CREATE TRIGGER "service_request_feedback_no_update_delete"
  BEFORE UPDATE OR DELETE ON "service_request_feedback"
  FOR EACH ROW EXECUTE FUNCTION "service_request_feedback_append_only"();

-- h.2 service_requests enumerated-transition terminal-enforcing column guard
--     (§5). Legal edges (plus the no-op self transition): OPEN->ASSIGNED,
--     OPEN->CANCELLED, ASSIGNED->IN_PROGRESS, ASSIGNED->ASSIGNED (reassign),
--     ASSIGNED->CANCELLED, IN_PROGRESS->PENDING_APPROVAL, IN_PROGRESS->RESOLVED,
--     IN_PROGRESS->CANCELLED, PENDING_APPROVAL->RESOLVED, PENDING_APPROVAL->
--     REJECTED, RESOLVED->CLOSED. CLOSED / REJECTED / CANCELLED are TERMINAL
--     (no legal source edge out of them). Freezes the identity columns via
--     IS DISTINCT FROM; forbids DELETE. The approval-type gate (requiresApproval)
--     is enforced in the handler (the DB allows IN_PROGRESS->PENDING_APPROVAL and
--     IN_PROGRESS->RESOLVED structurally; the handler chooses per type).
CREATE OR REPLACE FUNCTION "service_request_status_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'service_requests is guarded: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- frozen identity columns (byte-identical to design §5 / §8.5).
  IF NEW."institutionId"   IS DISTINCT FROM OLD."institutionId"
  OR NEW."requestTypeId"   IS DISTINCT FROM OLD."requestTypeId"
  OR NEW."requesterUserId" IS DISTINCT FROM OLD."requesterUserId"
  OR NEW."title"           IS DISTINCT FROM OLD."title"
  OR NEW."priority"        IS DISTINCT FROM OLD."priority"
  OR NEW."fieldValues"     IS DISTINCT FROM OLD."fieldValues"
  OR NEW."description"     IS DISTINCT FROM OLD."description"
  OR NEW."raisedAt"        IS DISTINCT FROM OLD."raisedAt"
  OR NEW."createdAt"       IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'immutable service_requests column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- Enumerated legal transitions (plus the no-op self transition). CLOSED,
  -- REJECTED and CANCELLED are terminal because they are not legal source states
  -- below.
  IF NOT (
       (OLD."status" = 'OPEN'             AND NEW."status" = 'ASSIGNED')
    OR (OLD."status" = 'OPEN'             AND NEW."status" = 'CANCELLED')
    OR (OLD."status" = 'ASSIGNED'         AND NEW."status" = 'IN_PROGRESS')
    OR (OLD."status" = 'ASSIGNED'         AND NEW."status" = 'ASSIGNED')
    OR (OLD."status" = 'ASSIGNED'         AND NEW."status" = 'CANCELLED')
    OR (OLD."status" = 'IN_PROGRESS'      AND NEW."status" = 'PENDING_APPROVAL')
    OR (OLD."status" = 'IN_PROGRESS'      AND NEW."status" = 'RESOLVED')
    OR (OLD."status" = 'IN_PROGRESS'      AND NEW."status" = 'CANCELLED')
    OR (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" = 'RESOLVED')
    OR (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" = 'REJECTED')
    OR (OLD."status" = 'RESOLVED'         AND NEW."status" = 'CLOSED')
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal service_requests status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "service_request_status_guard"
  BEFORE UPDATE OR DELETE ON "service_requests"
  FOR EACH ROW EXECUTE FUNCTION "service_request_status_guard"();

-- ─────────────────────────────────────────────────────────────────────────────
-- i. campass_app GRANT refresh (guarded + idempotent). The three mutable/guarded
--    tables get SELECT, INSERT, UPDATE (NO DELETE — the DB guard forbids DELETE
--    anyway, and no route hard-deletes a service-request row). The two
--    append-only ledgers get SELECT, INSERT and an explicit REVOKE UPDATE, DELETE
--    (the inventory ledger precedent). Never grant BYPASSRLS.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "service_request_types"             TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "service_request_field_definitions" TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "service_requests"                  TO "campass_app";

    GRANT SELECT, INSERT ON "service_request_activities" TO "campass_app";
    GRANT SELECT, INSERT ON "service_request_feedback"   TO "campass_app";
    REVOKE UPDATE, DELETE ON "service_request_activities" FROM "campass_app";
    REVOKE UPDATE, DELETE ON "service_request_feedback"   FROM "campass_app";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- j. Catalogue seed. The SERVICE_AGENT template role row (institutionId = NULL)
--    is NEW (the INVENTORY_MANAGER / TRANSPORT_MANAGER / WARDEN / HR_MANAGER
--    precedent), so it IS inserted here, BEFORE the permissions block (so its
--    `, NULL)` tuple falls outside the sliced permission span the catalogue-sync
--    parser reads). Then the six service_requests.* permissions (each "module" =
--    'service_requests', matching permissions.ts), then the role_permissions
--    pairs. ROLE_PERMISSIONS lockstep: ADMIN x5 staff keys (NOT request_own),
--    SERVICE_AGENT x5 staff keys (NOT request_own), STUDENT x1 (request_own).
--    Separation of duties: STUDENT gets no staff key; no staff role gets the self
--    key.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "roles" ("id","key","name","institutionId") VALUES
  ('role_service_agent', 'SERVICE_AGENT', 'Service Agent', NULL)
ON CONFLICT DO NOTHING;

INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_service_requests_types_manage',     'service_requests.types.manage',     'service_requests', 'Create/update request types + field definitions + SLA config'),
  ('perm_service_requests_assign_manage',    'service_requests.assign.manage',    'service_requests', 'Assign/reassign a request to an agent'),
  ('perm_service_requests_requests_handle',  'service_requests.requests.handle',  'service_requests', 'Drive lifecycle, resolve, comment, close/cancel any'),
  ('perm_service_requests_requests_approve', 'service_requests.requests.approve', 'service_requests', 'Approve/reject a PENDING_APPROVAL request'),
  ('perm_service_requests_view',             'service_requests.view',             'service_requests', 'Staff read of all requests/types/activity/feedback + reports/export'),
  ('perm_service_requests_request_own',      'service_requests.request_own',      'service_requests', 'Self-service: raise, list/view OWN, comment OWN, cancel OWN OPEN, close/feedback OWN')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('ADMIN',         'service_requests.types.manage'),
  ('ADMIN',         'service_requests.assign.manage'),
  ('ADMIN',         'service_requests.requests.handle'),
  ('ADMIN',         'service_requests.requests.approve'),
  ('ADMIN',         'service_requests.view'),
  ('SERVICE_AGENT', 'service_requests.types.manage'),
  ('SERVICE_AGENT', 'service_requests.assign.manage'),
  ('SERVICE_AGENT', 'service_requests.requests.handle'),
  ('SERVICE_AGENT', 'service_requests.requests.approve'),
  ('SERVICE_AGENT', 'service_requests.view'),
  ('STUDENT',       'service_requests.request_own')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
