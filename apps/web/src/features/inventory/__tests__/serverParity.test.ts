import { describe, it, expect } from "vitest";
import {
  createInventoryCategorySchema,
  patchInventoryCategorySchema,
  createInventoryAssetSchema,
  patchInventoryAssetSchema,
  inventoryTransferSchema,
  inventoryStockMovementSchema,
  createInventoryMaintenanceSchema,
  inventoryMaintenanceTransitionSchema,
  inventoryDisposalSchema,
  createInventoryAuditSessionSchema,
  inventoryAuditLineSchema,
  inventoryUserLookupQuerySchema,
} from "@campusgate/shared";
import {
  categoryCreateSchema,
  assetCreateSchema,
  maintenanceCreateSchema,
  auditCreateSchema,
  buildCategoryCreate,
  buildAssetCreate,
  buildTransfer,
  buildMaintenanceCreate,
  buildMaintenanceTransition,
  buildDispose,
  buildStockMovement,
  buildAuditCreate,
  buildAuditLine,
} from "../formSchemas";
import { minorUnitString } from "../money";
import type { z } from "zod";

function firstMessage(schema: z.ZodTypeAny, input: unknown, path?: string): string | undefined {
  const r = schema.safeParse(input);
  if (r.success) return undefined;
  const issues = path ? r.error.issues.filter((i) => i.path.join(".") === path) : r.error.issues;
  return (issues[0] ?? r.error.issues[0])?.message;
}

describe("inventory serverParity — required-field messages", () => {
  it("category name/code blank messages match", () => {
    expect(firstMessage(categoryCreateSchema, { name: "", code: "X", kind: "CONSUMABLE" }, "name")).toBe(
      firstMessage(createInventoryCategorySchema, { name: "", code: "X", kind: "CONSUMABLE" }, "name"),
    );
    expect(firstMessage(categoryCreateSchema, { name: "N", code: "", kind: "CONSUMABLE" }, "code")).toBe(
      firstMessage(createInventoryCategorySchema, { name: "N", code: "", kind: "CONSUMABLE" }, "code"),
    );
    expect(firstMessage(createInventoryCategorySchema, { name: "", code: "X", kind: "CONSUMABLE" }, "name")).toBe(
      "Name is required",
    );
  });
  it("asset tag/name blank messages match", () => {
    const client = { assetTag: "", name: "", categoryId: "c1" };
    expect(firstMessage(assetCreateSchema, { ...client, custodyUserId: "", custodyDepartmentId: "", acquisitionDate: "", currency: "", location: "", acquisitionCost: "" }, "assetTag")).toBe(
      firstMessage(createInventoryAssetSchema, client, "assetTag"),
    );
    expect(firstMessage(createInventoryAssetSchema, client, "assetTag")).toBe("Asset tag is required");
    expect(firstMessage(createInventoryAssetSchema, { assetTag: "T", name: "", categoryId: "c1" }, "name")).toBe(
      "Name is required",
    );
  });
  it("maintenance issue blank message matches", () => {
    expect(firstMessage(maintenanceCreateSchema, { issue: "", assigneeUserId: "", cost: "" }, "issue")).toBe(
      firstMessage(createInventoryMaintenanceSchema, { issue: "" }, "issue"),
    );
    expect(firstMessage(createInventoryMaintenanceSchema, { issue: "" }, "issue")).toBe("Issue is required");
  });
  it("audit session name blank message matches", () => {
    expect(firstMessage(auditCreateSchema, { name: "" }, "name")).toBe(
      firstMessage(createInventoryAuditSessionSchema, { name: "" }, "name"),
    );
  });
  it("money leaf message equals the server inventoryMoneyString message", () => {
    expect(firstMessage(minorUnitString(), "1.5")).toBe(
      firstMessage(createInventoryAssetSchema, { assetTag: "T", name: "N", categoryId: "c1", acquisitionCost: "1.5" }, "acquisitionCost"),
    );
    expect(firstMessage(minorUnitString(), "1.5")).toBe("must be a non-negative integer number of minor units");
  });
  it("currency message matches the server", () => {
    expect(firstMessage(createInventoryAssetSchema, { assetTag: "T", name: "N", categoryId: "c1", currency: "usd" }, "currency")).toBe(
      "must be a 3-letter uppercase currency code",
    );
  });
  it("transfer / stock / audit-line refine messages+paths match the server", () => {
    expect(firstMessage(inventoryTransferSchema, {}, "toUserId")).toBe(
      "at least one of toUserId or toDepartmentId is required",
    );
    expect(firstMessage(inventoryStockMovementSchema, { kind: "RECEIPT", quantity: 0 }, "quantity")).toBe(
      "quantity must be non-zero",
    );
    expect(firstMessage(inventoryStockMovementSchema, { kind: "RECEIPT", quantity: -1 }, "quantity")).toBe(
      "quantity sign must match kind (RECEIPT > 0, ISSUE < 0, ADJUSTMENT != 0)",
    );
    expect(firstMessage(inventoryAuditLineSchema, {}, "assetId")).toBe(
      "exactly one of assetId or stockItemId is required",
    );
  });
  it("user lookup short-q message matches", () => {
    expect(firstMessage(inventoryUserLookupQuerySchema, { q: "a" }, "q")).toBe("Enter at least 2 characters");
  });
});

