-- CAMPASS Phase 8 — Examinations & Results, SLICE 8.2 (backend only): completes
-- Phase 8 with re-evaluation, supplementary exams, and cross-session student
-- result history. It EXTENDS slice 8.1 (migration 20261206000000_phase8_exams_slice1)
-- and NEVER duplicates it. Access-and-correctness-critical (the exam analog of
-- money-critical): unpublished/superseded results must never leak to students,
-- result integrity + audit must hold, re-publication stays controlled.
--
-- Hand-authored (Prisma's diff models neither RLS, the composite same-tenant FKs,
-- the partial unique index, the column-guard triggers, the targeted GRANT refresh,
-- nor the catalogue seed). The sections a–j are ADDITIVE (one new enum, one new
-- table, the catalogue seed) in the frozen 8.1 lettered house style; the sections
-- k/l/m are explicitly NON-ADDITIVE changes to existing objects, documented inline:
--   k. ADD a nullable self-FK column parentExaminationId to "examinations".
--   l. CREATE OR REPLACE the examinations_guard() trigger FUNCTION to freeze the
--      new parentExaminationId column (the trigger BINDING is unchanged).
--   m. The result_publications trigger SWAP: a one-time idempotent backfill flips
--      every non-max PUBLISHED version to SUPERSEDED (so the "max version is the
--      sole PUBLISHED row" invariant holds for 8.1-era data), then the
--      unconditional append-only trigger is replaced by a COLUMN-GUARD that permits
--      EXACTLY PUBLISHED->SUPERSEDED, and the INSERT-only RLS policy is replaced by
--      the default modify pair + GRANT UPDATE.
--
-- This migration NEVER edits any of the fifteen frozen migration directories
-- (they stay byte-identical), never touches the _prisma_migrations ledger, and
-- campass_app stays NOSUPERUSER NOBYPASSRLS — never granted BYPASSRLS.
--
-- ONE new tenant-owned table: reeval_requests (forward-only column-guard class,
-- standard RLS pair + guard trigger). It carries institutionId + (id,
-- institutionId) composite unique + (institutionId) index + composite same-tenant
-- FKs incl. institutionId + ENABLE+FORCE RLS.
--
-- Ordering (mirrors the 8.1 sections a–j, then k/l/m for the non-additive edits):
--   a. CREATE TYPE the new ReevalRequestStatus enum (NO value added to
--      ExaminationType / ResultPublicationStatus — both already carry the values
--      8.2 needs: SUPPLEMENTARY and SUPERSEDED).
--   b. CREATE TABLE "reeval_requests" + PK (updatedAt NOT NULL — column-guard class).
--   c. (id,institutionId) unique + (institutionId)/query indexes + the partial
--      unique reeval_requests_open_unique.
--   d. tenant-root institutionId -> institutions(id) RESTRICT.
--   e. composite same-tenant FKs incl. institutionId.
--   f. CHECK char_length(studentReason) >= 1.
--   g. ENABLE+FORCE RLS (standard fail-closed nullif-guarded pair).
--   h. reeval_requests_guard() column guard + BEFORE UPDATE OR DELETE trigger.
--   i. guarded campass_app GRANT refresh.
--   j. catalogue seed: the two new exams.* permissions + the three role_permissions
--      pairs (STUDENT exams.reeval.request_own; ADMIN+HOD exams.reeval.manage).
--   k. ALTER "examinations": ADD nullable parentExaminationId + index + composite
--      same-tenant self-FK.
--   l. CREATE OR REPLACE examinations_guard() freezing parentExaminationId too.
--   m. result_publications backfill + trigger swap + RLS/GRANT swap.

-- ─────────────────────────────────────────────────────────────────────────────
-- a. Enum.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "ReevalRequestStatus" AS ENUM ('REQUESTED', 'UNDER_REVIEW', 'REMARKED', 'CLOSED', 'REJECTED');

-- ─────────────────────────────────────────────────────────────────────────────
-- b. New tenant-owned table + PK. updatedAt NOT NULL (column-guard class).
--    requestedByUserId / processedByUserId are recorded actor ids with NO FK (the
--    8.1 createdByUserId/enteredByUserId precedent). outcomePublicationId is a
--    recorded id with NO FK (cycle-avoidance — it names a publication written
--    AFTER the request, during re-publication).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "reeval_requests" (
    "id"                   TEXT NOT NULL,
    "institutionId"        TEXT NOT NULL,
    "examId"               TEXT NOT NULL,
    "candidateId"          TEXT NOT NULL,
    "studentId"            TEXT NOT NULL,
    "subjectId"            TEXT NOT NULL,
    "sourcePublicationId"  TEXT NOT NULL,
    "status"               "ReevalRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "studentReason"        TEXT NOT NULL,
    "requestedByUserId"    TEXT NOT NULL,
    "processedByUserId"    TEXT,
    "staffNote"            TEXT,
    "outcomePublicationId" TEXT,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reeval_requests_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- c. Unique + query indexes. (id, institutionId) anchors the composite
--    same-tenant FKs; (institutionId) + per-query indexes; the partial unique
--    reeval_requests_open_unique blocks a duplicate OPEN request per (institution,
--    candidate, subject) while leaving the slot free after CLOSED/REJECTED
--    (Prisma cannot express a partial unique — the candidates_schedule_seat_unique
--    precedent).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "reeval_requests_id_institutionId_key"     ON "reeval_requests"("id", "institutionId");
CREATE INDEX        "reeval_requests_institutionId_idx"        ON "reeval_requests"("institutionId");
CREATE INDEX        "reeval_requests_institutionId_examId_idx" ON "reeval_requests"("institutionId", "examId");
CREATE INDEX        "reeval_requests_institutionId_studentId_idx"   ON "reeval_requests"("institutionId", "studentId");
CREATE INDEX        "reeval_requests_institutionId_candidateId_idx" ON "reeval_requests"("institutionId", "candidateId");
CREATE INDEX        "reeval_requests_institutionId_status_idx" ON "reeval_requests"("institutionId", "status");
CREATE UNIQUE INDEX "reeval_requests_open_unique"
  ON "reeval_requests"("institutionId", "candidateId", "subjectId")
  WHERE "status" IN ('REQUESTED', 'UNDER_REVIEW', 'REMARKED');

-- ─────────────────────────────────────────────────────────────────────────────
-- d. Tenant-root FK.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "reeval_requests" ADD CONSTRAINT "reeval_requests_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- e. Composite same-tenant FKs (each carries institutionId so a child can never
--    reference a parent in another tenant). All ON DELETE RESTRICT ON UPDATE
--    CASCADE.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "reeval_requests"
  ADD CONSTRAINT "reeval_requests_exam_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "examId") REFERENCES "examinations"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reeval_requests"
  ADD CONSTRAINT "reeval_requests_candidate_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "candidateId") REFERENCES "candidates"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reeval_requests"
  ADD CONSTRAINT "reeval_requests_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reeval_requests"
  ADD CONSTRAINT "reeval_requests_subject_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "subjectId") REFERENCES "subjects"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reeval_requests"
  ADD CONSTRAINT "reeval_requests_publication_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "sourcePublicationId") REFERENCES "result_publications"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- f. CHECK.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "reeval_requests"
  ADD CONSTRAINT "reeval_requests_reason_nonempty_check" CHECK (char_length("studentReason") >= 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- g. RLS. ENABLE + FORCE + the standard fail-closed nullif-guarded pair
--    {tenant_isolation_select, tenant_isolation_modify} (column-guard class
--    carries a modify policy — the examinations / payment_transactions rationale).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "reeval_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reeval_requests" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_select" ON "reeval_requests";
CREATE POLICY "tenant_isolation_select" ON "reeval_requests" FOR SELECT
  USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

DROP POLICY IF EXISTS "tenant_isolation_modify" ON "reeval_requests";
CREATE POLICY "tenant_isolation_modify" ON "reeval_requests" FOR ALL
  USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''))
  WITH CHECK ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- h. reeval_requests_guard() column guard (forward-only lifecycle). Immutable
