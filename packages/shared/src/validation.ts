import { z } from "zod";

// ─── AUTH ────────────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(2, "Name must be at least 2 characters"),
  role: z.enum(["STUDENT"]), // Only students can self-register
  enrollmentNo: z.string().min(1, "Enrollment number is required"),
  departmentId: z.string().min(1, "Invalid course"),
  program: z.string().min(1, "Program is required"),
  semester: z.number().int().min(1).max(12),
  section: z.string().optional(),
});

// ─── GATE PASS ───────────────────────────────────────────────────────────────

export const createGatePassSchema = z
  .object({
    reasonId: z.string().min(1, "Reason is required"),
    customReason: z.string().optional(),
    requestedExit: z.string().datetime("Invalid exit time"),
    expectedReturn: z.string().datetime("Invalid return time"),
  })
  .refine(
    (data) => new Date(data.expectedReturn) > new Date(data.requestedExit),
    {
      message: "Return time must be after exit time",
      path: ["expectedReturn"],
    }
  );

export const approvePassSchema = z.object({
  passId: z.string().min(1, "Invalid pass ID"),
});

export const rejectPassSchema = z.object({
  passId: z.string().min(1, "Invalid pass ID"),
  rejectionReason: z.string().min(1, "Rejection reason is required"),
});

export const revokePassSchema = z.object({
  passId: z.string().min(1, "Invalid pass ID"),
  reason: z.string().min(3, "Revocation reason is required"),
});

// ─── GATE EVENTS ─────────────────────────────────────────────────────────────

export const verifyQrSchema = z.object({
  qrToken: z.string().min(1, "QR token is required"),
});

export const markExitSchema = z.object({
  passId: z.string().min(1, "Invalid pass ID"),
  gateId: z.string().min(1, "Invalid gate ID"),
});

export const markReturnSchema = z.object({
  passId: z.string().min(1, "Invalid pass ID"),
  gateId: z.string().min(1, "Invalid gate ID"),
});

export const startGuardShiftSchema = z.object({
  shiftId: z.string().min(1, "Invalid shift ID"),
});

export const endGuardShiftSchema = z.object({
  shiftId: z.string().min(1, "Invalid shift ID"),
});

// ─── ADMIN ───────────────────────────────────────────────────────────────────

export const createUserSchema = z.object({
  email: z.string().email("Invalid email"),
  name: z.string().min(2, "Name is required"),
  role: z.enum(["STUDENT", "HOD", "GUARD", "ADMIN"]),
  departmentId: z.string().min(1).optional(),
  enrollmentNo: z.string().optional(),
  program: z.string().optional(),
  semester: z.number().int().min(1).max(12).optional(),
  section: z.string().optional(),
  gateIds: z.array(z.string().min(1)).optional(),
});

export const bulkImportStudentSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  enrollmentNo: z.string().min(1),
  rollNumber: z.string().optional(),
  courseCode: z.string().min(1),
  program: z.string().min(1),
  semester: z.number().int().min(1).max(12),
  section: z.string().optional(),
  dob: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
});

export const createGuardShiftSchema = z
  .object({
    guardId: z.string().min(1, "Invalid guard ID"),
    gateId: z.string().min(1, "Invalid gate ID"),
    scheduledStartAt: z.string().datetime("Invalid start time"),
    scheduledEndAt: z.string().datetime("Invalid end time"),
    note: z.string().max(500).optional(),
  })
  .refine((data) => new Date(data.scheduledEndAt) > new Date(data.scheduledStartAt), {
    message: "Shift end time must be after start time",
    path: ["scheduledEndAt"],
  });

// ─── ALLOWANCE & RELIABILITY ─────────────────────────────────────────────────

export const updateAllowancePolicySchema = z.object({
  allowanceAmount: z.number().int().min(60).max(10080).optional(),
  policyPeriod: z.enum(["DAILY", "WEEKLY", "MONTHLY", "SEMESTER"]).optional(),
  gracePeriod: z.number().int().min(0).max(60).optional(),
  enforcement: z.enum(["BLOCK_NEW_REQUESTS", "WARN_ONLY"]).optional(),
  minimumSampleSize: z.number().int().min(3).max(20).optional(),
  severityMinorMax: z.number().int().min(1).optional(),
  severityModerateMax: z.number().int().min(2).optional(),
  severitySignificantMax: z.number().int().min(3).optional(),
});

export const emergencyOverrideSchema = z.object({
  passId: z.string().min(1),
  justification: z.string().min(10),
});

export const updateInstitutionConfigSchema = z.object({
  timezone: z.string().min(1).optional(),
  weekStartDay: z
    .enum(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"])
    .optional(),
  workingDaysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  lowAllowanceThresholdMinutes: z.number().int().min(0).max(10080).optional(),
});

export const upsertAcademicCalendarDaySchema = z.object({
  date: z.string().min(1),
  dayType: z.enum([
    "WORKING_DAY",
    "HOLIDAY",
    "WEEKEND",
    "EXAM_DAY",
    "VACATION",
    "SPECIAL_WORKING_DAY",
    "INSTITUTION_EVENT",
  ]),
  note: z.string().max(500).optional(),
  // Phase 1 generalization (all additive/optional — live callers stay valid).
  departmentId: z.string().min(1).optional(),
  academicSessionId: z.string().min(1).optional(),
  academicTermId: z.string().min(1).optional(),
});

// ─── ACADEMICS (Phase 1) ─────────────────────────────────────────────────────

const startBeforeEnd = (data: { startDate: string; endDate: string }) =>
  new Date(data.startDate) < new Date(data.endDate);

// Base object shapes are exported so routes can derive .partial()/.omit()
// variants (ZodEffects from .refine() does not support those helpers).
export const academicSessionObject = z.object({
  name: z.string().min(1, "Name is required").max(100),
  structureType: z.enum(["SEMESTER", "TRIMESTER", "ANNUAL", "CUSTOM"]),
  startDate: z.string().min(1, "Start date is required"),
  endDate: z.string().min(1, "End date is required"),
});

export const createAcademicSessionSchema = academicSessionObject.refine(startBeforeEnd, {
  message: "Start date must be before end date",
  path: ["endDate"],
});

export const academicTermObject = z.object({
  academicSessionId: z.string().min(1, "Session is required"),
  name: z.string().min(1, "Name is required").max(100),
  ordinal: z.number().int().min(1, "Ordinal must be >= 1"),
  startDate: z.string().min(1, "Start date is required"),
  endDate: z.string().min(1, "End date is required"),
});

export const createAcademicTermSchema = academicTermObject.refine(startBeforeEnd, {
  message: "Start date must be before end date",
  path: ["endDate"],
});

export const createProgramSchema = z.object({
  departmentId: z.string().min(1, "Department is required"),
  name: z.string().min(1, "Name is required").max(200),
  code: z.string().min(1, "Code is required").max(32),
  duration: z.number().int().min(1).max(20),
  durationUnit: z.enum(["TERMS", "YEARS"]).default("TERMS"),
});

// ─── STUDENTS / SIS (Phase 2) ────────────────────────────────────────────────

// Student lifecycle status enum members (mirrors the StudentStatus pg enum).
export const studentStatusEnum = z.enum([
  "APPLICANT",
  "ENROLLED",
  "ACTIVE",
  "ON_LEAVE",
  "GRADUATED",
  "WITHDRAWN",
  "SUSPENDED",
]);

export const createStudentSchema = z.object({
  email: z.string().email("Invalid email address"),
  name: z.string().min(1, "Name is required"),
  enrollmentNo: z.string().min(1, "Enrollment number is required"),
  departmentId: z.string().min(1, "Department is required"),
  program: z.string().min(1, "Program is required"),
  semester: z.number().int().min(1).max(12),
  section: z.string().optional(),
  rollNumber: z.string().optional(),
  dob: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  admissionDate: z.string().optional(),
  programId: z.string().min(1).optional(),
});

// Permitted-mutable-field rule enforced by construction: .strict() so any
// identity/lifecycle key (enrollmentNo, status, programId, semester, …) yields
// a 400 rather than being silently stripped.
export const updateStudentSchema = z
  .object({
    name: z.string().min(1).optional(),
    rollNumber: z.string().optional(),
    section: z.string().optional(),
    dob: z.string().optional(),
    phone: z.string().optional(),
    address: z.string().optional(),
    admissionDate: z.string().optional(),
  })
  .strict();

export const assignProgramSchema = z.object({
  programId: z.string().min(1, "Program is required"),
  refreshProgramText: z.boolean().optional(),
});

export const enrollStudentSchema = z.object({
  academicSessionId: z.string().min(1, "Session is required"),
  currentTermId: z.string().min(1, "Term is required"),
  activate: z.boolean().optional(),
  semester: z.number().int().min(1).max(12).optional(),
});

export const promoteStudentSchema = z.object({
  currentTermId: z.string().min(1).optional(),
  semester: z.number().int().min(1).max(12).optional(),
});

export const transferStudentSchema = z.object({
  departmentId: z.string().min(1).optional(),
  programId: z.string().min(1).optional(),
});

export const deactivateStudentSchema = z.object({
  status: studentStatusEnum,
  reason: z.string().max(500).optional(),
});

export const listStudentsQuerySchema = z.object({
  status: studentStatusEnum.optional(),
  programId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).catch(100).default(20),
});

export const declareEmergencySchema = z.object({
  type: z.enum(["FIRE", "EARTHQUAKE", "MEDICAL", "SECURITY", "EVACUATION", "OTHER"]),
  title: z.string().min(3).max(120),
  message: z.string().min(10).max(2000),
  affectedArea: z.string().max(200).optional(),
});

export const resolveEmergencySchema = z.object({
  resolutionNote: z.string().max(500).optional(),
});

// ─── CLASSES / COURSE MANAGEMENT (Phase 3) ───────────────────────────────────

// Enum members mirror the pg enums added by the phase3_classes migration.
export const classSectionStatusEnum = z.enum([
  "PLANNED",
  "ACTIVE",
  "CLOSED",
  "CANCELLED",
]);

export const facultyAssignmentRoleEnum = z.enum([
  "PRIMARY",
  "SUBSTITUTE",
  "ASSISTANT",
]);

export const dayOfWeekEnum = z.enum(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]);

// Course create/update (§10). programId required; code unique-per-tenant (409 in
// handler); academicTermId optional stage link.
export const createCourseSchema = z.object({
  programId: z.string().min(1, "Program is required"),
  name: z.string().min(1, "Name is required").max(200),
  code: z.string().min(1, "Code is required").max(40),
  description: z.string().max(2000).optional(),
  academicTermId: z.string().min(1).optional(),
});

export const updateCourseSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    academicTermId: z.string().min(1).optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  })
  .strict();

// Subject create/update (§10). courseId required; code unique-per-tenant.
export const createSubjectSchema = z.object({
  courseId: z.string().min(1, "Course is required"),
  name: z.string().min(1, "Name is required").max(200),
  code: z.string().min(1, "Code is required").max(40),
  credits: z.number().int().min(0).max(100).optional(),
  contactHoursPerWeek: z.number().int().min(0).max(100).optional(),
});

export const updateSubjectSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    credits: z.number().int().min(0).max(100).optional(),
    contactHoursPerWeek: z.number().int().min(0).max(100).optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  })
  .strict();

// ClassSection create/update (§10). program/session/term required; duplicate
// (program,session,term,label) -> 409 (composite unique).
export const createClassSectionSchema = z.object({
  programId: z.string().min(1, "Program is required"),
  academicSessionId: z.string().min(1, "Session is required"),
  academicTermId: z.string().min(1, "Term is required"),
  label: z.string().max(10).optional(),
  capacity: z.number().int().min(1).max(10000).optional(),
  status: classSectionStatusEnum.optional(),
});

export const updateClassSectionSchema = z
  .object({
    label: z.string().max(10).optional(),
    capacity: z.number().int().min(1).max(10000).optional(),
    status: classSectionStatusEnum.optional(),
  })
  .strict();

// ClassEnrollment (§10). Duplicate (section,student) + capacity -> 409 in handler.
export const enrollClassSchema = z.object({
  classSectionId: z.string().min(1, "Section is required"),
  studentId: z.string().min(1, "Student is required"),
});

// FacultyProfile create (§10). userId required (same-tenant, not already faculty).
export const createFacultyProfileSchema = z.object({
  userId: z.string().min(1, "User is required"),
  name: z.string().min(1, "Name is required").max(200),
  departmentId: z.string().min(1).optional(),
});

