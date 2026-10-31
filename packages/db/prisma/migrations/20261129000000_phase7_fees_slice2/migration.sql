-- CAMPASS Phase 7 — Fees & Payments, SLICE 7.1 (dir name _slice2): the money-OUT
-- + corrections half of the ledger (scholarships/concessions, refunds,
-- adjustments) plus the reporting read model.
--
-- Hand-authored (Prisma's diff does not model RLS, the composite same-tenant
-- FKs, the partial unique index, the global unique, the CHECK constraints, the
-- append-only triggers, the column guard, the targeted GRANT refresh, or the
-- catalogue seed). STRICTLY ADDITIVE: this migration only CREATEs new objects
-- and CREATE-OR-REPLACEs the existing student_charges_guard FUNCTION BODY (the
-- §E.1 relaxation). It NEVER drops an existing table, never ALTERs a frozen
-- table's RLS/grant/FK, never touches the _prisma_migrations ledger, and never
-- edits any of the THIRTEEN frozen migration directories (incl.
-- 20261122000000_phase7_fees_slice1). campass_app stays NOSUPERUSER
-- NOBYPASSRLS — never granted BYPASSRLS.
--
-- SIX new tenant-owned tables = TWO standard-RLS-pair tables (concession_
-- definitions [mutable] and refunds [snapshot/fact with a column guard]) + FOUR
-- fully INSERT-only append-only tables (student_concessions, concession_credits,
-- refund_reversals, adjustments). Every table carries institutionId +
-- (id, institutionId) composite unique + (institutionId) index + composite
-- same-tenant FKs incl. institutionId + ENABLE+FORCE RLS.
--
-- Money is INTEGER PAISE (BIGINT); currency is a stored non-null 'INR'
-- (CHECK currency = 'INR'); no money column is a float/decimal.
--
-- Ordering (mirrors slice-1 sections a–j):
--   a. CREATE TYPE the five new enums;
--   b. CREATE TABLE the six new tables + PKs (updatedAt NOT NULL only on
--      concession_definitions + refunds; the four INSERT-only tables have none);
--   c. (id,institutionId) uniques + business uniques + (institutionId)/query
--      indexes + the TWO global partials on refunds;
--   d. tenant-root institutionId -> institutions(id) RESTRICT on all six;
--   e. composite same-tenant FKs incl. institutionId;
--   f. CHECKs;
--   g. ENABLE+FORCE RLS (standard pair on concession_definitions + refunds;
--      append-only SELECT + <table>_tenant_insert pair on the four INSERT-only);
--   h. append-only triggers x4 + refunds_guard() column guard + the §E.1
--      CREATE OR REPLACE of student_charges_guard() (body only; trigger binding
--      untouched);
--   i. guarded campass_app GRANT refresh;
--   j. catalogue seed: the ONE new permission fees.concession.manage + the six
--      role_permissions pairs binding fees.concession.manage / fees.refund /
--      fees.adjust to ACCOUNTANT and ADMIN.

-- ─────────────────────────────────────────────────────────────────────────────
-- a. Enums.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "ConcessionType"   AS ENUM ('FIXED', 'PERCENT');
CREATE TYPE "ConcessionScope"  AS ENUM ('PER_STUDENT', 'PER_STRUCTURE');
CREATE TYPE "RefundStatus"     AS ENUM ('REQUESTED', 'PROCESSED', 'FAILED');
CREATE TYPE "AdjustmentType"   AS ENUM ('WAIVER', 'WRITE_OFF', 'CORRECTION');
CREATE TYPE "LedgerEntryKind"  AS ENUM ('CONCESSION', 'ADJUSTMENT', 'REFUND_REVERSAL');

