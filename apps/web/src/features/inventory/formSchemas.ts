import { z } from "zod";
import { optInt, optText, reqEnum, reqId, reqInt, reqText } from "@/lib/formFields";
import { currencyString, minorUnitString, rupeesToMinorString } from "./money";

export const ASSET_KINDS = ["FIXED_ASSET", "CONSUMABLE"] as const;
export const MAINTENANCE_TARGETS = ["IN_PROGRESS", "RESOLVED", "CANCELLED"] as const;
export const TERMINAL_STATUSES = ["RETIRED", "DISPOSED"] as const;
export const DISPOSAL_METHODS = ["SOLD", "SCRAPPED", "DONATED", "LOST", "WRITTEN_OFF", "OTHER"] as const;
export const STOCK_KINDS = ["RECEIPT", "ISSUE", "ADJUSTMENT"] as const;

/** Dirty-field map as produced by react-hook-form (`formState.dirtyFields`). */
export type Dirty<T> = Partial<Record<keyof T, unknown>>;

export const LOOKUP_HINT = "Enter at least 2 characters";

/**
 * Optional rupee money leaf. Blank -> undefined. A non-blank value is converted
 * to a minor-unit (paise) digit string via rupeesToMinorString (whose rupee-layer
 * messages are the documented 6.2 client-only exceptions) and then validated by
 * minorUnitString() so the output carries a /^\d+$/ string matching the server.
 */
const optMoney = () =>
  z
    .string()
    .transform((v) => (v.trim() === "" ? undefined : v))
    .superRefine((v, ctx) => {
      if (v === undefined) return;
      try {
        rupeesToMinorString(v);
      } catch (e) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
      }
    })
    .transform((v) => (v === undefined ? undefined : rupeesToMinorString(v)))
    .pipe(minorUnitString().optional());

const optCurrency = () =>
  z
    .string()
    .transform((v) => (v.trim() === "" ? undefined : v))
    .pipe(currencyString().optional());

// ── Categories ──
export const categoryCreateSchema = z.object({
  name: reqText("Name is required", 128),
  code: reqText("Code is required", 64),
  kind: reqEnum(ASSET_KINDS),
  depreciationMethod: optText(64),
  usefulLifeMonths: optInt({ min: 0 }),
});
export type CategoryCreateValues = z.output<typeof categoryCreateSchema>;

export const categoryPatchSchema = z.object({
  name: reqText("Name is required", 128),
  code: reqText("Code is required", 64),
  kind: reqEnum(ASSET_KINDS),
  depreciationMethod: optText(64),
  usefulLifeMonths: optInt({ min: 0 }),
});
export type CategoryPatchValues = z.output<typeof categoryPatchSchema>;

export function buildCategoryCreate(v: CategoryCreateValues): Record<string, unknown> {
  const body: Record<string, unknown> = { name: v.name, code: v.code, kind: v.kind };
  if (v.depreciationMethod !== undefined) body.depreciationMethod = v.depreciationMethod;
  if (v.usefulLifeMonths !== undefined) body.usefulLifeMonths = v.usefulLifeMonths;
  return body;
}

export function buildCategoryPatch(dirty: Dirty<CategoryPatchValues>, v: CategoryPatchValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dirty.name) body.name = v.name;
  if (dirty.code) body.code = v.code;
  if (dirty.kind) body.kind = v.kind;
  if (dirty.depreciationMethod) body.depreciationMethod = v.depreciationMethod === undefined ? null : v.depreciationMethod;
  if (dirty.usefulLifeMonths) body.usefulLifeMonths = v.usefulLifeMonths === undefined ? null : v.usefulLifeMonths;
  return body;
}

// ── Assets ──
export const assetCreateSchema = z.object({
  assetTag: reqText("Asset tag is required", 128),
  name: reqText("Name is required", 256),
  categoryId: reqId(),
  acquisitionDate: z
    .string()
    .refine((v) => v === "" || !Number.isNaN(new Date(v).getTime()), { message: "Invalid date" }),
  acquisitionCost: optMoney(),
  currency: optCurrency(),
  location: optText(256),
  custodyUserId: z.string(),
  custodyDepartmentId: z.string(),
});
export type AssetCreateValues = z.output<typeof assetCreateSchema>;

export const assetPatchSchema = z.object({
  name: reqText("Name is required", 256),
  location: optText(256),
});
export type AssetPatchValues = z.output<typeof assetPatchSchema>;

export function buildAssetCreate(v: AssetCreateValues): Record<string, unknown> {
  const body: Record<string, unknown> = { assetTag: v.assetTag, name: v.name, categoryId: v.categoryId };
  if (v.acquisitionDate !== "") body.acquisitionDate = new Date(v.acquisitionDate).toISOString();
  if (v.acquisitionCost !== undefined) body.acquisitionCost = v.acquisitionCost;
  if (v.currency !== undefined) body.currency = v.currency;
  if (v.location !== undefined) body.location = v.location;
  // At most one custody target is sent (user takes precedence if both set).
  if (v.custodyUserId !== "") body.custodyUserId = v.custodyUserId;
  else if (v.custodyDepartmentId !== "") body.custodyDepartmentId = v.custodyDepartmentId;
  return body;
}

export function buildAssetPatch(dirty: Dirty<AssetPatchValues>, v: AssetPatchValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dirty.name) body.name = v.name;
  if (dirty.location) body.location = v.location === undefined ? null : v.location;
  return body;
}