describe("inventory serverParity — builder outputs pass the shared schema", () => {
  it("category create", () => {
    const body = buildCategoryCreate({ name: "Furniture", code: "FUR", kind: "FIXED_ASSET", depreciationMethod: undefined, usefulLifeMonths: undefined });
    expect(createInventoryCategorySchema.safeParse(body).success).toBe(true);
  });
  it("asset create with money + custody", () => {
    const body = buildAssetCreate({
      assetTag: "T1",
      name: "Chair",
      categoryId: "c1",
      acquisitionDate: "2026-01-01",
      acquisitionCost: "123456",
      currency: "INR",
      location: "Room 1",
      custodyUserId: "u1",
      custodyDepartmentId: "",
    });
    expect(createInventoryAssetSchema.safeParse(body).success).toBe(true);
    expect(body.custodyUserId).toBe("u1");
    expect(body.custodyDepartmentId).toBeUndefined();
  });
  it("transfer", () => {
    expect(inventoryTransferSchema.safeParse(buildTransfer({ toUserId: "u1", toDepartmentId: "", reason: undefined, transferredAt: "" })).success).toBe(true);
  });
  it("maintenance create + transition", () => {
    expect(createInventoryMaintenanceSchema.safeParse(buildMaintenanceCreate({ issue: "Broken", assigneeUserId: "", cost: undefined })).success).toBe(true);
    expect(inventoryMaintenanceTransitionSchema.safeParse(buildMaintenanceTransition({ toStatus: "RESOLVED", cost: "5000", resolutionNote: "fixed" })).success).toBe(true);
  });
  it("dispose", () => {
    expect(inventoryDisposalSchema.safeParse(buildDispose({ terminalStatus: "DISPOSED", method: "SCRAPPED", proceeds: undefined, currency: undefined, reason: undefined, disposedAt: "" })).success).toBe(true);
  });
  it("stock movement", () => {
    expect(inventoryStockMovementSchema.safeParse(buildStockMovement({ kind: "RECEIPT", quantity: 5, reason: undefined })).success).toBe(true);
  });
  it("audit create + line (asset) + line (stock)", () => {
    expect(createInventoryAuditSessionSchema.safeParse(buildAuditCreate({ name: "Q1 count" })).success).toBe(true);
    expect(inventoryAuditLineSchema.safeParse(buildAuditLine({ ref: "asset", assetId: "a1", stockItemId: "", expectedQuantity: 10, foundQuantity: 9, note: undefined })).success).toBe(true);
    expect(inventoryAuditLineSchema.safeParse(buildAuditLine({ ref: "stock", assetId: "", stockItemId: "s1", expectedQuantity: undefined, foundQuantity: undefined, note: undefined })).success).toBe(true);
  });
  it("patch schemas accept empty/partial bodies", () => {
    expect(patchInventoryCategorySchema.safeParse({}).success).toBe(true);
    expect(patchInventoryAssetSchema.safeParse({ name: "New name" }).success).toBe(true);
  });
});
