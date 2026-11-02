-- CAMPASS Phase 9.5 — Inventory & Assets Management (backend only): the FIFTH
-- module of Phase 9 (Institutional operations). A gated ("booster") module
-- layered on the shared foundation (User / Department / Institution), independent
-- of Phase 9.1 (faculty_management), 9.2 (HR), 9.3 (hostel) and 9.4 (transport),
-- and DISTINCT from Phase 5 Library (no overlap, no coupling). It models asset
-- categories, an asset registry (enumerated-transition terminal-enforcing
-- lifecycle), custody held by a User and/or Department + an append-only
-- custody-transfer ledger, consumable stock with a concurrency-safe non-negative
-- STORED on-hand quantity + an append-only stock-movement ledger, maintenance
-- requests (forward-only), disposal (terminal) + an append-only disposal record,
-- stock-take audit sessions + append-only audit lines. Custody references the
-- single authoritative User/Department identities via composite same-tenant FKs
-- — it never duplicates them.
--
-- Hand-authored (Prisma's diff models neither RLS, the composite same-tenant
-- FKs, the CHECKs, the append-only triggers, the lifecycle column guards, the
-- targeted GRANT refresh, nor the catalogue seed). STRICTLY ADDITIVE: it only
-- CREATEs new objects + one additive catalogue seed. It NEVER edits any
-- pre-existing migration directory (every prior dir stays byte-identical), never
-- touches the _prisma_migrations ledger, and campass_app stays NOSUPERUSER
-- NOBYPASSRLS — never granted BYPASSRLS.
--
-- NINE new tenant-owned tables:
--   FIVE mutable/guarded (updatedAt NOT NULL):
--     * inventory_asset_categories      — mutable-with-audit, NO trigger.
--     * inventory_stock_items           — mutable-with-audit, NO trigger
--                                         (onHandQuantity mutated ONLY under the
--                                         per-item advisory lock, design §B.6).
--     * inventory_audit_sessions        — two-state forward-only guard
--                                         (OPEN->CLOSED; DELETE forbidden).
--     * inventory_assets                — enumerated-transition terminal-enforcing
--                                         lifecycle guard (RETIRED/DISPOSED
--                                         terminal; legal lateral/back edges).
--     * inventory_maintenance_requests  — linear forward-only lifecycle guard
--                                         (OPEN->IN_PROGRESS->RESOLVED/CANCELLED).
--   FOUR append-only (createdAt-only, NO updatedAt):
--     * inventory_custody_transfers     — append-only ledger.
--     * inventory_stock_movements       — append-only ledger (signed qty +
--                                         balanceAfter snapshot).
--     * inventory_audit_lines           — append-only stock-take lines.
--     * inventory_disposals             — append-only disposal fact.
-- Every table carries institutionId + (id, institutionId) composite unique +
-- (institutionId) index + composite same-tenant FKs incl. institutionId +
-- ENABLE+FORCE RLS.
--
-- Ordering (mirrors the transport lettered house style a–j):
--   a. CREATE TYPE the six new enums.
--   b. CREATE TABLE the nine tables + PKs (five carry updatedAt NOT NULL; four
--      append-only are createdAt-only).
--   c. (id,institutionId) unique + (institutionId)/query indexes + business
--      uniques + the maintenance partial unique + the disposals partial unique.
--   d. tenant-root institutionId -> institutions(id) RESTRICT on all nine.
--   e. composite same-tenant FKs (each carries institutionId; MATCH SIMPLE for
--      nullable custody / optional audit-line refs).
--   f. CHECKs.
--   g. ENABLE+FORCE RLS (standard pair on the five mutable/guarded; append-only
--      {tenant_isolation_select, <table>_tenant_insert} pair on the four ledgers).
--   h. four append-only triggers + three column-guard functions + their triggers.
--   i. guarded + idempotent campass_app GRANT refresh (SELECT,INSERT,UPDATE on
--      the five; SELECT,INSERT + REVOKE UPDATE,DELETE on the four append-only).
--   j. catalogue seed: the INVENTORY_MANAGER role row (BEFORE the permissions
--      block) + the eight inventory.* permissions + the ADMIN/INVENTORY_MANAGER
--      role_permissions pairs.