// FacultyAssignment (§10). facultyId/subjectId/term required; optional
// replacesAssignmentId drives the substitute swap (end + insert + revision).
export const createFacultyAssignmentSchema = z.object({
  facultyId: z.string().min(1, "Faculty is required"),
  subjectId: z.string().min(1, "Subject is required"),
  academicTermId: z.string().min(1, "Term is required"),
  classSectionId: z.string().min(1).optional(),
  role: facultyAssignmentRoleEnum.default("PRIMARY"),
  replacesAssignmentId: z.string().min(1).optional(),
});

// ScheduledClass create/update (§10). Exactly one of dayOfWeek / date; minute
// bounds [0,1440]; startTime < endTime (also DB CHECK + conflict INVALID_PERIOD).
const scheduledClassObject = z.object({
  timetableId: z.string().min(1, "Timetable is required"),
  classSectionId: z.string().min(1, "Section is required"),
  subjectId: z.string().min(1, "Subject is required"),
  facultyId: z.string().min(1, "Faculty is required"),
  academicTermId: z.string().min(1, "Term is required"),
  room: z.string().max(100).optional(),
  dayOfWeek: dayOfWeekEnum.optional(),
  date: z.string().min(1).optional(),
  startTime: z.number().int().min(0).max(1440),
  endTime: z.number().int().min(0).max(1440),
  period: z.number().int().min(0).max(50).optional(),
});

const dayXorDate = (data: { dayOfWeek?: string; date?: string }) =>
  (data.dayOfWeek == null) !== (data.date == null);
const startBeforeEndTime = (data: { startTime: number; endTime: number }) =>
  data.startTime < data.endTime;

export const createScheduledClassSchema = scheduledClassObject
  .refine(dayXorDate, {
    message: "Specify dayOfWeek OR date, not both",
    path: ["dayOfWeek"],
  })
  .refine(startBeforeEndTime, {
    message: "startTime must be before endTime",
    path: ["endTime"],
  });

export const updateScheduledClassSchema = scheduledClassObject
  .partial()
  .refine((data) => data.dayOfWeek == null || data.date == null, {
    message: "Specify dayOfWeek OR date, not both",
    path: ["dayOfWeek"],
  })
  .refine(
    (data) =>
      data.startTime == null || data.endTime == null || data.startTime < data.endTime,
    {
      message: "startTime must be before endTime",
      path: ["endTime"],
    },
  );

// Timetable create + publish (§10). Publish is a DRAFT->PUBLISHED transition
// (validated server-side; blocking conflicts -> 409).
export const createTimetableSchema = z.object({
  academicTermId: z.string().min(1, "Term is required"),
  name: z.string().min(1, "Name is required").max(200),
});

export const publishTimetableSchema = z
  .object({
    acceptWarnings: z.boolean().optional(),
  })
  .strict();

// ─── ATTENDANCE (Phase 4) ────────────────────────────────────────────────────

// Enum members mirror the pg enums added by the phase4_attendance migration.
export const attendanceStatusEnum = z.enum(["PRESENT", "ABSENT", "LATE", "EXCUSED"]);
export const attendanceSessionStatusEnum = z.enum(["OPEN", "SUBMITTED", "FINALIZED"]);
export const attendanceCorrectionReviewStatusEnum = z.enum(["PENDING", "APPROVED", "REJECTED"]);

export const openAttendanceSessionSchema = z.object({
  scheduledClassId: z.string().min(1, "Scheduled class is required"),
  date: z.coerce.date(),
  submissionDeadline: z.coerce.date().optional(),
});

export const markAttendanceRecordsSchema = z.object({
  records: z
    .array(
      z.object({
        studentId: z.string().min(1, "Student is required"),
        status: attendanceStatusEnum,
      }),
    )
    .min(1, "At least one record is required")
    .max(1000, "Too many records in one batch"),
});

export const requestCorrectionSchema = z.object({
  attendanceRecordId: z.string().min(1, "Attendance record is required"),
  requestedStatus: attendanceStatusEnum,
  reason: z.string().min(1, "Reason is required").max(2000),
});

export const reviewCorrectionSchema = z.object({
  reviewNote: z.string().max(2000).optional(),
});

export const attendanceReportQuerySchema = z.object({
  academicTermId: z.string().min(1, "Term is required"),
});

export const attendanceExportQuerySchema = z.object({
  sectionId: z.string().min(1, "Section is required"),
  academicTermId: z.string().min(1, "Term is required"),
  format: z.enum(["csv", "json"]).default("csv"),
});

// ─── LIBRARY (Phase 5) ───────────────────────────────────────────────────────

// Enum members mirror the pg enums added by the phase5_library migration.
export const bookCopyConditionEnum = z.enum(["NEW", "GOOD", "FAIR", "POOR", "DAMAGED"]);
export const libraryFineReasonEnum = z.enum(["OVERDUE", "LOST", "DAMAGED"]);

export const createBookTitleSchema = z.object({
  title: z.string().min(1, "Title is required").max(500),
  author: z.string().min(1, "Author is required").max(300),
  publisher: z.string().max(300).optional(),
  isbn: z.string().max(20).optional(),
  category: z.string().max(200).optional(),
  edition: z.string().max(100).optional(),
  publicationYear: z.coerce.number().int().min(1000).max(3000).optional(),
});

export const patchBookTitleSchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    author: z.string().min(1).max(300).optional(),
    publisher: z.string().max(300).nullish(),
    isbn: z.string().max(20).nullish(),
    category: z.string().max(200).nullish(),
    edition: z.string().max(100).nullish(),
    publicationYear: z.coerce.number().int().min(1000).max(3000).nullish(),
  })
  .strict();

export const registerBookCopySchema = z.object({
  accessionNumber: z.string().min(1, "Accession number is required").max(100),
  shelfLocation: z.string().max(200).optional(),
  condition: bookCopyConditionEnum.optional(),
  acquiredAt: z.coerce.date().optional(),
});

export const patchBookCopySchema = z
  .object({
    shelfLocation: z.string().max(200).nullish(),
    condition: bookCopyConditionEnum.optional(),
    acquiredAt: z.coerce.date().nullish(),
  })
  .strict();

export const issueLoanSchema = z.object({
  bookCopyId: z.string().min(1, "Copy is required"),
  studentId: z.string().min(1, "Student is required"),
});

export const returnLoanSchema = z.object({}).strict();

export const renewLoanSchema = z.object({}).strict();

export const markLoanLostSchema = z
  .object({
    note: z.string().max(2000).optional(),
  })
  .strict();

export const markCopyDamagedSchema = z
  .object({
    note: z.string().max(2000).optional(),
  })
  .strict();

export const createReservationSchema = z.object({
  bookTitleId: z.string().min(1, "Title is required"),
});

export const fulfilReservationSchema = z.object({
  bookCopyId: z.string().min(1, "Copy is required"),
});

export const collectReservationSchema = z.object({}).strict();

export const cancelReservationSchema = z
  .object({
    reason: z.string().max(2000).optional(),
  })
  .strict();

export const createLibraryFineSchema = z.object({
  studentId: z.string().min(1, "Student is required"),
  libraryLoanId: z.string().min(1).optional(),
  reason: libraryFineReasonEnum,
  amount: z.coerce.number().nonnegative("Amount must be non-negative"),
  note: z.string().max(2000).optional(),
});

export const waiveLibraryFineSchema = z
  .object({
    note: z.string().max(2000).optional(),
  })
  .strict();

export const payLibraryFineSchema = z
  .object({
    note: z.string().max(2000).optional(),
  })
  .strict();

export const catalogueSearchQuerySchema = z.object({
  q: z.string().max(300).optional(),
  category: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const libraryReportQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// Staff circulation reads (GET /loans, GET /reservations, GET /students/lookup).
export const libraryLoanStatusEnum = z.enum(["ACTIVE", "OVERDUE", "RETURNED", "LOST"]);
export const libraryReservationStatusEnum = z.enum(["PENDING", "FULFILLED", "CANCELLED", "EXPIRED"]);

export const libraryLoanListQuerySchema = z.object({
  status: libraryLoanStatusEnum.optional(),
  // overdue=true -> still-open loans (ACTIVE/OVERDUE) past their due date.
  overdue: z.enum(["true", "false"]).optional(),
  studentId: z.string().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const libraryReservationListQuerySchema = z.object({
  status: libraryReservationStatusEnum.optional(),
  bookTitleId: z.string().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const libraryStudentLookupQuerySchema = z.object({
  q: z.string().trim().min(2, "Enter at least 2 characters").max(100),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

// ─── ADMISSIONS (Phase 6) ────────────────────────────────────────────────────

// Enum members mirror the pg enums added by the phase6_admissions migration.
export const admissionCampaignStatusEnum = z.enum(["DRAFT", "OPEN", "CLOSED"]);
export const applicationStatusEnum = z.enum([
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "DOCUMENTS_REQUIRED",
  "ELIGIBLE",
  "SHORTLISTED",
  "OFFERED",
  "ACCEPTED",
  "ENROLLED",
  "REJECTED",
  "WITHDRAWN",
]);
export const applicationReviewDecisionEnum = z.enum([
  "RECOMMEND_ELIGIBLE",
  "RECOMMEND_REJECT",
  "REQUEST_DOCUMENTS",
  "SHORTLIST",
  "NOTE",
]);
export const admissionOfferStatusEnum = z.enum(["ISSUED", "ACCEPTED", "DECLINED", "EXPIRED"]);

// Applicant onboarding (PUBLIC POST /api/admissions/register; §8). Creates the
// applicant identity only — NO StudentProfile fields are accepted. institutionId
// is the ONE documented exception to "institutionId originates from the token".
export const admissionRegisterSchema = z
  .object({
    institutionId: z.string().min(1, "Institution is required"),
    email: z.string().email("Invalid email address"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    name: z.string().min(2, "Name must be at least 2 characters").max(200),
  })
  .strict();

// Campaign config (§8): NOT a generic form engine — exactly
// { requiredFields: string[], requiredDocTypes: string[] } with bounded lengths
// and non-empty keys.
export const campaignConfigSchema = z
  .object({
    requiredFields: z.array(z.string().min(1, "Field key must be non-empty").max(100)).max(50).default([]),
    requiredDocTypes: z.array(z.string().min(1, "Doc type must be non-empty").max(100)).max(50).default([]),
  })
  .strict();

// Campaign create/update (§8). name required non-empty; status optional;
// intakeSessionId/targetProgramId/programIds optional (resolved in-handler);
// openAt <= closeAt when both present; config validated against campaignConfigSchema.
const campaignTimesOrdered = (data: { openAt?: string; closeAt?: string }) =>
  data.openAt == null || data.closeAt == null || new Date(data.openAt) <= new Date(data.closeAt);

export const createCampaignSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(200),
    status: admissionCampaignStatusEnum.optional(),
    intakeSessionId: z.string().min(1).optional(),
    targetProgramId: z.string().min(1).optional(),
    programIds: z.array(z.string().min(1)).max(200).optional(),
    openAt: z.string().datetime("Invalid open time").optional(),
    closeAt: z.string().datetime("Invalid close time").optional(),
    config: campaignConfigSchema.optional(),
  })
  .strict()
  .refine(campaignTimesOrdered, {
    message: "openAt must be on or before closeAt",
    path: ["closeAt"],
  });

export const updateCampaignSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    status: admissionCampaignStatusEnum.optional(),
    intakeSessionId: z.string().min(1).nullish(),
    targetProgramId: z.string().min(1).nullish(),
    programIds: z.array(z.string().min(1)).max(200).optional(),
    openAt: z.string().datetime("Invalid open time").nullish(),
    closeAt: z.string().datetime("Invalid close time").nullish(),
    config: campaignConfigSchema.optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.openAt == null || data.closeAt == null || new Date(data.openAt) <= new Date(data.closeAt),
    {
      message: "openAt must be on or before closeAt",
      path: ["closeAt"],
    },
  );

// Application create (§8). Serves BOTH self-service and officer-on-behalf: the
// optional applicantEmail/applicantName are the officer-on-behalf inputs (the
// handler forces applicantUserId = request.user.userId for self-service).
export const createApplicationSchema = z
  .object({
    campaignId: z.string().min(1, "Campaign is required"),
    programId: z.string().min(1, "Program is required"),
    formData: z.record(z.string(), z.unknown()).optional(),
    applicantEmail: z.string().email("Invalid email address").optional(),
    applicantName: z.string().min(2).max(200).optional(),
  })
  .strict();

// Draft edit (PATCH /applications/:id). The applicant replaces the application's
// formData while it is still DRAFT; ownership + status are enforced in-handler.
export const updateApplicationDraftSchema = z
  .object({
    formData: z.record(z.string(), z.unknown()),
  })
  .strict();

// Document add (§8). docType validated against the campaign's requiredDocTypes
// in-handler; reference required non-empty with a length cap.
export const addApplicationDocumentSchema = z
  .object({
    docType: z.string().min(1, "Document type is required").max(100),
    reference: z.string().min(1, "Reference is required").max(2000),
    fileName: z.string().max(300).optional(),
    contentType: z.string().max(200).optional(),
  })
  .strict();

// Status transition (§8). Target status in enum; legality checked by the §3 table.
export const changeApplicationStatusSchema = z
  .object({
    status: applicationStatusEnum,
    reason: z.string().max(2000).optional(),
  })
  .strict();

// Submit / withdraw (§8). No body; .strict() rejects stray keys.
export const submitApplicationSchema = z.object({}).strict();

export const withdrawApplicationSchema = z
  .object({
    reason: z.string().max(2000).optional(),
  })
  .strict();

// Application review (§8). Append-only decision.
export const recordApplicationReviewSchema = z
  .object({
    decision: applicationReviewDecisionEnum,
    notes: z.string().max(4000).optional(),
  })
  .strict();

// Interview set (§8). Sets interviewAt on the application.
export const setApplicationInterviewSchema = z
  .object({
    interviewAt: z.string().datetime("Invalid interview time"),
  })
  .strict();

// Offer issue (§8). offeredProgramId required; expiresAt optional, must be future
// (checked in-handler); state preconditions enforced in-handler.
export const issueOfferSchema = z
  .object({
    offeredProgramId: z.string().min(1, "Offered program is required"),
    expiresAt: z.string().datetime("Invalid expiry time").optional(),
  })
  .strict();

// Offer accept / decline (applicant) / expire (officer) (§8). No body.
export const acceptOfferSchema = z.object({}).strict();

export const declineOfferSchema = z
  .object({
    reason: z.string().max(2000).optional(),
  })
  .strict();

export const expireOfferSchema = z.object({}).strict();

// Enroll (§8). enrollmentNo required; academicSessionId optional (used when the
// campaign has no intakeSessionId — resolution enforced in-handler, else 422).
export const enrollApplicationSchema = z
  .object({
    enrollmentNo: z.string().min(1, "Enrollment number is required"),
    academicSessionId: z.string().min(1).optional(),
  })
  .strict();

// ─── FEES & PAYMENTS (Phase 7 slice 1) ───────────────────────────────────────

// The SINGLE money-input schema (design §D.1). Money is INTEGER PAISE and
// crosses every JSON boundary as a decimal STRING, never a JSON number: a JSON
// number > Number.MAX_SAFE_INTEGER has already lost precision before Zod runs,
// so a z.number() schema cannot detect the truncation. The regex rejects "0",
// leading zeros, signs, decimals, and non-numeric input before the BigInt
// transform; the .refine upper bound keeps every accepted amount inside the
// single guarded Razorpay SDK-boundary conversion range (HIGH-2). Used by EVERY
// fee-amount field — no money field is ever a z.number().
export const PaiseAmount = z
  .string()
  .regex(/^[1-9]\d*$/, "positive integer paise, no leading zero")
  .transform((s) => BigInt(s))
  .refine((v) => v > 0n && v <= BigInt(Number.MAX_SAFE_INTEGER), "amount out of range");

// Enum members mirror the pg enums added by the phase7_fees_slice1 migration.
export const feeStructureStatusEnum = z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]);
export const feeComponentCategoryEnum = z.enum(["TUITION", "LIBRARY", "LAB", "EXAM", "OTHER"]);
export const studentChargeStatusEnum = z.enum(["PENDING", "PARTIALLY_PAID", "PAID"]);
export const paymentTransactionStatusEnum = z.enum(["CREATED", "AUTHORIZED", "CAPTURED", "FAILED"]);

// Fee structure create/patch (§D.5/§D.10). name required non-empty; status +
// program/session links optional (resolved in-handler via composite FKs).
export const createFeeStructureSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(200),
    status: feeStructureStatusEnum.optional(),
    programId: z.string().min(1).optional(),
    academicSessionId: z.string().min(1).optional(),
    description: z.string().max(2000).optional(),
  })
  .strict();

export const patchFeeStructureSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    status: feeStructureStatusEnum.optional(),
    programId: z.string().min(1).nullish(),
    academicSessionId: z.string().min(1).nullish(),
    description: z.string().max(2000).nullish(),
  })
  .strict();