// ── Custody transfer ──
export const transferSchema = z
  .object({
    toUserId: z.string(),
    toDepartmentId: z.string(),
    reason: optText(512),
    transferredAt: z
      .string()
      .refine((v) => v === "" || !Number.isNaN(new Date(v).getTime()), { message: "Invalid date" }),
  })
  .refine((v) => v.toUserId !== "" || v.toDepartmentId !== "", {
    message: "at least one of toUserId or toDepartmentId is required",
    path: ["toUserId"],
  });
export type TransferValues = z.output<typeof transferSchema>;

export function buildTransfer(v: TransferValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (v.toUserId !== "") body.toUserId = v.toUserId;
  if (v.toDepartmentId !== "") body.toDepartmentId = v.toDepartmentId;
  if (v.reason !== undefined) body.reason = v.reason;
  if (v.transferredAt !== "") body.transferredAt = new Date(v.transferredAt).toISOString();
  return body;
}

// ── Maintenance ──
export const maintenanceCreateSchema = z.object({
  issue: reqText("Issue is required", 512),
  assigneeUserId: z.string(),
  cost: optMoney(),
});
export type MaintenanceCreateValues = z.output<typeof maintenanceCreateSchema>;

export function buildMaintenanceCreate(v: MaintenanceCreateValues): Record<string, unknown> {
  const body: Record<string, unknown> = { issue: v.issue };
  if (v.assigneeUserId !== "") body.assigneeUserId = v.assigneeUserId;
  if (v.cost !== undefined) body.cost = v.cost;
  return body;
}

export const maintenanceTransitionSchema = z.object({
  toStatus: reqEnum(MAINTENANCE_TARGETS),
  cost: optMoney(),
  resolutionNote: optText(512),
});
export type MaintenanceTransitionValues = z.output<typeof maintenanceTransitionSchema>;

export function buildMaintenanceTransition(v: MaintenanceTransitionValues): Record<string, unknown> {
  const body: Record<string, unknown> = { toStatus: v.toStatus };
  if (v.cost !== undefined) body.cost = v.cost;
  if (v.resolutionNote !== undefined) body.resolutionNote = v.resolutionNote;
  return body;
}

// ── Disposal ──
export const disposeSchema = z.object({
  terminalStatus: reqEnum(TERMINAL_STATUSES),
  method: reqEnum(DISPOSAL_METHODS),
  proceeds: optMoney(),
  currency: optCurrency(),
  reason: optText(512),
  disposedAt: z
    .string()
    .refine((v) => v === "" || !Number.isNaN(new Date(v).getTime()), { message: "Invalid date" }),
});
export type DisposeValues = z.output<typeof disposeSchema>;

export function buildDispose(v: DisposeValues): Record<string, unknown> {
  const body: Record<string, unknown> = { terminalStatus: v.terminalStatus, method: v.method };
  if (v.proceeds !== undefined) body.proceeds = v.proceeds;
  if (v.currency !== undefined) body.currency = v.currency;
  if (v.reason !== undefined) body.reason = v.reason;
  if (v.disposedAt !== "") body.disposedAt = new Date(v.disposedAt).toISOString();
  return body;
}

// ── Stock movement ──
export const stockMovementSchema = z
  .object({
    kind: reqEnum(STOCK_KINDS),
    quantity: reqInt({ min: -1_000_000_000, max: 1_000_000_000 }),
    reason: optText(512),
  })
  .refine((v) => v.quantity !== 0, { message: "quantity must be non-zero", path: ["quantity"] })
  .refine(
    (v) =>
      (v.kind === "RECEIPT" && v.quantity > 0) ||
      (v.kind === "ISSUE" && v.quantity < 0) ||
      v.kind === "ADJUSTMENT",
    {
      message: "quantity sign must match kind (RECEIPT > 0, ISSUE < 0, ADJUSTMENT != 0)",
      path: ["quantity"],
    },
  );
export type StockMovementValues = z.output<typeof stockMovementSchema>;

export function buildStockMovement(v: StockMovementValues): Record<string, unknown> {
  const body: Record<string, unknown> = { kind: v.kind, quantity: v.quantity };
  if (v.reason !== undefined) body.reason = v.reason;
  return body;
}

// ── Audit session + line ──
export const auditCreateSchema = z.object({
  name: reqText("Name is required", 128),
});
export type AuditCreateValues = z.output<typeof auditCreateSchema>;
export const buildAuditCreate = (v: AuditCreateValues): Record<string, unknown> => ({ name: v.name });

export const auditLineSchema = z
  .object({
    ref: reqEnum(["asset", "stock"] as const),
    assetId: z.string(),
    stockItemId: z.string(),
    expectedQuantity: optInt({ min: -1_000_000_000, max: 1_000_000_000 }),
    foundQuantity: optInt({ min: -1_000_000_000, max: 1_000_000_000 }),
    note: optText(512),
  })
  .refine((v) => (v.ref === "asset" ? v.assetId !== "" : v.stockItemId !== ""), {
    message: "exactly one of assetId or stockItemId is required",
    path: ["assetId"],
  });
export type AuditLineValues = z.output<typeof auditLineSchema>;

export function buildAuditLine(v: AuditLineValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (v.ref === "asset") body.assetId = v.assetId;
  else body.stockItemId = v.stockItemId;
  if (v.expectedQuantity !== undefined) body.expectedQuantity = v.expectedQuantity;
  if (v.foundQuantity !== undefined) body.foundQuantity = v.foundQuantity;
  if (v.note !== undefined) body.note = v.note;
  return body;
}
