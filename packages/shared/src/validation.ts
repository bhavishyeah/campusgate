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
