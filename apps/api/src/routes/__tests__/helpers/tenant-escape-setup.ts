/**
 * Real-database setup for the cross-tenant escape suite (tenancy.md §7).
 *
 * This is the ONLY api test that hits the live Supabase instance. It uses two
 * connections:
 *   - appClient  : connects as `campass_app` (NOSUPERUSER NOBYPASSRLS) via the
 *                  transaction pooler (apps/api/.env DATABASE_URL). RLS enforces
 *                  for this role, so the escape tests exercise it through
 *                  `withTenant`.
 *   - adminClient: connects as `postgres` (bypasses RLS) via the session pooler
 *                  (packages/db/.env DIRECT_URL). Used ONLY in setup/teardown to
 *                  seed and delete the two test institutions and to inspect
 *                  pg_catalog in the meta-test.
 *
 * It seeds two institutions (A and B) with overlapping-shaped data so cross-tenant
 * IDs are plausible, and tears that data down afterwards (scoped by captured IDs /
 * the ESCAPE_TEST_ prefix — never a blanket delete).
 *
 * Secret values are read from the .env files into env vars and never printed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../../..");
const apiEnvPath = path.join(repoRoot, "apps", "api", ".env");
const dbEnvPath = path.join(repoRoot, "packages", "db", ".env");

/** Minimal .env parser (KEY="value" / KEY=value), ignores comments/blank lines. */
function parseEnv(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const apiEnv = parseEnv(apiEnvPath);
const dbEnv = parseEnv(dbEnvPath);

const appDatabaseUrl = apiEnv.DATABASE_URL; // campass_app (RLS-subject)
const adminDatabaseUrl = dbEnv.DIRECT_URL ?? dbEnv.DATABASE_URL; // postgres (RLS-bypass)

if (!appDatabaseUrl) throw new Error("apps/api/.env DATABASE_URL not found");
if (!adminDatabaseUrl) throw new Error("packages/db/.env DIRECT_URL not found");

// Pin the shared @campusgate/db singleton to the campass_app connection BEFORE it
// is imported, so `withTenant` runs through the RLS-subject role.
process.env.DATABASE_URL = appDatabaseUrl;

/** campass_app connection — the RLS-subject client the escape tests exercise. */
export const appClient = new PrismaClient({
  datasources: { db: { url: appDatabaseUrl } },
  log: ["error"],
});

/** postgres connection — bypasses RLS; setup/teardown + pg_catalog inspection only. */
export const adminClient = new PrismaClient({
  datasources: { db: { url: adminDatabaseUrl } },
  log: ["error"],
});

/** Unique marker so teardown deletes exactly what setup created. */
export const PREFIX = "ESCAPE_TEST_";

export interface SeededTenant {
  institutionId: string;
  departmentId: string;
  userId: string;
  studentProfileId: string;
  reasonId: string;
  gateId: string;
  gatePassId: string;
  membershipId: string;
  membershipRoleId: string;
  institutionModuleId: string;
  // FEAT-003 academics tables (design §10.1). The append-only revision table is
  // NOT seeded here (the trigger blocks even adminClient — audit_events precedent).
  academicSessionId: string;
  academicTermId: string;
  programId: string;
  calendarDayId: string;
  // FEAT-003 SIS tables (design §9.3). student_documents is seeded (standard
  // pair, child of the seeded studentProfile); student_profile_history is NOT
  // seeded — its BEFORE UPDATE OR DELETE trigger blocks even adminClient in the
  // shared teardown (the audit_events / academic_calendar_day_revisions
  // precedent). Its append-only behaviour is proven by the self-contained case
  // in the escape suite + the SIS regression suite.
  studentDocumentId: string;
  // FEAT-004 Phase-3 classes tables (design §6). The eight mutable tables are
  // seeded here (standard RLS pair) so the read/spoofed-write/foreign-parent
  // escape tests can prove campass_app cannot see or forge the other tenant's
  // rows. The ninth table, schedule_revisions, is append-only (its trigger
  // blocks UPDATE/DELETE even for adminClient), so it is EXCLUDED from this
  // generic seed/cleanup loop and proven by the self-contained case in the
  // escape suite — the audit_events / student_profile_history precedent.
  courseId: string;
  subjectId: string;
  classSectionId: string;
  classEnrollmentId: string;
  facultyUserId: string;
  facultyProfileId: string;
  facultyAssignmentId: string;
  timetableId: string;
  scheduledClassId: string;
  // Phase-4 attendance MUTABLE tables (design §9). The three mutable tables are
  // seeded here (standard RLS pair). attendance_record_history is append-only
  // (its trigger blocks UPDATE/DELETE even for adminClient), so it is EXCLUDED
  // from this generic seed/cleanup loop and proven by the self-contained case —
  // the schedule_revisions / student_profile_history precedent.
  attendanceSessionId: string;
  attendanceRecordId: string;
  attendanceCorrectionId: string;
  // Phase-5 library tables (design §3). The five tables all use the standard RLS
  // pair (no append-only table this phase), so they are seeded here in child-safe
  // order (title -> copy -> loan/reservation/fine) and torn down child-first. The
  // seeded loan flips its copy to ISSUED; a second copy stays AVAILABLE for the
  // reservation. No history/append-only library table exists, so there is no
  // trigger-disable teardown dance for this phase.
  bookTitleId: string;
  bookCopyId: string;
  bookCopyReservedId: string;
  libraryLoanId: string;
  bookReservationId: string;
  libraryFineId: string;
  // Phase-6 admissions tables (design §5). The FIVE standard-pair tables
  // (admission_campaigns, admission_campaign_programs, applications,
  // application_documents, admission_offers, enrollments) are seeded here so the
  // read/spoofed-write/foreign-parent escape tests can prove campass_app cannot
  // see or forge the other tenant's rows. application_reviews is APPEND-ONLY (its
  // BEFORE UPDATE OR DELETE trigger blocks even adminClient in the shared
  // teardown), so it is EXCLUDED from this generic seed/cleanup loop and proven
  // by the self-contained case — the schedule_revisions / audit_events precedent.
  admissionCampaignId: string;
  admissionCampaignProgramId: string;
  applicationId: string;
  applicationDocumentId: string;
  admissionOfferId: string;
  enrollmentId: string;
  // FEAT-004 (Phase-7 fees slice 1) tables (design §D.2/§D.3/§D.4). The four
  // mutable/guarded tables are seeded here: a FeeStructure + FeeComponent, a
  // StudentCharge on the ALREADY-seeded studentProfile, and a
  // payment_transactions CREATED row with a targetChargeIds array. The three
  // fully-append-only tables (payment_allocations, receipts,
  // processed_webhook_events) are DELIBERATELY NOT seeded here — their BEFORE
  // UPDATE OR DELETE trigger blocks even adminClient in the shared teardown (the
  // application_reviews / student_profile_history precedent); their append-only
  // behaviour is proven by the self-contained cases in the escape suite + the
  // fees-behavioral suite. The payment_transactions + student_charges
  // column-guard triggers forbid DELETE unconditionally, so those two are
  // deleted in teardown within a scoped trigger-disable (the audit_events dance).
  feeStructureId: string;
  feeComponentId: string;
  studentChargeId: string;
  paymentTransactionId: string;
  // Phase-7 fees slice 7.1 (design §E.1/§E.2). The two mutable/guarded tables are
  // seeded: a ConcessionDefinition (standard pair) and a Refund (REQUESTED,
  // razorpayRefundId NULL, unique idempotencyKey per tenant; the refunds_guard
  // forbids DELETE, so teardown disables it within a scoped trigger-disable). The
  // four INSERT-only tables (student_concessions, concession_credits,
  // refund_reversals, adjustments) are DELIBERATELY NOT seeded here — their BEFORE
  // UPDATE OR DELETE trigger blocks even adminClient in the shared teardown; their
  // append-only behaviour is proven by the self-contained cases.
  concessionDefinitionId: string;
  refundId: string;
  // Phase-8 exams tables (design §7). The SIX mutable/column-guard tables are
  // seeded here (examinations + marks_records carry column-guard triggers; the
  // other four are standard-pair). Seed order respects the RESTRICT composite
  // FKs: examination -> grading_scheme -> grade_band -> exam_schedule ->
  // assessment -> candidate -> marks_record. The THREE INSERT-only tables
  // (marks_record_history, result_publications, result_snapshots) are
  // DELIBERATELY NOT seeded here — their BEFORE UPDATE OR DELETE trigger blocks
  // even adminClient in the shared teardown (the payment_allocations / receipts /
  // application_reviews precedent); their append-only behaviour is proven by the
  // self-contained case in the escape suite + the exams-behavioral suite. The
  // examinations + marks_records column-guard triggers forbid DELETE
  // unconditionally, so teardown deletes those two within a scoped
  // trigger-disable (the audit_events dance).
  examinationId: string;
  gradingSchemeId: string;
  gradeBandId: string;
  examScheduleId: string;
  assessmentId: string;
  candidateId: string;
  marksRecordId: string;
  // Phase-8 slice 8.2 (design §7/§17). reeval_requests is a column-guard-class
  // table (forward-only status + frozen identity), seeded here with its parent
  // result_publications row (result_publications is INSERT-only in 8.1 but in 8.2
  // carries a column guard that permits PUBLISHED->SUPERSEDED; it is seeded via
  // adminClient either way). The reeval row's teardown uses a scoped
  // DISABLE TRIGGER "reeval_requests_guard" dance (the examinations/marks_records
  // precedent). result_publications is also deleted in teardown within a scoped
  // trigger-disable because its column guard forbids DELETE unconditionally.
  resultPublicationId: string;
  reevalRequestId: string;
}

export const seeded: { A?: SeededTenant; B?: SeededTenant } = {};

function id(suffix: string): string {
  return `${PREFIX}${suffix}`;
}

/**
 * Retry a DB operation on transient connectivity errors only. The Supabase
 * session pooler (port 5432, used by adminClient) occasionally drops a
 * connection under concurrent load (Prisma P1001); that is a network hiccup, not
 * a logic failure, so setup/teardown retry rather than fail the suite spuriously.
 * This does NOT touch any test assertion.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const transient =
        msg.includes("Can't reach database server") ||
        msg.includes("P1001") ||
        msg.includes("Timed out") ||
        msg.includes("ECONNRESET") ||
        msg.includes("max clients reached") ||
        msg.includes("EMAXCONNSESSION");
      if (!transient || i === attempts - 1) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * Seed one institution with overlapping-shaped data using deterministic IDs so
 * cleanup is exact. Runs via adminClient (bypasses RLS).
 */
async function seedTenant(key: "A" | "B"): Promise<SeededTenant> {
  const institutionId = id(`inst_${key}`);
  const departmentId = id(`dept_${key}`);
  const userId = id(`user_${key}`);
  const studentProfileId = id(`student_${key}`);
  const reasonId = id(`reason_${key}`);
  const gateId = id(`gate_${key}`);
  const gatePassId = id(`pass_${key}`);
  const membershipId = id(`mbr_${key}`);
  const membershipRoleId = id(`mrl_${key}`);
  const institutionModuleId = id(`imod_${key}`);
  const academicSessionId = id(`asess_${key}`);
  const academicTermId = id(`aterm_${key}`);
  const programId = id(`prog_${key}`);
  const calendarDayId = id(`acd_${key}`);
  const studentDocumentId = id(`sdoc_${key}`);
  // FEAT-004 Phase-3 classes IDs (deterministic so cleanup is exact).
  const courseId = id(`course_${key}`);
  const subjectId = id(`subject_${key}`);
  const classSectionId = id(`section_${key}`);
  const classEnrollmentId = id(`enroll_${key}`);
  const facultyUserId = id(`facuser_${key}`);
  const facultyProfileId = id(`faculty_${key}`);
  const facultyAssignmentId = id(`facassign_${key}`);
  const timetableId = id(`timetable_${key}`);
  const scheduledClassId = id(`sclass_${key}`);
  const attendanceSessionId = id(`asession_${key}`);
  const attendanceRecordId = id(`arecord_${key}`);
  const attendanceCorrectionId = id(`acorr_${key}`);
  // Phase-5 library IDs (deterministic so cleanup is exact).
  const bookTitleId = id(`btitle_${key}`);
  const bookCopyId = id(`bcopy_${key}`);
  const bookCopyReservedId = id(`bcopyr_${key}`);
  const libraryLoanId = id(`lloan_${key}`);
  const bookReservationId = id(`bresv_${key}`);
  const libraryFineId = id(`lfine_${key}`);
  // Phase-6 admissions IDs (deterministic so cleanup is exact). application_reviews
  // is append-only and NOT seeded here.
  const admissionCampaignId = id(`camp_${key}`);
  const admissionCampaignProgramId = id(`campprog_${key}`);
  const applicationId = id(`app_${key}`);
  const applicationDocumentId = id(`appdoc_${key}`);
  const admissionOfferId = id(`offer_${key}`);
  const enrollmentId = id(`enr_${key}`);
  // FEAT-004 fees IDs (deterministic so cleanup is exact).
  const feeStructureId = id(`feestruct_${key}`);
  const feeComponentId = id(`feecomp_${key}`);
  const studentChargeId = id(`charge_${key}`);
  const paymentTransactionId = id(`paytxn_${key}`);
  // Phase-7 fees slice 7.1 IDs (deterministic so cleanup is exact).
  const concessionDefinitionId = id(`concdef_${key}`);
  const refundId = id(`refund_${key}`);
  // Phase-8 exams IDs (deterministic so cleanup is exact).
  const examinationId = id(`exam_${key}`);
  const examGradingSchemeId = id(`gscheme_${key}`);
  const gradeBandId = id(`gband_${key}`);
  const examScheduleId = id(`eschedule_${key}`);
  const assessmentId = id(`assess_${key}`);
  const candidateId = id(`cand_${key}`);
  const marksRecordId = id(`mark_${key}`);
  // Phase-8 slice 8.2 IDs (deterministic so cleanup is exact).
  const resultPublicationId = id(`rpub_${key}`);
  const reevalRequestId = id(`reeval_${key}`);

  await adminClient.institution.create({
    data: {
      id: institutionId,
      name: `${PREFIX}Institution ${key}`,
      code: id(`CODE_${key}`),
    },
  });

  await adminClient.department.create({
    data: { id: departmentId, name: `${PREFIX}Dept ${key}`, code: id(`D_${key}`), institutionId },
  });

  await adminClient.user.create({
    data: {
      id: userId,
      email: `${PREFIX.toLowerCase()}${key.toLowerCase()}@example.test`,
      role: "STUDENT",
      institutionId,
    },
  });

  await adminClient.studentProfile.create({
    data: {
      id: studentProfileId,
      userId,
      institutionId,
      enrollmentNo: id(`ENR_${key}`),
      name: `${PREFIX}Student ${key}`,
      departmentId,
      program: "TEST",
      semester: 1,
      // FEAT-003: the generalized columns — status defaults ACTIVE at the DB,
      // set explicitly here so the escape seed exercises the generalized row
      // shape (the structured session/term/program links are set below, after
      // those parents exist).
      status: "ACTIVE",
    },
  });

  await adminClient.exitReason.create({
    data: { id: reasonId, label: `${PREFIX}Reason ${key}`, institutionId },
  });

  await adminClient.gate.create({
    data: { id: gateId, name: `${PREFIX}Gate ${key}`, institutionId },
  });

  await adminClient.gatePass.create({
    data: {
      id: gatePassId,
      passNumber: id(`PASS_${key}`),
      institutionId,
      studentId: studentProfileId,
      reasonId,
      requestedExit: new Date(),
      expectedReturn: new Date(Date.now() + 3600_000),
    },
  });

  // Membership + membership-role (the B-2 tenant-owned RBAC tables). The
  // membership-role binds to the global STUDENT template role (institutionId
  // null, seeded by the identity_rbac_b2 migration / seed). Created via the
  // RLS-bypassing adminClient so the read-escape test can later prove the
  // campass_app client CANNOT see the other tenant's row.
  const studentTemplateRole = await adminClient.role.findFirst({
    where: { key: "STUDENT", institutionId: null },
    select: { id: true },
  });
  if (!studentTemplateRole) {
    throw new Error(
      "STUDENT template role not found — run the identity_rbac_b2 migration + seed before the escape suite",
    );
  }

  await adminClient.institutionMembership.create({
    data: { id: membershipId, userId, institutionId, membershipStatus: "ACTIVE" },
  });

  await adminClient.membershipRole.create({
    data: {
      id: membershipRoleId,
      membershipId,
      roleId: studentTemplateRole.id,
      institutionId,
    },
  });

  // The new tenant-owned module-system table. Seeded via the RLS-bypassing
  // adminClient so the read-escape test can later prove the campass_app client
  // CANNOT see the other tenant's row.
  await adminClient.institutionModule.create({
    data: {
      id: institutionModuleId,
      institutionId,
      moduleKey: "campus_movement",
      state: "ACTIVE",
      entitledAt: new Date(),
      activatedAt: new Date(),
    },
  });

  // FEAT-003 academics tenant-owned tables (design §10.1). Seeded via the
  // RLS-bypassing adminClient so the read-escape tests can later prove the
  // campass_app client CANNOT see the other tenant's rows. A session (+1 term),
  // a program under the seeded department, and ONE department-scoped calendar
  // entry are created. The append-only academic_calendar_day_revisions table is
  // deliberately NOT seeded here (the BEFORE UPDATE OR DELETE trigger blocks even
  // adminClient in the shared teardown — exactly the audit_events precedent); its
  // escape behaviour is covered by the self-contained calendar-revision test.
  const sessionStart = new Date("2026-07-01T00:00:00.000Z");
  const sessionEnd = new Date("2027-06-30T00:00:00.000Z");

  await adminClient.academicSession.create({
    data: {
      id: academicSessionId,
      institutionId,
      name: `${PREFIX}Session ${key}`,
      structureType: "SEMESTER",
      status: "UPCOMING",
      startDate: sessionStart,
      endDate: sessionEnd,
    },
  });

  await adminClient.academicTerm.create({
    data: {
      id: academicTermId,
      institutionId,
      academicSessionId,
      name: `${PREFIX}Term ${key}`,
      ordinal: 1,
      status: "UPCOMING",
      startDate: sessionStart,
      endDate: new Date("2026-12-31T00:00:00.000Z"),
    },
  });

  await adminClient.program.create({
    data: {
      id: programId,
      institutionId,
      departmentId,
      name: `${PREFIX}Program ${key}`,
      code: id(`PROG_${key}`),
      duration: 6,
      durationUnit: "TERMS",
    },
  });

  await adminClient.academicCalendarDay.create({
    data: {
      id: calendarDayId,
      institutionId,
      date: new Date("2026-09-01T00:00:00.000Z"),
      dayType: "EXAM_DAY",
      note: `${PREFIX}dept-scoped ${key}`,
      departmentId,
      academicSessionId,
    },
  });

  // Now the session/term/program exist, link the generalized studentProfile row
  // to them (optional structured links — design §3.4). This proves the escape
  // seed exercises a FULLY-populated generalized row (status + all three links),
  // not just the additive-nullable default state.
  await adminClient.studentProfile.update({
    where: { id: studentProfileId },
    data: { programId, academicSessionId, currentTermId: academicTermId },
  });

  // FEAT-003 student_documents (standard RLS pair). Seeded via the RLS-bypassing
  // adminClient, a child of the seeded studentProfile (composite same-tenant FK
  // is ON DELETE RESTRICT), so the read/spoofed-write/foreign-parent escape
  // tests can later prove campass_app CANNOT see or forge the other tenant's row.
  await adminClient.studentDocument.create({
    data: {
      id: studentDocumentId,
      institutionId,
      studentProfileId,
      kind: "ID_PROOF",
      title: `${PREFIX}Doc ${key}`,
      storageKey: id(`store_${key}`),
      uploadedByUserId: userId,
    },
  });

  // FEAT-004 Phase-3 classes MUTABLE tables (design §6). Seeded via the
  // RLS-bypassing adminClient, in child-safe order so the RESTRICT composite FKs
  // are satisfied: course -> subject; section; faculty user -> faculty_profile;
  // faculty_assignment; timetable; scheduled_class; enrollment referencing the
  // ALREADY-seeded studentProfile (no second student — the enrollment proves the
  // single-identity composite FK). schedule_revisions is DELIBERATELY NOT seeded
  // here — its BEFORE UPDATE OR DELETE trigger blocks even adminClient in the
  // shared teardown (the audit_events / student_profile_history precedent); its
  // escape behaviour is covered by the self-contained append-only case.
  await adminClient.course.create({
    data: {
      id: courseId,
      institutionId,
      programId,
      academicTermId,
      name: `${PREFIX}Course ${key}`,
      code: id(`COURSE_${key}`),
      status: "ACTIVE",
    },
  });

  await adminClient.subject.create({
    data: {
      id: subjectId,
      institutionId,
      courseId,
      name: `${PREFIX}Subject ${key}`,
      code: id(`SUBJ_${key}`),
      credits: 4,
      contactHoursPerWeek: 4,
      status: "ACTIVE",
    },
  });

  await adminClient.classSection.create({
    data: {
      id: classSectionId,
      institutionId,
      programId,
      academicSessionId,
      academicTermId,
      label: `${PREFIX}${key}`,
      capacity: 60,
      status: "ACTIVE",
    },
  });

  // A dedicated faculty user so faculty_profiles(userId) unique is not consumed
  // by the already-seeded student user. The composite FK is to users(id,
  // institutionId), so this user lives in the same tenant.
  await adminClient.user.create({
    data: {
      id: facultyUserId,
      email: `${PREFIX.toLowerCase()}fac_${key.toLowerCase()}@example.test`,
      role: "GUARD", // inert non-actor legacy value for a pure-faculty user (design A3)
      institutionId,
    },
  });

  await adminClient.facultyProfile.create({
    data: {
      id: facultyProfileId,
      institutionId,
      userId: facultyUserId,
      name: `${PREFIX}Faculty ${key}`,
      departmentId,
      status: "ACTIVE",
    },
  });

  await adminClient.facultyAssignment.create({
    data: {
      id: facultyAssignmentId,
      institutionId,
      facultyId: facultyProfileId,
      subjectId,
      classSectionId,
      academicTermId,
      role: "PRIMARY",
      status: "ACTIVE",
    },
  });

  await adminClient.timetable.create({
    data: {
      id: timetableId,
      institutionId,
      academicTermId,
      name: `${PREFIX}Timetable ${key}`,
      status: "PUBLISHED",
      publishedAt: new Date(),
    },
  });

  await adminClient.scheduledClass.create({
    data: {
      id: scheduledClassId,
      institutionId,
      timetableId,
      classSectionId,
      subjectId,
      facultyId: facultyProfileId,
      academicTermId,
      room: id(`R_${key}`),
      dayOfWeek: "MON",
      startTime: 540,
      endTime: 600,
      status: "SCHEDULED",
    },
  });

  // Enrollment references the ALREADY-seeded studentProfile (single identity —
  // the composite same-tenant FK forbids enrolling another tenant's student).
  await adminClient.classEnrollment.create({
    data: {
      id: classEnrollmentId,
      institutionId,
      classSectionId,
      studentId: studentProfileId,
      status: "ENROLLED",
    },
  });

  // Phase-4 attendance MUTABLE tables (design §9). Seeded via the RLS-bypassing
  // adminClient, child-safe after scheduled_classes/enrollments: session (against
  // the seeded scheduledClass + academicTerm, a MON date) -> record (the seeded
  // studentProfile) -> one PENDING correction on that record.
  // attendance_record_history is DELIBERATELY NOT seeded here — its BEFORE UPDATE
  // OR DELETE trigger blocks even adminClient in the shared teardown (the
  // schedule_revisions / audit_events precedent); its append-only behaviour is
  // proven by the self-contained case.
  await adminClient.attendanceSession.create({
    data: {
      id: attendanceSessionId,
      institutionId,
      scheduledClassId,
      academicTermId,
      date: new Date("2026-11-02T00:00:00.000Z"), // a Monday (matches the MON slot)
      status: "FINALIZED",
      markedByFacultyId: facultyProfileId,
      submittedAt: new Date(),
      finalizedAt: new Date(),
    },
  });

  await adminClient.attendanceRecord.create({
    data: {
      id: attendanceRecordId,
      institutionId,
      attendanceSessionId,
      studentId: studentProfileId,
      status: "PRESENT",
    },
  });

  await adminClient.attendanceCorrection.create({
    data: {
      id: attendanceCorrectionId,
      institutionId,
      attendanceRecordId,
      requestedByUserId: facultyUserId,
      reason: `${PREFIX}correction ${key}`,
      requestedStatus: "ABSENT",
      priorStatus: "PRESENT",
      reviewStatus: "PENDING",
    },
  });

  // Phase-5 library tables (design §3). Seeded via the RLS-bypassing adminClient
  // in child-safe order: a title, two copies (one flipped ISSUED for the loan,
  // one left AVAILABLE), one ACTIVE loan on the issued copy referencing the
  // ALREADY-seeded studentProfile (the single-identity composite FK), one PENDING
  // reservation of the title by that same student, and one PENDING OVERDUE fine
  // on the loan. All five tables use the standard RLS pair, so the read /
  // spoofed-write / foreign-parent escape tests can prove campass_app cannot see
  // or forge the other tenant's rows. No append-only library table exists this
  // phase, so none is excluded from the generic seed/cleanup loop.
  await adminClient.bookTitle.create({
    data: {
      id: bookTitleId,
      institutionId,
      title: `${PREFIX}Title ${key}`,
      author: `${PREFIX}Author ${key}`,
      status: "ACTIVE",
    },
  });

  await adminClient.bookCopy.create({
    data: {
      id: bookCopyId,
      institutionId,
      bookTitleId,
      accessionNumber: id(`ACC_${key}`),
      status: "ISSUED", // on the seeded ACTIVE loan below
      condition: "GOOD",
    },
  });

  await adminClient.bookCopy.create({
    data: {
      id: bookCopyReservedId,
      institutionId,
      bookTitleId,
      accessionNumber: id(`ACCR_${key}`),
      status: "AVAILABLE",
      condition: "GOOD",
    },
  });

  await adminClient.libraryLoan.create({
    data: {
      id: libraryLoanId,
      institutionId,
      bookCopyId,
      studentId: studentProfileId,
      issuedByUserId: userId,
      issueDate: new Date("2026-11-01T00:00:00.000Z"),
      dueDate: new Date("2026-11-15T00:00:00.000Z"),
      status: "ACTIVE",
    },
  });

  await adminClient.bookReservation.create({
    data: {
      id: bookReservationId,
      institutionId,
      bookTitleId,
      studentId: studentProfileId,
      queuePosition: 1,
      status: "PENDING",
    },
  });

  await adminClient.libraryFine.create({
    data: {
      id: libraryFineId,
      institutionId,
      studentId: studentProfileId,
      libraryLoanId,
      amount: "5.00",
      reason: "OVERDUE",
      status: "PENDING",
    },
  });

  // Phase-6 admissions MUTABLE tables (design §5). Seeded via the RLS-bypassing
  // adminClient in child-safe order so the RESTRICT composite FKs are satisfied:
  // campaign (targets the seeded program + session) -> campaign_program join ->
  // application (the seeded applicant user + program) -> document; a live ISSUED
  // offer on the application; an enrollment referencing the ALREADY-seeded
  // studentProfile + session (the single-identity composite FK). The append-only
  // application_reviews table is DELIBERATELY NOT seeded here — its BEFORE UPDATE
  // OR DELETE trigger blocks even adminClient in the shared teardown (the
  // schedule_revisions / audit_events precedent); its escape behaviour is covered
  // by the self-contained append-only case.
  await adminClient.admissionCampaign.create({
    data: {
      id: admissionCampaignId,
      institutionId,
      name: `${PREFIX}Campaign ${key}`,
      status: "OPEN",
      intakeSessionId: academicSessionId,
      targetProgramId: programId,
      config: { requiredFields: [], requiredDocTypes: [] },
    },
  });

  await adminClient.admissionCampaignProgram.create({
    data: {
      id: admissionCampaignProgramId,
      institutionId,
      campaignId: admissionCampaignId,
      programId,
    },
  });

  await adminClient.application.create({
    data: {
      id: applicationId,
      institutionId,
      campaignId: admissionCampaignId,
      applicantUserId: userId,
      programId,
      status: "ELIGIBLE",
      applicationNumber: id(`APPNO_${key}`),
      formData: { fullName: `${PREFIX}Applicant ${key}` },
    },
  });

  await adminClient.applicationDocument.create({
    data: {
      id: applicationDocumentId,
      institutionId,
      applicationId,
      docType: "TRANSCRIPT",
      reference: id(`ref_${key}`),
    },
  });

  await adminClient.admissionOffer.create({
    data: {
      id: admissionOfferId,
      institutionId,
      applicationId,
      offeredProgramId: programId,
      status: "ISSUED",
    },
  });

  await adminClient.enrollment.create({
    data: {
      id: enrollmentId,
      institutionId,
      applicationId,
      studentProfileId,
      academicSessionId,
      enrolledByUserId: userId,
    },
  });

  // FEAT-004 Phase-7 fees MUTABLE/GUARDED tables (design §D.2). Seeded via the
  // RLS-bypassing adminClient in child-safe order so the RESTRICT composite FKs
  // are satisfied: structure -> component; a StudentCharge referencing the
  // ALREADY-seeded studentProfile (single-identity composite FK) + the structure
  // + component; a payment_transactions CREATED row (non-terminal) referencing
  // the same student, carrying targetChargeIds = [the charge]. The three fully
  // append-only tables (payment_allocations, receipts, processed_webhook_events)
  // are DELIBERATELY NOT seeded here — their BEFORE UPDATE OR DELETE trigger
  // blocks even adminClient in the shared teardown; their append-only behaviour
  // is proven by the self-contained cases. The CREATED payment_transactions row
  // and the PENDING student_charge are deletable in teardown only with their
  // column-guard triggers disabled (those triggers forbid DELETE
  // unconditionally), so teardown does that dance (the audit_events precedent).
  await adminClient.feeStructure.create({
    data: {
      id: feeStructureId,
      institutionId,
      name: `${PREFIX}Fee Structure ${key}`,
      status: "ACTIVE",
      programId,
      academicSessionId,
    },
  });

  await adminClient.feeComponent.create({
    data: {
      id: feeComponentId,
      institutionId,
      feeStructureId,
      category: "TUITION",
      amountPaise: 5000000n, // ₹50,000
      currency: "INR",
    },
  });

  await adminClient.studentCharge.create({
    data: {
      id: studentChargeId,
      institutionId,
      studentId: studentProfileId,
      feeStructureId,
      feeComponentId,
      category: "TUITION",
      amountPaise: 5000000n,
      currency: "INR",
      description: `${PREFIX}Tuition ${key}`,
      status: "PENDING",
      postedByUserId: userId,
    },
  });

  await adminClient.paymentTransaction.create({
    data: {
      id: paymentTransactionId,
      institutionId,
      studentId: studentProfileId,
      amountPaise: 5000000n,
      currency: "INR",
      status: "CREATED", // non-terminal; teardown deletes it with the guard trigger disabled
      razorpayOrderId: id(`order_${key}`),
      targetChargeIds: [studentChargeId],
      initiatedByUserId: userId,
    },
  });

  // Phase-7 fees slice 7.1 MUTABLE/GUARDED tables (design §E.1/§E.2). A
  // ConcessionDefinition (standard pair) and a Refund (REQUESTED, razorpayRefundId
  // NULL, unique idempotencyKey per tenant) referencing the seeded CREATED
  // payment_transactions row (the composite same-tenant FK only requires same
  // tenant, not a CAPTURED status). The four INSERT-only ledger tables are NOT
  // seeded here (their triggers block the shared teardown). The refunds_guard
  // forbids DELETE, so teardown disables it within a scoped trigger-disable.
  await adminClient.concessionDefinition.create({
    data: {
      id: concessionDefinitionId,
      institutionId,
      name: `${PREFIX}Concession ${key}`,
      type: "FIXED",
      amountPaise: 1000000n, // ₹10,000
      scope: "PER_STUDENT",
      status: "ACTIVE",
    },
  });

  await adminClient.refund.create({
    data: {
      id: refundId,
      institutionId,
      paymentTransactionId,
      studentId: studentProfileId,
      amountPaise: 1000000n,
      currency: "INR",
      status: "REQUESTED",
      reason: `${PREFIX}seed refund ${key}`,
      idempotencyKey: id(`idem_${key}`),
      approvedByUserId: userId,
    },
  });

  // Phase-8 exams MUTABLE/GUARDED tables (design §7). Seeded via the
  // RLS-bypassing adminClient in child-safe RESTRICT order against the
  // ALREADY-seeded session/term/program/subject/student: examination ->
  // grading_scheme -> grade_band -> exam_schedule (on the seeded subject) ->
  // assessment (on the seeded subject) -> candidate (the seeded studentProfile,
  // single-identity composite FK) -> marks_record (on that candidate +
  // assessment). The three INSERT-only tables are NOT seeded here (their triggers
  // block the shared teardown). examinations + marks_records carry column-guard
  // triggers that forbid DELETE unconditionally, so teardown disables them.
  await adminClient.examination.create({
    data: {
      id: examinationId,
      institutionId,
      academicSessionId,
      academicTermId,
      programId,
      name: `${PREFIX}Exam ${key}`,
      type: "MIDTERM",
      status: "MARKS_OPEN",
      createdByUserId: userId,
    },
  });

  await adminClient.gradingScheme.create({
    data: {
      id: examGradingSchemeId,
      institutionId,
      name: `${PREFIX}Scheme ${key}`,
      isActive: true,
      createdByUserId: userId,
    },
  });

  await adminClient.gradeBand.create({
    data: {
      id: gradeBandId,
      institutionId,
      gradingSchemeId: examGradingSchemeId,
      minPercentBps: 0,
      maxPercentBps: 10000,
      gradeLabel: "A",
      gradePoints: 1000,
      isPassing: true,
      ordinal: 0,
    },
  });

  await adminClient.examSchedule.create({
    data: {
      id: examScheduleId,
      institutionId,
      examId: examinationId,
      subjectId,
      room: id(`ROOM_${key}`),
      roomCapacity: 30,
      startsAt: new Date("2026-12-01T09:00:00.000Z"),
      endsAt: new Date("2026-12-01T12:00:00.000Z"),
    },
  });

  await adminClient.assessment.create({
    data: {
      id: assessmentId,
      institutionId,
      examId: examinationId,
      subjectId,
      name: "FINAL",
      maxMarks: 100,
      weight: 100,
    },
  });

  await adminClient.candidate.create({
    data: {
      id: candidateId,
      institutionId,
      examId: examinationId,
      studentId: studentProfileId,
    },
  });

  await adminClient.marksRecord.create({
    data: {
      id: marksRecordId,
      institutionId,
      examId: examinationId,
      assessmentId,
      candidateId,
      studentId: studentProfileId,
      marks: 80,
      enteredByUserId: userId,
    },
  });

  // Phase-8 slice 8.2: a result_publications header (the frozen provenance a
  // reeval_request contests) + the reeval_request itself (column-guard class).
  // result_publications is seeded via adminClient (it is INSERT-only for
  // campass_app; in 8.2 its column guard additionally permits PUBLISHED->
  // SUPERSEDED). The reeval row is REQUESTED, referencing the seeded candidate +
  // the publication for sourcePublicationId.
  await adminClient.resultPublication.create({
    data: {
      id: resultPublicationId,
      institutionId,
      examId: examinationId,
      version: 1,
      status: "PUBLISHED",
      gradingSchemeId: examGradingSchemeId,
      publishedByUserId: userId,
    },
  });

  await adminClient.reevalRequest.create({
    data: {
      id: reevalRequestId,
      institutionId,
      examId: examinationId,
      candidateId,
      studentId: studentProfileId,
      subjectId,
      sourcePublicationId: resultPublicationId,
      status: "REQUESTED",
      studentReason: `${PREFIX}reeval reason ${key}`,
      requestedByUserId: userId,
    },
  });

  return {
    institutionId,
    departmentId,
    userId,
    studentProfileId,
    reasonId,
    gateId,
    gatePassId,
    membershipId,
    membershipRoleId,
    institutionModuleId,
    academicSessionId,
    academicTermId,
    programId,
    calendarDayId,
    studentDocumentId,
    courseId,
    subjectId,
    classSectionId,
    classEnrollmentId,
    facultyUserId,
    facultyProfileId,
    facultyAssignmentId,
    timetableId,
    scheduledClassId,
    attendanceSessionId,
    attendanceRecordId,
    attendanceCorrectionId,
    bookTitleId,
    bookCopyId,
    bookCopyReservedId,
    libraryLoanId,
    bookReservationId,
    libraryFineId,
    admissionCampaignId,
    admissionCampaignProgramId,
    applicationId,
    applicationDocumentId,
    admissionOfferId,
    enrollmentId,
    feeStructureId,
    feeComponentId,
    studentChargeId,
    paymentTransactionId,
    concessionDefinitionId,
    refundId,
    examinationId,
    gradingSchemeId: examGradingSchemeId,
    gradeBandId,
    examScheduleId,
    assessmentId,
    candidateId,
    marksRecordId,
    resultPublicationId,
    reevalRequestId,
  };
}

export async function seedBothTenants(): Promise<void> {
  // Clean any residue from a previous aborted run first (idempotent).
  await cleanup();
  seeded.A = await withRetry(() => seedTenant("A"));
  seeded.B = await withRetry(() => seedTenant("B"));
}

/** Delete exactly the ESCAPE_TEST_ rows, child-first to respect FKs. */
export async function cleanup(): Promise<void> {
  const where = { institutionId: { startsWith: PREFIX } };
  // Phase-8 exams tables FIRST (child -> parent), BEFORE the student_profiles /
  // subjects / programs / academic_sessions / terms deletes below (their
  // composite FKs are ON DELETE RESTRICT). The three INSERT-only tables
  // (marks_record_history, result_publications, result_snapshots) are never
  // seeded by the generic loop, so there is nothing to delete here for them (the
  // payment_allocations / application_reviews precedent). marks_records +
  // examinations carry column-guard triggers that forbid DELETE unconditionally,
  // so delete them with those triggers disabled (the audit_events dance). Order:
  // marks_records -> candidates -> assessments -> exam_schedules -> grade_bands
  // -> grading_schemes -> examinations.
  // Slice 8.2: reeval_requests + result_publications carry column-guard triggers
  // that forbid DELETE unconditionally, so delete them (child-first) within the
  // same scoped trigger-disable dance. Order: reeval_requests ->
  // (marks_records/candidates/... below) and result_publications BEFORE
  // examinations/grading_schemes. The two INSERT-only snapshot/history tables are
  // never seeded here, so nothing to delete for them.
  // The three INSERT-only exam tables are never seeded by the generic loop, but a
  // self-contained append-only case (3p7) seeds + normally self-cleans rows under
  // the prefix; if that case errored mid-way it can leave residue that blocks the
  // marks_records / result_publications deletes below. Defensively delete them
  // here within their own trigger-disable (no-op when empty).
  const examInsertOnlyTables = [
    { table: "result_snapshots", trigger: "result_snapshots_no_update_delete" },
    { table: "marks_record_history", trigger: "marks_record_history_no_update_delete" },
  ];
  for (const { table, trigger } of examInsertOnlyTables) {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`),
    );
  }
  try {
    await withRetry(() => adminClient.resultSnapshot.deleteMany({ where }));
    await withRetry(() => adminClient.marksRecordHistory.deleteMany({ where }));
  } finally {
    for (const { table, trigger } of examInsertOnlyTables) {
      await withRetry(() =>
        adminClient.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`),
      );
    }
  }
  const examGuardedTables = [
    { table: "marks_records", trigger: "marks_records_guard" },
    { table: "examinations", trigger: "examinations_guard" },
    { table: "reeval_requests", trigger: "reeval_requests_guard" },
    { table: "result_publications", trigger: "result_publications_guard" },
  ];
  for (const { table, trigger } of examGuardedTables) {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`),
    );
  }
  try {
    await withRetry(() => adminClient.reevalRequest.deleteMany({ where }));
    await withRetry(() => adminClient.marksRecord.deleteMany({ where }));
    await withRetry(() => adminClient.candidate.deleteMany({ where }));
    await withRetry(() => adminClient.assessment.deleteMany({ where }));
    await withRetry(() => adminClient.examSchedule.deleteMany({ where }));
    await withRetry(() => adminClient.resultPublication.deleteMany({ where }));
    await withRetry(() => adminClient.gradeBand.deleteMany({ where }));
    await withRetry(() => adminClient.gradingScheme.deleteMany({ where }));
    await withRetry(() => adminClient.examination.deleteMany({ where }));
  } finally {
    for (const { table, trigger } of examGuardedTables) {
      await withRetry(() =>
        adminClient.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`),
      );
    }
  }
  // Phase-7 fees slice 7.1 tables FIRST (child -> parent), BEFORE the slice-1
  // fees teardown below (refund_reversals/concession_credits -> refunds/
  // student_concessions reference student_charges/payment_transactions with ON
  // DELETE RESTRICT). The four INSERT-only tables + refunds carry triggers that
  // forbid UPDATE/DELETE, so delete them with those triggers disabled (the
  // audit_events dance). Order: refund_reversals -> refunds -> concession_credits
  // -> student_concessions -> concession_definitions -> adjustments.
  const slice2GuardedTables = [
    { table: "refund_reversals", trigger: "refund_reversals_no_update_delete" },
    { table: "refunds", trigger: "refunds_guard" },
    { table: "concession_credits", trigger: "concession_credits_no_update_delete" },
    { table: "student_concessions", trigger: "student_concessions_no_update_delete" },
    { table: "adjustments", trigger: "adjustments_no_update_delete" },
  ];
  for (const { table, trigger } of slice2GuardedTables) {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`),
    );
  }
  try {
    await withRetry(() => adminClient.refundReversal.deleteMany({ where }));
    await withRetry(() => adminClient.refund.deleteMany({ where }));
    await withRetry(() => adminClient.concessionCredit.deleteMany({ where }));
    await withRetry(() => adminClient.studentConcession.deleteMany({ where }));
    await withRetry(() => adminClient.adjustment.deleteMany({ where }));
  } finally {
    for (const { table, trigger } of slice2GuardedTables) {
      await withRetry(() =>
        adminClient.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`),
      );
    }
  }
  await withRetry(() => adminClient.concessionDefinition.deleteMany({ where }));

  // FEAT-004 Phase-7 fees (slice 1) tables NEXT (child -> parent), BEFORE the
  // student_profiles / programs / academic_sessions deletes below (their
  // composite FKs are ON DELETE RESTRICT). The three fully append-only tables
  // (payment_allocations, receipts, processed_webhook_events) are never seeded by
  // the escape setup, so there is nothing to delete here for them (their
  // self-contained cases manage their own rows within a scoped trigger-disable).
  // payment_transactions + student_charges carry column-guard triggers that
  // forbid DELETE unconditionally, so delete them with those triggers disabled
  // (the audit_events / student_profile_history dance). Order: payment_transactions
  // -> student_charges -> fee_components -> fee_structures.
  await withRetry(() =>
    adminClient.$executeRawUnsafe(
      `ALTER TABLE "payment_transactions" DISABLE TRIGGER "payment_transactions_guard"`,
    ),
  );
  await withRetry(() =>
    adminClient.$executeRawUnsafe(
      `ALTER TABLE "student_charges" DISABLE TRIGGER "student_charges_guard"`,
    ),
  );
  try {
    await withRetry(() => adminClient.paymentTransaction.deleteMany({ where }));
    await withRetry(() => adminClient.studentCharge.deleteMany({ where }));
  } finally {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(
        `ALTER TABLE "payment_transactions" ENABLE TRIGGER "payment_transactions_guard"`,
      ),
    );
    await withRetry(() =>
      adminClient.$executeRawUnsafe(
        `ALTER TABLE "student_charges" ENABLE TRIGGER "student_charges_guard"`,
      ),
    );
  }
  await withRetry(() => adminClient.feeComponent.deleteMany({ where }));
  await withRetry(() => adminClient.feeStructure.deleteMany({ where }));
  // Phase-6 admissions tables FIRST (child -> parent): enrollments + offers +
  // documents + campaign_programs (leaves) -> applications -> campaigns, all
  // BEFORE the student_profiles / programs / academic_sessions deletes below
  // (their composite FKs are ON DELETE RESTRICT). The append-only
  // application_reviews is never seeded by the generic loop, so there is nothing
  // to delete here for it (the schedule_revisions / audit_events precedent).
  await withRetry(() => adminClient.enrollment.deleteMany({ where }));
  await withRetry(() => adminClient.admissionOffer.deleteMany({ where }));
  await withRetry(() => adminClient.applicationDocument.deleteMany({ where }));
  await withRetry(() => adminClient.admissionCampaignProgram.deleteMany({ where }));
  await withRetry(() => adminClient.application.deleteMany({ where }));
  await withRetry(() => adminClient.admissionCampaign.deleteMany({ where }));
  // Phase-4 attendance tables FIRST (child -> parent): corrections -> records ->
  // sessions, BEFORE the scheduled_classes / class_enrollments / student_profiles
  // deletes below (their composite FKs are ON DELETE RESTRICT). The append-only
  // attendance_record_history is never seeded by the generic loop, so there is
  // nothing to delete here for it (schedule_revisions precedent).
  await withRetry(() => adminClient.attendanceCorrection.deleteMany({ where }));
  await withRetry(() => adminClient.attendanceRecord.deleteMany({ where }));
  await withRetry(() => adminClient.attendanceSession.deleteMany({ where }));
  // Phase-5 library tables FIRST (child -> parent): fines + reservations + loans
  // (which reference student_profiles + book_copies with ON DELETE RESTRICT) ->
  // book_copies -> book_titles, all BEFORE the student_profiles / institution
  // deletes below. No append-only library table this phase.
  await withRetry(() => adminClient.libraryFine.deleteMany({ where }));
  await withRetry(() => adminClient.bookReservation.deleteMany({ where }));
  await withRetry(() => adminClient.libraryLoan.deleteMany({ where }));
  await withRetry(() => adminClient.bookCopy.deleteMany({ where }));
  await withRetry(() => adminClient.bookTitle.deleteMany({ where }));
  // FEAT-004 Phase-3 classes tables next, child -> parent per the §6.10 RESTRICT
  // FKs, so they do not block the student_profiles / programs / sessions / terms /
  // departments / users deletes below. Order: enrollments + scheduled_classes +
  // faculty_assignments (leaves) -> timetables + subjects + sections (mid) ->
  // courses + faculty_profiles (parents of the above but children of
  // programs/terms/departments/users). schedule_revisions is append-only and
  // never seeded by the generic loop, so there is nothing to delete here for it.
  await withRetry(() => adminClient.classEnrollment.deleteMany({ where }));
  await withRetry(() => adminClient.scheduledClass.deleteMany({ where }));
  await withRetry(() => adminClient.facultyAssignment.deleteMany({ where }));
  await withRetry(() => adminClient.timetable.deleteMany({ where }));
  await withRetry(() => adminClient.subject.deleteMany({ where }));
  await withRetry(() => adminClient.classSection.deleteMany({ where }));
  await withRetry(() => adminClient.course.deleteMany({ where }));
  await withRetry(() => adminClient.facultyProfile.deleteMany({ where }));
  // B-2 tenant-owned RBAC tables first (child -> parent), so the new RESTRICT
  // composite FKs (membership_roles -> institution_memberships -> users) do not
  // block the user/department/institution deletes below.
  // NOTE: the escape suite itself seeds no audit_events / support_grants rows
  // (the FEAT-003 superadmin-security integration suite is self-contained under
  // its own prefix and cleans up its own rows). Nothing to delete here for the
  // two new tables.
  await withRetry(() => adminClient.membershipRole.deleteMany({ where }));
  await withRetry(() => adminClient.institutionMembership.deleteMany({ where }));
  // institution_modules: child-first (before the institution delete) because the
  // tenant-root FK is ON DELETE RESTRICT.
  await withRetry(() => adminClient.institutionModule.deleteMany({ where }));
  // FEAT-003: the generalized student_profiles row carries composite same-tenant
  // FKs to programs/academic_sessions/academic_terms with ON DELETE SET NULL.
  // A SET NULL on a COMPOSITE FK nulls BOTH columns, including the NOT NULL
  // institutionId — so deleting those academic parents while a student still
  // links to them raises a null-constraint violation. The student_profiles row
  // (and its student_documents child — composite FK ON DELETE RESTRICT) must
  // therefore be removed BEFORE the programs/sessions/terms it links to. Gate
  // passes + their events reference student_profiles (RESTRICT), so those come
  // out first, then documents, then the student rows.
  await withRetry(() => adminClient.gateEvent.deleteMany({ where }));
  await withRetry(() => adminClient.emergencyOverride.deleteMany({ where }));
  await withRetry(() => adminClient.gatePass.deleteMany({ where }));
  await withRetry(() => adminClient.reliabilityScoreSnapshot.deleteMany({ where }));
  await withRetry(() => adminClient.notification.deleteMany({ where }));
  await withRetry(() => adminClient.auditLog.deleteMany({ where }));
  await withRetry(() => adminClient.guardGateAssignment.deleteMany({ where }));
  await withRetry(() => adminClient.gate.deleteMany({ where }));
  await withRetry(() => adminClient.exitReason.deleteMany({ where }));
  // student_documents (composite FK -> student_profiles ON DELETE RESTRICT) then
  // the student rows themselves — BEFORE the academic parents below.
  // student_profile_history is intentionally NOT deleted here — the append-only
  // BEFORE UPDATE OR DELETE trigger blocks even adminClient; the escape suite
  // seeds no history row (the audit_events / revision precedent).
  await withRetry(() => adminClient.studentDocument.deleteMany({ where }));
  await withRetry(() => adminClient.studentProfile.deleteMany({ where }));
  // FEAT-003 academics MUTABLE tables, now safe to delete (no student links left):
  // calendar days (dept-scoped -> departments RESTRICT) + terms (-> sessions
  // RESTRICT) before the sessions, programs (-> departments RESTRICT) before the
  // departments, and all before the institution. The append-only
  // academic_calendar_day_revisions table is intentionally NOT deleted here.
  await withRetry(() => adminClient.academicCalendarDay.deleteMany({ where }));
  await withRetry(() => adminClient.academicTerm.deleteMany({ where }));
  await withRetry(() => adminClient.academicSession.deleteMany({ where }));
  await withRetry(() => adminClient.program.deleteMany({ where }));
  await withRetry(() => adminClient.hodProfile.deleteMany({ where }));
  await withRetry(() => adminClient.guardProfile.deleteMany({ where }));
  await withRetry(() => adminClient.user.deleteMany({ where }));
  await withRetry(() => adminClient.department.deleteMany({ where }));
  await withRetry(() =>
    adminClient.institution.deleteMany({ where: { id: { startsWith: PREFIX } } }),
  );
}

