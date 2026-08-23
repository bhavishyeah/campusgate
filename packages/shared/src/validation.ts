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
  departmentId: z.string().min(1, "Invalid department"),
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
  departmentCode: z.string().min(1),
  program: z.string().min(1),
  semester: z.number().int().min(1).max(12),
  section: z.string().optional(),
});

// ─── TYPES ───────────────────────────────────────────────────────────────────

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type CreateGatePassInput = z.infer<typeof createGatePassSchema>;
export type ApprovePassInput = z.infer<typeof approvePassSchema>;
export type RejectPassInput = z.infer<typeof rejectPassSchema>;
export type VerifyQrInput = z.infer<typeof verifyQrSchema>;
export type MarkExitInput = z.infer<typeof markExitSchema>;
export type MarkReturnInput = z.infer<typeof markReturnSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type BulkImportStudentInput = z.infer<typeof bulkImportStudentSchema>;
