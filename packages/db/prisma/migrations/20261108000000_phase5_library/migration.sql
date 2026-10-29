-- CAMPASS Phase 5 — Library: the DB foundation.
--
-- Hand-authored (Prisma's diff does not model RLS, the composite same-tenant
-- FKs, the two partial unique indexes, the CHECK constraints, the targeted GRANT
-- refresh, or the catalogue seed). This migration only CREATEs new objects and
-- ADDs the library.* permission/role seed; it NEVER ALTERs a Phase-0/1/2/3/4
-- table's RLS, grant, or FK, and NEVER touches the _prisma_migrations ledger.
-- campass_app stays NOSUPERUSER NOBYPASSRLS — never granted BYPASSRLS.
--
-- It NEVER alters any of the TEN FROZEN migrations
-- (20260824143031_add_allowance_and_reliability_models, 20261018100917_init,
-- 20261018110658_tenancy_isolation_rls, 20261018171747_identity_rbac_b2,
-- 20261019053533_superadmin_security, 20261019093119_module_system,
-- 20261027111710_phase1_academics, 20261027161616_phase2_sis,
-- 20261028000000_phase3_classes, 20261101000000_phase4_attendance).
--
-- FIVE new tenant-owned tables (book_titles, book_copies, library_loans,
-- book_reservations, library_fines) — all mutable, so all get the standard
-- RLS select+modify pair (NO append-only table this phase). Every table carries
-- institutionId + (id, institutionId) composite unique + (institutionId) index +
-- composite same-tenant FKs incl. institutionId + ENABLE+FORCE RLS.
--
-- Ordering (design §9, mirrors phase4_attendance sections a–j):
--   a. CREATE TYPE the seven new enums;
--   b. CREATE TABLE the five new tables + PKs (updatedAt NOT NULL on all five);
--   c. unique + query indexes (each (id,institutionId), book_copies
--      (institutionId, accessionNumber), every (institutionId) index + the §3
--      query indexes, the TWO partial uniques — one-active-loan-per-copy and
--      one-pending-reservation-per-student-title);
--   d. tenant-root FKs institutionId -> institutions(id) RESTRICT on all five;
--   e. composite same-tenant FKs (incl. institutionId) for copy->title,
--      loan->copy, loan->student, reservation->title, reservation->student,
--      reservation->fulfilledByCopy (nullable), fine->student, fine->loan
--      (nullable);
--   f. CHECK constraints (library_fines amount >= 0; non-empty accessionNumber,
--      title, author);
--   g. ENABLE+FORCE RLS on all five (standard fail-closed select+modify pair);
--   h. guarded campass_app GRANT refresh (full DML on all five);
--   i. seed the seven library.* permissions + role_permissions pairs (LIBRARIAN
--      x6, ADMIN x6, STUDENT x1) and the NEW LIBRARIAN template role row.