// Fee component add (§D.5). amount via the single PaiseAmount schema (a positive
// integer-paise STRING); category required; dueDate/installment metadata optional.
export const addFeeComponentSchema = z
  .object({
    category: feeComponentCategoryEnum,
    amountPaise: PaiseAmount,
    dueDate: z.string().datetime("Invalid due date").optional(),
    installmentLabel: z.string().max(100).optional(),
    installmentNumber: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

// Post a charge to a single student (§D.5). The posted charge snapshots
// amount/category/dueDate/description; amount via PaiseAmount.
export const postChargeSchema = z
  .object({
    studentId: z.string().min(1, "Student is required"),
    feeStructureId: z.string().min(1).optional(),
    feeComponentId: z.string().min(1).optional(),
    category: feeComponentCategoryEnum,
    amountPaise: PaiseAmount,
    dueDate: z.string().datetime("Invalid due date").optional(),
    description: z.string().min(1, "Description is required").max(500),
  })
  .strict();

// Bulk-charge posting by program/session from a structure (§D.5). Each component
// snapshots onto one charge per targeted student; amounts come from the
// structure's components (PaiseAmount is enforced at component-definition time).
export const bulkChargeSchema = z
  .object({
    feeStructureId: z.string().min(1, "Fee structure is required"),
    programId: z.string().min(1).optional(),
    academicSessionId: z.string().min(1).optional(),
    studentIds: z.array(z.string().min(1)).max(5000).optional(),
  })
  .strict();

// Stage-1 create-order body (§D.5): the charges the student elects to pay.
// No client-supplied amount is ever trusted — the server recomputes the sum.
export const createPaymentSchema = z
  .object({
    chargeIds: z.array(z.string().min(1, "Charge id must be non-empty")).min(1, "At least one charge is required").max(500),
  })
  .strict();

// Stage-2 checkout-callback verify body (§D.5): the three Razorpay fields the
// browser returns. Optimistic UX only — never authoritative.
export const verifyPaymentSchema = z
  .object({
    razorpay_order_id: z.string().min(1, "razorpay_order_id is required"),
    razorpay_payment_id: z.string().min(1, "razorpay_payment_id is required"),
    razorpay_signature: z.string().min(1, "razorpay_signature is required"),
  })
  .strict();

// Reconciliation inputs (§D.11): a bounded sweep of stuck transactions.
export const reconciliationQuerySchema = z.object({
  thresholdMinutes: z.coerce.number().int().min(1).max(10080).default(30),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const runReconciliationSchema = z
  .object({
    thresholdMinutes: z.number().int().min(1).max(10080).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

// ─── FEES & PAYMENTS (Phase 7 slice 7.1) ─────────────────────────────────────
// Scholarships/concessions, refunds, adjustments, reports. Every money field
// reuses PaiseAmount (integer-paise STRING). Enums mirror the pg enums added by
// the phase7_fees_slice2 migration.

export const concessionTypeEnum = z.enum(["FIXED", "PERCENT"]);
export const concessionScopeEnum = z.enum(["PER_STUDENT", "PER_STRUCTURE"]);
export const refundStatusEnum = z.enum(["REQUESTED", "PROCESSED", "FAILED"]);
export const adjustmentTypeEnum = z.enum(["WAIVER", "WRITE_OFF", "CORRECTION"]);
export const adjustmentDirectionEnum = z.enum(["CREDIT", "DEBIT"]);

// A concession definition: FIXED paise amount XOR a PERCENT in basis points;
// scoped per-student or per-structure, optionally linked to a program/session.
export const createConcessionDefinitionSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(200),
    type: concessionTypeEnum,
    amountPaise: PaiseAmount.optional(),
    percentBps: z.number().int().min(1).max(10000).optional(),
    scope: concessionScopeEnum,
    programId: z.string().min(1).optional(),
    academicSessionId: z.string().min(1).optional(),
    note: z.string().max(2000).optional(),
    status: feeStructureStatusEnum.optional(),
  })
  .strict()
  .refine(
    (d) =>
      d.type === "FIXED"
        ? d.amountPaise !== undefined && d.percentBps === undefined
        : d.percentBps !== undefined && d.amountPaise === undefined,
    { message: "FIXED requires amountPaise (and no percentBps); PERCENT requires percentBps (and no amountPaise)" },
  );

export const patchConcessionDefinitionSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    note: z.string().max(2000).nullish(),
    status: feeStructureStatusEnum.optional(),
    programId: z.string().min(1).nullish(),
    academicSessionId: z.string().min(1).nullish(),
  })
  .strict();

// Post a concession to a student against one or more of their charges. When an
// allocation omits amountPaise the server resolves it from the definition
// (FIXED amount or PERCENT of the charge), clamped to outstanding.
export const postConcessionSchema = z
  .object({
    concessionDefinitionId: z.string().min(1, "Concession definition is required"),
    note: z.string().max(2000).optional(),
    allocations: z
      .array(
        z
          .object({
            chargeId: z.string().min(1, "Charge id is required"),
            amountPaise: PaiseAmount.optional(),
          })
          .strict(),
      )
      .min(1, "At least one allocation is required")
      .max(500),
  })
  .strict();

// Refund request body. amountPaise is validated against net-refundable in the
// service (under an advisory lock); idempotencyKey is server-minted, never here.
export const createRefundSchema = z
  .object({
    amountPaise: PaiseAmount,
    reason: z.string().min(1, "Reason is required").max(500),
    notes: z.record(z.union([z.string(), z.number()])).optional(),
  })
  .strict();

// Manual adjustment (waiver/write-off/correction). WAIVER/WRITE_OFF are always
// CREDIT; only a CORRECTION may be a DEBIT.
export const createAdjustmentSchema = z
  .object({
    chargeId: z.string().min(1, "Charge id is required"),
    type: adjustmentTypeEnum,
    direction: adjustmentDirectionEnum.optional(),
    amountPaise: PaiseAmount,
    reason: z.string().min(1, "Reason is required").max(500),
  })
  .strict()
  .refine((d) => d.direction !== "DEBIT" || d.type === "CORRECTION", {
    message: "only a CORRECTION may be a DEBIT",
  });

// ── Report query schemas (coerced + bounded; read-only, fees.view-gated) ──
export const collectionReportQuerySchema = z
  .object({
    from: z.string().datetime("Invalid from date").optional(),
    to: z.string().datetime("Invalid to date").optional(),
    groupBy: z.enum(["day", "program", "session"]).default("day"),
  })
  .strict();

export const outstandingReportQuerySchema = z
  .object({
    asOf: z.string().datetime("Invalid asOf date").optional(),
  })
  .strict();

export const reconciliationReportQuerySchema = z
  .object({
    thresholdMinutes: z.coerce.number().int().min(1).max(10080).default(30),
  })
  .strict();

export const rollupReportQuerySchema = z
  .object({
    dimension: z.enum(["program", "session"]).default("program"),
  })
  .strict();

// ─── TYPES ───────────────────────────────────────────────────────────────────

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type CreateGatePassInput = z.infer<typeof createGatePassSchema>;
export type ApprovePassInput = z.infer<typeof approvePassSchema>;
export type RejectPassInput = z.infer<typeof rejectPassSchema>;
export type RevokePassInput = z.infer<typeof revokePassSchema>;
export type VerifyQrInput = z.infer<typeof verifyQrSchema>;
export type MarkExitInput = z.infer<typeof markExitSchema>;
export type MarkReturnInput = z.infer<typeof markReturnSchema>;
export type StartGuardShiftInput = z.infer<typeof startGuardShiftSchema>;
export type EndGuardShiftInput = z.infer<typeof endGuardShiftSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type BulkImportStudentInput = z.infer<typeof bulkImportStudentSchema>;
export type CreateGuardShiftInput = z.infer<typeof createGuardShiftSchema>;
export type UpdateAllowancePolicyInput = z.infer<typeof updateAllowancePolicySchema>;
export type EmergencyOverrideInput = z.infer<typeof emergencyOverrideSchema>;
export type DeclareEmergencyInput = z.infer<typeof declareEmergencySchema>;
export type ResolveEmergencyInput = z.infer<typeof resolveEmergencySchema>;
export type UpdateInstitutionConfigInput = z.infer<typeof updateInstitutionConfigSchema>;
export type UpsertAcademicCalendarDayInput = z.infer<typeof upsertAcademicCalendarDaySchema>;
export type CreateAcademicSessionInput = z.infer<typeof createAcademicSessionSchema>;
export type CreateAcademicTermInput = z.infer<typeof createAcademicTermSchema>;
export type CreateProgramInput = z.infer<typeof createProgramSchema>;
export type StudentStatusValue = z.infer<typeof studentStatusEnum>;
export type CreateStudentInput = z.infer<typeof createStudentSchema>;
export type UpdateStudentInput = z.infer<typeof updateStudentSchema>;
export type AssignProgramInput = z.infer<typeof assignProgramSchema>;
export type EnrollStudentInput = z.infer<typeof enrollStudentSchema>;
export type PromoteStudentInput = z.infer<typeof promoteStudentSchema>;
export type TransferStudentInput = z.infer<typeof transferStudentSchema>;
export type DeactivateStudentInput = z.infer<typeof deactivateStudentSchema>;
export type ListStudentsQueryInput = z.infer<typeof listStudentsQuerySchema>;
export type ClassSectionStatusValue = z.infer<typeof classSectionStatusEnum>;
export type FacultyAssignmentRoleValue = z.infer<typeof facultyAssignmentRoleEnum>;
export type DayOfWeekValue = z.infer<typeof dayOfWeekEnum>;
export type CreateCourseInput = z.infer<typeof createCourseSchema>;
export type UpdateCourseInput = z.infer<typeof updateCourseSchema>;
export type CreateSubjectInput = z.infer<typeof createSubjectSchema>;
export type UpdateSubjectInput = z.infer<typeof updateSubjectSchema>;
export type CreateClassSectionInput = z.infer<typeof createClassSectionSchema>;
export type UpdateClassSectionInput = z.infer<typeof updateClassSectionSchema>;
export type EnrollClassInput = z.infer<typeof enrollClassSchema>;
export type CreateFacultyProfileInput = z.infer<typeof createFacultyProfileSchema>;
export type CreateFacultyAssignmentInput = z.infer<typeof createFacultyAssignmentSchema>;
export type CreateScheduledClassInput = z.infer<typeof createScheduledClassSchema>;
export type UpdateScheduledClassInput = z.infer<typeof updateScheduledClassSchema>;
export type CreateTimetableInput = z.infer<typeof createTimetableSchema>;
export type PublishTimetableInput = z.infer<typeof publishTimetableSchema>;
export type AttendanceStatusValue = z.infer<typeof attendanceStatusEnum>;
export type AttendanceSessionStatusValue = z.infer<typeof attendanceSessionStatusEnum>;
export type AttendanceCorrectionReviewStatusValue = z.infer<typeof attendanceCorrectionReviewStatusEnum>;
export type OpenAttendanceSessionInput = z.infer<typeof openAttendanceSessionSchema>;
export type MarkAttendanceRecordsInput = z.infer<typeof markAttendanceRecordsSchema>;
export type RequestCorrectionInput = z.infer<typeof requestCorrectionSchema>;
export type ReviewCorrectionInput = z.infer<typeof reviewCorrectionSchema>;
export type AttendanceReportQueryInput = z.infer<typeof attendanceReportQuerySchema>;
export type AttendanceExportQueryInput = z.infer<typeof attendanceExportQuerySchema>;
export type BookCopyConditionValue = z.infer<typeof bookCopyConditionEnum>;
export type LibraryFineReasonValue = z.infer<typeof libraryFineReasonEnum>;
export type CreateBookTitleInput = z.infer<typeof createBookTitleSchema>;
export type PatchBookTitleInput = z.infer<typeof patchBookTitleSchema>;
export type RegisterBookCopyInput = z.infer<typeof registerBookCopySchema>;
export type PatchBookCopyInput = z.infer<typeof patchBookCopySchema>;
export type IssueLoanInput = z.infer<typeof issueLoanSchema>;
export type ReturnLoanInput = z.infer<typeof returnLoanSchema>;
export type RenewLoanInput = z.infer<typeof renewLoanSchema>;
export type MarkLoanLostInput = z.infer<typeof markLoanLostSchema>;
export type MarkCopyDamagedInput = z.infer<typeof markCopyDamagedSchema>;
export type CreateReservationInput = z.infer<typeof createReservationSchema>;
export type FulfilReservationInput = z.infer<typeof fulfilReservationSchema>;
export type CollectReservationInput = z.infer<typeof collectReservationSchema>;
export type CancelReservationInput = z.infer<typeof cancelReservationSchema>;
export type CreateLibraryFineInput = z.infer<typeof createLibraryFineSchema>;
export type WaiveLibraryFineInput = z.infer<typeof waiveLibraryFineSchema>;
export type PayLibraryFineInput = z.infer<typeof payLibraryFineSchema>;
export type CatalogueSearchQueryInput = z.infer<typeof catalogueSearchQuerySchema>;
export type LibraryReportQueryInput = z.infer<typeof libraryReportQuerySchema>;
export type LibraryLoanListQueryInput = z.infer<typeof libraryLoanListQuerySchema>;
export type LibraryReservationListQueryInput = z.infer<typeof libraryReservationListQuerySchema>;
export type LibraryStudentLookupQueryInput = z.infer<typeof libraryStudentLookupQuerySchema>;
export type UpdateApplicationDraftInput = z.infer<typeof updateApplicationDraftSchema>;
export type AdmissionCampaignStatusValue = z.infer<typeof admissionCampaignStatusEnum>;
export type ApplicationStatusValue = z.infer<typeof applicationStatusEnum>;
export type ApplicationReviewDecisionValue = z.infer<typeof applicationReviewDecisionEnum>;
export type AdmissionOfferStatusValue = z.infer<typeof admissionOfferStatusEnum>;
export type AdmissionRegisterInput = z.infer<typeof admissionRegisterSchema>;
export type CampaignConfigInput = z.infer<typeof campaignConfigSchema>;
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;
export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
export type AddApplicationDocumentInput = z.infer<typeof addApplicationDocumentSchema>;
export type ChangeApplicationStatusInput = z.infer<typeof changeApplicationStatusSchema>;
export type SubmitApplicationInput = z.infer<typeof submitApplicationSchema>;
export type WithdrawApplicationInput = z.infer<typeof withdrawApplicationSchema>;
export type RecordApplicationReviewInput = z.infer<typeof recordApplicationReviewSchema>;
export type SetApplicationInterviewInput = z.infer<typeof setApplicationInterviewSchema>;
export type IssueOfferInput = z.infer<typeof issueOfferSchema>;
export type AcceptOfferInput = z.infer<typeof acceptOfferSchema>;
export type DeclineOfferInput = z.infer<typeof declineOfferSchema>;
export type ExpireOfferInput = z.infer<typeof expireOfferSchema>;
export type EnrollApplicationInput = z.infer<typeof enrollApplicationSchema>;
export type PaiseAmountInput = z.infer<typeof PaiseAmount>;
export type FeeStructureStatusValue = z.infer<typeof feeStructureStatusEnum>;
export type FeeComponentCategoryValue = z.infer<typeof feeComponentCategoryEnum>;
export type StudentChargeStatusValue = z.infer<typeof studentChargeStatusEnum>;
export type PaymentTransactionStatusValue = z.infer<typeof paymentTransactionStatusEnum>;
export type CreateFeeStructureInput = z.infer<typeof createFeeStructureSchema>;
export type PatchFeeStructureInput = z.infer<typeof patchFeeStructureSchema>;
export type AddFeeComponentInput = z.infer<typeof addFeeComponentSchema>;
export type PostChargeInput = z.infer<typeof postChargeSchema>;
export type BulkChargeInput = z.infer<typeof bulkChargeSchema>;
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type VerifyPaymentInput = z.infer<typeof verifyPaymentSchema>;
export type ReconciliationQueryInput = z.infer<typeof reconciliationQuerySchema>;
export type RunReconciliationInput = z.infer<typeof runReconciliationSchema>;
export type ConcessionTypeValue = z.infer<typeof concessionTypeEnum>;
export type ConcessionScopeValue = z.infer<typeof concessionScopeEnum>;
export type RefundStatusValue = z.infer<typeof refundStatusEnum>;
export type AdjustmentTypeValue = z.infer<typeof adjustmentTypeEnum>;
export type AdjustmentDirectionValue = z.infer<typeof adjustmentDirectionEnum>;
export type CreateConcessionDefinitionInput = z.infer<typeof createConcessionDefinitionSchema>;
export type PatchConcessionDefinitionInput = z.infer<typeof patchConcessionDefinitionSchema>;
export type PostConcessionInput = z.infer<typeof postConcessionSchema>;
export type CreateRefundInput = z.infer<typeof createRefundSchema>;
export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;
export type CollectionReportQueryInput = z.infer<typeof collectionReportQuerySchema>;
export type OutstandingReportQueryInput = z.infer<typeof outstandingReportQuerySchema>;
export type ReconciliationReportQueryInput = z.infer<typeof reconciliationReportQuerySchema>;
export type RollupReportQueryInput = z.infer<typeof rollupReportQuerySchema>;

// ─── Phase 8 Examinations & Results (slice 8.1) ──────────────────────────────
// institutionId / userId are NEVER accepted from the body — always from the
// verified token. seatNo is NEVER a client input (server-assigned under the
// allocation advisory lock). Money-free but string-safe + well-typed.

const cuidLikeString = z.string().min(1).max(64);

export const examinationTypeEnum = z.enum(["MIDTERM", "FINAL", "INTERNAL", "SUPPLEMENTARY"]);

export const reevalRequestStatusEnum = z.enum([
  "REQUESTED",
  "UNDER_REVIEW",
  "REMARKED",
  "CLOSED",
  "REJECTED",
]);

export const createExaminationSchema = z.object({
  academicSessionId: cuidLikeString,
  academicTermId: cuidLikeString,
  programId: cuidLikeString,
  name: z.string().min(1).max(200),
  type: examinationTypeEnum,
  // Slice 8.2: optional self-link for a SUPPLEMENTARY exam. The cross-field rule
  // (type === SUPPLEMENTARY ⇔ parentExaminationId present, same-tenant) is
  // service-owned (assertSupplementaryLinkage) because it needs a DB existence check.
  parentExaminationId: cuidLikeString.optional(),
});

export const patchExaminationSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
  })
  .refine((v) => v.name !== undefined, { message: "no updatable fields provided" });

