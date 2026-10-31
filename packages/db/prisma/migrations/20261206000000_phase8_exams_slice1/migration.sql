-- CAMPASS Phase 8 — Examinations & Results, SLICE 8.1 (backend only): the exam
-- DB foundation — exam lifecycle, capacity-aware scheduling/room allocation,
-- candidate registration, weighted assessment components, faculty-scoped marks
-- entry with audited append-only corrections, moderation/approval, a
-- deterministic grading engine, and controlled append-only versioned result
-- publication (step-up-gated). Access-and-correctness-critical (the exam analog
-- of money-critical): unpublished results are invisible to students, marks
-- integrity is trigger-enforced, publication is irreversible-by-default.
--
-- Hand-authored (Prisma's diff does not model RLS, the composite same-tenant
-- FKs, the partial unique index, the (institutionId,examId,version) unique, the
-- CHECK constraints, the append-only triggers, the column guards, the targeted
-- GRANT refresh, or the catalogue seed). STRICTLY ADDITIVE: this migration only
-- CREATEs new objects. It NEVER drops an existing table, never ALTERs a frozen
-- table's RLS/grant/FK, never touches the _prisma_migrations ledger, and never
-- edits any of the FOURTEEN frozen migration directories:
--   20261018171747_identity_rbac_b2, 20261019053533_superadmin_security,
--   20261019093119_module_system, 20261027111710_phase1_academics,
--   20261027161616_phase2_sis, 20261028000000_phase3_classes,
--   20261101000000_phase4_attendance, 20261108000000_phase5_library,
--   20261115000000_phase6_admissions, 20261122000000_phase7_fees_slice1,
--   20261129000000_phase7_fees_slice2, plus the three earliest base dirs.
-- campass_app stays NOSUPERUSER NOBYPASSRLS — never granted BYPASSRLS.
--
-- NINE new tenant-owned tables, in three table classes (design §7.3):
--   * Mutable, standard RLS pair + no guard: grading_schemes, grade_bands,
--     exam_schedules, assessments, candidates.
--   * Forward-only column-guard (standard RLS pair + guard trigger):
--     examinations (status lifecycle), marks_records (identity frozen, DELETE
--     forbidden).
--   * Append-only INSERT-only (append-only RLS pair + append-only trigger):
--     marks_record_history, result_publications, result_snapshots.
-- Every table carries institutionId + (id, institutionId) composite unique +
-- (institutionId) index + composite same-tenant FKs incl. institutionId +
-- ENABLE+FORCE RLS.
--
-- Ordering (mirrors fees-slice2 sections a–j):
--   a. CREATE TYPE the four new enums;
--   b. CREATE TABLE the nine new tables + PKs (updatedAt NOT NULL only on the
--      six mutable/column-guard tables; the three INSERT-only tables have none);
--   c. (id,institutionId) uniques + business uniques + (institutionId)/query
--      indexes + the partial unique candidates_schedule_seat_unique + the
--      (institutionId,examId,version) unique on result_publications;
--   d. tenant-root institutionId -> institutions(id) RESTRICT on all nine;
--   e. composite same-tenant FKs incl. institutionId;
--   f. CHECKs;
--   g. ENABLE+FORCE RLS (standard pair on the seven mutable/column-guard tables;
--      append-only SELECT + <table>_tenant_insert on the three INSERT-only);
--   h. triggers: examinations_guard() + marks_records_guard() column guards +
--      the three <table>_append_only() + BEFORE UPDATE OR DELETE triggers;
--   i. guarded campass_app GRANT refresh;
--   j. catalogue seed: the eight exams.* permissions + the fourteen
--      role_permissions pairs (ADMIN six, HOD six, FACULTY one, STUDENT one).

-- ─────────────────────────────────────────────────────────────────────────────
-- a. Enums.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "ExaminationType"   AS ENUM ('MIDTERM', 'FINAL', 'INTERNAL', 'SUPPLEMENTARY');
CREATE TYPE "ExaminationStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'MARKS_OPEN', 'MARKS_LOCKED', 'MODERATION', 'APPROVED', 'PUBLISHED');
CREATE TYPE "MarksRecordHistoryChangeType" AS ENUM ('MARKED', 'CORRECTED');
-- ResultPublicationStatus: 8.1 writes 'PUBLISHED' ONLY. 'SUPERSEDED' is RESERVED
-- for slice 8.2 and MUST NOT be written by any 8.1 code path — the append-only
-- trigger forbids UPDATE, so a prior row can never be flipped to SUPERSEDED;
-- "superseded" is DERIVED as version < max(version) for the (institution,exam)
-- scope. The variant is retained so 8.2 re-evaluation is purely additive.
CREATE TYPE "ResultPublicationStatus" AS ENUM ('PUBLISHED', 'SUPERSEDED');

