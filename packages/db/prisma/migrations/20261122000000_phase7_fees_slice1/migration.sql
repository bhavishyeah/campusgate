-- CAMPASS Phase 7 — Fees & Payments, SLICE 1: the DB foundation.
--
-- Hand-authored (Prisma's diff does not model RLS, the composite same-tenant
-- FKs, the partial unique index, the global unique, the CHECK constraints, the
-- append-only triggers, the targeted GRANT refresh, or the catalogue seed).
-- This migration only CREATEs new objects; it NEVER ALTERs a frozen table's
-- RLS, grant, or FK, and NEVER touches the _prisma_migrations ledger.
-- campass_app stays NOSUPERUSER NOBYPASSRLS — never granted BYPASSRLS.
--
-- It NEVER alters any of the TWELVE FROZEN migrations
-- (20260824143031_add_allowance_and_reliability_models, 20261018100917_init,
-- 20261018110658_tenancy_isolation_rls, 20261018171747_identity_rbac_b2,
-- 20261019053533_superadmin_security, 20261019093119_module_system,
-- 20261027111710_phase1_academics, 20261027161616_phase2_sis,
-- 20261028000000_phase3_classes, 20261101000000_phase4_attendance,
-- 20261108000000_phase5_library, 20261115000000_phase6_admissions).
--
-- SEVEN new tenant-owned tables = FOUR standard-RLS-pair tables with a column
-- guard where needed (fee_structures, fee_components [mutable]; student_charges,
-- payment_transactions [snapshot/fact with a column-guard trigger]) + THREE
-- fully INSERT-only append-only tables (payment_allocations, receipts,
-- processed_webhook_events). Every table carries institutionId +
-- (id, institutionId) composite unique + (institutionId) index + composite
-- same-tenant FKs incl. institutionId + ENABLE+FORCE RLS.
--
-- Money is INTEGER PAISE (BIGINT); currency is a stored non-null 'INR'
-- (CHECK currency = 'INR'); no money column is a float/decimal.
--
-- Ordering (design §D.15, mirrors phase6_admissions sections a–j):
--   a. CREATE TYPE the four new enums;
--   b. CREATE TABLE the seven new tables + PKs (createdAt DEFAULT
--      CURRENT_TIMESTAMP; updatedAt NOT NULL on the four mutable/snapshot tables;
--      the three INSERT-only tables have no updatedAt);
--   c. (id,institutionId) uniques + business uniques + (institutionId)/query
--      indexes + the raw-SQL partial unique payment_transactions_payment_id_unique
--      + the global unique on processed_webhook_events(razorpayEventId);
--   d. tenant-root institutionId -> institutions(id) RESTRICT on all seven;
--   e. composite same-tenant FKs incl. institutionId;
--   f. CHECKs (amountPaise > 0, currency = 'INR', non-empty name/description,
--      sequence > 0);
--   g. ENABLE+FORCE RLS (standard select+modify pair on fee_structures/
--      fee_components/student_charges/payment_transactions; append-only SELECT +
--      <table>_tenant_insert INSERT-only pair on payment_allocations/receipts/
--      processed_webhook_events), all nullif-guarded fail-closed;
--   h. append-only triggers: unconditional-raise <table>_append_only() + BEFORE
--      UPDATE OR DELETE trigger x3 on the INSERT-only tables; plus the TWO
--      column-guard functions payment_transactions_guard() + student_charges_guard()
--      (copied verbatim from design §D.3) with BEFORE UPDATE OR DELETE triggers;
--   i. guarded campass_app GRANT refresh (full DML on the four mutable/snapshot
--      tables; SELECT,INSERT + REVOKE UPDATE,DELETE on the three append-only
--      tables);
--   j. catalogue seed: the ACCOUNTANT role row, the seven fees.* permissions,
--      and the role_permissions pairs.