export const advanceExamStatusSchema = z.object({
  to: z.enum(["SCHEDULED", "MARKS_OPEN", "MARKS_LOCKED", "MODERATION", "APPROVED"]),
});

export const createExamScheduleSchema = z.object({
  subjectId: cuidLikeString,
  room: z.string().min(1).max(100),
  roomCapacity: z.number().int().positive(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

export const allocateCandidatesSchema = z.object({
  candidateIds: z.array(cuidLikeString).min(1).max(1000),
});

export const registerCandidatesSchema = z.object({
  studentIds: z.array(cuidLikeString).min(1).max(5000),
});

export const createAssessmentSchema = z.object({
  subjectId: cuidLikeString,
  name: z.string().min(1).max(100),
  maxMarks: z.number().int().positive(),
  weight: z.number().int().min(1).max(100),
});

export const patchAssessmentSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    maxMarks: z.number().int().positive().optional(),
    weight: z.number().int().min(1).max(100).optional(),
  })
  .refine((v) => v.name !== undefined || v.maxMarks !== undefined || v.weight !== undefined, {
    message: "no updatable fields provided",
  });

export const putMarksSchema = z.object({
  marks: z
    .array(
      z.object({
        assessmentId: cuidLikeString,
        candidateId: cuidLikeString,
        marks: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(5000),
});

export const correctMarkSchema = z.object({
  marks: z.number().int().min(0),
  reason: z.string().min(1).max(500),
});

const gradeBandInputSchema = z.object({
  minPercentBps: z.number().int().min(0).max(10000),
  maxPercentBps: z.number().int().min(0).max(10000),
  gradeLabel: z.string().min(1).max(20),
  gradePoints: z.number().int().min(0),
  isPassing: z.boolean(),
});

export const createGradingSchemeSchema = z.object({
  name: z.string().min(1).max(200),
  isActive: z.boolean().optional(),
  bands: z.array(gradeBandInputSchema).min(1).max(50),
});

export const patchGradingSchemeSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    isActive: z.boolean().optional(),
    bands: z.array(gradeBandInputSchema).min(1).max(50).optional(),
  })
  .refine((v) => v.name !== undefined || v.isActive !== undefined || v.bands !== undefined, {
    message: "no updatable fields provided",
  });

// ─── Slice 8.2: re-evaluation + supplementary registration schemas ──────────

export const createReevalRequestSchema = z.object({
  examId: cuidLikeString,
  subjectId: cuidLikeString,
  reason: z.string().min(1).max(500),
});

// Shape only; the (from,to) legality, the optimistic concurrency guard, and the
// outcomePublicationId existence/scope check are service-owned (they need the
// current DB row). `note` is required for REJECTED; outcomePublicationId is only
// meaningful for REMARKED.
export const transitionReevalSchema = z
  .object({
    to: z.enum(["UNDER_REVIEW", "REMARKED", "CLOSED", "REJECTED"]),
    note: z.string().min(1).max(500).optional(),
    outcomePublicationId: cuidLikeString.optional(),
  })
  .refine((v) => v.to !== "REJECTED" || v.note !== undefined, {
    message: "note is required when rejecting a re-evaluation request",
  })
  .refine((v) => v.outcomePublicationId === undefined || v.to === "REMARKED", {
    message: "outcomePublicationId is only permitted when transitioning to REMARKED",
  });

export const remarkReevalSchema = z.object({
  marksRecordId: cuidLikeString,
  marks: z.number().int().min(0),
  reason: z.string().min(1).max(500),
});

export const listReevalQuerySchema = z.object({
  status: reevalRequestStatusEnum.optional(),
  examId: cuidLikeString.optional(),
});

export const registerSupplementaryCandidatesSchema = z.object({
  subjectIds: z.array(cuidLikeString).min(1).max(1000),
  studentIds: z.array(cuidLikeString).max(5000).optional(),
});

export type ExaminationTypeValue = z.infer<typeof examinationTypeEnum>;
export type ReevalRequestStatusValue = z.infer<typeof reevalRequestStatusEnum>;
export type CreateReevalRequestInput = z.infer<typeof createReevalRequestSchema>;
export type TransitionReevalInput = z.infer<typeof transitionReevalSchema>;
export type RemarkReevalInput = z.infer<typeof remarkReevalSchema>;
export type ListReevalQueryInput = z.infer<typeof listReevalQuerySchema>;
export type RegisterSupplementaryCandidatesInput = z.infer<typeof registerSupplementaryCandidatesSchema>;
export type CreateExaminationInput = z.infer<typeof createExaminationSchema>;
export type PatchExaminationInput = z.infer<typeof patchExaminationSchema>;
export type AdvanceExamStatusInput = z.infer<typeof advanceExamStatusSchema>;
export type CreateExamScheduleInput = z.infer<typeof createExamScheduleSchema>;
export type AllocateCandidatesInput = z.infer<typeof allocateCandidatesSchema>;
export type RegisterCandidatesInput = z.infer<typeof registerCandidatesSchema>;
export type CreateAssessmentInput = z.infer<typeof createAssessmentSchema>;
export type PatchAssessmentInput = z.infer<typeof patchAssessmentSchema>;
export type PutMarksInput = z.infer<typeof putMarksSchema>;
export type CorrectMarkInput = z.infer<typeof correctMarkSchema>;
export type CreateGradingSchemeInput = z.infer<typeof createGradingSchemeSchema>;
export type PatchGradingSchemeInput = z.infer<typeof patchGradingSchemeSchema>;

// ─── Phase 9.1 Faculty Management ────────────────────────────────────────────
// institutionId / userId are NEVER accepted from the body — always from the
// verified token. facultyId / academicTermId / qualification id come from the
// path and are existence-validated by composite FK + in-handler lookup, not
// trusted from input. documentRef is a metadata string/URL only — NO upload.

export const facultyQualificationKindEnum = z.enum([
  "DEGREE",
  "CERTIFICATION",
  "DIPLOMA",
  "OTHER",
]);

const qualificationYearSchema = z
  .number()
  .int()
  .min(1900)
  .max(new Date().getFullYear() + 1);

export const createFacultyQualificationSchema = z.object({
  title: z.string().min(1).max(200),
  kind: facultyQualificationKindEnum.optional(),
  issuingBody: z.string().min(1).max(200).optional(),
  field: z.string().min(1).max(200).optional(),
  year: qualificationYearSchema.optional(),
  documentRef: z.string().min(1).max(2048).optional(),
});

// All fields optional; at least one must be present. NOTE: a PATCH that passes
// validation and writes ALWAYS records faculty.qualification.updated — even a
// semantic no-op (audits the staff action, not a field diff) — design §B.11 F8.
export const patchFacultyQualificationSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    kind: facultyQualificationKindEnum.optional(),
    issuingBody: z.string().min(1).max(200).optional(),
    field: z.string().min(1).max(200).optional(),
    year: qualificationYearSchema.optional(),
    documentRef: z.string().min(1).max(2048).optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.kind !== undefined ||
      v.issuingBody !== undefined ||
      v.field !== undefined ||
      v.year !== undefined ||
      v.documentRef !== undefined,
    { message: "no updatable fields provided" },
  );

export const putWorkloadPolicySchema = z.object({
  maxWeeklyHours: z.number().int().min(1).max(168),
});

// nonTeachingHours / override / overrideReason. overrideReason is REQUIRED when
// override === true (design §B.11). The over-allocation 422 decision itself is
// service-owned (needs the policy row + computed total).
export const patchFacultyWorkloadSchema = z
  .object({
    nonTeachingHours: z.number().int().min(0).max(168).optional(),
    override: z.boolean().optional(),
    overrideReason: z.string().min(1).max(500).optional(),
  })
  .refine((v) => v.override !== true || (v.overrideReason !== undefined && v.overrideReason.length > 0), {
    message: "overrideReason is required when override is true",
    path: ["overrideReason"],
  });

export type FacultyQualificationKindValue = z.infer<typeof facultyQualificationKindEnum>;
export type CreateFacultyQualificationInput = z.infer<typeof createFacultyQualificationSchema>;
export type PatchFacultyQualificationInput = z.infer<typeof patchFacultyQualificationSchema>;
export type PutWorkloadPolicyInput = z.infer<typeof putWorkloadPolicySchema>;
export type PatchFacultyWorkloadInput = z.infer<typeof patchFacultyWorkloadSchema>;

// ─── Phase 9.2 HR Management ─────────────────────────────────────────────────
// institutionId / userId (the actor) are NEVER accepted from the body — always
// from the verified token. userId (the employee's referenced user), departmentId,
// employeeId, shiftId, contractId, appId come from the body/path and are
// existence-validated by composite FK + in-handler lookup, not trusted from
// input. salaryAmount is a stored BIGINT minor-unit metadata field — NO fees
// integration. `days` is derived server-side from start/end (inclusive) and is
// NEVER trusted from the client. Enums mirror the Prisma/pg enums (§4.7).

export const hrEmploymentTypeEnum = z.enum(["PERMANENT", "CONTRACT", "PART_TIME"]);
export const hrEmployeeStatusEnum = z.enum(["ACTIVE", "INACTIVE", "TERMINATED"]);
export const hrContractTypeEnum = z.enum(["PERMANENT", "FIXED_TERM", "PROBATION", "CONSULTANT"]);
export const hrLeaveTypeEnum = z.enum(["CASUAL", "SICK", "EARNED", "UNPAID", "OTHER"]);
export const hrAccrualRuleEnum = z.enum(["ANNUAL_LUMP_SUM", "MONTHLY_ACCRUAL"]);
export const hrAttendanceStatusEnum = z.enum(["PRESENT", "ABSENT", "ON_LEAVE", "HALF_DAY"]);
export const hrAttendanceSourceEnum = z.enum(["MANUAL", "DERIVED"]);

// ISO calendar-date (YYYY-MM-DD). Accepts a full ISO datetime too, but the
// :date path segment uses the strict YYYY-MM-DD form below.
const hrIsoDateSchema = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: "invalid ISO date" });