-- ─────────────────────────────────────────────────────────────────────────────
-- b. New tenant-owned tables + PKs. updatedAt NOT NULL on the six
--    mutable/column-guard tables; the three INSERT-only tables have none.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "examinations" (
    "id"                TEXT NOT NULL,
    "institutionId"     TEXT NOT NULL,
    "academicSessionId" TEXT NOT NULL,
    "academicTermId"    TEXT NOT NULL,
    "programId"         TEXT NOT NULL,
    "name"              TEXT NOT NULL,
    "type"              "ExaminationType" NOT NULL,
    "status"            "ExaminationStatus" NOT NULL DEFAULT 'DRAFT',
    "createdByUserId"   TEXT NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "examinations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "grading_schemes" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "isActive"        BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grading_schemes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "grade_bands" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "gradingSchemeId" TEXT NOT NULL,
    "minPercentBps"   INTEGER NOT NULL,
    "maxPercentBps"   INTEGER NOT NULL,
    "gradeLabel"      TEXT NOT NULL,
    "gradePoints"     INTEGER NOT NULL,
    "isPassing"       BOOLEAN NOT NULL,
    "ordinal"         INTEGER NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grade_bands_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "exam_schedules" (
    "id"            TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "examId"        TEXT NOT NULL,
    "subjectId"     TEXT NOT NULL,
    "room"          TEXT NOT NULL,
    "roomCapacity"  INTEGER NOT NULL,
    "startsAt"      TIMESTAMP(3) NOT NULL,
    "endsAt"        TIMESTAMP(3) NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exam_schedules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "candidates" (
    "id"             TEXT NOT NULL,
    "institutionId"  TEXT NOT NULL,
    "examId"         TEXT NOT NULL,
    "studentId"      TEXT NOT NULL,
    "examScheduleId" TEXT,
    "seatNo"         TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assessments" (
    "id"            TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "examId"        TEXT NOT NULL,
    "subjectId"     TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "maxMarks"      INTEGER NOT NULL,
    "weight"        INTEGER NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assessments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "marks_records" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "examId"          TEXT NOT NULL,
    "assessmentId"    TEXT NOT NULL,
    "candidateId"     TEXT NOT NULL,
    "studentId"       TEXT NOT NULL,
    "marks"           INTEGER NOT NULL,
    "enteredByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marks_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "marks_record_history" (
    "id"                TEXT NOT NULL,
    "institutionId"     TEXT NOT NULL,
    "marksRecordId"     TEXT NOT NULL,
    "changeType"        "MarksRecordHistoryChangeType" NOT NULL,
    "previousMarks"     INTEGER,
    "newMarks"          INTEGER NOT NULL,
    "actorUserId"       TEXT NOT NULL,
    "actorMembershipId" TEXT,
    "reason"            TEXT,
    "metadata"          JSONB,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marks_record_history_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "result_publications" (
    "id"                TEXT NOT NULL,
    "institutionId"     TEXT NOT NULL,
    "examId"            TEXT NOT NULL,
    "version"           INTEGER NOT NULL,
    "status"            "ResultPublicationStatus" NOT NULL DEFAULT 'PUBLISHED',
    "gradingSchemeId"   TEXT NOT NULL,
    "publishedByUserId" TEXT NOT NULL,
    "reason"            TEXT,
    "publishedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_publications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "result_snapshots" (
    "id"                  TEXT NOT NULL,
    "institutionId"       TEXT NOT NULL,
    "resultPublicationId" TEXT NOT NULL,
    "examId"              TEXT NOT NULL,
    "candidateId"         TEXT NOT NULL,
    "studentId"           TEXT NOT NULL,
    "subjectId"           TEXT NOT NULL,
    "percentBps"          INTEGER NOT NULL,
    "gradeLabel"          TEXT NOT NULL,
    "gradePoints"         INTEGER NOT NULL,
    "passed"              BOOLEAN NOT NULL,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_snapshots_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- c. Unique + query indexes. (id, institutionId) composite uniques anchor the
--    composite same-tenant FKs; business uniques; (institutionId) + per-table
--    query indexes; the partial unique candidates_schedule_seat_unique (seat
--    double-booking backstop); the (institutionId, examId, version) unique.
-- ─────────────────────────────────────────────────────────────────────────────
-- examinations
CREATE UNIQUE INDEX "examinations_id_institutionId_key"            ON "examinations"("id", "institutionId");
CREATE INDEX        "examinations_institutionId_idx"               ON "examinations"("institutionId");
CREATE INDEX        "examinations_institutionId_academicTermId_idx" ON "examinations"("institutionId", "academicTermId");
CREATE INDEX        "examinations_institutionId_programId_idx"     ON "examinations"("institutionId", "programId");
CREATE INDEX        "examinations_institutionId_status_idx"        ON "examinations"("institutionId", "status");

-- grading_schemes
CREATE UNIQUE INDEX "grading_schemes_id_institutionId_key"   ON "grading_schemes"("id", "institutionId");
CREATE UNIQUE INDEX "grading_schemes_institutionId_name_key" ON "grading_schemes"("institutionId", "name");
CREATE INDEX        "grading_schemes_institutionId_idx"      ON "grading_schemes"("institutionId");

-- grade_bands
CREATE UNIQUE INDEX "grade_bands_id_institutionId_key"                        ON "grade_bands"("id", "institutionId");
CREATE UNIQUE INDEX "grade_bands_institutionId_gradingSchemeId_ordinal_key"   ON "grade_bands"("institutionId", "gradingSchemeId", "ordinal");
CREATE INDEX        "grade_bands_institutionId_idx"                           ON "grade_bands"("institutionId");
CREATE INDEX        "grade_bands_institutionId_gradingSchemeId_idx"           ON "grade_bands"("institutionId", "gradingSchemeId");

-- exam_schedules
CREATE UNIQUE INDEX "exam_schedules_id_institutionId_key"              ON "exam_schedules"("id", "institutionId");
CREATE UNIQUE INDEX "exam_schedules_institutionId_examId_subjectId_key" ON "exam_schedules"("institutionId", "examId", "subjectId");
CREATE INDEX        "exam_schedules_institutionId_idx"                 ON "exam_schedules"("institutionId");
CREATE INDEX        "exam_schedules_institutionId_examId_idx"          ON "exam_schedules"("institutionId", "examId");

-- candidates
CREATE UNIQUE INDEX "candidates_id_institutionId_key"              ON "candidates"("id", "institutionId");
CREATE UNIQUE INDEX "candidates_examId_studentId_key"             ON "candidates"("examId", "studentId");
CREATE INDEX        "candidates_institutionId_idx"                ON "candidates"("institutionId");
CREATE INDEX        "candidates_institutionId_examId_idx"         ON "candidates"("institutionId", "examId");
CREATE INDEX        "candidates_institutionId_studentId_idx"      ON "candidates"("institutionId", "studentId");
CREATE INDEX        "candidates_institutionId_examScheduleId_idx" ON "candidates"("institutionId", "examScheduleId");
-- Partial unique: no two candidates share a seat within the same room. NULLs
-- (unallocated candidates) are exempt. Prisma cannot express a partial unique.
CREATE UNIQUE INDEX "candidates_schedule_seat_unique"
  ON "candidates"("institutionId", "examScheduleId", "seatNo")
  WHERE "examScheduleId" IS NOT NULL AND "seatNo" IS NOT NULL;

-- assessments
CREATE UNIQUE INDEX "assessments_id_institutionId_key"                     ON "assessments"("id", "institutionId");
CREATE UNIQUE INDEX "assessments_institutionId_examId_subjectId_name_key"  ON "assessments"("institutionId", "examId", "subjectId", "name");
CREATE INDEX        "assessments_institutionId_idx"                        ON "assessments"("institutionId");
CREATE INDEX        "assessments_institutionId_examId_subjectId_idx"       ON "assessments"("institutionId", "examId", "subjectId");

-- marks_records
CREATE UNIQUE INDEX "marks_records_id_institutionId_key"             ON "marks_records"("id", "institutionId");
CREATE UNIQUE INDEX "marks_records_assessmentId_candidateId_key"     ON "marks_records"("assessmentId", "candidateId");
CREATE INDEX        "marks_records_institutionId_idx"                ON "marks_records"("institutionId");
CREATE INDEX        "marks_records_institutionId_examId_idx"         ON "marks_records"("institutionId", "examId");
CREATE INDEX        "marks_records_institutionId_assessmentId_idx"   ON "marks_records"("institutionId", "assessmentId");
CREATE INDEX        "marks_records_institutionId_candidateId_idx"    ON "marks_records"("institutionId", "candidateId");

-- marks_record_history
CREATE UNIQUE INDEX "marks_record_history_id_institutionId_key"           ON "marks_record_history"("id", "institutionId");
CREATE INDEX        "marks_record_history_institutionId_idx"              ON "marks_record_history"("institutionId");
CREATE INDEX        "marks_record_history_institutionId_marksRecordId_idx" ON "marks_record_history"("institutionId", "marksRecordId");

-- result_publications
CREATE UNIQUE INDEX "result_publications_id_institutionId_key"            ON "result_publications"("id", "institutionId");
CREATE UNIQUE INDEX "result_publications_institutionId_examId_version_key" ON "result_publications"("institutionId", "examId", "version");
CREATE INDEX        "result_publications_institutionId_idx"               ON "result_publications"("institutionId");
CREATE INDEX        "result_publications_institutionId_examId_idx"        ON "result_publications"("institutionId", "examId");

-- result_snapshots
CREATE UNIQUE INDEX "result_snapshots_id_institutionId_key"                               ON "result_snapshots"("id", "institutionId");
CREATE UNIQUE INDEX "result_snapshots_resultPublicationId_candidateId_subjectId_key"      ON "result_snapshots"("resultPublicationId", "candidateId", "subjectId");
CREATE INDEX        "result_snapshots_institutionId_idx"                                  ON "result_snapshots"("institutionId");
CREATE INDEX        "result_snapshots_institutionId_resultPublicationId_idx"              ON "result_snapshots"("institutionId", "resultPublicationId");
CREATE INDEX        "result_snapshots_institutionId_studentId_idx"                        ON "result_snapshots"("institutionId", "studentId");
CREATE INDEX        "result_snapshots_institutionId_examId_subjectId_idx"                 ON "result_snapshots"("institutionId", "examId", "subjectId");

-- ─────────────────────────────────────────────────────────────────────────────
-- d. Tenant-root FKs: institutionId -> institutions(id) RESTRICT on all nine.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "examinations"         ADD CONSTRAINT "examinations_institutionId_fkey"         FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "grading_schemes"      ADD CONSTRAINT "grading_schemes_institutionId_fkey"      FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "grade_bands"          ADD CONSTRAINT "grade_bands_institutionId_fkey"          FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "exam_schedules"       ADD CONSTRAINT "exam_schedules_institutionId_fkey"       FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "candidates"           ADD CONSTRAINT "candidates_institutionId_fkey"           FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assessments"          ADD CONSTRAINT "assessments_institutionId_fkey"          FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marks_records"        ADD CONSTRAINT "marks_records_institutionId_fkey"        FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marks_record_history" ADD CONSTRAINT "marks_record_history_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "result_publications"  ADD CONSTRAINT "result_publications_institutionId_fkey"  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "result_snapshots"     ADD CONSTRAINT "result_snapshots_institutionId_fkey"     FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- e. Composite same-tenant FKs (each carries institutionId so a child can never
--    reference a parent in another tenant). createdByUserId / enteredByUserId /
--    publishedByUserId / actorUserId are recorded actor ids with NO FK (the
--    fees/attendance precedent). All ON DELETE RESTRICT ON UPDATE CASCADE.
-- ─────────────────────────────────────────────────────────────────────────────
-- examinations -> academic_sessions / academic_terms / programs
ALTER TABLE "examinations"
  ADD CONSTRAINT "examinations_session_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicSessionId") REFERENCES "academic_sessions"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "examinations"
  ADD CONSTRAINT "examinations_term_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicTermId") REFERENCES "academic_terms"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "examinations"
  ADD CONSTRAINT "examinations_program_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "programId") REFERENCES "programs"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- grade_bands -> grading_schemes
ALTER TABLE "grade_bands"
  ADD CONSTRAINT "grade_bands_scheme_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "gradingSchemeId") REFERENCES "grading_schemes"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- exam_schedules -> examinations / subjects
ALTER TABLE "exam_schedules"
  ADD CONSTRAINT "exam_schedules_exam_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "examId") REFERENCES "examinations"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "exam_schedules"
  ADD CONSTRAINT "exam_schedules_subject_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "subjectId") REFERENCES "subjects"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- candidates -> examinations / student_profiles / exam_schedules (nullable)
ALTER TABLE "candidates"
  ADD CONSTRAINT "candidates_exam_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "examId") REFERENCES "examinations"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "candidates"
  ADD CONSTRAINT "candidates_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "candidates"
  ADD CONSTRAINT "candidates_schedule_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "examScheduleId") REFERENCES "exam_schedules"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- assessments -> examinations / subjects
ALTER TABLE "assessments"
  ADD CONSTRAINT "assessments_exam_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "examId") REFERENCES "examinations"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assessments"
  ADD CONSTRAINT "assessments_subject_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "subjectId") REFERENCES "subjects"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- marks_records -> examinations / assessments / candidates / student_profiles
ALTER TABLE "marks_records"
  ADD CONSTRAINT "marks_records_exam_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "examId") REFERENCES "examinations"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marks_records"
  ADD CONSTRAINT "marks_records_assessment_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "assessmentId") REFERENCES "assessments"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marks_records"
  ADD CONSTRAINT "marks_records_candidate_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "candidateId") REFERENCES "candidates"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marks_records"
  ADD CONSTRAINT "marks_records_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- marks_record_history -> marks_records
ALTER TABLE "marks_record_history"
  ADD CONSTRAINT "marks_record_history_record_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "marksRecordId") REFERENCES "marks_records"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- result_publications -> examinations / grading_schemes
ALTER TABLE "result_publications"
  ADD CONSTRAINT "result_publications_exam_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "examId") REFERENCES "examinations"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "result_publications"
  ADD CONSTRAINT "result_publications_scheme_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "gradingSchemeId") REFERENCES "grading_schemes"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- result_snapshots -> result_publications / examinations / candidates / student_profiles / subjects
ALTER TABLE "result_snapshots"
  ADD CONSTRAINT "result_snapshots_publication_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "resultPublicationId") REFERENCES "result_publications"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "result_snapshots"
  ADD CONSTRAINT "result_snapshots_exam_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "examId") REFERENCES "examinations"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "result_snapshots"
  ADD CONSTRAINT "result_snapshots_candidate_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "candidateId") REFERENCES "candidates"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "result_snapshots"
  ADD CONSTRAINT "result_snapshots_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "result_snapshots"
  ADD CONSTRAINT "result_snapshots_subject_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "subjectId") REFERENCES "subjects"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- f. CHECK constraints (design §7.2 / §17). Non-empty names/rooms/labels;
--    positive maxMarks/roomCapacity; weight 1..100; basis-point ranges; version
--    >= 1; percentBps 0..10000; gradePoints >= 0; marks >= 0 (upper bound is the
--    cross-table service invariant). The multi-row weight-sum=100 invariant is
--    SERVICE-owned (a single-row CHECK cannot express a cross-row sum).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "examinations"
  ADD CONSTRAINT "examinations_name_nonempty_check" CHECK (char_length("name") >= 1);

ALTER TABLE "grading_schemes"
  ADD CONSTRAINT "grading_schemes_name_nonempty_check" CHECK (char_length("name") >= 1);

ALTER TABLE "grade_bands"
  ADD CONSTRAINT "grade_bands_min_nonneg_check" CHECK ("minPercentBps" >= 0);
ALTER TABLE "grade_bands"
  ADD CONSTRAINT "grade_bands_max_range_check" CHECK ("maxPercentBps" <= 10000);
ALTER TABLE "grade_bands"
  ADD CONSTRAINT "grade_bands_min_le_max_check" CHECK ("minPercentBps" <= "maxPercentBps");
ALTER TABLE "grade_bands"
  ADD CONSTRAINT "grade_bands_points_nonneg_check" CHECK ("gradePoints" >= 0);
ALTER TABLE "grade_bands"
  ADD CONSTRAINT "grade_bands_label_nonempty_check" CHECK (char_length("gradeLabel") >= 1);

ALTER TABLE "exam_schedules"
  ADD CONSTRAINT "exam_schedules_capacity_positive_check" CHECK ("roomCapacity" > 0);
ALTER TABLE "exam_schedules"
  ADD CONSTRAINT "exam_schedules_time_order_check" CHECK ("endsAt" > "startsAt");
ALTER TABLE "exam_schedules"
  ADD CONSTRAINT "exam_schedules_room_nonempty_check" CHECK (char_length("room") >= 1);

ALTER TABLE "assessments"
  ADD CONSTRAINT "assessments_maxmarks_positive_check" CHECK ("maxMarks" > 0);
ALTER TABLE "assessments"
  ADD CONSTRAINT "assessments_weight_range_check" CHECK ("weight" BETWEEN 1 AND 100);
ALTER TABLE "assessments"
  ADD CONSTRAINT "assessments_name_nonempty_check" CHECK (char_length("name") >= 1);

ALTER TABLE "marks_records"
  ADD CONSTRAINT "marks_records_marks_nonneg_check" CHECK ("marks" >= 0);

ALTER TABLE "result_publications"
  ADD CONSTRAINT "result_publications_version_positive_check" CHECK ("version" >= 1);

ALTER TABLE "result_snapshots"
  ADD CONSTRAINT "result_snapshots_percent_range_check" CHECK ("percentBps" BETWEEN 0 AND 10000);
ALTER TABLE "result_snapshots"
  ADD CONSTRAINT "result_snapshots_points_nonneg_check" CHECK ("gradePoints" >= 0);

-- ─────────────────────────────────────────────────────────────────────────────
-- g. RLS. ENABLE + FORCE on all nine. The seven mutable/column-guard tables get
--    the standard fail-closed nullif-guarded pair {tenant_isolation_select,
--    tenant_isolation_modify} (the column guards enforce immutability at the row
--    level, so they still carry a modify policy — the payment_transactions
--    rationale). The three INSERT-only tables get the append-only pair
--    {tenant_isolation_select, <table>_tenant_insert} with NO modify policy.
--    nullif(current_setting('app.current_institution_id', true), '') fails closed
--    for both an unset and an empty-string GUC.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  mutable_tables TEXT[] := ARRAY[
    'examinations', 'grading_schemes', 'grade_bands', 'exam_schedules',
    'candidates', 'assessments', 'marks_records'
  ];
  append_only_tables TEXT[] := ARRAY[
    'marks_record_history', 'result_publications', 'result_snapshots'
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
--   h.1 examinations_guard() column guard (forward-only lifecycle): immutable
--       scope/identity columns, terminal PUBLISHED frozen, enumerated
--       forward-only transitions, raise on DELETE.
--   h.2 marks_records_guard() column guard: immutable identity columns, raise on
--       DELETE (marks + updatedAt may change; the MARKS_OPEN-vs-correction gate
--       is a SERVICE check because the row has no exam-status context).
--   h.3 the three INSERT-only tables get <table>_append_only() raising
--       restrict_violation, bound by BEFORE UPDATE OR DELETE ... FOR EACH ROW
--       (binds the owner too — GRANTs alone cannot restrict the owner).
-- ─────────────────────────────────────────────────────────────────────────────

-- h.1 examinations column guard (forward-only lifecycle).
CREATE OR REPLACE FUNCTION "examinations_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'examinations is append-only'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- immutable scope/identity columns
  IF NEW."institutionId"     IS DISTINCT FROM OLD."institutionId"
  OR NEW."academicSessionId" IS DISTINCT FROM OLD."academicSessionId"
  OR NEW."academicTermId"    IS DISTINCT FROM OLD."academicTermId"
  OR NEW."programId"         IS DISTINCT FROM OLD."programId"
  OR NEW."type"              IS DISTINCT FROM OLD."type"
  OR NEW."createdByUserId"   IS DISTINCT FROM OLD."createdByUserId"
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
CREATE TRIGGER "examinations_guard"
  BEFORE UPDATE OR DELETE ON "examinations"
  FOR EACH ROW EXECUTE FUNCTION "examinations_guard"();

-- h.2 marks_records column guard (identity frozen, DELETE forbidden).
CREATE OR REPLACE FUNCTION "marks_records_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'marks_records is append-only'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."institutionId" IS DISTINCT FROM OLD."institutionId"
  OR NEW."examId"        IS DISTINCT FROM OLD."examId"
  OR NEW."assessmentId"  IS DISTINCT FROM OLD."assessmentId"
  OR NEW."candidateId"   IS DISTINCT FROM OLD."candidateId"
  OR NEW."studentId"     IS DISTINCT FROM OLD."studentId"
  THEN
    RAISE EXCEPTION 'immutable marks_records column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "marks_records_guard"
  BEFORE UPDATE OR DELETE ON "marks_records"
  FOR EACH ROW EXECUTE FUNCTION "marks_records_guard"();

-- h.3 marks_record_history (append-only).
CREATE OR REPLACE FUNCTION "marks_record_history_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'marks_record_history is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "marks_record_history_no_update_delete"
  BEFORE UPDATE OR DELETE ON "marks_record_history"
  FOR EACH ROW EXECUTE FUNCTION "marks_record_history_append_only"();

-- h.3 result_publications (append-only).
CREATE OR REPLACE FUNCTION "result_publications_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'result_publications is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "result_publications_no_update_delete"
  BEFORE UPDATE OR DELETE ON "result_publications"
  FOR EACH ROW EXECUTE FUNCTION "result_publications_append_only"();

-- h.3 result_snapshots (append-only).
CREATE OR REPLACE FUNCTION "result_snapshots_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'result_snapshots is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "result_snapshots_no_update_delete"
  BEFORE UPDATE OR DELETE ON "result_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "result_snapshots_append_only"();

-- ─────────────────────────────────────────────────────────────────────────────
-- i. campass_app GRANT refresh (guarded + idempotent). Full DML on the seven
--    mutable/column-guard tables (their RLS + the column guards enforce
--    immutability at the row level); SELECT, INSERT + REVOKE UPDATE, DELETE on
--    the three INSERT-only tables. Never grant BYPASSRLS.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "examinations"    TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "grading_schemes" TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "grade_bands"     TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "exam_schedules"  TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "candidates"      TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "assessments"     TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "marks_records"   TO "campass_app";

    GRANT SELECT, INSERT ON "marks_record_history" TO "campass_app";
    REVOKE UPDATE, DELETE ON "marks_record_history" FROM "campass_app";
    GRANT SELECT, INSERT ON "result_publications"  TO "campass_app";
    REVOKE UPDATE, DELETE ON "result_publications"  FROM "campass_app";
    GRANT SELECT, INSERT ON "result_snapshots"     TO "campass_app";
    REVOKE UPDATE, DELETE ON "result_snapshots"     FROM "campass_app";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- j. Catalogue seed. The eight exams.* permissions + the fourteen
--    role_permissions pairs (ADMIN six, HOD six, FACULTY one, STUDENT one). NO
--    new roles row (reuse ADMIN/HOD/FACULTY/STUDENT template roles). The block
--    shapes mirror the catalogue-sync parser's expectations (the permissions
--    span is sliced up to its ON CONFLICT clause; the role_permissions span is
--    sliced up to its `AS m(` VALUES alias). Separation of duties (§12): ADMIN
--    never gains exams.marks.enter; ADMIN never gets the STUDENT-only
--    exams.results.view_own.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_exams_manage',             'exams.manage',             'examinations', 'Create/update examinations, schedules, assessments; status advance to APPROVED'),
  ('perm_exams_grading_manage',     'exams.grading.manage',     'examinations', 'Create/update grading schemes + bands'),
  ('perm_exams_candidates_manage',  'exams.candidates.manage',  'examinations', 'Register candidates; allocate rooms'),
  ('perm_exams_marks_enter',        'exams.marks.enter',        'examinations', 'Enter/edit own in-scope marks (scope enforced in service)'),
  ('perm_exams_moderate',           'exams.moderate',           'examinations', 'Lock marks, run moderation corrections, approve'),
  ('perm_exams_results_publish',    'exams.results.publish',    'examinations', 'Publish results (step-up-gated)'),
  ('perm_exams_results_view',       'exams.results.view',       'examinations', 'Staff read of unpublished + published results/reports'),
  ('perm_exams_results_view_own',   'exams.results.view_own',   'examinations', 'Student read of OWN latest PUBLISHED result only')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('ADMIN',   'exams.manage'),
  ('ADMIN',   'exams.grading.manage'),
  ('ADMIN',   'exams.candidates.manage'),
  ('ADMIN',   'exams.moderate'),
  ('ADMIN',   'exams.results.publish'),
  ('ADMIN',   'exams.results.view'),
  ('HOD',     'exams.manage'),
  ('HOD',     'exams.grading.manage'),
  ('HOD',     'exams.candidates.manage'),
  ('HOD',     'exams.moderate'),
  ('HOD',     'exams.results.publish'),
  ('HOD',     'exams.results.view'),
  ('FACULTY', 'exams.marks.enter'),
  ('STUDENT', 'exams.results.view_own')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
