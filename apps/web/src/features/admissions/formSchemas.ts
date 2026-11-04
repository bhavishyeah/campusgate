import { z } from "zod";

// ─── Campaign form ──────────────────────────────────────────────────────────

/** R1: new requiredFields keys must be safe to use as flat object keys. */
export const REQUIRED_FIELD_KEY_REGEX = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function uniqueTrimmed(values: string[]): boolean {
  const trimmed = values.map((v) => v.trim());
  return new Set(trimmed).size === trimmed.length;
}

export const campaignFormSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(200),
    intakeSessionId: z.string(), // "" = None
    targetProgramId: z.string(), // "" = None
    programIds: z.array(z.string()),
    openAt: z.string(), // datetime-local or ""
    closeAt: z.string(),
    requiredFields: z
      .array(z.string().trim().min(1).max(100))
      .max(50, "Up to 50 required fields")
      .refine(uniqueTrimmed, "Duplicate keys are not allowed")
      .refine(
        (keys) => keys.every((k) => !UNSAFE_KEYS.has(k.trim())),
        "That key name is not allowed",
      )
      .refine(
        (keys) => keys.every((k) => REQUIRED_FIELD_KEY_REGEX.test(k.trim())),
        "Letters, digits and underscore only; must start with a letter.",
      ),
    requiredDocTypes: z
      .array(z.string().trim().min(1).max(100))
      .max(50, "Up to 50 document types")
      .refine(uniqueTrimmed, "Duplicate document types are not allowed"),
  })
  .refine(
    (v) => {
      if (!v.openAt || !v.closeAt) return true;
      return new Date(v.openAt).getTime() <= new Date(v.closeAt).getTime();
    },
    { message: "Close must be on or after open", path: ["closeAt"] },
  );

export type CampaignFormValues = z.infer<typeof campaignFormSchema>;

export function buildCampaignCreate(v: CampaignFormValues): Record<string, unknown> {
  const body: Record<string, unknown> = { name: v.name.trim() };
  if (v.intakeSessionId) body.intakeSessionId = v.intakeSessionId;
  if (v.targetProgramId) body.targetProgramId = v.targetProgramId;
  if (v.programIds.length > 0) body.programIds = v.programIds;
  if (v.openAt) body.openAt = new Date(v.openAt).toISOString();
  if (v.closeAt) body.closeAt = new Date(v.closeAt).toISOString();
  const requiredFields = v.requiredFields.map((k) => k.trim()).filter(Boolean);
  const requiredDocTypes = v.requiredDocTypes.map((k) => k.trim()).filter(Boolean);
  if (requiredFields.length > 0 || requiredDocTypes.length > 0) {
    body.config = { requiredFields, requiredDocTypes };
  }
  return body;
}

/**
 * R2: only dirty fields are sent, EXCEPT that when either config list is
 * dirty the body always carries BOTH arrays (the server defaults a missing
 * list to [] and would wipe the other one). Cleared selects/dates send null.
 */
export function buildCampaignPatch(
  dirty: Partial<Record<keyof CampaignFormValues, unknown>>,
  v: CampaignFormValues,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dirty.name) body.name = v.name.trim();
  if (dirty.intakeSessionId) body.intakeSessionId = v.intakeSessionId || null;
  if (dirty.targetProgramId) body.targetProgramId = v.targetProgramId || null;
  if (dirty.programIds) body.programIds = v.programIds;
  if (dirty.openAt) body.openAt = v.openAt ? new Date(v.openAt).toISOString() : null;
  if (dirty.closeAt) body.closeAt = v.closeAt ? new Date(v.closeAt).toISOString() : null;
  if (dirty.requiredFields || dirty.requiredDocTypes) {
    body.config = {
      requiredFields: v.requiredFields.map((k) => k.trim()).filter(Boolean),
      requiredDocTypes: v.requiredDocTypes.map((k) => k.trim()).filter(Boolean),
    };
  }
  return body;
}

// ─── Applicant dynamic form ─────────────────────────────────────────────────

/**
 * R1: dynamic requiredFields keys are NEVER used as react-hook-form field
 * names or zod object keys (a dotted/numeric/__proto__ key would otherwise
 * register as a nested path or pollute the prototype). Inputs are bound by
 * INDEX ("values.0", "values.1", ...) and mapped back to a flat object here.
 */
export function buildApplyValues(keys: string[], existing?: Record<string, unknown>): string[] {
  return keys.map((k) => {
    const v = existing?.[k];
    return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
  });
}

export function toFormData(
  keys: string[],
  values: string[],
  original?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = original ? { ...original } : {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i].trim();
    if (UNSAFE_KEYS.has(key)) {
      throw new Error(`"${key}" is not a safe field name`);
    }
    out[key] = (values[i] ?? "").trim();
  }
  return Object.fromEntries(Object.entries(out));
}

export function buildApplyFormSchema(keys: string[]) {
  return z.object({
    values: z
      .array(z.string().trim().min(1, "Required").max(2000))
      .length(keys.length),
  });
}

// ─── Other admissions schemas ───────────────────────────────────────────────

export const offerFormSchema = z.object({
  offeredProgramId: z.string().min(1, "Choose a program"),
  expiresAt: z
    .string()
    .refine((v) => v === "" || new Date(v).getTime() > Date.now(), "Expiry must be in the future"),
});
export type OfferFormValues = z.infer<typeof offerFormSchema>;

export const interviewFormSchema = z.object({
  interviewAt: z.string().min(1, "Interview time is required").refine((v) => !Number.isNaN(new Date(v).getTime()), "Invalid date"),
});
export type InterviewFormValues = z.infer<typeof interviewFormSchema>;

export const enrollFormSchema = z.object({
  enrollmentNo: z.string().trim().min(1, "Enrollment number is required").max(100),
  academicSessionId: z.string(),
});
export type EnrollFormValues = z.infer<typeof enrollFormSchema>;

export const documentFormSchema = z.object({
  docType: z.string().trim().min(1, "Document type is required").max(100),
  reference: z.string().trim().min(1, "Reference is required").max(2000),
  fileName: z.string().trim().max(300),
});
export type DocumentFormValues = z.infer<typeof documentFormSchema>;

export const reviewFormSchema = z.object({
  decision: z.enum(["RECOMMEND_ELIGIBLE", "RECOMMEND_REJECT", "REQUEST_DOCUMENTS", "SHORTLIST", "NOTE"]),
  notes: z.string().trim().max(4000),
});
export type ReviewFormValues = z.infer<typeof reviewFormSchema>;

export const reasonFormSchema = z.object({
  reason: z.string().trim().max(2000),
});
export type ReasonFormValues = z.infer<typeof reasonFormSchema>;