-- ─────────────────────────────────────────────────────────────────────────────
-- b. New tenant-owned tables + PKs. updatedAt NOT NULL on concession_definitions
--    + refunds; the four INSERT-only tables have no updatedAt. Money BIGINT;
--    currency TEXT default 'INR'.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "concession_definitions" (
    "id"                TEXT NOT NULL,
    "institutionId"     TEXT NOT NULL,
    "name"              TEXT NOT NULL,
    "type"              "ConcessionType" NOT NULL,
    "amountPaise"       BIGINT,
    "percentBps"        INTEGER,
    "scope"             "ConcessionScope" NOT NULL,
    "programId"         TEXT,
    "academicSessionId" TEXT,
    "note"              TEXT,
    "status"            "FeeStructureStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "concession_definitions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "student_concessions" (
    "id"                     TEXT NOT NULL,
    "institutionId"          TEXT NOT NULL,
    "concessionDefinitionId" TEXT NOT NULL,
    "studentId"              TEXT NOT NULL,
    "totalPaise"             BIGINT NOT NULL,
    "approvedByUserId"       TEXT NOT NULL,
    "note"                   TEXT,
    "postedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_concessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "concession_credits" (
    "id"                  TEXT NOT NULL,
    "institutionId"       TEXT NOT NULL,
    "studentConcessionId" TEXT NOT NULL,
    "studentChargeId"     TEXT NOT NULL,
    "amountPaise"         BIGINT NOT NULL,
    "currency"            TEXT NOT NULL DEFAULT 'INR',
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "concession_credits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refunds" (
    "id"                   TEXT NOT NULL,
    "institutionId"        TEXT NOT NULL,
    "paymentTransactionId" TEXT NOT NULL,
    "studentId"            TEXT NOT NULL,
    "amountPaise"          BIGINT NOT NULL,
    "currency"             TEXT NOT NULL DEFAULT 'INR',
    "status"               "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason"               TEXT NOT NULL,
    "razorpayRefundId"     TEXT,
    "idempotencyKey"       TEXT NOT NULL,
    "approvedByUserId"     TEXT NOT NULL,
    "requestedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt"            TIMESTAMP(3),
    "unreversiblePaise"    BIGINT NOT NULL DEFAULT 0,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refund_reversals" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "refundId"        TEXT NOT NULL,
    "studentChargeId" TEXT NOT NULL,
    "amountPaise"     BIGINT NOT NULL,
    "currency"        TEXT NOT NULL DEFAULT 'INR',
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_reversals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "adjustments" (
    "id"               TEXT NOT NULL,
    "institutionId"    TEXT NOT NULL,
    "studentId"        TEXT NOT NULL,
    "studentChargeId"  TEXT NOT NULL,
    "type"             "AdjustmentType" NOT NULL,
    "direction"        TEXT NOT NULL,
    "amountPaise"      BIGINT NOT NULL,
    "currency"         TEXT NOT NULL DEFAULT 'INR',
    "reason"           TEXT NOT NULL,
    "approvedByUserId" TEXT NOT NULL,
    "postedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adjustments_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- c. Unique + query indexes. (id, institutionId) composite uniques anchor the
--    composite same-tenant FKs; concession_definitions (institutionId, name)
--    business unique; the TWO global partials on refunds (NIT-1: no
--    (institutionId, …) composite — the global uniques already imply tenant
--    uniqueness); (institutionId) + per-table query indexes.
-- ─────────────────────────────────────────────────────────────────────────────
-- concession_definitions
CREATE UNIQUE INDEX "concession_definitions_id_institutionId_key"   ON "concession_definitions"("id", "institutionId");
CREATE UNIQUE INDEX "concession_definitions_institutionId_name_key" ON "concession_definitions"("institutionId", "name");
CREATE INDEX        "concession_definitions_institutionId_idx"      ON "concession_definitions"("institutionId");

-- student_concessions
CREATE UNIQUE INDEX "student_concessions_id_institutionId_key"          ON "student_concessions"("id", "institutionId");
CREATE INDEX        "student_concessions_institutionId_idx"             ON "student_concessions"("institutionId");
CREATE INDEX        "student_concessions_institutionId_studentId_idx"   ON "student_concessions"("institutionId", "studentId");

-- concession_credits
CREATE UNIQUE INDEX "concession_credits_id_institutionId_key"                ON "concession_credits"("id", "institutionId");
CREATE INDEX        "concession_credits_institutionId_idx"                   ON "concession_credits"("institutionId");
CREATE INDEX        "concession_credits_institutionId_studentChargeId_idx"   ON "concession_credits"("institutionId", "studentChargeId");

-- refunds
CREATE UNIQUE INDEX "refunds_id_institutionId_key"                       ON "refunds"("id", "institutionId");
-- GLOBAL partial unique on a settled Razorpay refund id (the hard idempotency
-- key); NULLs (REQUESTED-but-not-yet-settled) are exempt. Prisma emits a FULL
-- unique on this column — this partial supersedes it (the known cosmetic diff).
CREATE UNIQUE INDEX "refunds_razorpay_refund_id_unique" ON "refunds"("razorpayRefundId") WHERE "razorpayRefundId" IS NOT NULL;
-- GLOBAL unique on the request-time correlation key (HIGH-2; NOT NULL).
CREATE UNIQUE INDEX "refunds_idempotency_key_key" ON "refunds"("idempotencyKey");
CREATE INDEX        "refunds_institutionId_idx"                          ON "refunds"("institutionId");
CREATE INDEX        "refunds_institutionId_paymentTransactionId_idx"     ON "refunds"("institutionId", "paymentTransactionId");
CREATE INDEX        "refunds_institutionId_status_idx"                   ON "refunds"("institutionId", "status");

-- refund_reversals
CREATE UNIQUE INDEX "refund_reversals_id_institutionId_key"              ON "refund_reversals"("id", "institutionId");
CREATE INDEX        "refund_reversals_institutionId_idx"                 ON "refund_reversals"("institutionId");
CREATE INDEX        "refund_reversals_institutionId_studentChargeId_idx" ON "refund_reversals"("institutionId", "studentChargeId");

-- adjustments
CREATE UNIQUE INDEX "adjustments_id_institutionId_key"              ON "adjustments"("id", "institutionId");
CREATE INDEX        "adjustments_institutionId_idx"                 ON "adjustments"("institutionId");
CREATE INDEX        "adjustments_institutionId_studentChargeId_idx" ON "adjustments"("institutionId", "studentChargeId");

-- ─────────────────────────────────────────────────────────────────────────────
-- d. Tenant-root FKs: institutionId -> institutions(id) RESTRICT on all six.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "concession_definitions" ADD CONSTRAINT "concession_definitions_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "student_concessions"    ADD CONSTRAINT "student_concessions_institutionId_fkey"    FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "concession_credits"     ADD CONSTRAINT "concession_credits_institutionId_fkey"     FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds"                ADD CONSTRAINT "refunds_institutionId_fkey"                FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_reversals"       ADD CONSTRAINT "refund_reversals_institutionId_fkey"       FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "adjustments"            ADD CONSTRAINT "adjustments_institutionId_fkey"            FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- e. Composite same-tenant FKs (each carries institutionId so a child can never
--    reference a parent in another tenant). approvedByUserId is a recorded actor
--    id with NO FK (slice-1 precedent).
-- ─────────────────────────────────────────────────────────────────────────────
-- concession_definitions -> programs (nullable) / academic_sessions (nullable)
ALTER TABLE "concession_definitions"
  ADD CONSTRAINT "concession_definitions_program_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "programId") REFERENCES "programs"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "concession_definitions"
  ADD CONSTRAINT "concession_definitions_session_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicSessionId") REFERENCES "academic_sessions"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- student_concessions -> concession_definitions / student_profiles
ALTER TABLE "student_concessions"
  ADD CONSTRAINT "student_concessions_definition_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "concessionDefinitionId") REFERENCES "concession_definitions"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "student_concessions"
  ADD CONSTRAINT "student_concessions_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- concession_credits -> student_concessions / student_charges
ALTER TABLE "concession_credits"
  ADD CONSTRAINT "concession_credits_concession_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentConcessionId") REFERENCES "student_concessions"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "concession_credits"
  ADD CONSTRAINT "concession_credits_charge_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentChargeId") REFERENCES "student_charges"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- refunds -> payment_transactions / student_profiles
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_transaction_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "paymentTransactionId") REFERENCES "payment_transactions"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- refund_reversals -> refunds / student_charges
ALTER TABLE "refund_reversals"
  ADD CONSTRAINT "refund_reversals_refund_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "refundId") REFERENCES "refunds"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_reversals"
  ADD CONSTRAINT "refund_reversals_charge_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentChargeId") REFERENCES "student_charges"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- adjustments -> student_profiles / student_charges
