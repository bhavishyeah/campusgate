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
