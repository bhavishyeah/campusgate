import { z } from "zod";
import { inclusiveDays, isoYear, minuteFromTime } from "./format";
import { parseSalaryRupees } from "./money";

/** Exact strings the server writes for its refinements (packages/shared validation). */
export const HR_SERVER_MESSAGES = {
  endBeforeStart: "endDate must be on or after startDate",
  leaveOneYear: "leave startDate and endDate must share one calendar year",
  rangeOrder: "to must be on or after from",
  rangeTooLong: "range must not exceed 366 days",
  noUpdatable: "no updatable fields provided",
} as const;

const EMPLOYMENT_TYPES = ["PERMANENT", "CONTRACT", "PART_TIME"] as const;
const EMPLOYEE_STATUSES = ["ACTIVE", "INACTIVE", "TERMINATED"] as const;
const CONTRACT_TYPES = ["PERMANENT", "FIXED_TERM", "PROBATION", "CONSULTANT"] as const;
const LEAVE_TYPES = ["CASUAL", "SICK", "EARNED", "UNPAID", "OTHER"] as const;
const ACCRUAL_RULES = ["ANNUAL_LUMP_SUM", "MONTHLY_ACCRUAL"] as const;
const ATTENDANCE_STATUSES = ["PRESENT", "ABSENT", "ON_LEAVE", "HALF_DAY"] as const;
const ATTENDANCE_SOURCES = ["MANUAL", "DERIVED"] as const;

export function isValidDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
}

const requiredDate = (label: string) =>
  z.string().refine(isValidDate, { message: `${label} is required` });
const optionalDate = z.string().refine((v) => v === "" || isValidDate(v), { message: "Enter a valid date" });

// ── Employees ──
const employeeFields = {
  employeeNo: z.string().trim().min(1, "Employee number is required").max(64, "Employee number must be 64 characters or fewer"),
  designation: z.string().trim().max(200, "Designation must be 200 characters or fewer"),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  departmentId: z.string(),
  joiningDate: requiredDate("Joining date"),
  status: z.enum(EMPLOYEE_STATUSES),
};
export const employeeCreateSchema = z.object({
  userId: z.string().min(1, "User is required"),
  ...employeeFields,
});
/** Edit form: same value shape; the linked user is not editable so userId is not validated. */
export const employeeEditSchema = z.object({ userId: z.string(), ...employeeFields });
export type EmployeeFormValues = z.infer<typeof employeeCreateSchema>;

/** Body shape of PATCH /employees/:id. At least one field is required, like the server. */
export const employeePatchSchema = z
  .object({
    employeeNo: z.string().trim().min(1).max(64).optional(),
    designation: z.string().min(1).max(200).optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
    departmentId: z.string().min(1).nullable().optional(),
    joiningDate: z.string().optional(),
    status: z.enum(EMPLOYEE_STATUSES).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: HR_SERVER_MESSAGES.noUpdatable });

export function buildEmployeeCreate(v: EmployeeFormValues): Record<string, unknown> {
  const body: Record<string, unknown> = {
    userId: v.userId,
    employeeNo: v.employeeNo.trim(),
    employmentType: v.employmentType,
    joiningDate: v.joiningDate,
    status: v.status,
  };
  if (v.designation.trim() !== "") body.designation = v.designation.trim();
  if (v.departmentId !== "") body.departmentId = v.departmentId;
  return body;
}

/** PATCH: dirty fields only; clearing Department sends null; a blank Designation is omitted. */
export function buildEmployeePatch(
  v: EmployeeFormValues,
  dirty: Partial<Record<keyof EmployeeFormValues, unknown>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dirty.employeeNo) body.employeeNo = v.employeeNo.trim();
  if (dirty.designation && v.designation.trim() !== "") body.designation = v.designation.trim();
  if (dirty.employmentType) body.employmentType = v.employmentType;
  if (dirty.departmentId) body.departmentId = v.departmentId === "" ? null : v.departmentId;
  if (dirty.joiningDate) body.joiningDate = v.joiningDate;
  if (dirty.status) body.status = v.status;
  return body;
}

