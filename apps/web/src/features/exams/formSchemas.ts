import { z } from "zod";
import {
  createExaminationSchema,
  createExamScheduleSchema,
  createAssessmentSchema,
  patchAssessmentSchema,
  correctMarkSchema,
  createGradingSchemeSchema,
  patchGradingSchemeSchema,
  registerCandidatesSchema,
  allocateCandidatesSchema,
  registerSupplementaryCandidatesSchema,
} from "@campusgate/shared";
import { validateBands, pctToBps } from "./gradingBands";
import type { GradingBand } from "./types";

export {
  createExaminationSchema,
  createExamScheduleSchema,
  createAssessmentSchema,
  patchAssessmentSchema,
  correctMarkSchema,
  createGradingSchemeSchema,
  patchGradingSchemeSchema,
  registerCandidatesSchema,
  allocateCandidatesSchema,
  registerSupplementaryCandidatesSchema,
};

// ─── Create exam (client form) ───────────────────────────────────────────────
export const createExamFormSchema = z
  .object({
    academicSessionId: z.string().min(1, "Select a session"),
    academicTermId: z.string().min(1, "Select a term"),
    programId: z.string().min(1, "Select a program"),
    name: z.string().min(1, "Name is required").max(200),
    type: z.enum(["MIDTERM", "FINAL", "INTERNAL", "SUPPLEMENTARY"]),
    parentExaminationId: z.string().optional(),
  })
  .refine((v) => v.type !== "SUPPLEMENTARY" || Boolean(v.parentExaminationId), {
    message: "A parent exam is required for a supplementary exam",
    path: ["parentExaminationId"],
  });
export type CreateExamFormValues = z.infer<typeof createExamFormSchema>;

// ─── Schedule (client form; datetime-local strings -> ISO on submit) ─────────
export const scheduleFormSchema = z
  .object({
    subjectId: z.string().min(1, "Subject ID is required").max(64),
    room: z.string().min(1, "Room is required").max(100),
    roomCapacity: z.number({ coerce: true }).int().positive("Must be positive"),
    startsAt: z.string().min(1, "Start is required"),
    endsAt: z.string().min(1, "End is required"),
  })
  .refine((v) => new Date(v.startsAt).getTime() < new Date(v.endsAt).getTime(), {
    message: "End must be after start",
    path: ["endsAt"],
  });
export type ScheduleFormValues = z.infer<typeof scheduleFormSchema>;

// ─── Assessment (client form) ────────────────────────────────────────────────
export const assessmentFormSchema = z.object({
  subjectId: z.string().min(1, "Subject ID is required").max(64),
  name: z.string().min(1, "Name is required").max(100),
  maxMarks: z.number({ coerce: true }).int().positive("Must be positive"),
  weight: z.number({ coerce: true }).int().min(1).max(100),
});
export type AssessmentFormValues = z.infer<typeof assessmentFormSchema>;

// ─── Correction (client form) ────────────────────────────────────────────────
export const correctionFormSchema = z.object({
  marks: z.number({ coerce: true }).int().min(0),
  reason: z.string().min(1, "Reason is required").max(500),
});
export type CorrectionFormValues = z.infer<typeof correctionFormSchema>;

// ─── Grading scheme (percent entry; converted to bps on submit) ──────────────
const pctString = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, "0 to 100, up to 2 decimals")
  .refine((v) => Number(v) <= 100, "Must be at most 100");

export const bandRowSchema = z.object({
  minPct: pctString,
  maxPct: pctString,
  gradeLabel: z.string().min(1, "Required").max(20),
  gradePoints: z.string().regex(/^\d+$/, "Whole number"),
  isPassing: z.boolean(),
});
export type BandRowValues = z.infer<typeof bandRowSchema>;

/**
 * Converts editor rows to API bands. The first row's min is snapped to 0 and the
 * last row's max to 10000 bps (read-only boundary cells in the editor).
 */
export function rowsToBands(rows: BandRowValues[]): GradingBand[] {
  return rows.map((r, i) => ({
    minPercentBps: i === 0 ? 0 : pctToBps(Number(r.minPct)),
    maxPercentBps: i === rows.length - 1 ? 10000 : pctToBps(Number(r.maxPct)),
    gradeLabel: r.gradeLabel,
    gradePoints: Number(r.gradePoints),
    isPassing: r.isPassing,
  }));
}

export const gradingFormSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(200),
    isActive: z.boolean(),
    bands: z.array(bandRowSchema).min(1, "At least one band").max(50),
  })
  .superRefine((v, ctx) => {
    // Skip until every row is individually well-formed.
    if (!v.bands.every((b) => bandRowSchema.safeParse(b).success)) return;
    const result = validateBands(rowsToBands(v.bands));
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.message, path: ["bands"] });
    }
  });
export type GradingFormValues = z.infer<typeof gradingFormSchema>;