// Strict YYYY-MM-DD path segment (route #19 PATCH .../attendance/:date).
export const hrDatePathSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: "invalid calendar date" });

// Optional metadata JSON object, size-bounded to 16 KB serialized.
const hrMetadataSchema = z
  .record(z.unknown())
  .refine((v) => JSON.stringify(v).length <= 16 * 1024, {
    message: "metadata exceeds 16KB",
  });

// salaryAmount: optional integer (BIGINT minor units) >= 0. Bounded to the safe
// integer range so it round-trips through JSON before BigInt coercion.
const hrSalaryAmountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// ── Employees (routes #1 / #2) ──
export const createEmployeeSchema = z.object({
  userId: z.string().min(1, "User is required"),
  employeeNo: z.string().trim().min(1).max(64),
  designation: z.string().min(1).max(200).optional(),
  employmentType: hrEmploymentTypeEnum,
  departmentId: z.string().min(1).optional(),
  joiningDate: hrIsoDateSchema,
  status: hrEmployeeStatusEnum.optional(),
});

// All fields optional; at least one must be present. userId is immutable (the
// employee→user binding never changes) so it is NOT patchable.
export const patchEmployeeSchema = z
  .object({
    employeeNo: z.string().trim().min(1).max(64).optional(),
    designation: z.string().min(1).max(200).optional(),
    employmentType: hrEmploymentTypeEnum.optional(),
    departmentId: z.string().min(1).nullable().optional(),
    joiningDate: hrIsoDateSchema.optional(),
    status: hrEmployeeStatusEnum.optional(),
  })
  .refine(
    (v) =>
      v.employeeNo !== undefined ||
      v.designation !== undefined ||
      v.employmentType !== undefined ||
      v.departmentId !== undefined ||
      v.joiningDate !== undefined ||
      v.status !== undefined,
    { message: "no updatable fields provided" },
  );

// ── Contracts (routes #5 / #6) ──
export const createContractSchema = z
  .object({
    contractType: hrContractTypeEnum,
    startDate: hrIsoDateSchema,
    endDate: hrIsoDateSchema.optional(),
    termsMetadata: hrMetadataSchema.optional(),
    salaryAmount: hrSalaryAmountSchema.optional(),
    currency: z.literal("INR").default("INR"),
  })
  .refine((v) => v.endDate === undefined || Date.parse(v.endDate) >= Date.parse(v.startDate), {
    message: "endDate must be on or after startDate",
    path: ["endDate"],
  });

// Supersede creates a NEW ACTIVE contract version (same shape as create) and
// flips the prior row to SUPERSEDED in the same tx (§4.2).
export const supersedeContractSchema = createContractSchema;

// ── Leave policies (route #9 — PUT /leave-policies/:leaveType) ──
// leaveType comes from the path; the body carries the policy config.
export const putLeavePolicySchema = z.object({
  annualQuotaDays: z.number().int().min(0),
  accrualRule: hrAccrualRuleEnum,
  active: z.boolean().optional(),
});

// ── Leave applications (routes #11 staff / #28 self) ──
// `days` is derived server-side (inclusive endpoints) and NEVER trusted from the
// client; startDate/endDate must share one calendar year (multi-year rejected).
export const createLeaveApplicationSchema = z
  .object({
    leaveType: hrLeaveTypeEnum,
    startDate: hrIsoDateSchema,
    endDate: hrIsoDateSchema,
    reason: z.string().min(1).max(2000),
  })
  .refine((v) => Date.parse(v.endDate) >= Date.parse(v.startDate), {
    message: "endDate must be on or after startDate",
    path: ["endDate"],
  })
  .refine((v) => new Date(v.startDate).getUTCFullYear() === new Date(v.endDate).getUTCFullYear(), {
    message: "leave startDate and endDate must share one calendar year",
    path: ["endDate"],
  });

// Approve / reject carry an optional review note (routes #12 / #13).
export const reviewLeaveApplicationSchema = z.object({
  reviewNote: z.string().min(1).max(2000).optional(),
});

// ── Shifts (routes #16a POST / #16b PATCH) ──
export const putShiftSchema = z.object({
  name: z.string().trim().min(1).max(200),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(0).max(1439),
  active: z.boolean().optional(),
});

// PATCH /shifts/:id — all fields optional, at least one present.
export const patchShiftSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    startMinute: z.number().int().min(0).max(1439).optional(),
    endMinute: z.number().int().min(0).max(1439).optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.startMinute !== undefined ||
      v.endMinute !== undefined ||
      v.active !== undefined,
    { message: "no updatable fields provided" },
  );

// ── Employee attendance (routes #18 record / #19 correct) ──
export const recordAttendanceSchema = z.object({
  attendanceDate: hrIsoDateSchema,
  status: hrAttendanceStatusEnum,
  source: hrAttendanceSourceEnum.optional(),
  shiftId: z.string().min(1).optional(),
});

// Correction (PATCH .../attendance/:date) — the date is in the path; the body
// carries the new status (+ optional shift / reason / metadata).
export const correctAttendanceSchema = z.object({
  status: hrAttendanceStatusEnum,
  source: hrAttendanceSourceEnum.optional(),
  shiftId: z.string().min(1).nullable().optional(),
  reason: z.string().min(1).max(2000).optional(),
  metadata: hrMetadataSchema.optional(),
});

// ── Leave-balance query (routes #15 staff / #27b self) ──
// year optional int bounded 2000..2100, default current calendar year. The
// handler derives referenceDate = min(today, Dec 31 of year) server-side.
export const leaveBalanceQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

