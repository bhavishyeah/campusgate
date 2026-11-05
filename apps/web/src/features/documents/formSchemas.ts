import { z } from "zod";
import { optText, reqEnum, reqInt, reqText } from "@/lib/formFields";

/** Reused for BOTH the UserPicker hint and the lookup zod message (serverParity). */
export const LOOKUP_HINT = "Enter at least 2 characters";

export const ACCESS_LEVELS = ["READ", "MANAGE"] as const;

// ── Create document (metadata — bytes ride the raw body, see upload.ts) ──
// Messages are byte-equal to createDocumentSchema in packages/shared.
export const createDocumentFormSchema = z.object({
  title: reqText("Title is required", 300),
  description: optText(4000),
  category: optText(120),
  // The file's declared content type. Seeded from file.type in the dialog and
  // always sent non-empty (server requires 1–255).
  contentType: reqText("Content type is required", 255),
  retentionPolicyId: z.string(),
});
export type CreateDocumentValues = z.output<typeof createDocumentFormSchema>;

// ── New version (filename comes from the picked File; contentType editable) ──
export const newVersionFormSchema = z.object({
  contentType: reqText("Content type is required", 255),
});
export type NewVersionValues = z.output<typeof newVersionFormSchema>;

// ── Grant (user XOR department) ──
// `granteeType` drives which field is required; the XOR message matches the
// server string on the `granteeUserId` path.
export const grantFormSchema = z
  .object({
    granteeType: z.enum(["user", "department"]),
    granteeUserId: z.string(),
    granteeDepartmentId: z.string(),
    accessLevel: reqEnum(ACCESS_LEVELS),
  })
  .refine(
    (v) =>
      v.granteeType === "user"
        ? v.granteeUserId !== "" && v.granteeDepartmentId === ""
        : v.granteeDepartmentId !== "" && v.granteeUserId === "",
    {
      message: "exactly one of granteeUserId or granteeDepartmentId is required",
      path: ["granteeUserId"],
    },
  );
export type GrantValues = z.output<typeof grantFormSchema>;

export function buildGrantBody(v: GrantValues): Record<string, unknown> {
  const body: Record<string, unknown> = { accessLevel: v.accessLevel };
  if (v.granteeType === "user") body.granteeUserId = v.granteeUserId;
  else body.granteeDepartmentId = v.granteeDepartmentId;
  return body;
}

// ── Retention policy (create/edit) ──
// Messages byte-equal to upsertDocumentRetentionPolicySchema in packages/shared.
export const retentionPolicyFormSchema = z.object({
  name: reqText("Name is required", 120),
  retentionDays: reqInt({ min: 1, max: 36500 }),
  category: optText(120),
});
export type RetentionPolicyValues = z.output<typeof retentionPolicyFormSchema>;

export function buildRetentionPolicyBody(v: RetentionPolicyValues): Record<string, unknown> {
  const body: Record<string, unknown> = { name: v.name, retentionDays: v.retentionDays };
  if (v.category !== undefined) body.category = v.category;
  return body;
}
