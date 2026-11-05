import { z } from "zod";
import { optInt, optText, reqEnum, reqId, reqInt, reqText } from "@/lib/formFields";
import type { FieldDef } from "./types";

export const FIELD_TYPES = ["TEXT", "NUMBER", "DATE", "SELECT"] as const;
export const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export const STATUS_TARGETS = ["IN_PROGRESS", "PENDING_APPROVAL"] as const;

export const LOOKUP_HINT = "Enter at least 2 characters";

/** Dirty-field map as produced by react-hook-form. */
export type Dirty<T> = Partial<Record<keyof T, unknown>>;

// ── Request types ──
export const typeCreateSchema = z.object({
  name: reqText("Name is required", 200),
  code: reqText("Code is required", 64).regex(/^[A-Z0-9_]+$/, "Code must be [A-Z0-9_]"),
  category: reqText("Category is required", 64),
  description: optText(2000),
  defaultAssigneeRole: z
    .string()
    .trim()
    .transform((v) => (v === "" ? undefined : v))
    .pipe(z.string().regex(/^[A-Z0-9_]{1,64}$/).optional()),
  defaultAssigneeDepartmentId: z.string(),
  slaTargetHours: reqInt({ min: 1, max: 8760 }),
  requiresApproval: z.boolean(),
  isActive: z.boolean(),
});
export type TypeCreateValues = z.output<typeof typeCreateSchema>;

// PATCH drops the custom code/category messages (6.2): plain min(1) + regex (no message).
export const typePatchSchema = z.object({
  name: reqText("Name is required", 200),
  code: reqText("Code is required", 64).regex(/^[A-Z0-9_]+$/),
  category: reqText("Category is required", 64),
  description: optText(2000),
  defaultAssigneeRole: z
    .string()
    .trim()
    .transform((v) => (v === "" ? undefined : v))
    .pipe(z.string().regex(/^[A-Z0-9_]{1,64}$/).optional()),
  defaultAssigneeDepartmentId: z.string(),
  slaTargetHours: reqInt({ min: 1, max: 8760 }),
  requiresApproval: z.boolean(),
  isActive: z.boolean(),
});
export type TypePatchValues = z.output<typeof typePatchSchema>;

export function buildTypeCreate(v: TypeCreateValues): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: v.name,
    code: v.code,
    category: v.category,
    slaTargetHours: v.slaTargetHours,
    requiresApproval: v.requiresApproval,
    isActive: v.isActive,
  };
  if (v.description !== undefined) body.description = v.description;
  if (v.defaultAssigneeRole !== undefined) body.defaultAssigneeRole = v.defaultAssigneeRole;
  if (v.defaultAssigneeDepartmentId !== "") body.defaultAssigneeDepartmentId = v.defaultAssigneeDepartmentId;
  return body;
}

export function buildTypePatch(dirty: Dirty<TypePatchValues>, v: TypePatchValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dirty.name) body.name = v.name;
  if (dirty.code) body.code = v.code;
  if (dirty.category) body.category = v.category;
  if (dirty.description) body.description = v.description === undefined ? null : v.description;
  if (dirty.defaultAssigneeRole) body.defaultAssigneeRole = v.defaultAssigneeRole === undefined ? null : v.defaultAssigneeRole;
  if (dirty.defaultAssigneeDepartmentId) body.defaultAssigneeDepartmentId = v.defaultAssigneeDepartmentId === "" ? null : v.defaultAssigneeDepartmentId;
  if (dirty.slaTargetHours) body.slaTargetHours = v.slaTargetHours;
  if (dirty.requiresApproval) body.requiresApproval = v.requiresApproval;
  if (dirty.isActive) body.isActive = v.isActive;
  return body;
}

// ── Field definitions ──
const selectRefine = (v: { dataType: string; options?: string[] }) =>
  v.dataType === "SELECT"
    ? Array.isArray(v.options) && v.options.length >= 1
    : v.options === undefined || v.options.length === 0;

export const fieldCreateSchema = z
  .object({
    fieldKey: reqText("Field key is required", 64).regex(/^[a-zA-Z0-9_]+$/, "Field key must be [a-zA-Z0-9_]"),
    label: reqText("Label is required", 200),
    dataType: reqEnum(FIELD_TYPES),
    required: z.boolean(),
    sortOrder: optInt({ min: 0 }),
    options: z.array(z.string().trim().min(1).max(200)).max(50),
  })
  .transform((v) => ({ ...v, options: v.options.filter((o) => o !== "") }))
  .refine(selectRefine, {
    message: "SELECT fields require non-empty options; non-SELECT fields must omit options",
    path: ["options"],
  });
export type FieldCreateValues = z.output<typeof fieldCreateSchema>;