// ── Contracts ──
const MAX_TERMS_CHARS = 16 * 1024;

export type TermsParse = { ok: true; value: Record<string, unknown> | undefined } | { ok: false; error: string };

/** Blank is allowed (no terms). Size check is on the re-serialized object, like the server. */
export function parseTerms(text: string): TermsParse {
  const t = text.trim();
  if (t === "") return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return { ok: false, error: "Terms must be a JSON object" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Terms must be a JSON object" };
  }
  if (JSON.stringify(parsed).length > MAX_TERMS_CHARS) {
    return { ok: false, error: "Terms must be 16 KB or smaller" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export const contractFormSchema = z
  .object({
    contractType: z.enum(CONTRACT_TYPES),
    startDate: requiredDate("Start date"),
    endDate: optionalDate,
    salary: z.string(),
    terms: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.endDate !== "" && isValidDate(v.startDate) && isValidDate(v.endDate) && Date.parse(v.endDate) < Date.parse(v.startDate)) {
      ctx.addIssue({ code: "custom", message: HR_SERVER_MESSAGES.endBeforeStart, path: ["endDate"] });
    }
    if (v.salary.trim() !== "" && parseSalaryRupees(v.salary) === null) {
      ctx.addIssue({
        code: "custom",
        message: /^[\d,]+(\.\d{1,2})?$/.test(v.salary.trim()) ? "Amount is too large" : "Enter an amount in rupees, up to 2 decimals",
        path: ["salary"],
      });
    }
    const terms = parseTerms(v.terms);
    if (!terms.ok) ctx.addIssue({ code: "custom", message: terms.error, path: ["terms"] });
  });
export type ContractFormValues = z.infer<typeof contractFormSchema>;

export function toContractBody(v: ContractFormValues): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contractType: v.contractType,
    startDate: v.startDate,
    currency: "INR",
  };
  if (v.endDate !== "") body.endDate = v.endDate;
  if (v.salary.trim() !== "") {
    const paise = parseSalaryRupees(v.salary);
    if (paise !== null) body.salaryAmount = paise;
  }
  const terms = parseTerms(v.terms);
  if (terms.ok && terms.value !== undefined) body.termsMetadata = terms.value;
  return body;
}

// ── Leave ──
export const leaveApplySchema = z
  .object({
    leaveType: z.enum(LEAVE_TYPES),
    startDate: requiredDate("Start date"),
    endDate: requiredDate("End date"),
    reason: z.string().trim().min(1, "Reason is required").max(2000, "Reason must be 2000 characters or fewer"),
  })
  .superRefine((v, ctx) => {
    if (!isValidDate(v.startDate) || !isValidDate(v.endDate)) return;
    if (Date.parse(v.endDate) < Date.parse(v.startDate)) {
      ctx.addIssue({ code: "custom", message: HR_SERVER_MESSAGES.endBeforeStart, path: ["endDate"] });
    }
    if (isoYear(v.startDate) !== isoYear(v.endDate)) {
      ctx.addIssue({ code: "custom", message: HR_SERVER_MESSAGES.leaveOneYear, path: ["endDate"] });
    }
  });
export type LeaveApplyValues = z.infer<typeof leaveApplySchema>;

export function toLeaveBody(v: LeaveApplyValues): Record<string, unknown> {
  return { leaveType: v.leaveType, startDate: v.startDate, endDate: v.endDate, reason: v.reason.trim() };
}

export const leaveReviewSchema = z.object({
  reviewNote: z.string().trim().max(2000, "Note must be 2000 characters or fewer"),
});
export type LeaveReviewValues = z.infer<typeof leaveReviewSchema>;

export function toReviewBody(v: LeaveReviewValues): { reviewNote?: string } {
  const n = v.reviewNote.trim();
  return n === "" ? {} : { reviewNote: n };
}