ALTER TABLE "adjustments"
  ADD CONSTRAINT "adjustments_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "adjustments"
  ADD CONSTRAINT "adjustments_charge_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentChargeId") REFERENCES "student_charges"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- f. CHECK constraints (design §E.2.f). Money strictly positive, currency
--    locked to 'INR', non-empty name/reason, percentBps 1..10000, FIXED/PERCENT
--    exclusivity, adjustment direction, unreversiblePaise >= 0.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "concession_definitions"
  ADD CONSTRAINT "concession_definitions_name_nonempty_check" CHECK (char_length("name") >= 1);
ALTER TABLE "concession_definitions"
  ADD CONSTRAINT "concession_definitions_percent_range_check"
  CHECK ("percentBps" IS NULL OR ("percentBps" BETWEEN 1 AND 10000));
ALTER TABLE "concession_definitions"
  ADD CONSTRAINT "concession_definitions_fixed_amount_positive_check"
  CHECK ("amountPaise" IS NULL OR "amountPaise" > 0);
-- FIXED => amountPaise set (and percentBps null); PERCENT => percentBps set (and amountPaise null).
ALTER TABLE "concession_definitions"
  ADD CONSTRAINT "concession_definitions_type_exclusivity_check"
  CHECK (
    ("type" = 'FIXED'   AND "amountPaise" IS NOT NULL AND "percentBps" IS NULL)
    OR
    ("type" = 'PERCENT' AND "percentBps" IS NOT NULL AND "amountPaise" IS NULL)
  );