-- ─────────────────────────────────────────────────────────────────────────────
-- a. Enums.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "FeeStructureStatus"       AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "FeeComponentCategory"     AS ENUM ('TUITION', 'LIBRARY', 'LAB', 'EXAM', 'OTHER');
CREATE TYPE "StudentChargeStatus"      AS ENUM ('PENDING', 'PARTIALLY_PAID', 'PAID');
CREATE TYPE "PaymentTransactionStatus" AS ENUM ('CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED');

-- ─────────────────────────────────────────────────────────────────────────────
-- b. New tenant-owned tables + PKs. createdAt DEFAULT CURRENT_TIMESTAMP;
--    updatedAt NOT NULL on fee_structures/fee_components/student_charges/
--    payment_transactions; payment_allocations/receipts/processed_webhook_events
--    have no updatedAt (INSERT-only). Money columns are BIGINT; currency is a
--    stored non-null text defaulting to 'INR'.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "fee_structures" (
    "id"                TEXT NOT NULL,
    "institutionId"     TEXT NOT NULL,
    "name"              TEXT NOT NULL,
    "status"            "FeeStructureStatus" NOT NULL DEFAULT 'DRAFT',
    "programId"         TEXT,
    "academicSessionId" TEXT,
    "description"       TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_structures_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "fee_components" (
    "id"                TEXT NOT NULL,
    "institutionId"     TEXT NOT NULL,
    "feeStructureId"    TEXT NOT NULL,
    "category"          "FeeComponentCategory" NOT NULL,
    "amountPaise"       BIGINT NOT NULL,
    "currency"          TEXT NOT NULL DEFAULT 'INR',
    "dueDate"           TIMESTAMP(3),
    "installmentLabel"  TEXT,
    "installmentNumber" INTEGER,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_components_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "student_charges" (
    "id"             TEXT NOT NULL,
    "institutionId"  TEXT NOT NULL,
    "studentId"      TEXT NOT NULL,
    "feeStructureId" TEXT,
    "feeComponentId" TEXT,
    "category"       "FeeComponentCategory" NOT NULL,
    "amountPaise"    BIGINT NOT NULL,
    "currency"       TEXT NOT NULL DEFAULT 'INR',
    "dueDate"        TIMESTAMP(3),
    "description"    TEXT NOT NULL,
    "status"         "StudentChargeStatus" NOT NULL DEFAULT 'PENDING',
    "postedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedByUserId" TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_charges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_transactions" (
    "id"                TEXT NOT NULL,
    "institutionId"     TEXT NOT NULL,
    "studentId"         TEXT NOT NULL,
    "amountPaise"       BIGINT NOT NULL,
    "currency"          TEXT NOT NULL DEFAULT 'INR',
    "status"            "PaymentTransactionStatus" NOT NULL DEFAULT 'CREATED',
    "razorpayOrderId"   TEXT NOT NULL,
    "razorpayPaymentId" TEXT,
    "razorpaySignature" TEXT,
    "targetChargeIds"   TEXT[] NOT NULL,
    "initiatedByUserId" TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedAt"        TIMESTAMP(3),
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_allocations" (
    "id"                   TEXT NOT NULL,
    "institutionId"        TEXT NOT NULL,
    "paymentTransactionId" TEXT NOT NULL,
    "studentChargeId"      TEXT NOT NULL,
    "amountPaise"          BIGINT NOT NULL,
    "currency"             TEXT NOT NULL DEFAULT 'INR',
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "receipts" (
    "id"                   TEXT NOT NULL,
    "institutionId"        TEXT NOT NULL,
    "paymentTransactionId" TEXT NOT NULL,
    "receiptNumber"        TEXT NOT NULL,
    "sequence"             INTEGER NOT NULL,
    "amountPaise"          BIGINT NOT NULL,
    "currency"             TEXT NOT NULL DEFAULT 'INR',
    "issuedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "processed_webhook_events" (
    "id"                   TEXT NOT NULL,
    "institutionId"        TEXT NOT NULL,
    "razorpayEventId"      TEXT NOT NULL,
    "eventType"            TEXT NOT NULL,
    "processedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentTransactionId" TEXT,
    "payloadDigest"        TEXT,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_webhook_events_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- c. Unique + query indexes. Each table's (id, institutionId) composite unique
--    (anchors the composite same-tenant FKs); the business uniques; every
--    (institutionId) index + the query indexes; the raw-SQL partial unique on
--    payment_transactions (Prisma cannot express partial indexes); the global
--    unique on processed_webhook_events(razorpayEventId) (the hard idempotency
--    key, §D.7).
-- ─────────────────────────────────────────────────────────────────────────────
-- fee_structures
CREATE UNIQUE INDEX "fee_structures_id_institutionId_key"   ON "fee_structures"("id", "institutionId");
CREATE UNIQUE INDEX "fee_structures_institutionId_name_key" ON "fee_structures"("institutionId", "name");
CREATE INDEX        "fee_structures_institutionId_idx"      ON "fee_structures"("institutionId");

-- fee_components
CREATE UNIQUE INDEX "fee_components_id_institutionId_key"                ON "fee_components"("id", "institutionId");
CREATE INDEX        "fee_components_institutionId_idx"                   ON "fee_components"("institutionId");
CREATE INDEX        "fee_components_institutionId_feeStructureId_idx"    ON "fee_components"("institutionId", "feeStructureId");

-- student_charges
CREATE UNIQUE INDEX "student_charges_id_institutionId_key"               ON "student_charges"("id", "institutionId");
CREATE INDEX        "student_charges_institutionId_idx"                  ON "student_charges"("institutionId");
CREATE INDEX        "student_charges_institutionId_studentId_idx"        ON "student_charges"("institutionId", "studentId");
CREATE INDEX        "student_charges_institutionId_studentId_status_idx" ON "student_charges"("institutionId", "studentId", "status");
CREATE INDEX        "student_charges_institutionId_status_idx"           ON "student_charges"("institutionId", "status");

-- payment_transactions
CREATE UNIQUE INDEX "payment_transactions_id_institutionId_key"                ON "payment_transactions"("id", "institutionId");
CREATE UNIQUE INDEX "payment_transactions_institutionId_razorpayOrderId_key"   ON "payment_transactions"("institutionId", "razorpayOrderId");
CREATE INDEX        "payment_transactions_institutionId_idx"                   ON "payment_transactions"("institutionId");
CREATE INDEX        "payment_transactions_institutionId_status_idx"            ON "payment_transactions"("institutionId", "status");
CREATE INDEX        "payment_transactions_institutionId_status_createdAt_idx"  ON "payment_transactions"("institutionId", "status", "createdAt");
CREATE INDEX        "payment_transactions_institutionId_studentId_idx"         ON "payment_transactions"("institutionId", "studentId");
-- At most one transaction per captured payment id (§D.7 guard 2) — Prisma cannot express a partial unique.
CREATE UNIQUE INDEX "payment_transactions_payment_id_unique" ON "payment_transactions"("institutionId", "razorpayPaymentId") WHERE "razorpayPaymentId" IS NOT NULL;

-- payment_allocations
CREATE UNIQUE INDEX "payment_allocations_id_institutionId_key"                    ON "payment_allocations"("id", "institutionId");
CREATE INDEX        "payment_allocations_institutionId_idx"                       ON "payment_allocations"("institutionId");
CREATE INDEX        "payment_allocations_institutionId_paymentTransactionId_idx"  ON "payment_allocations"("institutionId", "paymentTransactionId");
CREATE INDEX        "payment_allocations_institutionId_studentChargeId_idx"       ON "payment_allocations"("institutionId", "studentChargeId");

-- receipts
CREATE UNIQUE INDEX "receipts_id_institutionId_key"                       ON "receipts"("id", "institutionId");
CREATE UNIQUE INDEX "receipts_institutionId_receiptNumber_key"            ON "receipts"("institutionId", "receiptNumber");
CREATE UNIQUE INDEX "receipts_institutionId_sequence_key"                 ON "receipts"("institutionId", "sequence");
CREATE UNIQUE INDEX "receipts_institutionId_paymentTransactionId_key"     ON "receipts"("institutionId", "paymentTransactionId");
CREATE INDEX        "receipts_institutionId_idx"                          ON "receipts"("institutionId");

-- processed_webhook_events
CREATE UNIQUE INDEX "processed_webhook_events_id_institutionId_key"                   ON "processed_webhook_events"("id", "institutionId");
-- GLOBAL idempotency key (§D.7 guard 1): Razorpay event ids are globally unique.
CREATE UNIQUE INDEX "processed_webhook_events_razorpayEventId_key"                    ON "processed_webhook_events"("razorpayEventId");
CREATE UNIQUE INDEX "processed_webhook_events_institutionId_razorpayEventId_key"      ON "processed_webhook_events"("institutionId", "razorpayEventId");
CREATE INDEX        "processed_webhook_events_institutionId_idx"                      ON "processed_webhook_events"("institutionId");
CREATE INDEX        "processed_webhook_events_institutionId_paymentTransactionId_idx" ON "processed_webhook_events"("institutionId", "paymentTransactionId");

-- ─────────────────────────────────────────────────────────────────────────────
-- d. Tenant-root FKs: institutionId -> institutions(id) ON DELETE RESTRICT on
--    all seven new tables.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "fee_structures"           ADD CONSTRAINT "fee_structures_institutionId_fkey"           FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fee_components"           ADD CONSTRAINT "fee_components_institutionId_fkey"           FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "student_charges"          ADD CONSTRAINT "student_charges_institutionId_fkey"          FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_transactions"     ADD CONSTRAINT "payment_transactions_institutionId_fkey"     FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_allocations"      ADD CONSTRAINT "payment_allocations_institutionId_fkey"      FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receipts"                 ADD CONSTRAINT "receipts_institutionId_fkey"                 FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "processed_webhook_events" ADD CONSTRAINT "processed_webhook_events_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- e. Composite same-tenant FKs (tenancy.md §4, design §D.2). Each carries
--    institutionId so a child can never reference a parent in another tenant.
--    postedByUserId / initiatedByUserId are recorded actor ids with NO FK;
--    targetChargeIds is an authoritative NON-FK array (§D.2 NIT-1).
-- ─────────────────────────────────────────────────────────────────────────────
-- fee_structures -> programs (nullable) / academic_sessions (nullable)
ALTER TABLE "fee_structures"
  ADD CONSTRAINT "fee_structures_program_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "programId") REFERENCES "programs"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fee_structures"
  ADD CONSTRAINT "fee_structures_session_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicSessionId") REFERENCES "academic_sessions"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- fee_components -> fee_structures
ALTER TABLE "fee_components"
  ADD CONSTRAINT "fee_components_structure_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "feeStructureId") REFERENCES "fee_structures"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- student_charges -> student_profiles (shared identity) / fee_structures (nullable) / fee_components (nullable)
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_structure_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "feeStructureId") REFERENCES "fee_structures"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_component_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "feeComponentId") REFERENCES "fee_components"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- payment_transactions -> student_profiles
ALTER TABLE "payment_transactions"
  ADD CONSTRAINT "payment_transactions_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- payment_allocations -> payment_transactions / student_charges
ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "payment_allocations_transaction_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "paymentTransactionId") REFERENCES "payment_transactions"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "payment_allocations_charge_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentChargeId") REFERENCES "student_charges"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- receipts -> payment_transactions
ALTER TABLE "receipts"
  ADD CONSTRAINT "receipts_transaction_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "paymentTransactionId") REFERENCES "payment_transactions"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- processed_webhook_events -> payment_transactions (nullable)
ALTER TABLE "processed_webhook_events"
  ADD CONSTRAINT "processed_webhook_events_transaction_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "paymentTransactionId") REFERENCES "payment_transactions"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- f. CHECK constraints (design §D.1/§D.2): money strictly positive, currency
--    locked to 'INR', non-empty structure name + charge description, receipt
--    sequence strictly positive.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "fee_structures"
  ADD CONSTRAINT "fee_structures_name_nonempty_check" CHECK (char_length("name") >= 1);

ALTER TABLE "fee_components"
  ADD CONSTRAINT "fee_components_amount_positive_check" CHECK ("amountPaise" > 0);
ALTER TABLE "fee_components"
  ADD CONSTRAINT "fee_components_currency_inr_check" CHECK ("currency" = 'INR');

ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_amount_positive_check" CHECK ("amountPaise" > 0);
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_currency_inr_check" CHECK ("currency" = 'INR');
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_description_nonempty_check" CHECK (char_length("description") >= 1);

ALTER TABLE "payment_transactions"
  ADD CONSTRAINT "payment_transactions_amount_positive_check" CHECK ("amountPaise" > 0);
ALTER TABLE "payment_transactions"
  ADD CONSTRAINT "payment_transactions_currency_inr_check" CHECK ("currency" = 'INR');

ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "payment_allocations_amount_positive_check" CHECK ("amountPaise" > 0);
ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "payment_allocations_currency_inr_check" CHECK ("currency" = 'INR');

ALTER TABLE "receipts"
  ADD CONSTRAINT "receipts_amount_positive_check" CHECK ("amountPaise" > 0);
ALTER TABLE "receipts"
  ADD CONSTRAINT "receipts_currency_inr_check" CHECK ("currency" = 'INR');
ALTER TABLE "receipts"
  ADD CONSTRAINT "receipts_sequence_positive_check" CHECK ("sequence" > 0);

-- ─────────────────────────────────────────────────────────────────────────────
-- g. RLS. ENABLE + FORCE on all seven. The four mutable/snapshot tables
--    (fee_structures, fee_components, student_charges, payment_transactions) get
--    the standard fail-closed nullif-guarded pair {tenant_isolation_select,
--    tenant_isolation_modify}. The three INSERT-only tables (payment_allocations,
--    receipts, processed_webhook_events) get the APPEND-ONLY pair
--    {tenant_isolation_select, <table>_tenant_insert} with NO modify/FOR ALL
--    policy (the application_reviews house style). nullif(current_setting(
--    'app.current_institution_id', true), '') fails closed for both an unset and
--    an empty-string GUC.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  mutable_tables TEXT[] := ARRAY[
    'fee_structures', 'fee_components', 'student_charges', 'payment_transactions'
  ];
  append_only_tables TEXT[] := ARRAY[
    'payment_allocations', 'receipts', 'processed_webhook_events'
  ];
BEGIN
  -- Four mutable/snapshot tables: standard select + modify pair.
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

  -- Three INSERT-only tables: append-only (SELECT + INSERT, NO modify).
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
-- h. Append-only / immutable triggers.
--
--    h.1 The three fully INSERT-only tables (payment_allocations, receipts,
--        processed_webhook_events) mirror application_reviews exactly: a
--        <table>_append_only() plpgsql function raising restrict_violation,
--        bound by a BEFORE UPDATE OR DELETE ... FOR EACH ROW trigger (binds the
--        owner too — GRANTs alone cannot restrict the owner).
--    h.2 payment_transactions + student_charges instead use NEW column-guard
--        triggers (NOT the unconditional-raise append-only trigger): they need a
--        forward-only status UPDATE while every money/identity fact stays frozen.
--        Copied VERBATIM from design §D.3.
-- ─────────────────────────────────────────────────────────────────────────────

-- h.1 payment_allocations
CREATE OR REPLACE FUNCTION "payment_allocations_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment_allocations is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "payment_allocations_no_update_delete"
  BEFORE UPDATE OR DELETE ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION "payment_allocations_append_only"();

-- h.1 receipts
CREATE OR REPLACE FUNCTION "receipts_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'receipts is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "receipts_no_update_delete"
  BEFORE UPDATE OR DELETE ON "receipts"
  FOR EACH ROW EXECUTE FUNCTION "receipts_append_only"();

-- h.1 processed_webhook_events
CREATE OR REPLACE FUNCTION "processed_webhook_events_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'processed_webhook_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "processed_webhook_events_no_update_delete"
  BEFORE UPDATE OR DELETE ON "processed_webhook_events"
  FOR EACH ROW EXECUTE FUNCTION "processed_webhook_events_append_only"();

-- h.2 payment_transactions column-guard (verbatim from design §D.3): immutable
--     fact columns, no exit from a terminal state, forward-only transitions.
CREATE OR REPLACE FUNCTION "payment_transactions_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_transactions is append-only'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- immutable fact columns: never change once written
  IF NEW."amountPaise"     IS DISTINCT FROM OLD."amountPaise"
  OR NEW."currency"        IS DISTINCT FROM OLD."currency"
  OR NEW."razorpayOrderId" IS DISTINCT FROM OLD."razorpayOrderId"
  OR NEW."studentId"       IS DISTINCT FROM OLD."studentId"
  OR NEW."institutionId"   IS DISTINCT FROM OLD."institutionId"
  OR NEW."targetChargeIds" IS DISTINCT FROM OLD."targetChargeIds"
  OR (OLD."razorpayPaymentId" IS NOT NULL
      AND NEW."razorpayPaymentId" IS DISTINCT FROM OLD."razorpayPaymentId")
  OR (OLD."razorpaySignature" IS NOT NULL
      AND NEW."razorpaySignature" IS DISTINCT FROM OLD."razorpaySignature")
  THEN
    RAISE EXCEPTION 'immutable payment_transactions column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- no exit from a terminal state
  IF OLD."status" IN ('CAPTURED','FAILED')
     AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'terminal payment_transactions status is frozen'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- forward-only transitions (a late webhook may skip AUTHORIZED)
  IF NOT (
       (OLD."status" = 'CREATED'    AND NEW."status" IN ('AUTHORIZED','CAPTURED','FAILED'))
    OR (OLD."status" = 'AUTHORIZED' AND NEW."status" IN ('CAPTURED','FAILED'))
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal payment_transactions status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;

CREATE TRIGGER "payment_transactions_guard"
  BEFORE UPDATE OR DELETE ON "payment_transactions"
  FOR EACH ROW EXECUTE FUNCTION "payment_transactions_guard"();

-- h.2 student_charges column-guard (verbatim from design §D.3): freezes every
--     snapshot column; allows only the forward-only status move and updatedAt.
CREATE OR REPLACE FUNCTION "student_charges_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'student_charges is append-only'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- immutable snapshot columns: posted facts never change
  IF NEW."amountPaise"     IS DISTINCT FROM OLD."amountPaise"
  OR NEW."currency"        IS DISTINCT FROM OLD."currency"
  OR NEW."category"        IS DISTINCT FROM OLD."category"
  OR NEW."dueDate"         IS DISTINCT FROM OLD."dueDate"
  OR NEW."description"     IS DISTINCT FROM OLD."description"
  OR NEW."studentId"       IS DISTINCT FROM OLD."studentId"
  OR NEW."institutionId"   IS DISTINCT FROM OLD."institutionId"
  OR NEW."feeStructureId"  IS DISTINCT FROM OLD."feeStructureId"
  OR NEW."feeComponentId"  IS DISTINCT FROM OLD."feeComponentId"
  OR NEW."postedAt"        IS DISTINCT FROM OLD."postedAt"
  OR NEW."postedByUserId"  IS DISTINCT FROM OLD."postedByUserId"
  THEN
    RAISE EXCEPTION 'immutable student_charges snapshot column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- forward-only, allocation-driven status
  IF NOT (
       (OLD."status" = 'PENDING'        AND NEW."status" IN ('PARTIALLY_PAID','PAID'))
    OR (OLD."status" = 'PARTIALLY_PAID' AND NEW."status" = 'PAID')
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal student_charges status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;

CREATE TRIGGER "student_charges_guard"
  BEFORE UPDATE OR DELETE ON "student_charges"
  FOR EACH ROW EXECUTE FUNCTION "student_charges_guard"();

-- ─────────────────────────────────────────────────────────────────────────────
-- i. campass_app GRANT refresh (guarded + idempotent). The four mutable/snapshot
--    tables legitimately need full DML (the column-guard triggers enforce
--    immutability at the row level, not the grant); the three INSERT-only tables
--    keep SELECT, INSERT and REVOKE UPDATE, DELETE. Never grant BYPASSRLS.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "fee_structures"       TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "fee_components"       TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "student_charges"      TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "payment_transactions" TO "campass_app";

    GRANT SELECT, INSERT ON "payment_allocations"      TO "campass_app";
    REVOKE UPDATE, DELETE ON "payment_allocations"      FROM "campass_app";
    GRANT SELECT, INSERT ON "receipts"                 TO "campass_app";
    REVOKE UPDATE, DELETE ON "receipts"                 FROM "campass_app";
    GRANT SELECT, INSERT ON "processed_webhook_events" TO "campass_app";
    REVOKE UPDATE, DELETE ON "processed_webhook_events" FROM "campass_app";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- j. Catalogue seed: the ACCOUNTANT template role + the seven fees.* permissions
--    + their role_permissions pairs, using the same seed-block shape + join +
--    markers the earlier seeds use so the catalogue-sync meta-test parses this
--    block too. The ACCOUNTANT template role is NEW (the LIBRARIAN /
--    ADMISSION_OFFICER precedent) — so its "roles" row IS inserted here
--    (institutionId = NULL), BEFORE the permissions block (so its `, NULL)`
--    tuple falls outside the sliced permission span). ROLE_PERMISSIONS lockstep
--    (design §D.12): ACCOUNTANT x4 staff fees keys, ADMIN x the same four,
--    STUDENT x fees.view_own. fees.refund / fees.adjust are forward-declared,
--    unbound permission keys (no role_permissions pair) — slice 7.1 binds them.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "roles" ("id","key","name","institutionId") VALUES
  ('role_accountant', 'ACCOUNTANT', 'Accountant', NULL)
ON CONFLICT DO NOTHING;

INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_fees_structures_manage', 'fees.structures.manage', 'fees', 'Create/update fee structures + components'),
  ('perm_fees_charges_manage',    'fees.charges.manage',    'fees', 'Post charges (single + bulk)'),
  ('perm_fees_view',              'fees.view',              'fees', 'Staff read of structures, a student ledger, payments, receipts, reconciliation'),
  ('perm_fees_collect',           'fees.collect',           'fees', 'Trigger order creation on behalf / run reconciliation (collection ops)'),
  ('perm_fees_view_own',          'fees.view_own',          'fees', 'Student reads own charges/outstanding/receipts and initiates/verifies own payment'),
  ('perm_fees_refund',            'fees.refund',            'fees', 'Approve a refund (forward-declared, step-up-gated; unbound + unbuilt in slice 1)'),
  ('perm_fees_adjust',            'fees.adjust',            'fees', 'Approve a fee adjustment (forward-declared, step-up-gated; unbound + unbuilt in slice 1)')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('ACCOUNTANT', 'fees.structures.manage'),
  ('ACCOUNTANT', 'fees.charges.manage'),
  ('ACCOUNTANT', 'fees.view'),
  ('ACCOUNTANT', 'fees.collect'),
  ('ADMIN',      'fees.structures.manage'),
  ('ADMIN',      'fees.charges.manage'),
  ('ADMIN',      'fees.view'),
  ('ADMIN',      'fees.collect'),
  ('STUDENT',    'fees.view_own')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
