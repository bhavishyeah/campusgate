import { z } from "zod";

/**
 * Zod schemas for the platform surface with messages pinned to the server's
 * wording (api-contract §3.3 / §3.5). Validation here is a UX convenience; the
 * backend remains authoritative.
 */

const REQUIRED_FIELDS_MESSAGE = "name, code and adminEmail are required";

export const createInstitutionSchema = z.object({
  name: z.string().trim().min(1, REQUIRED_FIELDS_MESSAGE),
  code: z.string().trim().min(1, REQUIRED_FIELDS_MESSAGE),
  adminEmail: z
    .string()
    .trim()
    .min(1, REQUIRED_FIELDS_MESSAGE)
    .email("adminEmail must be a valid email"),
  domain: z.string().trim().optional(),
});

export type CreateInstitutionValues = z.infer<typeof createInstitutionSchema>;

/** Max step-up grant TTL = 4 hours (MAX_TTL_MS on the server). */
const MAX_TTL_MS = 4 * 60 * 60 * 1000;

const EXPIRES_AT_MESSAGE = "expiresAt must be in the future and within 4 hours";

export const createSupportGrantSchema = z.object({
  institutionId: z.string().min(1, "institutionId is required"),
  purpose: z
    .string()
    .min(1, "purpose is required")
    .max(500, "purpose must be at most 500 characters"),
  expiresAt: z
    .string()
    .refine(
      (value) => {
        const ts = Date.parse(value);
        if (Number.isNaN(ts)) return false;
        const now = Date.now();
        return ts > now && ts <= now + MAX_TTL_MS;
      },
      { message: EXPIRES_AT_MESSAGE },
    ),
  scope: z
    .object({
      modules: z.array(z.string()).max(50).optional(),
      resources: z.array(z.string()).max(50).optional(),
    })
    .optional(),
});

export type CreateSupportGrantValues = z.infer<typeof createSupportGrantSchema>;

/**
 * Clamp an audit-explorer limit into the server-enforced [1, 100] range,
 * defaulting to 50 for non-finite inputs (mirrors the backend `take` clamp).
 */
export function clampAuditLimit(n: number): number {
  if (!Number.isFinite(n)) return 50;
  const floored = Math.floor(n);
  if (floored < 1) return 1;
  if (floored > 100) return 100;
  return floored;
}