ALTER TABLE "student_concessions"
  ADD CONSTRAINT "student_concessions_total_positive_check" CHECK ("totalPaise" > 0);

ALTER TABLE "concession_credits"
  ADD CONSTRAINT "concession_credits_amount_positive_check" CHECK ("amountPaise" > 0);
ALTER TABLE "concession_credits"
  ADD CONSTRAINT "concession_credits_currency_inr_check" CHECK ("currency" = 'INR');

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amount_positive_check" CHECK ("amountPaise" > 0);
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_currency_inr_check" CHECK ("currency" = 'INR');
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_reason_nonempty_check" CHECK (char_length("reason") >= 1);
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_unreversible_nonneg_check" CHECK ("unreversiblePaise" >= 0);

ALTER TABLE "refund_reversals"
  ADD CONSTRAINT "refund_reversals_amount_positive_check" CHECK ("amountPaise" > 0);
ALTER TABLE "refund_reversals"
  ADD CONSTRAINT "refund_reversals_currency_inr_check" CHECK ("currency" = 'INR');

ALTER TABLE "adjustments"
  ADD CONSTRAINT "adjustments_amount_positive_check" CHECK ("amountPaise" > 0);
ALTER TABLE "adjustments"
  ADD CONSTRAINT "adjustments_currency_inr_check" CHECK ("currency" = 'INR');
ALTER TABLE "adjustments"
  ADD CONSTRAINT "adjustments_reason_nonempty_check" CHECK (char_length("reason") >= 1);
-- direction is CREDIT or DEBIT; only a CORRECTION may be DEBIT.
ALTER TABLE "adjustments"
  ADD CONSTRAINT "adjustments_direction_check"
  CHECK ("direction" IN ('CREDIT', 'DEBIT') AND ("type" = 'CORRECTION' OR "direction" = 'CREDIT'));