-- ─────────────────────────────────────────────────────────────────────────────
-- a. Enums.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "InventoryAssetKind"          AS ENUM ('FIXED_ASSET', 'CONSUMABLE');
CREATE TYPE "InventoryAssetStatus"        AS ENUM ('IN_STORE', 'ASSIGNED', 'IN_MAINTENANCE', 'RETIRED', 'DISPOSED');
CREATE TYPE "InventoryMaintenanceStatus"  AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED');
CREATE TYPE "InventoryStockMovementKind"  AS ENUM ('RECEIPT', 'ISSUE', 'ADJUSTMENT');
CREATE TYPE "InventoryAuditSessionStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "InventoryDisposalMethod"     AS ENUM ('SOLD', 'SCRAPPED', 'DONATED', 'LOST', 'WRITTEN_OFF', 'OTHER');

-- ─────────────────────────────────────────────────────────────────────────────
-- b. New tenant-owned tables + PKs. Five mutable/guarded carry updatedAt NOT
--    NULL; four append-only are createdAt-only. Actor/provenance ids
--    (createdByUserId, actorUserId, reportedByUserId, assigneeUserId) are
--    recorded ids with NO FK (the transport/hostel precedent).
--    inventory_maintenance_requests DELIBERATELY has NO createdByUserId;
--    reportedByUserId is the creator actor.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "inventory_asset_categories" (
    "id"                 TEXT NOT NULL,
    "institutionId"      TEXT NOT NULL,
    "name"               TEXT NOT NULL,
    "code"               TEXT NOT NULL,
    "kind"               "InventoryAssetKind" NOT NULL,
    "depreciationMethod" TEXT,
    "usefulLifeMonths"   INTEGER,
    "createdByUserId"    TEXT NOT NULL,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_asset_categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_assets" (
    "id"                  TEXT NOT NULL,
    "institutionId"       TEXT NOT NULL,
    "assetTag"            TEXT NOT NULL,
    "name"                TEXT NOT NULL,
    "categoryId"          TEXT NOT NULL,
    "status"              "InventoryAssetStatus" NOT NULL DEFAULT 'IN_STORE',
    "acquisitionDate"     TIMESTAMP(3),
    "acquisitionCost"     INTEGER,
    "currency"            TEXT,
    "location"            TEXT,
    "custodyUserId"       TEXT,
    "custodyDepartmentId" TEXT,
    "createdByUserId"     TEXT NOT NULL,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_assets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_stock_items" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "assetId"         TEXT NOT NULL,
    "onHandQuantity"  INTEGER NOT NULL DEFAULT 0,
    "reorderLevel"    INTEGER,
    "createdByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_stock_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_maintenance_requests" (
    "id"               TEXT NOT NULL,
    "institutionId"    TEXT NOT NULL,
    "assetId"          TEXT NOT NULL,
    "issue"            TEXT NOT NULL,
    "status"           "InventoryMaintenanceStatus" NOT NULL DEFAULT 'OPEN',
    "assigneeUserId"   TEXT,
    "priorAssetStatus" "InventoryAssetStatus" NOT NULL,
    "cost"             INTEGER,
    "reportedByUserId" TEXT NOT NULL,
    "resolutionNote"   TEXT,
    "resolvedAt"       TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_maintenance_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_audit_sessions" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "status"          "InventoryAuditSessionStatus" NOT NULL DEFAULT 'OPEN',
    "startedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt"        TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_audit_sessions_pkey" PRIMARY KEY ("id")
);

-- append-only (createdAt-only, NO updatedAt)
CREATE TABLE "inventory_custody_transfers" (
    "id"               TEXT NOT NULL,
    "institutionId"    TEXT NOT NULL,
    "assetId"          TEXT NOT NULL,
    "fromUserId"       TEXT,
    "fromDepartmentId" TEXT,
    "toUserId"         TEXT,
    "toDepartmentId"   TEXT,
    "transferredAt"    TIMESTAMP(3) NOT NULL,
    "reason"           TEXT,
    "actorUserId"      TEXT NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_custody_transfers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_stock_movements" (
    "id"            TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "stockItemId"   TEXT NOT NULL,
    "assetId"       TEXT NOT NULL,
    "kind"          "InventoryStockMovementKind" NOT NULL,
    "quantity"      INTEGER NOT NULL,
    "reason"        TEXT,
    "balanceAfter"  INTEGER NOT NULL,
    "actorUserId"   TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_stock_movements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_audit_lines" (
    "id"               TEXT NOT NULL,
    "institutionId"    TEXT NOT NULL,
    "sessionId"        TEXT NOT NULL,
    "assetId"          TEXT,
    "stockItemId"      TEXT,
    "expectedQuantity" INTEGER,
    "foundQuantity"    INTEGER,
    "discrepancy"      INTEGER,
    "note"             TEXT,
    "actorUserId"      TEXT NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_audit_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_disposals" (
    "id"             TEXT NOT NULL,
    "institutionId"  TEXT NOT NULL,
    "assetId"        TEXT NOT NULL,
    "terminalStatus" "InventoryAssetStatus" NOT NULL,
    "method"         "InventoryDisposalMethod" NOT NULL,
    "disposedAt"     TIMESTAMP(3) NOT NULL,
    "proceeds"       INTEGER,
    "currency"       TEXT,
    "reason"         TEXT,
    "actorUserId"    TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_disposals_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- c. Unique + query indexes. (id, institutionId) anchors the composite
--    same-tenant FKs; (institutionId) + per-query indexes; the business uniques
--    (one code per institution on categories; one assetTag per institution; one
--    stock item per asset); the maintenance partial unique (one OPEN/IN_PROGRESS
--    request per asset — the transport one-ACTIVE precedent); the disposals
--    partial unique (one disposal per asset).
-- ─────────────────────────────────────────────────────────────────────────────
-- inventory_asset_categories
CREATE UNIQUE INDEX "inventory_asset_categories_id_institutionId_key" ON "inventory_asset_categories"("id", "institutionId");
CREATE UNIQUE INDEX "inventory_asset_categories_institutionId_code_key" ON "inventory_asset_categories"("institutionId", "code");
CREATE INDEX        "inventory_asset_categories_institutionId_idx" ON "inventory_asset_categories"("institutionId");

-- inventory_assets
CREATE UNIQUE INDEX "inventory_assets_id_institutionId_key" ON "inventory_assets"("id", "institutionId");
CREATE UNIQUE INDEX "inventory_assets_institutionId_assetTag_key" ON "inventory_assets"("institutionId", "assetTag");
CREATE INDEX        "inventory_assets_institutionId_idx" ON "inventory_assets"("institutionId");
CREATE INDEX        "inventory_assets_institutionId_status_idx" ON "inventory_assets"("institutionId", "status");
CREATE INDEX        "inventory_assets_institutionId_categoryId_idx" ON "inventory_assets"("institutionId", "categoryId");
CREATE INDEX        "inventory_assets_institutionId_custodyUserId_idx" ON "inventory_assets"("institutionId", "custodyUserId");

-- inventory_stock_items
CREATE UNIQUE INDEX "inventory_stock_items_id_institutionId_key" ON "inventory_stock_items"("id", "institutionId");
CREATE UNIQUE INDEX "inventory_stock_items_institutionId_assetId_key" ON "inventory_stock_items"("institutionId", "assetId");
CREATE INDEX        "inventory_stock_items_institutionId_idx" ON "inventory_stock_items"("institutionId");

-- inventory_maintenance_requests
CREATE UNIQUE INDEX "inventory_maintenance_requests_id_institutionId_key" ON "inventory_maintenance_requests"("id", "institutionId");
CREATE INDEX        "inventory_maintenance_requests_institutionId_idx" ON "inventory_maintenance_requests"("institutionId");
CREATE INDEX        "inventory_maintenance_requests_institutionId_assetId_idx" ON "inventory_maintenance_requests"("institutionId", "assetId");
CREATE INDEX        "inventory_maintenance_requests_institutionId_status_idx" ON "inventory_maintenance_requests"("institutionId", "status");
-- One OPEN/IN_PROGRESS maintenance request per asset (per tenant) — slot-shaped
-- partial unique backstop for the in-handler coupling (the transport one-ACTIVE
-- precedent).
CREATE UNIQUE INDEX "inventory_maintenance_requests_one_open_per_asset"
  ON "inventory_maintenance_requests"("institutionId", "assetId") WHERE "status" IN ('OPEN', 'IN_PROGRESS');

-- inventory_audit_sessions
CREATE UNIQUE INDEX "inventory_audit_sessions_id_institutionId_key" ON "inventory_audit_sessions"("id", "institutionId");
CREATE INDEX        "inventory_audit_sessions_institutionId_idx" ON "inventory_audit_sessions"("institutionId");

-- inventory_custody_transfers
CREATE UNIQUE INDEX "inventory_custody_transfers_id_institutionId_key" ON "inventory_custody_transfers"("id", "institutionId");
CREATE INDEX        "inventory_custody_transfers_institutionId_idx" ON "inventory_custody_transfers"("institutionId");
CREATE INDEX        "inventory_custody_transfers_institutionId_assetId_idx" ON "inventory_custody_transfers"("institutionId", "assetId");

-- inventory_stock_movements
CREATE UNIQUE INDEX "inventory_stock_movements_id_institutionId_key" ON "inventory_stock_movements"("id", "institutionId");
CREATE INDEX        "inventory_stock_movements_institutionId_idx" ON "inventory_stock_movements"("institutionId");
CREATE INDEX        "inventory_stock_movements_institutionId_stockItemId_idx" ON "inventory_stock_movements"("institutionId", "stockItemId");

-- inventory_audit_lines
CREATE UNIQUE INDEX "inventory_audit_lines_id_institutionId_key" ON "inventory_audit_lines"("id", "institutionId");
CREATE INDEX        "inventory_audit_lines_institutionId_idx" ON "inventory_audit_lines"("institutionId");
CREATE INDEX        "inventory_audit_lines_institutionId_sessionId_idx" ON "inventory_audit_lines"("institutionId", "sessionId");

-- inventory_disposals
CREATE UNIQUE INDEX "inventory_disposals_id_institutionId_key" ON "inventory_disposals"("id", "institutionId");
CREATE INDEX        "inventory_disposals_institutionId_idx" ON "inventory_disposals"("institutionId");
CREATE INDEX        "inventory_disposals_institutionId_assetId_idx" ON "inventory_disposals"("institutionId", "assetId");
-- One disposal record per asset (per tenant) — a terminal asset is disposed
-- exactly once; backstops the in-handler terminal check.
CREATE UNIQUE INDEX "inventory_disposals_one_per_asset"
  ON "inventory_disposals"("institutionId", "assetId");

-- ─────────────────────────────────────────────────────────────────────────────
-- d. Tenant-root FKs.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "inventory_asset_categories"     ADD CONSTRAINT "inventory_asset_categories_institutionId_fkey"     FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_assets"               ADD CONSTRAINT "inventory_assets_institutionId_fkey"               FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_stock_items"          ADD CONSTRAINT "inventory_stock_items_institutionId_fkey"          FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_maintenance_requests" ADD CONSTRAINT "inventory_maintenance_requests_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_audit_sessions"       ADD CONSTRAINT "inventory_audit_sessions_institutionId_fkey"       FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_custody_transfers"    ADD CONSTRAINT "inventory_custody_transfers_institutionId_fkey"    FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_stock_movements"      ADD CONSTRAINT "inventory_stock_movements_institutionId_fkey"      FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_audit_lines"          ADD CONSTRAINT "inventory_audit_lines_institutionId_fkey"          FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_disposals"            ADD CONSTRAINT "inventory_disposals_institutionId_fkey"            FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- e. Composite same-tenant FKs (each carries institutionId so a child can never
--    reference a parent in another tenant). All ON DELETE RESTRICT ON UPDATE
--    CASCADE. inventory_assets->users/departments custody use MATCH SIMPLE so a
--    NULL custody column is a no-op (the transport schedule->stop NULL
--    precedent); inventory_audit_lines->asset/stock optional refs likewise.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "inventory_assets"
  ADD CONSTRAINT "inventory_assets_category_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "categoryId") REFERENCES "inventory_asset_categories"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_assets"
  ADD CONSTRAINT "inventory_assets_custody_user_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "custodyUserId") REFERENCES "users"("institutionId", "id") MATCH SIMPLE
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_assets"
  ADD CONSTRAINT "inventory_assets_custody_department_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "custodyDepartmentId") REFERENCES "departments"("institutionId", "id") MATCH SIMPLE
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_stock_items"
  ADD CONSTRAINT "inventory_stock_items_asset_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "assetId") REFERENCES "inventory_assets"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_maintenance_requests"
  ADD CONSTRAINT "inventory_maintenance_requests_asset_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "assetId") REFERENCES "inventory_assets"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_custody_transfers"
  ADD CONSTRAINT "inventory_custody_transfers_asset_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "assetId") REFERENCES "inventory_assets"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_stock_movements"
  ADD CONSTRAINT "inventory_stock_movements_stock_item_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "stockItemId") REFERENCES "inventory_stock_items"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_stock_movements"
  ADD CONSTRAINT "inventory_stock_movements_asset_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "assetId") REFERENCES "inventory_assets"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_audit_lines"
  ADD CONSTRAINT "inventory_audit_lines_session_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "sessionId") REFERENCES "inventory_audit_sessions"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_audit_lines"
  ADD CONSTRAINT "inventory_audit_lines_asset_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "assetId") REFERENCES "inventory_assets"("institutionId", "id") MATCH SIMPLE
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_audit_lines"
  ADD CONSTRAINT "inventory_audit_lines_stock_item_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "stockItemId") REFERENCES "inventory_stock_items"("institutionId", "id") MATCH SIMPLE
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_disposals"
  ADD CONSTRAINT "inventory_disposals_asset_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "assetId") REFERENCES "inventory_assets"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- f. CHECKs. Non-empty strings; non-negative money/quantities; onHandQuantity
--    >= 0; movement quantity <> 0 + balanceAfter >= 0; transfer >=1 to*;
--    audit-line exactly-one-of asset/stock; priorAssetStatus IN
--    ('IN_STORE','ASSIGNED'); disposals terminalStatus IN ('RETIRED','DISPOSED')
--    + proceeds >= 0; currency 3-char on assets and disposals.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "inventory_asset_categories"
  ADD CONSTRAINT "inventory_asset_categories_name_nonempty_check" CHECK (char_length("name") >= 1);
ALTER TABLE "inventory_asset_categories"
  ADD CONSTRAINT "inventory_asset_categories_code_nonempty_check" CHECK (char_length("code") >= 1);
ALTER TABLE "inventory_asset_categories"
  ADD CONSTRAINT "inventory_asset_categories_usefulLifeMonths_nonnegative_check" CHECK ("usefulLifeMonths" IS NULL OR "usefulLifeMonths" >= 0);

ALTER TABLE "inventory_assets"
  ADD CONSTRAINT "inventory_assets_assetTag_nonempty_check" CHECK (char_length("assetTag") >= 1);
ALTER TABLE "inventory_assets"
  ADD CONSTRAINT "inventory_assets_name_nonempty_check" CHECK (char_length("name") >= 1);
ALTER TABLE "inventory_assets"
  ADD CONSTRAINT "inventory_assets_acquisitionCost_nonnegative_check" CHECK ("acquisitionCost" IS NULL OR "acquisitionCost" >= 0);
ALTER TABLE "inventory_assets"
  ADD CONSTRAINT "inventory_assets_currency_shape_check" CHECK ("currency" IS NULL OR char_length("currency") = 3);

ALTER TABLE "inventory_stock_items"
  ADD CONSTRAINT "inventory_stock_items_onHandQuantity_nonnegative_check" CHECK ("onHandQuantity" >= 0);
ALTER TABLE "inventory_stock_items"
  ADD CONSTRAINT "inventory_stock_items_reorderLevel_nonnegative_check" CHECK ("reorderLevel" IS NULL OR "reorderLevel" >= 0);

ALTER TABLE "inventory_maintenance_requests"
  ADD CONSTRAINT "inventory_maintenance_requests_issue_nonempty_check" CHECK (char_length("issue") >= 1);
ALTER TABLE "inventory_maintenance_requests"
  ADD CONSTRAINT "inventory_maintenance_requests_cost_nonnegative_check" CHECK ("cost" IS NULL OR "cost" >= 0);
ALTER TABLE "inventory_maintenance_requests"
  ADD CONSTRAINT "inventory_maintenance_requests_priorAssetStatus_check" CHECK ("priorAssetStatus" IN ('IN_STORE', 'ASSIGNED'));

ALTER TABLE "inventory_audit_sessions"
  ADD CONSTRAINT "inventory_audit_sessions_name_nonempty_check" CHECK (char_length("name") >= 1);

ALTER TABLE "inventory_custody_transfers"
  ADD CONSTRAINT "inventory_custody_transfers_to_present_check"
  CHECK ((("toUserId" IS NOT NULL)::int + ("toDepartmentId" IS NOT NULL)::int) >= 1);

ALTER TABLE "inventory_stock_movements"
  ADD CONSTRAINT "inventory_stock_movements_quantity_nonzero_check" CHECK ("quantity" <> 0);
ALTER TABLE "inventory_stock_movements"
  ADD CONSTRAINT "inventory_stock_movements_balanceAfter_nonnegative_check" CHECK ("balanceAfter" >= 0);

ALTER TABLE "inventory_audit_lines"
  ADD CONSTRAINT "inventory_audit_lines_one_of_target_check"
  CHECK ((("assetId" IS NOT NULL)::int + ("stockItemId" IS NOT NULL)::int) = 1);

ALTER TABLE "inventory_disposals"
  ADD CONSTRAINT "inventory_disposals_terminalStatus_check" CHECK ("terminalStatus" IN ('RETIRED', 'DISPOSED'));
ALTER TABLE "inventory_disposals"
  ADD CONSTRAINT "inventory_disposals_proceeds_nonnegative_check" CHECK ("proceeds" IS NULL OR "proceeds" >= 0);
ALTER TABLE "inventory_disposals"
  ADD CONSTRAINT "inventory_disposals_currency_shape_check" CHECK ("currency" IS NULL OR char_length("currency") = 3);

-- ─────────────────────────────────────────────────────────────────────────────
-- g. RLS. ENABLE + FORCE on all nine. The five mutable/guarded get the standard
--    fail-closed nullif-guarded pair {tenant_isolation_select,
--    tenant_isolation_modify}. The four append-only ledgers get the append-only
--    pair {tenant_isolation_select, <table>_tenant_insert} (NO modify policy).
--    nullif(current_setting('app.current_institution_id', true), '') fails closed
--    for both an unset and an empty-string GUC.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  mutable_tables TEXT[] := ARRAY[
    'inventory_asset_categories', 'inventory_assets', 'inventory_stock_items',
    'inventory_maintenance_requests', 'inventory_audit_sessions'
  ];
  append_only_tables TEXT[] := ARRAY[
    'inventory_custody_transfers', 'inventory_stock_movements',
    'inventory_audit_lines', 'inventory_disposals'
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
--   h.1 The four append-only tables mirror the fees-slice2 shape: a
--       <table>_append_only() plpgsql function raising restrict_violation, bound
--       by a BEFORE UPDATE OR DELETE ... FOR EACH ROW trigger (binds the owner
--       too — GRANTs alone cannot restrict the owner).
--   h.2 inventory_assets enumerated-transition terminal-enforcing column guard.
--   h.3 inventory_maintenance_requests linear forward-only column guard.
--   h.4 inventory_audit_sessions two-state forward-only column guard.
-- ─────────────────────────────────────────────────────────────────────────────

-- h.1 inventory_custody_transfers
CREATE OR REPLACE FUNCTION "inventory_custody_transfers_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory_custody_transfers is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;$$;
CREATE TRIGGER "inventory_custody_transfers_no_update_delete"
  BEFORE UPDATE OR DELETE ON "inventory_custody_transfers"
  FOR EACH ROW EXECUTE FUNCTION "inventory_custody_transfers_append_only"();

-- h.1 inventory_stock_movements
CREATE OR REPLACE FUNCTION "inventory_stock_movements_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory_stock_movements is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;$$;
CREATE TRIGGER "inventory_stock_movements_no_update_delete"
  BEFORE UPDATE OR DELETE ON "inventory_stock_movements"
  FOR EACH ROW EXECUTE FUNCTION "inventory_stock_movements_append_only"();

-- h.1 inventory_audit_lines
CREATE OR REPLACE FUNCTION "inventory_audit_lines_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory_audit_lines is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;$$;
CREATE TRIGGER "inventory_audit_lines_no_update_delete"
  BEFORE UPDATE OR DELETE ON "inventory_audit_lines"
  FOR EACH ROW EXECUTE FUNCTION "inventory_audit_lines_append_only"();

-- h.1 inventory_disposals
CREATE OR REPLACE FUNCTION "inventory_disposals_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory_disposals is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;$$;
CREATE TRIGGER "inventory_disposals_no_update_delete"
  BEFORE UPDATE OR DELETE ON "inventory_disposals"
  FOR EACH ROW EXECUTE FUNCTION "inventory_disposals_append_only"();

-- h.2 inventory_assets enumerated-transition terminal-enforcing column guard.
--     Legal edges (plus the no-op self transition): IN_STORE<->ASSIGNED,
--     IN_STORE/ASSIGNED<->IN_MAINTENANCE, {IN_STORE,ASSIGNED,IN_MAINTENANCE}->
--     RETIRED|DISPOSED. RETIRED and DISPOSED are TERMINAL (no legal source edge
--     out of them). Freezes identity cols via IS DISTINCT FROM; forbids DELETE.
--     (The transport/hostel guard shape.)
CREATE OR REPLACE FUNCTION "inventory_assets_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory_assets is guarded: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- frozen identity columns.
  IF NEW."institutionId"   IS DISTINCT FROM OLD."institutionId"
  OR NEW."assetTag"        IS DISTINCT FROM OLD."assetTag"
  OR NEW."categoryId"      IS DISTINCT FROM OLD."categoryId"
  OR NEW."acquisitionDate" IS DISTINCT FROM OLD."acquisitionDate"
  OR NEW."acquisitionCost" IS DISTINCT FROM OLD."acquisitionCost"
  OR NEW."currency"        IS DISTINCT FROM OLD."currency"
  OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
  OR NEW."createdAt"       IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'immutable inventory_assets column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- Enumerated legal transitions (plus the no-op self transition). RETIRED and
  -- DISPOSED are terminal because they are not legal source states below.
  IF NOT (
       (OLD."status" = 'IN_STORE'       AND NEW."status" = 'ASSIGNED')
    OR (OLD."status" = 'IN_STORE'       AND NEW."status" = 'IN_MAINTENANCE')
    OR (OLD."status" = 'IN_STORE'       AND NEW."status" = 'RETIRED')
    OR (OLD."status" = 'IN_STORE'       AND NEW."status" = 'DISPOSED')
    OR (OLD."status" = 'ASSIGNED'       AND NEW."status" = 'IN_STORE')
    OR (OLD."status" = 'ASSIGNED'       AND NEW."status" = 'IN_MAINTENANCE')
    OR (OLD."status" = 'ASSIGNED'       AND NEW."status" = 'RETIRED')
    OR (OLD."status" = 'ASSIGNED'       AND NEW."status" = 'DISPOSED')
    OR (OLD."status" = 'IN_MAINTENANCE' AND NEW."status" = 'IN_STORE')
    OR (OLD."status" = 'IN_MAINTENANCE' AND NEW."status" = 'ASSIGNED')
    OR (OLD."status" = 'IN_MAINTENANCE' AND NEW."status" = 'RETIRED')
    OR (OLD."status" = 'IN_MAINTENANCE' AND NEW."status" = 'DISPOSED')
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal inventory_assets status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "inventory_assets_guard"
  BEFORE UPDATE OR DELETE ON "inventory_assets"
  FOR EACH ROW EXECUTE FUNCTION "inventory_assets_guard"();

-- h.3 inventory_maintenance_requests linear forward-only column guard
--     (OPEN->IN_PROGRESS->RESOLVED, OPEN|IN_PROGRESS->CANCELLED; terminal frozen;
--     priorAssetStatus frozen; DELETE forbidden). Identical in shape to the
--     transport maintenance guard.
CREATE OR REPLACE FUNCTION "inventory_maintenance_requests_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory_maintenance_requests is forward-only: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."institutionId"    IS DISTINCT FROM OLD."institutionId"
  OR NEW."assetId"          IS DISTINCT FROM OLD."assetId"
  OR NEW."priorAssetStatus" IS DISTINCT FROM OLD."priorAssetStatus"
  OR NEW."reportedByUserId" IS DISTINCT FROM OLD."reportedByUserId"
  OR NEW."createdAt"        IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'immutable inventory_maintenance_requests column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (
       (OLD."status" = 'OPEN'        AND NEW."status" = 'IN_PROGRESS')
    OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" = 'RESOLVED')
    OR (OLD."status" = 'OPEN'        AND NEW."status" = 'CANCELLED')
    OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" = 'CANCELLED')
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal inventory_maintenance_requests status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "inventory_maintenance_requests_guard"
  BEFORE UPDATE OR DELETE ON "inventory_maintenance_requests"
  FOR EACH ROW EXECUTE FUNCTION "inventory_maintenance_requests_guard"();

-- h.4 inventory_audit_sessions two-state forward-only column guard (OPEN->CLOSED;
--     terminal frozen; DELETE forbidden). INTENTIONAL hardening beyond the brief
--     (a sealed stock-take is immutable; design §B.1/A.5).
CREATE OR REPLACE FUNCTION "inventory_audit_sessions_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory_audit_sessions is forward-only: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."institutionId"   IS DISTINCT FROM OLD."institutionId"
  OR NEW."startedAt"       IS DISTINCT FROM OLD."startedAt"
  OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
  OR NEW."createdAt"       IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'immutable inventory_audit_sessions column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (
       (OLD."status" = 'OPEN' AND NEW."status" = 'CLOSED')
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal inventory_audit_sessions status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "inventory_audit_sessions_guard"
  BEFORE UPDATE OR DELETE ON "inventory_audit_sessions"
  FOR EACH ROW EXECUTE FUNCTION "inventory_audit_sessions_guard"();

-- ─────────────────────────────────────────────────────────────────────────────
-- i. campass_app GRANT refresh (guarded + idempotent). The five mutable/guarded
--    tables get SELECT, INSERT, UPDATE (NO DELETE — the DB guards forbid DELETE
--    anyway, and no route hard-deletes an inventory row). The four append-only
--    ledgers get SELECT, INSERT and an explicit REVOKE UPDATE, DELETE (the
--    fees-slice2 append-only precedent). Never grant BYPASSRLS.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "inventory_asset_categories"     TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "inventory_assets"               TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "inventory_stock_items"          TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "inventory_maintenance_requests" TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "inventory_audit_sessions"       TO "campass_app";

    GRANT SELECT, INSERT ON "inventory_custody_transfers" TO "campass_app";
    GRANT SELECT, INSERT ON "inventory_stock_movements"   TO "campass_app";
    GRANT SELECT, INSERT ON "inventory_audit_lines"       TO "campass_app";
    GRANT SELECT, INSERT ON "inventory_disposals"         TO "campass_app";
    REVOKE UPDATE, DELETE ON "inventory_custody_transfers" FROM "campass_app";
    REVOKE UPDATE, DELETE ON "inventory_stock_movements"   FROM "campass_app";
    REVOKE UPDATE, DELETE ON "inventory_audit_lines"       FROM "campass_app";
    REVOKE UPDATE, DELETE ON "inventory_disposals"         FROM "campass_app";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- j. Catalogue seed. The INVENTORY_MANAGER template role row (institutionId =
--    NULL) is NEW (the TRANSPORT_MANAGER / WARDEN / HR_MANAGER precedent), so it
--    IS inserted here, BEFORE the permissions block (so its `, NULL)` tuple falls
--    outside the sliced permission span the catalogue-sync parser reads). Then
--    the eight inventory.* permissions (each "module" = 'inventory', matching
--    permissions.ts), then the role_permissions pairs. ROLE_PERMISSIONS lockstep:
--    ADMIN x7 staff keys (NOT view_own), INVENTORY_MANAGER x8 (the 7 staff keys
--    PLUS inventory.view_own so /me/assets is reachable). Separation of duties:
--    STUDENT gets no inventory key; ADMIN does not get the module-gated view_own.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "roles" ("id","key","name","institutionId") VALUES
  ('role_inventory_manager', 'INVENTORY_MANAGER', 'Inventory Manager', NULL)
ON CONFLICT DO NOTHING;

INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_inventory_categories_manage',  'inventory.categories.manage',  'inventory', 'Create/update asset categories'),
  ('perm_inventory_assets_manage',      'inventory.assets.manage',      'inventory', 'Create/update assets + custody transfer/assign'),
  ('perm_inventory_stock_manage',       'inventory.stock.manage',       'inventory', 'Record stock receipts/issues/adjustments'),
  ('perm_inventory_maintenance_manage', 'inventory.maintenance.manage', 'inventory', 'Open/advance/resolve asset maintenance requests'),
  ('perm_inventory_disposals_manage',   'inventory.disposals.manage',   'inventory', 'Dispose/retire assets'),
  ('perm_inventory_audits_manage',      'inventory.audits.manage',      'inventory', 'Create stock-take audit sessions + append audit lines'),
  ('perm_inventory_view',               'inventory.view',               'inventory', 'Staff read of categories/assets/stock/maintenance/disposals/audits + reports/export'),
  ('perm_inventory_view_own',           'inventory.view_own',           'inventory', 'Custodian self-service: assets currently in MY custody')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('ADMIN',             'inventory.categories.manage'),
  ('ADMIN',             'inventory.assets.manage'),
  ('ADMIN',             'inventory.stock.manage'),
  ('ADMIN',             'inventory.maintenance.manage'),
  ('ADMIN',             'inventory.disposals.manage'),
  ('ADMIN',             'inventory.audits.manage'),
  ('ADMIN',             'inventory.view'),
  ('INVENTORY_MANAGER', 'inventory.categories.manage'),
  ('INVENTORY_MANAGER', 'inventory.assets.manage'),
  ('INVENTORY_MANAGER', 'inventory.stock.manage'),
  ('INVENTORY_MANAGER', 'inventory.maintenance.manage'),
  ('INVENTORY_MANAGER', 'inventory.disposals.manage'),
  ('INVENTORY_MANAGER', 'inventory.audits.manage'),
  ('INVENTORY_MANAGER', 'inventory.view'),
  ('INVENTORY_MANAGER', 'inventory.view_own')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
