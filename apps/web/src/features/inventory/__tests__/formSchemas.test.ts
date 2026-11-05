import { describe, it, expect } from "vitest";
import {
  categoryCreateSchema,
  categoryPatchSchema,
  assetCreateSchema,
  assetPatchSchema,
  transferSchema,
  maintenanceCreateSchema,
  disposeSchema,
  stockMovementSchema,
  auditCreateSchema,
  auditLineSchema,
  buildCategoryPatch,
  buildAssetCreate,
  buildAssetPatch,
  buildMaintenanceCreate,
  buildDispose,
  type CategoryPatchValues,
  type AssetPatchValues,
} from "../formSchemas";
import type { z } from "zod";

function msg(schema: z.ZodTypeAny, input: unknown, path?: string): string | undefined {
  const r = schema.safeParse(input);
  if (r.success) return undefined;
  const issues = path ? r.error.issues.filter((i) => i.path.join(".") === path) : r.error.issues;
  return (issues[0] ?? r.error.issues[0])?.message;
}

const assetBase = { categoryId: "c1", acquisitionDate: "", acquisitionCost: "", currency: "", location: "", custodyUserId: "", custodyDepartmentId: "" };

describe("inventory formSchemas — literal message pins", () => {
  it("required text messages", () => {
    expect(msg(categoryCreateSchema, { name: "", code: "X", kind: "CONSUMABLE", depreciationMethod: "", usefulLifeMonths: "" }, "name")).toBe("Name is required");
    expect(msg(categoryCreateSchema, { name: "N", code: "", kind: "CONSUMABLE", depreciationMethod: "", usefulLifeMonths: "" }, "code")).toBe("Code is required");
    expect(msg(assetCreateSchema, { ...assetBase, assetTag: "", name: "N" }, "assetTag")).toBe("Asset tag is required");
    expect(msg(maintenanceCreateSchema, { issue: "", assigneeUserId: "", cost: "" }, "issue")).toBe("Issue is required");
    expect(msg(auditCreateSchema, { name: "" }, "name")).toBe("Name is required");
  });
  it("blank-on-edit shows the create text (6.2 exception)", () => {
    expect(msg(categoryPatchSchema, { name: "", code: "X", kind: "CONSUMABLE", depreciationMethod: "", usefulLifeMonths: "" }, "name")).toBe("Name is required");
    expect(msg(assetPatchSchema, { name: "", location: "" }, "name")).toBe("Name is required");
  });
  it("whitespace-only required text is rejected (client trims)", () => {
    expect(categoryCreateSchema.safeParse({ name: "   ", code: "X", kind: "CONSUMABLE", depreciationMethod: "", usefulLifeMonths: "" }).success).toBe(false);
  });
  it("refine messages are the server strings at the server paths", () => {
    expect(msg(transferSchema, { toUserId: "", toDepartmentId: "", reason: "", transferredAt: "" }, "toUserId")).toBe("at least one of toUserId or toDepartmentId is required");
    expect(msg(stockMovementSchema, { kind: "RECEIPT", quantity: "0", reason: "" }, "quantity")).toBe("quantity must be non-zero");
    expect(msg(stockMovementSchema, { kind: "ISSUE", quantity: "3", reason: "" }, "quantity")).toBe("quantity sign must match kind (RECEIPT > 0, ISSUE < 0, ADJUSTMENT != 0)");
    expect(msg(auditLineSchema, { ref: "asset", assetId: "", stockItemId: "", expectedQuantity: "", foundQuantity: "", note: "" }, "assetId")).toBe("exactly one of assetId or stockItemId is required");
  });
  it("money rupee-layer messages are the documented client-only exceptions", () => {
    expect(msg(assetCreateSchema, { ...assetBase, assetTag: "T", name: "N", acquisitionCost: "1.234" }, "acquisitionCost")).toBe("Enter a valid amount (digits with up to two decimals).");
    expect(msg(assetCreateSchema, { ...assetBase, assetTag: "T", name: "N", acquisitionCost: "0" }, "acquisitionCost")).toBe("Amount must be greater than zero.");
  });
});

describe("inventory formSchemas — boundaries", () => {
  it("name 128 ok / 129 fails", () => {
    expect(categoryCreateSchema.safeParse({ name: "x".repeat(128), code: "C", kind: "CONSUMABLE", depreciationMethod: "", usefulLifeMonths: "" }).success).toBe(true);
    expect(categoryCreateSchema.safeParse({ name: "x".repeat(129), code: "C", kind: "CONSUMABLE", depreciationMethod: "", usefulLifeMonths: "" }).success).toBe(false);
  });
  it("issue 512 ok / 513 fails", () => {
    expect(maintenanceCreateSchema.safeParse({ issue: "x".repeat(512), assigneeUserId: "", cost: "" }).success).toBe(true);
    expect(maintenanceCreateSchema.safeParse({ issue: "x".repeat(513), assigneeUserId: "", cost: "" }).success).toBe(false);
  });
});

describe("inventory formSchemas — builders", () => {
  it("category patch is dirty-only with null clearables", () => {
    const v: CategoryPatchValues = { name: "N", code: "C", kind: "CONSUMABLE", depreciationMethod: undefined, usefulLifeMonths: undefined };
    const dirty = { depreciationMethod: true };
    expect(buildCategoryPatch(dirty, v)).toEqual({ depreciationMethod: null });
  });
  it("asset create omits blanks and money converts to minor string", () => {
    // Values here are the schema OUTPUT (optText already mapped blank -> undefined).
    const body = buildAssetCreate({ assetTag: "T", name: "N", categoryId: "c1", acquisitionDate: "", acquisitionCost: "123456", currency: undefined, location: undefined, custodyUserId: "", custodyDepartmentId: "d1" });
    expect(body.acquisitionCost).toBe("123456");
    expect(body.custodyDepartmentId).toBe("d1");
    expect(body.acquisitionDate).toBeUndefined();
    expect(body.location).toBeUndefined();
  });
  it("asset create prefers the user custody key when both set", () => {
    const body = buildAssetCreate({ assetTag: "T", name: "N", categoryId: "c1", acquisitionDate: "", acquisitionCost: "", currency: "", location: "", custodyUserId: "u1", custodyDepartmentId: "d1" });
    expect(body.custodyUserId).toBe("u1");
    expect(body.custodyDepartmentId).toBeUndefined();
  });
  it("asset patch clears location to null on dirty-blank", () => {
    const v: AssetPatchValues = { name: "N", location: undefined };
    expect(buildAssetPatch({ location: true }, v)).toEqual({ location: null });
  });
  it("maintenance create omits blank assignee and cost", () => {
    expect(buildMaintenanceCreate({ issue: "x", assigneeUserId: "", cost: undefined })).toEqual({ issue: "x" });
  });
  it("dispose carries required enums, omits blank optionals", () => {
    const body = buildDispose({ terminalStatus: "RETIRED", method: "LOST", proceeds: undefined, currency: undefined, reason: undefined, disposedAt: "" });
    expect(body).toEqual({ terminalStatus: "RETIRED", method: "LOST" });
  });
});