-- ─────────────────────────────────────────────────────────────────────────────
-- g. RLS. ENABLE + FORCE on all six. concession_definitions + refunds get the
--    standard fail-closed nullif-guarded pair {tenant_isolation_select,
--    tenant_isolation_modify} (refunds's column guard enforces immutability at
--    the row level, so it still carries a modify policy — the
--    payment_transactions rationale). The four INSERT-only tables get the
--    append-only pair {tenant_isolation_select, <table>_tenant_insert} with NO
--    modify policy. nullif(current_setting('app.current_institution_id', true),
--    '') fails closed for both an unset and an empty-string GUC.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  mutable_tables TEXT[] := ARRAY[
    'concession_definitions', 'refunds'
  ];
  append_only_tables TEXT[] := ARRAY[
    'student_concessions', 'concession_credits', 'refund_reversals', 'adjustments'
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
--   h.1 The four fully INSERT-only tables mirror the slice-1 receipts shape: a
--       <table>_append_only() plpgsql function raising restrict_violation, bound
--       by a BEFORE UPDATE OR DELETE ... FOR EACH ROW trigger (binds the owner
--       too — GRANTs alone cannot restrict the owner).
--   h.2 refunds_guard() column guard (mirrors payment_transactions_guard):
--       immutable money/identity columns, NULL->value razorpayRefundId stamp
--       allowed once then frozen, forward-only REQUESTED->{PROCESSED,FAILED},
--       terminal frozen, raise on DELETE.
--   h.3 CREATE OR REPLACE student_charges_guard() with the §E.1 relaxed body
--       (body only; the slice-1 trigger binding is untouched).
-- ─────────────────────────────────────────────────────────────────────────────

-- h.1 student_concessions
CREATE OR REPLACE FUNCTION "student_concessions_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'student_concessions is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "student_concessions_no_update_delete"
  BEFORE UPDATE OR DELETE ON "student_concessions"
  FOR EACH ROW EXECUTE FUNCTION "student_concessions_append_only"();

-- h.1 concession_credits
CREATE OR REPLACE FUNCTION "concession_credits_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'concession_credits is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "concession_credits_no_update_delete"
  BEFORE UPDATE OR DELETE ON "concession_credits"
  FOR EACH ROW EXECUTE FUNCTION "concession_credits_append_only"();

-- h.1 refund_reversals
CREATE OR REPLACE FUNCTION "refund_reversals_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'refund_reversals is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "refund_reversals_no_update_delete"
  BEFORE UPDATE OR DELETE ON "refund_reversals"
  FOR EACH ROW EXECUTE FUNCTION "refund_reversals_append_only"();

-- h.1 adjustments
CREATE OR REPLACE FUNCTION "adjustments_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'adjustments is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "adjustments_no_update_delete"
  BEFORE UPDATE OR DELETE ON "adjustments"
  FOR EACH ROW EXECUTE FUNCTION "adjustments_append_only"();

-- h.2 refunds column guard.
CREATE OR REPLACE FUNCTION "refunds_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refunds is append-only'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- immutable money/identity columns: never change once written
  IF NEW."amountPaise"          IS DISTINCT FROM OLD."amountPaise"
  OR NEW."currency"             IS DISTINCT FROM OLD."currency"
  OR NEW."paymentTransactionId" IS DISTINCT FROM OLD."paymentTransactionId"
  OR NEW."studentId"            IS DISTINCT FROM OLD."studentId"
  OR NEW."institutionId"        IS DISTINCT FROM OLD."institutionId"
  OR NEW."reason"               IS DISTINCT FROM OLD."reason"
  OR NEW."idempotencyKey"       IS DISTINCT FROM OLD."idempotencyKey"
  OR (OLD."razorpayRefundId" IS NOT NULL
      AND NEW."razorpayRefundId" IS DISTINCT FROM OLD."razorpayRefundId")
  THEN
    RAISE EXCEPTION 'immutable refunds column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- unreversiblePaise is writable only on the REQUESTED->PROCESSED move; once the
  -- row is terminal it is frozen (covered by the terminal-freeze below), and it
  -- must not change while still REQUESTED.
  IF OLD."status" = 'REQUESTED'
     AND NEW."status" = 'REQUESTED'
     AND NEW."unreversiblePaise" IS DISTINCT FROM OLD."unreversiblePaise" THEN
    RAISE EXCEPTION 'refunds.unreversiblePaise is set only at settle'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- no exit from a terminal state
  IF OLD."status" IN ('PROCESSED','FAILED')
     AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'terminal refunds status is frozen'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- forward-only transitions
  IF NOT (
       (OLD."status" = 'REQUESTED' AND NEW."status" IN ('PROCESSED','FAILED'))
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal refunds status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;

CREATE TRIGGER "refunds_guard"
  BEFORE UPDATE OR DELETE ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION "refunds_guard"();

-- h.3 §E.1 RELAXATION of the slice-1 student_charges_guard FUNCTION BODY. Every
--     immutable-snapshot check is byte-identical to slice 1 and DELETE still
--     raises; the ONLY change is the forward-only status clause is replaced by a
--     "status must be one of the three valid values" clause (money-OUT moves a
--     charge backward legitimately; status is a pure projection of the
--     append-only ledger). The trigger binding is NOT recreated — a
--     CREATE OR REPLACE FUNCTION swaps the body under the existing trigger.
CREATE OR REPLACE FUNCTION "student_charges_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'student_charges is append-only'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- immutable snapshot columns: posted facts never change (UNCHANGED from slice 1)
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
  -- 7.1: status is a pure projection of the append-only ledger; any of the three
  -- valid states is reachable (money-out moves it backward). The forward-only
  -- clause from slice 1 is intentionally removed; snapshot immutability (above)
  -- and ledger-row immutability (append-only triggers) are the real guards.
  IF NEW."status" NOT IN ('PENDING','PARTIALLY_PAID','PAID') THEN
    RAISE EXCEPTION 'invalid student_charges status %', NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- i. campass_app GRANT refresh (guarded + idempotent). Full DML on the two
--    mutable/snapshot tables (their RLS + the refunds column guard enforce
--    immutability at the row level); SELECT, INSERT + REVOKE UPDATE, DELETE on
--    the four INSERT-only tables. Never grant BYPASSRLS.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "concession_definitions" TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "refunds"                TO "campass_app";

    GRANT SELECT, INSERT ON "student_concessions" TO "campass_app";
    REVOKE UPDATE, DELETE ON "student_concessions" FROM "campass_app";
    GRANT SELECT, INSERT ON "concession_credits"  TO "campass_app";
    REVOKE UPDATE, DELETE ON "concession_credits"  FROM "campass_app";
    GRANT SELECT, INSERT ON "refund_reversals"    TO "campass_app";
    REVOKE UPDATE, DELETE ON "refund_reversals"    FROM "campass_app";
    GRANT SELECT, INSERT ON "adjustments"         TO "campass_app";
    REVOKE UPDATE, DELETE ON "adjustments"         FROM "campass_app";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- j. Catalogue seed. ONE new permission (fees.concession.manage) + the six
--    role_permissions pairs binding fees.concession.manage / fees.refund /
--    fees.adjust to ACCOUNTANT and ADMIN. fees.refund / fees.adjust permission
--    ROWS were seeded in slice-1 §j — they are NOT re-inserted here (only their
--    role bindings). The block shapes mirror the catalogue-sync parser's
--    expectations (the permissions span is sliced up to its conflict clause; the
--    role_permissions span is sliced up to its VALUES alias).
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_fees_concession_manage', 'fees.concession.manage', 'fees', 'Create concession definitions + post concessions/scholarships')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('ACCOUNTANT', 'fees.concession.manage'),
  ('ADMIN',      'fees.concession.manage'),
  ('ACCOUNTANT', 'fees.refund'),
  ('ADMIN',      'fees.refund'),
  ('ACCOUNTANT', 'fees.adjust'),
  ('ADMIN',      'fees.adjust')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