// ── Report date-range query (routes #21–#24) ──
// from/to ISO dates, to >= from, range <= 366 days.
export const hrReportRangeQuerySchema = z
  .object({
    from: hrIsoDateSchema,
    to: hrIsoDateSchema,
  })
  .refine((v) => Date.parse(v.to) >= Date.parse(v.from), {
    message: "to must be on or after from",
    path: ["to"],
  })
  .refine(
    (v) => (Date.parse(v.to) - Date.parse(v.from)) / (24 * 60 * 60 * 1000) <= 366,
    { message: "range must not exceed 366 days", path: ["to"] },
  );

export type HrEmploymentTypeValue = z.infer<typeof hrEmploymentTypeEnum>;
export type HrEmployeeStatusValue = z.infer<typeof hrEmployeeStatusEnum>;
export type HrContractTypeValue = z.infer<typeof hrContractTypeEnum>;
export type HrLeaveTypeValue = z.infer<typeof hrLeaveTypeEnum>;
export type HrAccrualRuleValue = z.infer<typeof hrAccrualRuleEnum>;
export type HrAttendanceStatusValue = z.infer<typeof hrAttendanceStatusEnum>;
export type HrAttendanceSourceValue = z.infer<typeof hrAttendanceSourceEnum>;
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type PatchEmployeeInput = z.infer<typeof patchEmployeeSchema>;
export type CreateContractInput = z.infer<typeof createContractSchema>;
export type SupersedeContractInput = z.infer<typeof supersedeContractSchema>;
export type PutLeavePolicyInput = z.infer<typeof putLeavePolicySchema>;
export type CreateLeaveApplicationInput = z.infer<typeof createLeaveApplicationSchema>;
export type ReviewLeaveApplicationInput = z.infer<typeof reviewLeaveApplicationSchema>;
export type PutShiftInput = z.infer<typeof putShiftSchema>;
export type PatchShiftInput = z.infer<typeof patchShiftSchema>;
export type RecordAttendanceInput = z.infer<typeof recordAttendanceSchema>;
export type CorrectAttendanceInput = z.infer<typeof correctAttendanceSchema>;
export type LeaveBalanceQueryInput = z.infer<typeof leaveBalanceQuerySchema>;
export type HrReportRangeQueryInput = z.infer<typeof hrReportRangeQuerySchema>;

// ── Frontend read/lookup queries (G-H1..G-H5) ──
// Staff list of employees with optional filters + paging (GET /employees).
export const hrEmployeeListQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  status: hrEmployeeStatusEnum.optional(),
  departmentId: z.string().min(1).max(100).optional(),
  employmentType: hrEmploymentTypeEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
// Cross-employee leave queue (GET /leave).
export const hrLeaveListQuerySchema = z.object({
  status: z.enum(["REQUESTED", "APPROVED", "REJECTED", "CANCELLED"]).optional(),
  leaveType: hrLeaveTypeEnum.optional(),
  employeeId: z.string().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
// Daily attendance roster (GET /attendance/roster?date=YYYY-MM-DD).
export const hrAttendanceRosterQuerySchema = z.object({
  date: hrDatePathSchema,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
// User picker for creating an employee (GET /users/lookup).
export const hrUserLookupQuerySchema = z.object({
  q: z.string().trim().min(2, "Enter at least 2 characters").max(100),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

// Faculty directory list (GET /api/faculty).
export const facultyListQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  departmentId: z.string().min(1).max(100).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// ─── Phase 9.3 Hostel Management ─────────────────────────────────────────────
// institutionId / userId / studentId (for /me/*) are NEVER accepted from the
// body — always derived from the verified token / the caller's StudentProfile.
// Enum members mirror the pg enums added by the 20270103000000_phase9_hostel
// migration (design §B.2 / §B.10).

export const hostelBuildingTypeEnum = z.enum(["BOYS", "GIRLS", "MIXED", "STAFF"]);
export const hostelRoomStatusEnum = z.enum(["AVAILABLE", "FULL", "MAINTENANCE", "CLOSED"]);
export const hostelCheckEventTypeEnum = z.enum(["CHECK_IN", "CHECK_OUT"]);
// Only the forward reachable states a staff transition may target (never OPEN).
export const hostelMaintenanceTransitionTargetEnum = z.enum([
  "IN_PROGRESS",
  "RESOLVED",
  "CANCELLED",
]);

const hostelCuidLike = z.string().min(1).max(64);

// 1. Buildings. isActive optional (DB column defaults true). wardenUserId is a
// recorded actor id (no FK, assumption A1).
export const createBuildingSchema = z.object({
  name: z.string().min(1, "Name is required").max(120),
  type: hostelBuildingTypeEnum,
  wardenUserId: hostelCuidLike.optional(),
  isActive: z.boolean().optional(),
});

export const patchBuildingSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    type: hostelBuildingTypeEnum.optional(),
    wardenUserId: hostelCuidLike.nullish(),
    isActive: z.boolean().optional(),
  })
  .strict();

// 2. Rooms. capacity sanity-capped at 64; capacity-below-occupancy is a runtime
// 409 (§B.5), not a schema error. status is a manual staff flag (§B.2 Table 2).
export const createRoomSchema = z.object({
  roomNumber: z.string().min(1, "Room number is required").max(32),
  capacity: z.coerce.number().int().min(1).max(64),
  floor: z.coerce.number().int().min(0).max(200).optional(),
});

export const patchRoomSchema = z
  .object({
    roomNumber: z.string().min(1).max(32).optional(),
    capacity: z.coerce.number().int().min(1).optional(),
    floor: z.coerce.number().int().min(0).max(200).nullish(),
    status: hostelRoomStatusEnum.optional(),
  })
  .strict();

// 3. Allocation / transfer / check / vacate.
export const allocateSchema = z.object({
  roomId: hostelCuidLike,
  studentId: hostelCuidLike,
});

export const transferSchema = z.object({
  toRoomId: hostelCuidLike,
});

export const checkEventSchema = z.object({
  eventType: hostelCheckEventTypeEnum,
  occurredAt: z.coerce.date().optional(), // defaults to now() in the handler
});

// 4. Leave. toDate >= fromDate (refine). applyLeaveSchema is used by the student
// self-service POST /me/leave. Vacate + /me/leave/:id/cancel take NO body
// (design-review NIT 5), so they have no schema here.
export const applyLeaveSchema = z
  .object({
    fromDate: z.coerce.date(),
    toDate: z.coerce.date(),
    reason: z.string().min(1, "Reason is required").max(500),
  })
  .refine((v) => v.toDate >= v.fromDate, {
    message: "toDate must be on or after fromDate",
    path: ["toDate"],
  });

export const leaveDecisionSchema = z
  .object({
    decisionNote: z.string().max(500).optional(),
  })
  .strict();

// 5. Maintenance.
export const createMaintenanceSchema = z.object({
  roomId: hostelCuidLike,
  issue: z.string().min(1, "Issue is required").max(500),
  assigneeUserId: hostelCuidLike.optional(),
});

export const maintenanceTransitionSchema = z.object({
  toStatus: hostelMaintenanceTransitionTargetEnum,
  resolutionNote: z.string().max(500).optional(),
});

// 6. List / report query schemas (page >= 1 default 1; pageSize 1..100
// default 20; optional buildingId + status filters).
export const hostelListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  buildingId: hostelCuidLike.optional(),
  status: z.string().max(40).optional(),
});

export type HostelBuildingTypeValue = z.infer<typeof hostelBuildingTypeEnum>;
export type HostelRoomStatusValue = z.infer<typeof hostelRoomStatusEnum>;
export type HostelCheckEventTypeValue = z.infer<typeof hostelCheckEventTypeEnum>;
export type HostelMaintenanceTransitionTargetValue = z.infer<
  typeof hostelMaintenanceTransitionTargetEnum
>;
export type CreateBuildingInput = z.infer<typeof createBuildingSchema>;
export type PatchBuildingInput = z.infer<typeof patchBuildingSchema>;
export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type PatchRoomInput = z.infer<typeof patchRoomSchema>;
export type AllocateInput = z.infer<typeof allocateSchema>;
export type TransferInput = z.infer<typeof transferSchema>;
export type CheckEventInput = z.infer<typeof checkEventSchema>;
export type ApplyLeaveInput = z.infer<typeof applyLeaveSchema>;
export type LeaveDecisionInput = z.infer<typeof leaveDecisionSchema>;
export type CreateMaintenanceInput = z.infer<typeof createMaintenanceSchema>;
export type MaintenanceTransitionInput = z.infer<typeof maintenanceTransitionSchema>;
export type HostelListQueryInput = z.infer<typeof hostelListQuerySchema>;

// ─── Phase 9.4 Transport Management ──────────────────────────────────────────
// institutionId / userId / studentId (for /me/*) are NEVER accepted from the
// body — always derived from the verified token / the caller's StudentProfile.
// Enum members mirror the pg enums added by the 20270110000000_phase9_transport
// migration (design §B.2). feeAmount / cost are int paise in the DB but cross
// the JSON boundary as a decimal-digit STRING (money-as-string, design §D.1).

export const transportVehicleTypeEnum = z.enum(["BUS", "VAN", "CAR", "OTHER"]);
export const transportVehicleStatusEnum = z.enum(["ACTIVE", "INACTIVE", "MAINTENANCE"]);
export const transportDriverStatusEnum = z.enum(["ACTIVE", "INACTIVE"]);
export const transportRouteStatusEnum = z.enum(["ACTIVE", "INACTIVE"]);
export const transportDayOfWeekEnum = z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);
// Only the forward reachable states a staff transition may target (never OPEN).
export const transportMaintenanceTransitionTargetEnum = z.enum([
  "IN_PROGRESS",
  "RESOLVED",
  "CANCELLED",
]);

const transportCuidLike = z.string().min(1).max(64);

// feeAmount / cost money-as-string boundary: a non-empty decimal-digit string
// that parses to int paise >= 0 (the DB stores Int).
const transportMoneyString = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer number of paise");

// 1. Vehicles. seatCapacity coerced int >= 1 (CHECK seatCapacity >= 1). status
// optional (DB column defaults ACTIVE).
export const createVehicleSchema = z.object({
  registrationNo: z.string().min(1, "Registration number is required").max(32),
  type: transportVehicleTypeEnum,
  seatCapacity: z.coerce.number().int().min(1),
  status: transportVehicleStatusEnum.optional(),
});

export const patchVehicleSchema = z
  .object({
    registrationNo: z.string().min(1).max(32).optional(),
    type: transportVehicleTypeEnum.optional(),
    seatCapacity: z.coerce.number().int().min(1).optional(),
    status: transportVehicleStatusEnum.optional(),
  })
  .strict();

// 2. Drivers. phone / userId optional (recorded actor id, no FK). status
// optional (DB column defaults ACTIVE).
export const createDriverSchema = z.object({
  name: z.string().min(1, "Name is required").max(120),
  licenseNo: z.string().min(1, "License number is required").max(64),
  phone: z.string().min(1).max(32).optional(),
  userId: transportCuidLike.optional(),
  status: transportDriverStatusEnum.optional(),
});

export const patchDriverSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    licenseNo: z.string().min(1).max(64).optional(),
    phone: z.string().min(1).max(32).nullish(),
    userId: transportCuidLike.nullish(),
    status: transportDriverStatusEnum.optional(),
  })
  .strict();

// 3. Routes. feeAmount is the money-as-string boundary (optional/nullish on
// patch). status optional (DB column defaults ACTIVE).
export const createRouteSchema = z.object({
  name: z.string().min(1, "Name is required").max(120),
  code: z.string().min(1, "Code is required").max(32),
  feeAmount: transportMoneyString.optional(),
  status: transportRouteStatusEnum.optional(),
});

export const patchRouteSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    code: z.string().min(1).max(32).optional(),
    feeAmount: transportMoneyString.nullish(),
    status: transportRouteStatusEnum.optional(),
  })
  .strict();

// 4. Route stops. sequence int >= 1 (CHECK sequence >= 1); pickupOffsetMinutes
// optional int >= 0 (CHECK pickupOffsetMinutes >= 0). latitude / longitude are
// optional floats.
export const createStopSchema = z.object({
  name: z.string().min(1, "Name is required").max(120),
  sequence: z.coerce.number().int().min(1),
  landmark: z.string().min(1).max(200).optional(),
  latitude: z.coerce.number().optional(),
  longitude: z.coerce.number().optional(),
  pickupOffsetMinutes: z.coerce.number().int().min(0).optional(),
});