/**
 * Count remaining test rows across the seeded tables (teardown assertion).
 *
 * Run SEQUENTIALLY (not Promise.all): the postgres session pooler caps at 15
 * clients, and firing every count concurrently alongside teardown connections
 * trips `EMAXCONNSESSION: max clients reached in session mode`. One at a time
 * (with transient-error retry) keeps well under the cap and is plenty fast for a
 * teardown assertion.
 */
export async function countRemainingTestRows(): Promise<number> {
  const where = { institutionId: { startsWith: PREFIX } };
  const counters: Array<() => Promise<number>> = [
    // Phase-8 exams MUTABLE/GUARDED tables (the two INSERT-only snapshot/history
    // tables are never seeded by the generic loop, so they are not counted — the
    // payment_allocations precedent). reeval_requests + the seeded
    // result_publications header ARE seeded in 8.2, so they are counted. Counted
    // SEQUENTIALLY (session-pooler cap).
    () => adminClient.reevalRequest.count({ where }),
    () => adminClient.resultPublication.count({ where }),
    () => adminClient.marksRecord.count({ where }),
    () => adminClient.candidate.count({ where }),
    () => adminClient.assessment.count({ where }),
    () => adminClient.examSchedule.count({ where }),
    () => adminClient.gradeBand.count({ where }),
    () => adminClient.gradingScheme.count({ where }),
    () => adminClient.examination.count({ where }),
    // FEAT-004 Phase-7 fees MUTABLE/GUARDED tables (the three fully append-only
    // tables are never seeded by the generic loop, so they are not counted — the
    // application_reviews precedent). Counted SEQUENTIALLY (session-pooler cap).
    () => adminClient.paymentTransaction.count({ where }),
    () => adminClient.studentCharge.count({ where }),
    () => adminClient.feeComponent.count({ where }),
    () => adminClient.feeStructure.count({ where }),
    // Phase-6 admissions MUTABLE tables (application_reviews is append-only and
    // never seeded by the generic loop, so it is not counted — the
    // schedule_revisions precedent). Counted SEQUENTIALLY (session-pooler cap).
    () => adminClient.enrollment.count({ where }),
    () => adminClient.admissionOffer.count({ where }),
    () => adminClient.applicationDocument.count({ where }),
    () => adminClient.admissionCampaignProgram.count({ where }),
    () => adminClient.application.count({ where }),
    () => adminClient.admissionCampaign.count({ where }),
    // Phase-4 attendance MUTABLE tables (attendance_record_history is append-only
    // and never seeded by the generic loop, so it is not counted — the
    // schedule_revisions precedent). Counted SEQUENTIALLY (session-pooler cap).
    () => adminClient.attendanceCorrection.count({ where }),
    () => adminClient.attendanceRecord.count({ where }),
    () => adminClient.attendanceSession.count({ where }),
    // Phase-5 library tables (all standard-pair, seeded + torn down here).
    () => adminClient.libraryFine.count({ where }),
    () => adminClient.bookReservation.count({ where }),
    () => adminClient.libraryLoan.count({ where }),
    () => adminClient.bookCopy.count({ where }),
    () => adminClient.bookTitle.count({ where }),
    () => adminClient.membershipRole.count({ where }),
    () => adminClient.institutionMembership.count({ where }),
    () => adminClient.institutionModule.count({ where }),
    // FEAT-004 Phase-3 classes MUTABLE tables (schedule_revisions is append-only
    // and never seeded by the generic loop, so it is not counted — audit_events
    // precedent). Counted SEQUENTIALLY (session-pooler client cap).
    () => adminClient.classEnrollment.count({ where }),
    () => adminClient.scheduledClass.count({ where }),
    () => adminClient.facultyAssignment.count({ where }),
    () => adminClient.timetable.count({ where }),
    () => adminClient.subject.count({ where }),
    () => adminClient.classSection.count({ where }),
    () => adminClient.course.count({ where }),
    () => adminClient.facultyProfile.count({ where }),
    // FEAT-003 academics mutable tables (the revision table is append-only and
    // not seeded here, so it is not counted — audit_events precedent).
    () => adminClient.academicCalendarDay.count({ where }),
    () => adminClient.academicTerm.count({ where }),
    () => adminClient.academicSession.count({ where }),
    () => adminClient.program.count({ where }),
    // FEAT-003 student_documents (standard pair, seeded + torn down here). The
    // append-only student_profile_history is NOT seeded/counted — audit_events
    // precedent.
    () => adminClient.studentDocument.count({ where }),
    () => adminClient.gatePass.count({ where }),
    () => adminClient.studentProfile.count({ where }),
    () => adminClient.user.count({ where }),
    () => adminClient.department.count({ where }),
    () => adminClient.exitReason.count({ where }),
    () => adminClient.gate.count({ where }),
    () => adminClient.institution.count({ where: { id: { startsWith: PREFIX } } }),
  ];
  let total = 0;
  for (const count of counters) {
    total += await withRetry(count);
  }
  return total;
}

