import { z } from "zod";

/** Exact strings the server writes for its refinements (packages/shared validation). */
export const FACULTY_SERVER_MESSAGES = {
  noUpdatable: "no updatable fields provided",
  overrideReasonRequired: "overrideReason is required when override is true",
} as const;

const KINDS = ["DEGREE", "CERTIFICATION", "DIPLOMA", "OTHER"] as const;

function maxYear(): number {
  return new Date().getFullYear() + 1;
}

/** Form values are strings (what inputs produce); blank optionals are omitted by the builders. */
const yearField = z.string().refine((v) => {
  const t = v.trim();
  if (t === "") return true;
  if (!/^\d+$/.test(t)) return false;
  const n = Number(t);
  return n >= 1900 && n <= maxYear();
}, () => ({ message: `Year must be between 1900 and ${maxYear()}` }));

export const qualificationSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200, "Title must be 200 characters or fewer"),
  kind: z.enum(KINDS),
  issuingBody: z.string().trim().max(200, "Issuing body must be 200 characters or fewer"),
  field: z.string().trim().max(200, "Field must be 200 characters or fewer"),
  year: yearField,
  documentRef: z.string().trim().max(2048, "Document reference must be 2048 characters or fewer"),
});
export type QualificationFormValues = z.infer<typeof qualificationSchema>;

/** Body shape of PATCH /qualifications/:id. At least one field is required, like the server. */
export const qualificationPatchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    kind: z.enum(KINDS).optional(),
    issuingBody: z.string().min(1).max(200).optional(),
    field: z.string().min(1).max(200).optional(),
    year: z.number().int().min(1900).optional(),
    documentRef: z.string().min(1).max(2048).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: FACULTY_SERVER_MESSAGES.noUpdatable,
  });

const OPTIONAL_TEXT = ["issuingBody", "field", "documentRef"] as const;

export function buildQualificationCreate(v: QualificationFormValues): Record<string, unknown> {
  const body: Record<string, unknown> = { title: v.title.trim(), kind: v.kind };
  for (const k of OPTIONAL_TEXT) {
    const t = v[k].trim();
    if (t !== "") body[k] = t;
  }
  const y = v.year.trim();
  if (y !== "") body.year = Number(y);
  return body;
}

/** PATCH: only dirty fields; a blank optional is omitted (the server cannot clear fields). */
export function buildQualificationPatch(
  v: QualificationFormValues,
  dirty: Partial<Record<keyof QualificationFormValues, unknown>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dirty.title) body.title = v.title.trim();
  if (dirty.kind) body.kind = v.kind;
  for (const k of OPTIONAL_TEXT) {
    if (dirty[k] && v[k].trim() !== "") body[k] = v[k].trim();
  }
  if (dirty.year && v.year.trim() !== "") body.year = Number(v.year.trim());
  return body;
}

export const workloadEditSchema = z
  .object({
    nonTeachingHours: z
      .string()
      .refine((v) => /^\d+$/.test(v.trim()) && Number(v.trim()) <= 168, "Enter a whole number from 0 to 168"),
    override: z.boolean(),
    overrideReason: z.string().trim().max(500, "Reason must be 500 characters or fewer"),
  })
  .refine((v) => !v.override || v.overrideReason.length > 0, {
    message: FACULTY_SERVER_MESSAGES.overrideReasonRequired,
    path: ["overrideReason"],
  });
export type WorkloadEditValues = z.infer<typeof workloadEditSchema>;

/** overrideReason is only sent when override is true. */
export function buildWorkloadPatch(v: WorkloadEditValues): Record<string, unknown> {
  const body: Record<string, unknown> = {
    nonTeachingHours: Number(v.nonTeachingHours.trim()),
    override: v.override,
  };
  if (v.override) body.overrideReason = v.overrideReason.trim();
  return body;
}

export const workloadPolicySchema = z.object({
  maxWeeklyHours: z
    .string()
    .refine((v) => {
      if (!/^\d+$/.test(v.trim())) return false;
      const n = Number(v.trim());
      return n >= 1 && n <= 168;
    }, "Enter a whole number from 1 to 168"),
});
export type WorkloadPolicyValues = z.infer<typeof workloadPolicySchema>;