export const patchStopSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    sequence: z.coerce.number().int().min(1).optional(),
    landmark: z.string().min(1).max(200).nullish(),
    latitude: z.coerce.number().nullish(),
    longitude: z.coerce.number().nullish(),
    pickupOffsetMinutes: z.coerce.number().int().min(0).nullish(),
  })
  .strict();

// 5. Route assignment (vehicle + driver -> route). effectiveTo optional; the
// effectiveTo >= effectiveFrom CHECK is enforced in the DB.
export const createAssignmentSchema = z.object({
  vehicleId: transportCuidLike,
  driverId: transportCuidLike,
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().optional(),
});

// 6. Enrollment (capacity-safe, lock-keyed on the route in the handler).
export const createEnrollmentSchema = z.object({
  studentId: transportCuidLike,
  routeId: transportCuidLike,
  stopId: transportCuidLike,
});

// 7. Schedule. Exactly one of dayOfWeek / date (DB CHECK). departureTime
// 0..1439; arrivalTime optional 0..1439. stopId optional.
export const createScheduleSchema = z
  .object({
    stopId: transportCuidLike.optional(),
    dayOfWeek: transportDayOfWeekEnum.optional(),
    date: z.coerce.date().optional(),
    departureTime: z.coerce.number().int().min(0).max(1439),
    arrivalTime: z.coerce.number().int().min(0).max(1439).optional(),
  })
  .refine((v) => (v.dayOfWeek !== undefined) !== (v.date !== undefined), {
    message: "exactly one of dayOfWeek or date is required",
    path: ["dayOfWeek"],
  });

export const patchScheduleSchema = z
  .object({
    stopId: transportCuidLike.nullish(),
    dayOfWeek: transportDayOfWeekEnum.nullish(),
    date: z.coerce.date().nullish(),
    departureTime: z.coerce.number().int().min(0).max(1439).optional(),
    arrivalTime: z.coerce.number().int().min(0).max(1439).nullish(),
  })
  .strict();

// 8. Maintenance. cost is the money-as-string boundary (optional). issue
// non-empty. transition targets forward-only (never OPEN).
export const createTransportMaintenanceSchema = z.object({
  vehicleId: transportCuidLike,
  issue: z.string().min(1, "Issue is required").max(500),
  assigneeUserId: transportCuidLike.optional(),
  cost: transportMoneyString.optional(),
});

export const transportMaintenanceTransitionSchema = z.object({
  toStatus: transportMaintenanceTransitionTargetEnum,
  cost: transportMoneyString.optional(),
  resolutionNote: z.string().max(500).optional(),
});

// 9. List / report query (page >= 1 default 1; pageSize 1..100 default 20;
// optional status / routeId / vehicleId filters).
export const transportListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().max(40).optional(),
  routeId: transportCuidLike.optional(),
  vehicleId: transportCuidLike.optional(),
});

export type TransportVehicleTypeValue = z.infer<typeof transportVehicleTypeEnum>;
export type TransportVehicleStatusValue = z.infer<typeof transportVehicleStatusEnum>;
export type TransportDriverStatusValue = z.infer<typeof transportDriverStatusEnum>;
export type TransportRouteStatusValue = z.infer<typeof transportRouteStatusEnum>;
export type TransportDayOfWeekValue = z.infer<typeof transportDayOfWeekEnum>;
export type TransportMaintenanceTransitionTargetValue = z.infer<
  typeof transportMaintenanceTransitionTargetEnum
>;
export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;
export type PatchVehicleInput = z.infer<typeof patchVehicleSchema>;
export type CreateDriverInput = z.infer<typeof createDriverSchema>;
export type PatchDriverInput = z.infer<typeof patchDriverSchema>;
export type CreateRouteInput = z.infer<typeof createRouteSchema>;
export type PatchRouteInput = z.infer<typeof patchRouteSchema>;
export type CreateStopInput = z.infer<typeof createStopSchema>;
export type PatchStopInput = z.infer<typeof patchStopSchema>;
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
export type CreateEnrollmentInput = z.infer<typeof createEnrollmentSchema>;
export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;
export type PatchScheduleInput = z.infer<typeof patchScheduleSchema>;
export type CreateTransportMaintenanceInput = z.infer<typeof createTransportMaintenanceSchema>;
export type TransportMaintenanceTransitionInput = z.infer<
  typeof transportMaintenanceTransitionSchema
>;
export type TransportListQueryInput = z.infer<typeof transportListQuerySchema>;

// ─── Phase 9.5 Inventory & Assets Management ─────────────────────────────────
// institutionId / userId (for /me/*) are NEVER accepted from the body — always
// derived from the verified token. Enum members mirror the pg enums added by the
// 20270117000000_phase9_inventory migration (design §B.1). acquisitionCost /
// cost / proceeds are int minor units in the DB but cross the JSON boundary as a
// decimal-digit STRING (money-as-string, design §B.9).

export const inventoryAssetKindEnum = z.enum(["FIXED_ASSET", "CONSUMABLE"]);
export const inventoryAssetStatusEnum = z.enum([
  "IN_STORE",
  "ASSIGNED",
  "IN_MAINTENANCE",
  "RETIRED",
  "DISPOSED",
]);
export const inventoryMaintenanceStatusEnum = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "RESOLVED",
  "CANCELLED",
]);
export const inventoryStockMovementKindEnum = z.enum(["RECEIPT", "ISSUE", "ADJUSTMENT"]);
export const inventoryDisposalMethodEnum = z.enum([
  "SOLD",
  "SCRAPPED",
  "DONATED",
  "LOST",
  "WRITTEN_OFF",
  "OTHER",
]);
// Only the two terminal states a disposal may move an asset into.
export const inventoryTerminalStatusEnum = z.enum(["RETIRED", "DISPOSED"]);
// Only the reachable states a staff maintenance transition may target (never OPEN).
export const inventoryMaintenanceTransitionTargetEnum = z.enum([
  "IN_PROGRESS",
  "RESOLVED",
  "CANCELLED",
]);

const inventoryCuidLike = z.string().min(1).max(64);

// acquisitionCost / cost / proceeds money-as-string boundary: a non-empty
// decimal-digit string that parses to int minor units >= 0 (the DB stores Int).
const inventoryMoneyString = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer number of minor units");

// currency: optional uppercase ISO-4217-shaped 3-letter code (DB CHECK
// char_length(currency) = 3).
const inventoryCurrency = z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter uppercase currency code");

// 1. Categories. code / name non-empty. kind required. Depreciation metadata
// optional (stored only — no engine).
export const createInventoryCategorySchema = z.object({
  name: z.string().min(1, "Name is required").max(128),
  code: z.string().min(1, "Code is required").max(64),
  kind: inventoryAssetKindEnum,
  depreciationMethod: z.string().min(1).max(64).optional(),
  usefulLifeMonths: z.coerce.number().int().min(0).optional(),
});

export const patchInventoryCategorySchema = z
  .object({
    name: z.string().min(1).max(128).optional(),
    code: z.string().min(1).max(64).optional(),
    kind: inventoryAssetKindEnum.optional(),
    depreciationMethod: z.string().min(1).max(64).nullish(),
    usefulLifeMonths: z.coerce.number().int().min(0).nullish(),
  })
  .strict();

// 2. Assets. assetTag / name non-empty. acquisitionCost money-as-string +
// currency 3-letter (both optional). custodyUserId / custodyDepartmentId optional
// (composite FK same-tenant). status is NOT accepted — lifecycle is driven by
// dedicated handlers (transfer/maintenance/dispose) through the DB guard.
export const createInventoryAssetSchema = z.object({
  assetTag: z.string().min(1, "Asset tag is required").max(128),
  name: z.string().min(1, "Name is required").max(256),
  categoryId: inventoryCuidLike,
  acquisitionDate: z.coerce.date().optional(),
  acquisitionCost: inventoryMoneyString.optional(),
  currency: inventoryCurrency.optional(),
  location: z.string().min(1).max(256).optional(),
  custodyUserId: inventoryCuidLike.optional(),
  custodyDepartmentId: inventoryCuidLike.optional(),
});

export const patchInventoryAssetSchema = z
  .object({
    assetTag: z.string().min(1).max(128).optional(),
    name: z.string().min(1).max(256).optional(),
    categoryId: inventoryCuidLike.optional(),
    acquisitionDate: z.coerce.date().nullish(),
    acquisitionCost: inventoryMoneyString.nullish(),
    currency: inventoryCurrency.nullish(),
    location: z.string().min(1).max(256).nullish(),
  })
  .strict();

// 3. Custody transfer. At least one of toUserId / toDepartmentId. reason
// optional. transferredAt optional (defaults to now in the handler).
export const inventoryTransferSchema = z
  .object({
    toUserId: inventoryCuidLike.optional(),
    toDepartmentId: inventoryCuidLike.optional(),
    reason: z.string().min(1).max(512).optional(),
    transferredAt: z.coerce.date().optional(),
  })
  .refine((v) => v.toUserId !== undefined || v.toDepartmentId !== undefined, {
    message: "at least one of toUserId or toDepartmentId is required",
    path: ["toUserId"],
  });

// 4. Stock movement. quantity is a non-zero signed int; its sign must match the
// kind (RECEIPT > 0, ISSUE < 0, ADJUSTMENT != 0). reason optional.
export const inventoryStockMovementSchema = z
  .object({
    kind: inventoryStockMovementKindEnum,
    quantity: z.coerce.number().int(),
    reason: z.string().min(1).max(512).optional(),
  })
  .refine((v) => v.quantity !== 0, {
    message: "quantity must be non-zero",
    path: ["quantity"],
  })
  .refine(
    (v) =>
      (v.kind === "RECEIPT" && v.quantity > 0) ||
      (v.kind === "ISSUE" && v.quantity < 0) ||
      v.kind === "ADJUSTMENT",
    {
      message: "quantity sign must match kind (RECEIPT > 0, ISSUE < 0, ADJUSTMENT != 0)",
      path: ["quantity"],
    },
  );

// 5. Maintenance. issue non-empty. assigneeUserId soft reference (no FK). cost
// money-as-string (optional). transition target forward-only (never OPEN).
export const createInventoryMaintenanceSchema = z.object({
  issue: z.string().min(1, "Issue is required").max(512),
  assigneeUserId: inventoryCuidLike.optional(),
  cost: inventoryMoneyString.optional(),
});

export const inventoryMaintenanceTransitionSchema = z.object({
  toStatus: inventoryMaintenanceTransitionTargetEnum,
  cost: inventoryMoneyString.optional(),
  resolutionNote: z.string().max(512).optional(),
});

// 6. Disposal. terminalStatus required ∈ {RETIRED, DISPOSED}; method required
// enum. proceeds / currency / reason / disposedAt optional.
export const inventoryDisposalSchema = z.object({
  terminalStatus: inventoryTerminalStatusEnum,
  method: inventoryDisposalMethodEnum,
  proceeds: inventoryMoneyString.optional(),
  currency: inventoryCurrency.optional(),
  reason: z.string().min(1).max(512).optional(),
  disposedAt: z.coerce.date().optional(),
});

// 7. Audit session + line. Session name non-empty. A line references EXACTLY one
// of assetId / stockItemId. expected/found quantities optional ints.
export const createInventoryAuditSessionSchema = z.object({
  name: z.string().min(1, "Name is required").max(128),
});

export const inventoryAuditLineSchema = z
  .object({
    assetId: inventoryCuidLike.optional(),
    stockItemId: inventoryCuidLike.optional(),
    expectedQuantity: z.coerce.number().int().optional(),
    foundQuantity: z.coerce.number().int().optional(),
    note: z.string().min(1).max(512).optional(),
  })
  .refine((v) => (v.assetId !== undefined) !== (v.stockItemId !== undefined), {
    message: "exactly one of assetId or stockItemId is required",
    path: ["assetId"],
  });

// 8. List / report query (page >= 1 default 1; pageSize 1..100 default 20;
// optional status / kind / categoryId filters).
export const inventoryListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().max(40).optional(),
  kind: z.string().max(40).optional(),
  categoryId: inventoryCuidLike.optional(),
});

export type InventoryAssetKindValue = z.infer<typeof inventoryAssetKindEnum>;
export type InventoryAssetStatusValue = z.infer<typeof inventoryAssetStatusEnum>;
export type InventoryMaintenanceStatusValue = z.infer<typeof inventoryMaintenanceStatusEnum>;
export type InventoryStockMovementKindValue = z.infer<typeof inventoryStockMovementKindEnum>;
export type InventoryDisposalMethodValue = z.infer<typeof inventoryDisposalMethodEnum>;
export type InventoryTerminalStatusValue = z.infer<typeof inventoryTerminalStatusEnum>;
export type InventoryMaintenanceTransitionTargetValue = z.infer<
  typeof inventoryMaintenanceTransitionTargetEnum
