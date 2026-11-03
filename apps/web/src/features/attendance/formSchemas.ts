// features/attendance/formSchemas.ts
import { z } from "zod";
import { todayISO } from "./utils";

// ─── Session creation (MF8 spec) ──────────────────────────────────────────────
// Fields: scheduledClassId (select from scheduled classes), date (date input)
// startTime/endTime come from the selected ScheduledClass record, not separate inputs.
// Validation: all required; date must not be in the past (UTC).
// Cross-field: endTime > startTime is enforced on the ScheduledClass itself by the API.

export const createSessionSchema = z.object({
  scheduledClassId: z.string().min(1, "Scheduled class is required"),
  date:             z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .refine((d) => d >= todayISO(), { message: "Date cannot be in the past" }),
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
