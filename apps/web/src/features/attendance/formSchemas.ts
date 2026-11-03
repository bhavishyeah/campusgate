// features/attendance/formSchemas.ts
import { z } from "zod";
import { todayISO } from "./utils";

// ─── Session creation (MF8 spec) ──────────────────────────────────────────────
// Fields: sectionId (select), date (date input), startTime (time input), endTime (time input)
// Validation: all required; date must not be in the past (UTC).

export const createSessionSchema = z.object({
  sectionId:  z.string().min(1, "Section is required"),
  date:       z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .refine((d) => d >= todayISO(), { message: "Date cannot be in the past" }),
  startTime:  z.string().min(1, "Start time is required"),
  endTime:    z.string().min(1, "End time is required"),
});
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

export const submitCorrectionSchema = z.object({
  attendanceRecordId: z.string().min(1, "Record is required"),
  requestedStatus:    z.enum(["PRESENT", "ABSENT", "LATE", "EXCUSED"]),
  reason:             z.string().min(1, "Reason is required").max(2000),
});
export type SubmitCorrectionInput = z.infer<typeof submitCorrectionSchema>;

export const reviewCorrectionSchema = z.object({
  reviewNote: z.string().max(2000).optional(),
});
export type ReviewCorrectionInput = z.infer<typeof reviewCorrectionSchema>;