>;
export type CreateInventoryCategoryInput = z.infer<typeof createInventoryCategorySchema>;
export type PatchInventoryCategoryInput = z.infer<typeof patchInventoryCategorySchema>;
export type CreateInventoryAssetInput = z.infer<typeof createInventoryAssetSchema>;
export type PatchInventoryAssetInput = z.infer<typeof patchInventoryAssetSchema>;
export type InventoryTransferInput = z.infer<typeof inventoryTransferSchema>;
export type InventoryStockMovementInput = z.infer<typeof inventoryStockMovementSchema>;
export type CreateInventoryMaintenanceInput = z.infer<typeof createInventoryMaintenanceSchema>;
export type InventoryMaintenanceTransitionInput = z.infer<
  typeof inventoryMaintenanceTransitionSchema
>;
export type InventoryDisposalInput = z.infer<typeof inventoryDisposalSchema>;
export type CreateInventoryAuditSessionInput = z.infer<typeof createInventoryAuditSessionSchema>;
export type InventoryAuditLineInput = z.infer<typeof inventoryAuditLineSchema>;
export type InventoryListQueryInput = z.infer<typeof inventoryListQuerySchema>;

// ─── Phase 9.6 Service Requests Management ───────────────────────────────────
// institutionId / requesterUserId are NEVER accepted from the body — always
// derived from the verified token. Enum members mirror the pg enums added by the
// 20270124000000_phase9_service_requests migration (design §8). There are no
// money fields in this module. The per-field typing of fieldValues against a
// type's dynamic field definitions is the HANDLER step (validateFieldValues,
// design §6); the Zod schema here only validates the request envelope.

export const serviceRequestFieldTypeEnum = z.enum(["TEXT", "NUMBER", "DATE", "SELECT"]);
export const serviceRequestPriorityEnum = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);
// Only the two reachable states a staff status PATCH may target. RESOLVED is
// reached via POST /:id/resolve, never PATCH /:id/status (plan NIT-2).
export const serviceRequestStatusPatchTargetEnum = z.enum(["IN_PROGRESS", "PENDING_APPROVAL"]);

const serviceRequestsCuidLike = z.string().min(1).max(64);

// 1. Request type. name / code / category non-empty. code is [A-Z0-9_].
// defaultAssigneeRole is a FREE uppercase string (advisory routing hint, NO
// cross-table validation — plan NIT-1; SERVICE_AGENT is a legal value).
// slaTargetHours 1..8760 (DB CHECK >= 1). requiresApproval / isActive optional.
export const createServiceRequestTypeSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  code: z.string().min(1, "Code is required").max(64).regex(/^[A-Z0-9_]+$/, "Code must be [A-Z0-9_]"),
  category: z.string().min(1, "Category is required").max(64),
  description: z.string().max(2000).optional(),
  defaultAssigneeRole: z.string().regex(/^[A-Z0-9_]{1,64}$/).optional(),
  defaultAssigneeDepartmentId: serviceRequestsCuidLike.optional(),
  slaTargetHours: z.coerce.number().int().min(1).max(8760),
  requiresApproval: z.coerce.boolean().optional(),
  isActive: z.coerce.boolean().optional(),
});

export const patchServiceRequestTypeSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    code: z.string().min(1).max(64).regex(/^[A-Z0-9_]+$/).optional(),
    category: z.string().min(1).max(64).optional(),
    description: z.string().max(2000).nullish(),
    defaultAssigneeRole: z.string().regex(/^[A-Z0-9_]{1,64}$/).nullish(),
    defaultAssigneeDepartmentId: serviceRequestsCuidLike.nullish(),
    slaTargetHours: z.coerce.number().int().min(1).max(8760).optional(),
    requiresApproval: z.coerce.boolean().optional(),
    isActive: z.coerce.boolean().optional(),
  })
  .strict();

// 2. Field definition. fieldKey [a-zA-Z0-9_]. label non-empty. dataType enum.
// Refinement: SELECT => options non-empty; non-SELECT => options absent.
const serviceRequestFieldBase = {
  fieldKey: z.string().min(1, "Field key is required").max(64).regex(/^[a-zA-Z0-9_]+$/, "Field key must be [a-zA-Z0-9_]"),
  label: z.string().min(1, "Label is required").max(200),
  dataType: serviceRequestFieldTypeEnum,
  required: z.coerce.boolean().optional(),
  options: z.array(z.string().min(1).max(200)).max(50).optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
};

const selectOptionsRefine = (v: { dataType: string; options?: string[] }) =>
  v.dataType === "SELECT"
    ? Array.isArray(v.options) && v.options.length >= 1
    : v.options === undefined || v.options.length === 0;

export const createServiceRequestFieldSchema = z
  .object(serviceRequestFieldBase)
  .refine(selectOptionsRefine, {
    message: "SELECT fields require non-empty options; non-SELECT fields must omit options",
    path: ["options"],
  });

export const patchServiceRequestFieldSchema = z
  .object({
    fieldKey: serviceRequestFieldBase.fieldKey.optional(),
    label: z.string().min(1).max(200).optional(),
    dataType: serviceRequestFieldTypeEnum.optional(),
    required: z.coerce.boolean().optional(),
    options: z.array(z.string().min(1).max(200)).max(50).nullish(),
    sortOrder: z.coerce.number().int().min(0).optional(),
  })
  .strict();

// 3. Raise a request. requestTypeId + title required; description / priority
// optional (priority defaults NORMAL). fieldValues is a record; the per-field
// typing against the type's field definitions is the handler step (§6).
export const raiseServiceRequestSchema = z.object({
  requestTypeId: serviceRequestsCuidLike,
  title: z.string().min(1, "Title is required").max(200),
  description: z.string().max(4000).optional(),
  priority: serviceRequestPriorityEnum.default("NORMAL"),
  fieldValues: z.record(z.string(), z.unknown()).default({}),
});

// 4. Assign. assigneeUserId required.
export const assignServiceRequestSchema = z.object({
  assigneeUserId: serviceRequestsCuidLike,
});

// 5. Status PATCH. toStatus ∈ {IN_PROGRESS, PENDING_APPROVAL} only (NIT-2).
export const serviceRequestStatusPatchSchema = z.object({
  toStatus: serviceRequestStatusPatchTargetEnum,
});

// 6. Resolve. resolutionNote required.
export const resolveServiceRequestSchema = z.object({
  resolutionNote: z.string().min(1, "Resolution note is required").max(4000),
});

// 7. Reject (approver). reason optional.
export const rejectServiceRequestSchema = z.object({
  reason: z.string().max(2000).optional(),
});

// 8. Comment. body required.
export const serviceRequestCommentSchema = z.object({
  body: z.string().min(1, "Comment body is required").max(4000),
});

// 9. Feedback. rating 1..5 int; comment optional.
export const serviceRequestFeedbackSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
});

// 10. List / report query. page >= 1 default 1; pageSize 1..100 default 20;
// optional status / requestTypeId / assigneeUserId / overdue filters;
// atRiskHours SLA look-ahead default 24.
export const serviceRequestListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().max(40).optional(),
  requestTypeId: serviceRequestsCuidLike.optional(),
  assigneeUserId: serviceRequestsCuidLike.optional(),
  overdue: z.coerce.boolean().optional(),
  atRiskHours: z.coerce.number().int().min(1).max(8760).default(24),
});

export type ServiceRequestFieldTypeValue = z.infer<typeof serviceRequestFieldTypeEnum>;
export type ServiceRequestPriorityValue = z.infer<typeof serviceRequestPriorityEnum>;
export type ServiceRequestStatusPatchTargetValue = z.infer<
  typeof serviceRequestStatusPatchTargetEnum
>;
export type CreateServiceRequestTypeInput = z.infer<typeof createServiceRequestTypeSchema>;
export type PatchServiceRequestTypeInput = z.infer<typeof patchServiceRequestTypeSchema>;
export type CreateServiceRequestFieldInput = z.infer<typeof createServiceRequestFieldSchema>;
export type PatchServiceRequestFieldInput = z.infer<typeof patchServiceRequestFieldSchema>;
export type RaiseServiceRequestInput = z.infer<typeof raiseServiceRequestSchema>;
export type AssignServiceRequestInput = z.infer<typeof assignServiceRequestSchema>;
export type ServiceRequestStatusPatchInput = z.infer<typeof serviceRequestStatusPatchSchema>;
export type ResolveServiceRequestInput = z.infer<typeof resolveServiceRequestSchema>;
export type RejectServiceRequestInput = z.infer<typeof rejectServiceRequestSchema>;
export type ServiceRequestCommentInput = z.infer<typeof serviceRequestCommentSchema>;
export type ServiceRequestFeedbackInput = z.infer<typeof serviceRequestFeedbackSchema>;
export type ServiceRequestListQueryInput = z.infer<typeof serviceRequestListQuerySchema>;

// ─── Phase 9.7 Document Management ───────────────────────────────────────────
// institutionId / ownerUserId / storageKey / checksum / size are NEVER accepted
// from external input — the owner is the verified token, and the storage key +
// checksum + byte size are computed server-side from the received bytes (design
// §7/§8). Enum members mirror the pg enums added by the
// 20270131000000_phase9_documents migration. There are no money fields in this
// module. The raw file bytes themselves arrive on the request body (the
// encapsulated raw-body Buffer parser); these schemas validate the METADATA
// envelope only.

export const documentAccessLevelEnum = z.enum(["READ", "MANAGE"]);
// The forward-only transition targets a staff lifecycle route may name.
export const documentLifecycleTargetEnum = z.enum([
  "ARCHIVED",
  "ACTIVE",
  "PURGE_PENDING",
  "PURGED",
]);

const documentsCuidLike = z.string().min(1).max(64);

// 1. Upload metadata (carried as headers/query alongside the raw body). title
// non-empty <=300; description optional <=4000; category optional <=120;
// filename non-empty <=255; contentType non-empty; optional retentionPolicyId.
export const createDocumentSchema = z.object({
  title: z.string().min(1, "Title is required").max(300),
  description: z.string().max(4000).optional(),
  category: z.string().max(120).optional(),
  filename: z.string().min(1, "Filename is required").max(255),
  contentType: z.string().min(1, "Content type is required").max(255),
  retentionPolicyId: documentsCuidLike.optional(),
});

// 2. New version of an existing document (metadata only; the document id is a
// path param). No title/description/category/retention — those live on the doc.
export const newDocumentVersionSchema = z.object({
  filename: z.string().min(1, "Filename is required").max(255),
  contentType: z.string().min(1, "Content type is required").max(255),
});

// 3. Create grant. EXACTLY one of granteeUserId / granteeDepartmentId (XOR);
// accessLevel READ|MANAGE. Grantee existence is validated same-tenant in-handler.
export const createDocumentGrantSchema = z
  .object({
    granteeUserId: documentsCuidLike.optional(),
    granteeDepartmentId: documentsCuidLike.optional(),
    accessLevel: documentAccessLevelEnum,
  })
  .refine((v) => (v.granteeUserId !== undefined) !== (v.granteeDepartmentId !== undefined), {
    message: "exactly one of granteeUserId or granteeDepartmentId is required",
    path: ["granteeUserId"],
  });

// 4. Retention policy. name non-empty <=120; retentionDays int 1..36500; optional
// category scope.
export const upsertDocumentRetentionPolicySchema = z.object({
  name: z.string().min(1, "Name is required").max(120),
  retentionDays: z.coerce.number().int().min(1).max(36500),
  category: z.string().max(120).optional(),
});

export const patchDocumentRetentionPolicySchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    retentionDays: z.coerce.number().int().min(1).max(36500).optional(),
    category: z.string().max(120).nullish(),
  })
  .strict();

// 5. List / report query. page >= 1 default 1; pageSize 1..100 default 20;
// optional status / ownerUserId / category filters; scope (mine|all) optional.
export const documentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().max(40).optional(),
  ownerUserId: documentsCuidLike.optional(),
  category: z.string().max(120).optional(),
  scope: z.enum(["mine", "all"]).optional(),
});

export type DocumentAccessLevelValue = z.infer<typeof documentAccessLevelEnum>;
export type DocumentLifecycleTargetValue = z.infer<typeof documentLifecycleTargetEnum>;
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type NewDocumentVersionInput = z.infer<typeof newDocumentVersionSchema>;
export type CreateDocumentGrantInput = z.infer<typeof createDocumentGrantSchema>;
export type UpsertDocumentRetentionPolicyInput = z.infer<typeof upsertDocumentRetentionPolicySchema>;
export type PatchDocumentRetentionPolicyInput = z.infer<typeof patchDocumentRetentionPolicySchema>;
export type DocumentListQueryInput = z.infer<typeof documentListQuerySchema>;