export async function disconnect(): Promise<void> {
  await Promise.all([appClient.$disconnect(), adminClient.$disconnect()]);
}

/** Tables that MUST have RLS enabled + forced (tenancy plan RLS set). */
export const RLS_TABLES = [
  "departments",
  "users",
  "gates",
  "exit_reasons",
  "guard_shifts",
  "emergency_alerts",
  "academic_calendar_days",
  "institution_configs",
  "allowance_policies",
  "student_profiles",
  "hod_profiles",
  "guard_profiles",
  "gate_passes",
  "gate_events",
  "guard_gate_assignments",
  "emergency_overrides",
  "reliability_score_snapshots",
  "notifications",
  "audit_logs",
  "institution_memberships",
  "membership_roles",
  // FEAT-003 new tables (design §9.3).
  "audit_events",
  "support_grants",
  // Module-system table (design §9.1) — uses the default policy pair.
  "institution_modules",
  // FEAT-003 academics tables (design §9/§10.1). sessions/terms/programs use the
  // default modify pair; the revision table is append-only (EXPECTED_POLICIES).
  "academic_sessions",
  "academic_terms",
  "programs",
  "academic_calendar_day_revisions",
  // FEAT-003 SIS tables (design §9.3). student_documents uses the default modify
  // pair; student_profile_history is append-only (EXPECTED_POLICIES below).
  "student_profile_history",
  "student_documents",
  // FEAT-004 Phase-3 classes tables (design §6). The eight mutable tables use the
  // default modify pair; schedule_revisions is append-only (EXPECTED_POLICIES).
  "courses",
  "subjects",
  "class_sections",
  "class_enrollments",
  "faculty_profiles",
  "faculty_assignments",
  "timetables",
  "scheduled_classes",
  "schedule_revisions",
  // Phase-4 attendance tables (design §9/§10). The three mutable tables use the
  // default modify pair; attendance_record_history is append-only (EXPECTED_POLICIES).
  "attendance_sessions",
  "attendance_records",
  "attendance_corrections",
  "attendance_record_history",
  // Phase-5 library tables (design §3). All five use the default modify pair —
  // no append-only table this phase, so none appears in EXPECTED_POLICIES.
  "book_titles",
  "book_copies",
  "library_loans",
  "book_reservations",
  "library_fines",
  // Phase-6 admissions tables (design §5). The five standard tables + the join
  // use the default modify pair; application_reviews is append-only (EXPECTED_POLICIES).
  "admission_campaigns",
  "admission_campaign_programs",
  "applications",
  "application_documents",
  "admission_offers",
  "enrollments",
  "application_reviews",
  // FEAT-004 Phase-7 fees tables (design §D.2/§D.3/§D.4). The four
  // mutable/guarded tables (fee_structures, fee_components, student_charges,
  // payment_transactions) use the default modify pair — the column-guard triggers
  // on student_charges/payment_transactions enforce immutability at the row level,
  // NOT via an append-only RLS policy, so they still carry tenant_isolation_modify.
  // The three fully INSERT-only tables (payment_allocations, receipts,
  // processed_webhook_events) are append-only (EXPECTED_POLICIES).
  "fee_structures",
  "fee_components",
  "student_charges",
  "payment_transactions",
  "payment_allocations",
  "receipts",
  "processed_webhook_events",
  // Phase-7 fees slice 7.1 (design §E.1/§E.2). concession_definitions + refunds
  // use the default modify pair (refunds carries a column-guard trigger that
  // enforces immutability at the row level, like payment_transactions). The four
  // INSERT-only tables are append-only (EXPECTED_POLICIES below).
  "concession_definitions",
  "student_concessions",
  "concession_credits",
  "refunds",
  "refund_reversals",
  "adjustments",
  // Phase-8 exams tables (design §7.3). The seven mutable/column-guard tables
  // (examinations, grading_schemes, grade_bands, exam_schedules, candidates,
  // assessments, marks_records) use the default modify pair — the column-guard
  // triggers on examinations/marks_records enforce immutability at the row level,
  // NOT via an append-only RLS policy, so they still carry tenant_isolation_modify.
  // The three INSERT-only tables are append-only (EXPECTED_POLICIES).
  "examinations",
  "grading_schemes",
  "grade_bands",
  "exam_schedules",
  "candidates",
  "assessments",
  "marks_records",
  "marks_record_history",
  "result_publications",
  "result_snapshots",
  // Phase-8 slice 8.2: reeval_requests (column-guard class) uses the default
  // modify pair (ABSENT from EXPECTED_POLICIES). result_publications moves from
  // the append-only pair to the default modify pair in 8.2 (its immutability is
  // now a column guard), so its EXPECTED_POLICIES entry is REMOVED below.
  "reeval_requests",
] as const;