-- ─────────────────────────────────────────────────────────────────────────────
-- a. Enums.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "BookTitleStatus"       AS ENUM ('ACTIVE', 'WITHDRAWN');
CREATE TYPE "BookCopyCondition"     AS ENUM ('NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED');
CREATE TYPE "BookCopyStatus"        AS ENUM ('AVAILABLE', 'ISSUED', 'RESERVED', 'LOST', 'DAMAGED', 'WITHDRAWN');
CREATE TYPE "LibraryLoanStatus"     AS ENUM ('ACTIVE', 'RETURNED', 'OVERDUE', 'LOST');
CREATE TYPE "BookReservationStatus" AS ENUM ('PENDING', 'FULFILLED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "LibraryFineReason"     AS ENUM ('OVERDUE', 'LOST', 'DAMAGED');
CREATE TYPE "LibraryFineStatus"     AS ENUM ('PENDING', 'PAID', 'WAIVED');

-- ─────────────────────────────────────────────────────────────────────────────
-- b. New tenant-owned tables + PKs. createdAt DEFAULT CURRENT_TIMESTAMP; updatedAt
--    NOT NULL on all five (all mutable; no append-only table this phase).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "book_titles" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "title"           TEXT NOT NULL,
    "author"          TEXT NOT NULL,
    "publisher"       TEXT,
    "isbn"            TEXT,
    "category"        TEXT,
    "edition"         TEXT,
    "publicationYear" INTEGER,
    "status"          "BookTitleStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "book_titles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "book_copies" (
    "id"              TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "bookTitleId"     TEXT NOT NULL,
    "accessionNumber" TEXT NOT NULL,
    "shelfLocation"   TEXT,
    "condition"       "BookCopyCondition" NOT NULL DEFAULT 'GOOD',
    "status"          "BookCopyStatus" NOT NULL DEFAULT 'AVAILABLE',
    "acquiredAt"      TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "book_copies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "library_loans" (
    "id"             TEXT NOT NULL,
    "institutionId"  TEXT NOT NULL,
    "bookCopyId"     TEXT NOT NULL,
    "studentId"      TEXT NOT NULL,
    "issuedByUserId" TEXT NOT NULL,
    "issueDate"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate"        TIMESTAMP(3) NOT NULL,
    "returnDate"     TIMESTAMP(3),
    "renewalCount"   INTEGER NOT NULL DEFAULT 0,
    "status"         "LibraryLoanStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "library_loans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "book_reservations" (
    "id"                TEXT NOT NULL,
    "institutionId"     TEXT NOT NULL,
    "bookTitleId"       TEXT NOT NULL,
    "studentId"         TEXT NOT NULL,
    "reservedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queuePosition"     INTEGER NOT NULL,
    "status"            "BookReservationStatus" NOT NULL DEFAULT 'PENDING',
    "fulfilledByCopyId" TEXT,
    "fulfilledAt"       TIMESTAMP(3),
    "cancelledAt"       TIMESTAMP(3),
    "expiredAt"         TIMESTAMP(3),
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "book_reservations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "library_fines" (
    "id"                   TEXT NOT NULL,
    "institutionId"        TEXT NOT NULL,
    "studentId"            TEXT NOT NULL,
    "libraryLoanId"        TEXT,
    "amount"               DECIMAL(10,2) NOT NULL,
    "reason"               "LibraryFineReason" NOT NULL,
    "status"               "LibraryFineStatus" NOT NULL DEFAULT 'PENDING',
    "note"                 TEXT,
    "waivedByUserId"       TEXT,
    "paidRecordedByUserId" TEXT,
    "waivedAt"             TIMESTAMP(3),
    "paidAt"               TIMESTAMP(3),
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "library_fines_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- c. Unique + query indexes. Each table's (id, institutionId) composite unique
--    (anchors the composite same-tenant FKs); the business unique
--    (book_copies (institutionId, accessionNumber)); every (institutionId) index
--    + the §3 query indexes; and the TWO partial uniques (Prisma cannot express
--    partial indexes, so they are hand-authored here).
-- ─────────────────────────────────────────────────────────────────────────────
-- book_titles
CREATE UNIQUE INDEX "book_titles_id_institutionId_key"        ON "book_titles"("id", "institutionId");
CREATE INDEX        "book_titles_institutionId_idx"           ON "book_titles"("institutionId");
CREATE INDEX        "book_titles_institutionId_isbn_idx"      ON "book_titles"("institutionId", "isbn");
CREATE INDEX        "book_titles_institutionId_title_idx"     ON "book_titles"("institutionId", "title");

-- book_copies
CREATE UNIQUE INDEX "book_copies_institutionId_accessionNumber_key" ON "book_copies"("institutionId", "accessionNumber");
CREATE UNIQUE INDEX "book_copies_id_institutionId_key"              ON "book_copies"("id", "institutionId");
CREATE INDEX        "book_copies_institutionId_idx"                 ON "book_copies"("institutionId");
CREATE INDEX        "book_copies_institutionId_bookTitleId_idx"     ON "book_copies"("institutionId", "bookTitleId");
CREATE INDEX        "book_copies_institutionId_status_idx"          ON "book_copies"("institutionId", "status");

-- library_loans
CREATE UNIQUE INDEX "library_loans_id_institutionId_key"                 ON "library_loans"("id", "institutionId");
CREATE INDEX        "library_loans_institutionId_idx"                    ON "library_loans"("institutionId");
CREATE INDEX        "library_loans_institutionId_studentId_status_idx"   ON "library_loans"("institutionId", "studentId", "status");
CREATE INDEX        "library_loans_institutionId_status_dueDate_idx"     ON "library_loans"("institutionId", "status", "dueDate");
CREATE INDEX        "library_loans_institutionId_bookCopyId_idx"         ON "library_loans"("institutionId", "bookCopyId");
-- At most one ACTIVE loan per copy per tenant — the hard concurrency backstop (design §5.2).
CREATE UNIQUE INDEX "library_loans_one_active_per_copy" ON "library_loans"("institutionId", "bookCopyId") WHERE "status" = 'ACTIVE';

-- book_reservations
CREATE UNIQUE INDEX "book_reservations_id_institutionId_key"                          ON "book_reservations"("id", "institutionId");
CREATE INDEX        "book_reservations_institutionId_idx"                             ON "book_reservations"("institutionId");
CREATE INDEX        "book_reservations_institutionId_bookTitleId_status_queuePosition_idx" ON "book_reservations"("institutionId", "bookTitleId", "status", "queuePosition");
CREATE INDEX        "book_reservations_institutionId_studentId_status_idx"            ON "book_reservations"("institutionId", "studentId", "status");
-- One PENDING hold per student per title (design §3.4).
CREATE UNIQUE INDEX "book_reservations_one_pending_per_student_title" ON "book_reservations"("institutionId", "bookTitleId", "studentId") WHERE "status" = 'PENDING';

-- library_fines
CREATE UNIQUE INDEX "library_fines_id_institutionId_key"              ON "library_fines"("id", "institutionId");
CREATE INDEX        "library_fines_institutionId_idx"                 ON "library_fines"("institutionId");
CREATE INDEX        "library_fines_institutionId_studentId_status_idx" ON "library_fines"("institutionId", "studentId", "status");
CREATE INDEX        "library_fines_institutionId_status_idx"          ON "library_fines"("institutionId", "status");

-- ─────────────────────────────────────────────────────────────────────────────
-- d. Tenant-root FKs: institutionId -> institutions(id) ON DELETE RESTRICT on
--    all five new tables.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "book_titles"       ADD CONSTRAINT "book_titles_institutionId_fkey"       FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "book_copies"       ADD CONSTRAINT "book_copies_institutionId_fkey"       FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "library_loans"     ADD CONSTRAINT "library_loans_institutionId_fkey"     FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "book_reservations" ADD CONSTRAINT "book_reservations_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "library_fines"     ADD CONSTRAINT "library_fines_institutionId_fkey"     FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- e. Composite same-tenant FKs (tenancy.md §4, design §3/§9e). Each carries
--    institutionId so a child can never reference a parent in another tenant.
--    issuedByUserId / waivedByUserId / paidRecordedByUserId are recorded ids
--    with NO FK.
-- ─────────────────────────────────────────────────────────────────────────────
-- book_copies -> book_titles
ALTER TABLE "book_copies"
  ADD CONSTRAINT "book_copies_title_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "bookTitleId") REFERENCES "book_titles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- library_loans -> book_copies / student_profiles
ALTER TABLE "library_loans"
  ADD CONSTRAINT "library_loans_copy_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "bookCopyId") REFERENCES "book_copies"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "library_loans"
  ADD CONSTRAINT "library_loans_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- book_reservations -> book_titles / student_profiles / book_copies (fulfilled, nullable)
ALTER TABLE "book_reservations"
  ADD CONSTRAINT "book_reservations_title_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "bookTitleId") REFERENCES "book_titles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "book_reservations"
  ADD CONSTRAINT "book_reservations_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "book_reservations"
  ADD CONSTRAINT "book_reservations_fulfilled_copy_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "fulfilledByCopyId") REFERENCES "book_copies"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- library_fines -> student_profiles / library_loans (nullable)
ALTER TABLE "library_fines"
  ADD CONSTRAINT "library_fines_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId") REFERENCES "student_profiles"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "library_fines"
  ADD CONSTRAINT "library_fines_loan_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "libraryLoanId") REFERENCES "library_loans"("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- f. CHECK constraints (design §9f): a fine amount is non-negative; the headline
--    identity/bibliographic text fields are non-empty.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "library_fines"
  ADD CONSTRAINT "library_fines_amount_nonneg_check"
  CHECK ("amount" >= 0);
ALTER TABLE "book_copies"
  ADD CONSTRAINT "book_copies_accession_nonempty_check"
  CHECK (char_length("accessionNumber") >= 1);
ALTER TABLE "book_titles"
  ADD CONSTRAINT "book_titles_title_nonempty_check"
  CHECK (char_length("title") >= 1);
ALTER TABLE "book_titles"
  ADD CONSTRAINT "book_titles_author_nonempty_check"
  CHECK (char_length("author") >= 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- g. RLS. ENABLE + FORCE on all five. All five are mutable, so each gets the
--    standard fail-closed nullif-guarded pair {tenant_isolation_select,
--    tenant_isolation_modify}. nullif(current_setting('app.current_institution_id',
--    true), '') fails closed for both an unset and an empty-string GUC. NO
--    append-only table this phase.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  library_tables TEXT[] := ARRAY[
    'book_titles', 'book_copies', 'library_loans', 'book_reservations', 'library_fines'
  ];
BEGIN
  FOREACH t IN ARRAY library_tables LOOP
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
-- h. campass_app GRANT refresh (guarded + idempotent). All five tables are
--    mutable circulation tables and legitimately need full DML. Never grant
--    BYPASSRLS — campass_app stays NOSUPERUSER NOBYPASSRLS.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "book_titles"       TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "book_copies"       TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "library_loans"     TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "book_reservations" TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "library_fines"     TO "campass_app";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- i. Seed the seven library.* permissions + their role_permissions pairs, using
--    the same seed-block shape + join + markers the earlier seeds use so the
--    catalogue-sync meta-test parses this block too. The LIBRARIAN template role
--    is NEW (unlike FACULTY, which already existed) — so its "roles" row IS
--    inserted here. ROLE_PERMISSIONS lockstep (design §7.2): LIBRARIAN x6 staff
--    keys, ADMIN x6, STUDENT x1 (library.view_own); HOD/GUARD/FACULTY/SUPER_ADMIN
--    none.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "roles" ("id","key","name","institutionId") VALUES
  ('role_librarian', 'LIBRARIAN', 'Librarian', NULL)
ON CONFLICT DO NOTHING;

INSERT INTO "permissions" ("id","key","module","description") VALUES
  ('perm_library_books_view',         'library.books.view',         'library', 'Staff read of catalogue, copies, loans, reservations, reports'),
  ('perm_library_books_manage',       'library.books.manage',       'library', 'Create/edit BookTitle + register/edit BookCopy (acquisition, condition, withdraw)'),
  ('perm_library_issue',              'library.issue',              'library', 'Issue a copy to a student (concurrency-safe)'),
  ('perm_library_return',             'library.return',             'library', 'Return / renew a loan; mark lost/damaged'),
  ('perm_library_reservations_manage','library.reservations.manage','library', 'Fulfil / cancel / expire reservations on behalf of circulation'),
  ('perm_library_fines_manage',       'library.fines.manage',       'library', 'Create (rule-driven) / waive / mark-paid a LibraryFine'),
  ('perm_library_view_own',           'library.view_own',           'library', 'A student reads only their own loans/history/reservations/fines and searches the catalogue; requests/cancels their own reservations')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('LIBRARIAN', 'library.books.view'),
  ('LIBRARIAN', 'library.books.manage'),
  ('LIBRARIAN', 'library.issue'),
  ('LIBRARIAN', 'library.return'),
  ('LIBRARIAN', 'library.reservations.manage'),
  ('LIBRARIAN', 'library.fines.manage'),
  ('ADMIN',     'library.books.view'),
  ('ADMIN',     'library.books.manage'),
  ('ADMIN',     'library.issue'),
  ('ADMIN',     'library.return'),
  ('ADMIN',     'library.reservations.manage'),
  ('ADMIN',     'library.fines.manage'),
  ('STUDENT',   'library.view_own')
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