--    identity/provenance columns; forward-only transitions
--    REQUESTED->UNDER_REVIEW->REMARKED->CLOSED plus REQUESTED|UNDER_REVIEW->REJECTED
--    (+ the no-op self transition); raise on DELETE. Terminal CLOSED/REJECTED
--    frozen. Mutable columns: status, staffNote, processedByUserId,
--    outcomePublicationId, updatedAt. The FROZEN set here MUST stay byte-aligned
--    with the Prisma model + the CREATE TABLE above (finding 8).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "reeval_requests_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reeval_requests is append-only'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- immutable identity / provenance columns
  IF NEW."institutionId"       IS DISTINCT FROM OLD."institutionId"
  OR NEW."examId"              IS DISTINCT FROM OLD."examId"
  OR NEW."candidateId"         IS DISTINCT FROM OLD."candidateId"
  OR NEW."studentId"           IS DISTINCT FROM OLD."studentId"
  OR NEW."subjectId"           IS DISTINCT FROM OLD."subjectId"
  OR NEW."sourcePublicationId" IS DISTINCT FROM OLD."sourcePublicationId"
  OR NEW."studentReason"       IS DISTINCT FROM OLD."studentReason"
  OR NEW."requestedByUserId"   IS DISTINCT FROM OLD."requestedByUserId"
  OR NEW."createdAt"           IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'immutable reeval_requests column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- forward-only transitions (plus the no-op self transition)
  IF NOT (
       (OLD."status" = 'REQUESTED'    AND NEW."status" = 'UNDER_REVIEW')
    OR (OLD."status" = 'UNDER_REVIEW' AND NEW."status" = 'REMARKED')
    OR (OLD."status" = 'REMARKED'     AND NEW."status" = 'CLOSED')
    OR (OLD."status" = 'REQUESTED'    AND NEW."status" = 'REJECTED')
    OR (OLD."status" = 'UNDER_REVIEW' AND NEW."status" = 'REJECTED')
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal reeval_requests status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "reeval_requests_guard"
  BEFORE UPDATE OR DELETE ON "reeval_requests"
  FOR EACH ROW EXECUTE FUNCTION "reeval_requests_guard"();

-- ─────────────────────────────────────────────────────────────────────────────
-- i. campass_app GRANT refresh (guarded + idempotent). Full DML; the guard
--    enforces immutability + forbids DELETE at the row level (the examinations
--    precedent, which also GRANTs DELETE then blocks it in-trigger). Never
--    BYPASSRLS.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "reeval_requests" TO "campass_app";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- j. Catalogue seed. The two new exams.* permissions + the three role_permissions
--    pairs (STUDENT exams.reeval.request_own; ADMIN+HOD exams.reeval.manage). The
--    block shapes mirror the catalogue-sync parser's expectations (the permissions
--    span is sliced up to its ON CONFLICT clause; the role_permissions span up to
--    its `AS m(` VALUES alias). Separation of duties: STUDENT never gets the staff
--    exams.reeval.manage; staff never gets the STUDENT-only exams.reeval.request_own.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_exams_reeval_request_own', 'exams.reeval.request_own', 'examinations', 'Student self-service re-evaluation request against OWN published result'),
  ('perm_exams_reeval_manage',      'exams.reeval.manage',      'examinations', 'Staff re-evaluation processing (transition + re-mark on a PUBLISHED exam)')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('STUDENT', 'exams.reeval.request_own'),
  ('ADMIN',   'exams.reeval.manage'),
  ('HOD',     'exams.reeval.manage')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- k. ALTER "examinations": ADD a nullable self-FK column parentExaminationId