/**
 * Per-table expected RLS policy-name set (design §9.3). The standard tenant pair
 * is {tenant_isolation_select, tenant_isolation_modify}; the two FEAT-003 tables
 * are special cases. NO inert *_platform_all TO-postgres policy is listed (they
 * are not created — a BYPASSRLS role ignores them). Only load-bearing policies
 * that bind campass_app appear here.
 */
export const EXPECTED_POLICIES: Record<string, readonly string[]> = {
  audit_events: ["tenant_isolation_select", "audit_events_tenant_insert"],
  support_grants: ["support_grants_tenant_read"],
  // FEAT-003: the calendar-revision table is append-only (design §4.3/§10.1) —
  // the audit_events pair, NOT the default modify pair.
  academic_calendar_day_revisions: [
    "tenant_isolation_select",
    "academic_calendar_day_revisions_tenant_insert",
  ],
  // FEAT-003: student_profile_history is append-only (design §4.3/§10.1) — the
  // SELECT + INSERT pair, NO modify policy. student_documents is deliberately
  // ABSENT here so it falls through to DEFAULT_POLICIES (the standard pair).
  student_profile_history: [
    "tenant_isolation_select",
    "student_profile_history_tenant_insert",
  ],
  // FEAT-004: schedule_revisions is append-only (design §6.9) — the SELECT +
  // INSERT pair, NO modify policy. All eight other Phase-3 tables are deliberately
  // ABSENT here so they fall through to DEFAULT_POLICIES (the standard pair).
  schedule_revisions: [
    "tenant_isolation_select",
    "schedule_revisions_tenant_insert",
  ],
  // Phase-4: attendance_record_history is append-only (design §10) — the SELECT +
  // INSERT pair, NO modify policy. The three mutable attendance tables are
  // deliberately ABSENT here so they fall through to DEFAULT_POLICIES.
  attendance_record_history: [
    "tenant_isolation_select",
    "attendance_record_history_tenant_insert",
  ],
  // FEAT-004: application_reviews is append-only (design §5) — the SELECT +
  // INSERT pair, NO modify policy. The other five Phase-6 tables + the join are
  // deliberately ABSENT here so they fall through to DEFAULT_POLICIES.
  application_reviews: [
    "tenant_isolation_select",
    "application_reviews_tenant_insert",
  ],
  // FEAT-004: the three fully INSERT-only fees tables are append-only (design
  // §D.3) — the SELECT + INSERT pair, NO modify policy. The four
  // mutable/guarded fees tables are deliberately ABSENT here so they fall through
  // to DEFAULT_POLICIES (the standard pair).
  payment_allocations: [
    "tenant_isolation_select",
    "payment_allocations_tenant_insert",
  ],
  receipts: ["tenant_isolation_select", "receipts_tenant_insert"],
  processed_webhook_events: [
    "tenant_isolation_select",
    "processed_webhook_events_tenant_insert",
  ],
  // Phase-7 fees slice 7.1: the four INSERT-only ledger tables are append-only
  // (design §E.2.g) — the SELECT + INSERT pair, NO modify policy.
  // concession_definitions + refunds are deliberately ABSENT here so they fall
  // through to DEFAULT_POLICIES (refunds's row immutability is a column guard,
  // not an append-only RLS policy — the payment_transactions precedent).
  student_concessions: [
    "tenant_isolation_select",
    "student_concessions_tenant_insert",
  ],
  concession_credits: [
    "tenant_isolation_select",
    "concession_credits_tenant_insert",
  ],
  refund_reversals: [
    "tenant_isolation_select",
    "refund_reversals_tenant_insert",
  ],
  adjustments: ["tenant_isolation_select", "adjustments_tenant_insert"],
  // Phase-8 exams: marks_record_history + result_snapshots stay strictly
  // append-only (design §7.4) — the SELECT + INSERT pair, NO modify policy. The
  // seven mutable/column-guard exam tables + reeval_requests are deliberately
  // ABSENT here so they fall through to DEFAULT_POLICIES (examinations /
  // marks_records / reeval_requests row immutability is a column guard, not an
  // append-only RLS policy — the payment_transactions precedent). Slice 8.2
  // additionally moves result_publications from the append-only pair to the
  // default modify pair (its immutability is now the result_publications_guard
  // column guard), so it too is ABSENT here and falls through to DEFAULT_POLICIES.
  marks_record_history: [
    "tenant_isolation_select",
    "marks_record_history_tenant_insert",
  ],
  result_snapshots: [
    "tenant_isolation_select",
    "result_snapshots_tenant_insert",
  ],
};

/** The default policy pair every non-special table must carry. */
export const DEFAULT_POLICIES = [
  "tenant_isolation_select",
  "tenant_isolation_modify",
] as const;