export const fieldPatchSchema = z
  .object({
    fieldKey: reqText("Field key is required", 64).regex(/^[a-zA-Z0-9_]+$/, "Field key must be [a-zA-Z0-9_]"),
    label: reqText("Label is required", 200),
    dataType: reqEnum(FIELD_TYPES),
    required: z.boolean(),
    sortOrder: optInt({ min: 0 }),
    options: z.array(z.string().trim().min(1).max(200)).max(50),
  })
  .transform((v) => ({ ...v, options: v.options.filter((o) => o !== "") }))
  .refine(selectRefine, {
    message: "SELECT fields require non-empty options; non-SELECT fields must omit options",
    path: ["options"],
  });
export type FieldPatchValues = z.output<typeof fieldPatchSchema>;

export function buildFieldCreate(v: FieldCreateValues): Record<string, unknown> {
  const body: Record<string, unknown> = { fieldKey: v.fieldKey, label: v.label, dataType: v.dataType, required: v.required };
  if (v.sortOrder !== undefined) body.sortOrder = v.sortOrder;
  if (v.dataType === "SELECT") body.options = v.options;
  return body;
}

export function buildFieldPatch(dirty: Dirty<FieldPatchValues>, v: FieldPatchValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dirty.fieldKey) body.fieldKey = v.fieldKey;
  if (dirty.label) body.label = v.label;
  if (dirty.dataType) body.dataType = v.dataType;
  if (dirty.required) body.required = v.required;
  if (dirty.sortOrder) body.sortOrder = v.sortOrder;
  // Switching away from SELECT sends options: null; a SELECT edit sends the list.
  if (dirty.options || dirty.dataType) body.options = v.dataType === "SELECT" ? v.options : null;
  return body;
}

// ── Assign / status / resolve / reject / comment / feedback ──
export const assignSchema = z.object({ assigneeUserId: reqId() });
export type AssignValues = z.output<typeof assignSchema>;
export const buildAssign = (v: AssignValues) => ({ assigneeUserId: v.assigneeUserId });

export const statusSchema = z.object({ toStatus: reqEnum(STATUS_TARGETS) });
export type StatusValues = z.output<typeof statusSchema>;
export const buildStatus = (v: StatusValues) => ({ toStatus: v.toStatus });

export const resolveSchema = z.object({ resolutionNote: reqText("Resolution note is required", 4000) });
export type ResolveValues = z.output<typeof resolveSchema>;
export const buildResolve = (v: ResolveValues) => ({ resolutionNote: v.resolutionNote });

export const rejectSchema = z.object({ reason: optText(2000) });
export type RejectValues = z.output<typeof rejectSchema>;
export function buildReject(v: RejectValues): Record<string, unknown> {
  return v.reason === undefined ? {} : { reason: v.reason };
}

export const commentSchema = z.object({ body: reqText("Comment body is required", 4000) });
export type CommentValues = z.output<typeof commentSchema>;
export const buildComment = (v: CommentValues) => ({ body: v.body });

export const feedbackSchema = z.object({
  rating: reqInt({ min: 1, max: 5 }),
  comment: optText(2000),
});
export type FeedbackValues = z.output<typeof feedbackSchema>;
export function buildFeedback(v: FeedbackValues): Record<string, unknown> {
  const body: Record<string, unknown> = { rating: v.rating };
  if (v.comment !== undefined) body.comment = v.comment;
  return body;
}

// ── Raise ──
/** priority is optional/defaulted to NORMAL to mirror the server (NOT reqEnum). */
const prioritySchema = z
  .string()
  .transform((v) => (v === "" ? "NORMAL" : v))
  .pipe(z.enum(PRIORITIES));

export const raiseSchema = z.object({
  requestTypeId: reqId(),
  title: reqText("Title is required", 200),
  description: optText(4000),
  priority: prioritySchema,
});
export type RaiseValues = z.output<typeof raiseSchema>;

/**
 * Builds the raise envelope. fieldValues is assembled from the dynamic inputs; the
 * server's per-field validator (422 tokens) remains authoritative. May omit
 * fieldValues entirely (server `.default({})`). NUMBER -> number, DATE -> date string.
 */
export function buildRaise(
  v: RaiseValues,
  fields: readonly FieldDef[],
  values: Record<string, string>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { requestTypeId: v.requestTypeId, title: v.title, priority: v.priority };
  if (v.description !== undefined) body.description = v.description;

  const fieldValues: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = values[f.fieldKey];
    if (raw === undefined || raw === "") continue; // blank omitted; server decides required
    if (f.dataType === "NUMBER") fieldValues[f.fieldKey] = Number(raw);
    else fieldValues[f.fieldKey] = raw; // TEXT/SELECT/DATE kept as string
  }
  if (Object.keys(fieldValues).length > 0) body.fieldValues = fieldValues;
  return body;
}