--    (the supplementary-exam linkage). Strictly additive — ADD COLUMN nullable +
--    ADD CONSTRAINT, NO table rewrite, NO DROP. Anchorable on the existing
--    (id, institutionId) unique (8.1 §c). Composite same-tenant so a supplementary
--    exam can never reference a parent in another tenant.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "examinations" ADD COLUMN "parentExaminationId" TEXT;
CREATE INDEX "examinations_institutionId_parentExaminationId_idx"
  ON "examinations"("institutionId", "parentExaminationId");
ALTER TABLE "examinations"
  ADD CONSTRAINT "examinations_parent_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "parentExaminationId")
  REFERENCES "examinations"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- l. CREATE OR REPLACE examinations_guard() — re-authored from the 8.1 body with
--    parentExaminationId ADDED to the frozen identity set (set at INSERT only; the
--    guard freezes it so the parent link is immutable after create). The trigger
--    BINDING is unchanged (we do NOT touch the frozen 8.1 dir). Re-authoring the
--    FUNCTION is the documented, tested change — the same idiom as the
--    result_publications swap below.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "examinations_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'examinations is append-only'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- immutable scope/identity columns (parentExaminationId ADDED in 8.2)
  IF NEW."institutionId"       IS DISTINCT FROM OLD."institutionId"
  OR NEW."academicSessionId"   IS DISTINCT FROM OLD."academicSessionId"
  OR NEW."academicTermId"      IS DISTINCT FROM OLD."academicTermId"
  OR NEW."programId"           IS DISTINCT FROM OLD."programId"
  OR NEW."type"                IS DISTINCT FROM OLD."type"
  OR NEW."createdByUserId"     IS DISTINCT FROM OLD."createdByUserId"
  OR NEW."parentExaminationId" IS DISTINCT FROM OLD."parentExaminationId"
  THEN
    RAISE EXCEPTION 'immutable examinations column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- terminal state frozen
  IF OLD."status" = 'PUBLISHED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'published examination status is frozen'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- forward-only transitions (plus the no-op self transition)
  IF NOT (
       (OLD."status" = 'DRAFT'        AND NEW."status" = 'SCHEDULED')
    OR (OLD."status" = 'SCHEDULED'    AND NEW."status" = 'MARKS_OPEN')
    OR (OLD."status" = 'MARKS_OPEN'   AND NEW."status" = 'MARKS_LOCKED')
    OR (OLD."status" = 'MARKS_LOCKED' AND NEW."status" = 'MODERATION')
    OR (OLD."status" = 'MODERATION'   AND NEW."status" = 'APPROVED')
    OR (OLD."status" = 'APPROVED'     AND NEW."status" = 'PUBLISHED')
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal examinations status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- m. result_publications backfill + trigger swap (the controlled supersede).
--    ORDERING IS LOAD-BEARING (design §7.1 / finding 2): 8.1 NEVER wrote
--    SUPERSEDED and its append-only trigger made UPDATE impossible, so a single
--    (institutionId, examId) may already carry versions 1..N ALL 'PUBLISHED'. The
--    append-only trigger would block the backfill, so we (0) disable it, run the
--    idempotent backfill flipping every non-max PUBLISHED version to SUPERSEDED,
--    then (1) drop the append-only trigger + function, (2) create the column
--    guard, (3) swap the INSERT-only RLS policy for the default modify pair, and
--    (4) GRANT UPDATE. The backfill emits NO app audit (it is a schema migration).
--    result_snapshots + marks_record_history are NOT touched (strictly append-only).
--    The policy/trigger swap is INVISIBLE to `prisma migrate diff` (Prisma models
--    neither RLS nor triggers), so no DROP appears in the diff.
-- ─────────────────────────────────────────────────────────────────────────────

-- (0) one-time idempotent backfill. Disable the append-only trigger for the span,
--     flip every non-max PUBLISHED version to SUPERSEDED, then re-enable (it is
--     dropped in step 1 — re-enabling first keeps the table in a consistent state
--     should step 1 be examined independently). Idempotent: re-running flips
--     nothing once every non-max version is already SUPERSEDED.
ALTER TABLE "result_publications" DISABLE TRIGGER "result_publications_no_update_delete";
UPDATE "result_publications" rp
   SET "status" = 'SUPERSEDED'
 WHERE rp."status" = 'PUBLISHED'
   AND EXISTS (
     SELECT 1 FROM "result_publications" rp2
      WHERE rp2."institutionId" = rp."institutionId"
        AND rp2."examId"        = rp."examId"
        AND rp2."version"       > rp."version"
   );
ALTER TABLE "result_publications" ENABLE TRIGGER "result_publications_no_update_delete";

-- (1) drop the 8.1 append-only trigger + its function.
DROP TRIGGER IF EXISTS "result_publications_no_update_delete" ON "result_publications";
DROP FUNCTION IF EXISTS "result_publications_append_only"();

-- (2) create the column guard. Raise on DELETE; freeze every column except status
--     (IS DISTINCT FROM handles nulls); status may change ONLY PUBLISHED->SUPERSEDED
--     (plus the no-op self transition). Mirrors examinations_guard /
--     payment_transactions_guard / student_charges_guard.
CREATE OR REPLACE FUNCTION "result_publications_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'result_publications is append-only'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- freeze every column except status
  IF NEW."id"                IS DISTINCT FROM OLD."id"
  OR NEW."institutionId"     IS DISTINCT FROM OLD."institutionId"
  OR NEW."examId"            IS DISTINCT FROM OLD."examId"
  OR NEW."version"           IS DISTINCT FROM OLD."version"
  OR NEW."gradingSchemeId"   IS DISTINCT FROM OLD."gradingSchemeId"
  OR NEW."publishedByUserId" IS DISTINCT FROM OLD."publishedByUserId"
  OR NEW."reason"            IS DISTINCT FROM OLD."reason"
  OR NEW."publishedAt"       IS DISTINCT FROM OLD."publishedAt"
  OR NEW."createdAt"         IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'immutable result_publications column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- status may change ONLY PUBLISHED -> SUPERSEDED (plus the no-op self transition)
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'PUBLISHED' AND NEW."status" = 'SUPERSEDED')
  THEN
    RAISE EXCEPTION 'illegal result_publications status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "result_publications_guard"
  BEFORE UPDATE OR DELETE ON "result_publications"
  FOR EACH ROW EXECUTE FUNCTION "result_publications_guard"();

-- (3) swap the INSERT-only RLS policy for the default modify pair. The column
--     guard now enforces immutability at the row level (exactly like
--     payment_transactions), so the correct end state is the DEFAULT pair
--     {tenant_isolation_select, tenant_isolation_modify}. The 8.1 INSERT path
--     always sets institutionId to the tenant GUC, so the new FOR ALL policy's
--     WITH CHECK is satisfied on every INSERT — the publish path is unaffected.
DROP POLICY IF EXISTS "result_publications_tenant_insert" ON "result_publications";
DROP POLICY IF EXISTS "tenant_isolation_modify" ON "result_publications";
CREATE POLICY "tenant_isolation_modify" ON "result_publications" FOR ALL
  USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''))
  WITH CHECK ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));
-- The SELECT policy (tenant_isolation_select) stays as-is.

-- (4) GRANT UPDATE so campass_app can perform the one legal PUBLISHED->SUPERSEDED
--     flip under RLS (SELECT + INSERT were already granted in 8.1). Never BYPASSRLS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT UPDATE ON "result_publications" TO "campass_app";
  END IF;
END $$;