export const leavePolicySchema = z.object({
  annualQuotaDays: z.string().refine((v) => /^\d+$/.test(v.trim()) && Number.isSafeInteger(Number(v.trim())), "Enter a whole number of days, 0 or more"),
  accrualRule: z.enum(ACCRUAL_RULES),
  active: z.boolean(),
});
export type LeavePolicyValues = z.infer<typeof leavePolicySchema>;

export function toPolicyBody(v: LeavePolicyValues): Record<string, unknown> {
  return { annualQuotaDays: Number(v.annualQuotaDays.trim()), accrualRule: v.accrualRule, active: v.active };
}

// ── Shifts ──
const timeField = z.string().refine((v) => minuteFromTime(v) !== null, "Enter a time");
export const shiftSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200, "Name must be 200 characters or fewer"),
  startTime: timeField,
  endTime: timeField,
  active: z.boolean(),
});
export type ShiftFormValues = z.infer<typeof shiftSchema>;

export const shiftPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    startMinute: z.number().int().min(0).max(1439).optional(),
    endMinute: z.number().int().min(0).max(1439).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: HR_SERVER_MESSAGES.noUpdatable });

export function toShiftBody(v: ShiftFormValues): Record<string, unknown> {
  return {
    name: v.name.trim(),
    startMinute: minuteFromTime(v.startTime),
    endMinute: minuteFromTime(v.endTime),
    active: v.active,
  };
}

/** PATCH: dirty fields only. */
export function toShiftPatch(
  v: ShiftFormValues,
  dirty: Partial<Record<keyof ShiftFormValues, unknown>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dirty.name) body.name = v.name.trim();
  if (dirty.startTime) body.startMinute = minuteFromTime(v.startTime);
  if (dirty.endTime) body.endMinute = minuteFromTime(v.endTime);
  if (dirty.active) body.active = v.active;
  return body;
}

// ── Attendance ──
export const attendanceRecordSchema = z.object({
  status: z.enum(ATTENDANCE_STATUSES),
  source: z.enum(ATTENDANCE_SOURCES),
  shiftId: z.string(),
});
export type AttendanceRecordValues = z.infer<typeof attendanceRecordSchema>;

export const attendanceCorrectSchema = attendanceRecordSchema.extend({
  reason: z.string().trim().max(2000, "Reason must be 2000 characters or fewer"),
});
export type AttendanceCorrectValues = z.infer<typeof attendanceCorrectSchema>;

export function toRecordBody(date: string, v: AttendanceRecordValues): Record<string, unknown> {
  const body: Record<string, unknown> = { attendanceDate: date, status: v.status, source: v.source };
  if (v.shiftId !== "") body.shiftId = v.shiftId;
  return body;
}

/** A cleared shift sends null so the correction removes it. */
export function toCorrectBody(v: AttendanceCorrectValues): Record<string, unknown> {
  const body: Record<string, unknown> = {
    status: v.status,
    source: v.source,
    shiftId: v.shiftId === "" ? null : v.shiftId,
  };
  if (v.reason.trim() !== "") body.reason = v.reason.trim();
  return body;
}

// ── Reports ──
export const reportRangeSchema = z
  .object({ from: requiredDate("From date"), to: requiredDate("To date") })
  .superRefine((v, ctx) => {
    if (!isValidDate(v.from) || !isValidDate(v.to)) return;
    if (Date.parse(v.to) < Date.parse(v.from)) {
      ctx.addIssue({ code: "custom", message: HR_SERVER_MESSAGES.rangeOrder, path: ["to"] });
      return;
    }
    const days = inclusiveDays(v.from, v.to);
    if (days !== null && (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 > 366) {
      ctx.addIssue({ code: "custom", message: HR_SERVER_MESSAGES.rangeTooLong, path: ["to"] });
    }
  });
export type ReportRangeValues = z.infer<typeof reportRangeSchema>;
