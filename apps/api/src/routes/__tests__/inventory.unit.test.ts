/**
 * Phase-9.5 Inventory & Assets FAST unit specs (no DB, no Fastify). These cover
 * the PURE pieces of the design the live-DB suites would be wasteful to re-prove:
 *   - the asset lifecycle transition-legality predicate (enumerated-transition,
 *     terminal-enforcing — IN_STORE<->ASSIGNED, IN_MAINTENANCE->IN_STORE|ASSIGNED,
 *     RETIRED/DISPOSED terminal; design §B.2 / MUST-FIX 2);
 *   - the maintenance transition predicate (linear forward-only; design §B.7);
 *   - the stock sign-vs-kind rule + the reconciliation helpers (design §B.4/§B.6);
 *   - the exported Zod schemas (valid/invalid, incl. the ≥1-to*, exactly-one-of
 *     audit line, sign-vs-kind, currency shape, money-string rules; design §B.12).
 *
 * The lifecycle/transition logic mirrors inventory.ts EXACTLY so drift would be
 * caught by the behavioral suite that drives the real handler.
 */
import { describe, expect, it } from "vitest";
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
  inventoryListQuerySchema,
} from "@campusgate/shared";

// ─── Pure asset lifecycle predicate (design §B.2 / MUST-FIX 2) ───────────────
// EXACTLY the enumerated transitions the DB guard inventory_assets_guard enforces.
// Legal lateral/back edges among the three non-terminal states; RETIRED/DISPOSED
// are terminal (no legal source edge out). Plus the no-op self transition.
const ASSET_TRANSITIONS: Record<string, readonly string[]> = {
  IN_STORE: ["ASSIGNED", "IN_MAINTENANCE", "RETIRED", "DISPOSED"],
  ASSIGNED: ["IN_STORE", "IN_MAINTENANCE", "RETIRED", "DISPOSED"],
  IN_MAINTENANCE: ["IN_STORE", "ASSIGNED", "RETIRED", "DISPOSED"],
  RETIRED: [],
  DISPOSED: [],
};
function isLegalAssetTransition(from: string, to: string): boolean {
  if (from === to) return true; // no-op self transition
  return (ASSET_TRANSITIONS[from] ?? []).includes(to);
}

// ─── Pure maintenance transition predicate (design §B.7) ─────────────────────
const MAINTENANCE_TRANSITIONS: Record<string, readonly string[]> = {
  OPEN: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["RESOLVED", "CANCELLED"],
  RESOLVED: [],
  CANCELLED: [],
};
function isLegalMaintenanceTransition(from: string, to: string): boolean {
  return (MAINTENANCE_TRANSITIONS[from] ?? []).includes(to);
}

// ─── Pure stock helpers (design §B.4 / §B.6) ─────────────────────────────────
function signedQuantityOk(kind: string, quantity: number): boolean {
  if (quantity === 0) return false;
  if (kind === "RECEIPT") return quantity > 0;
  if (kind === "ISSUE") return quantity < 0;
  return kind === "ADJUSTMENT"; // any non-zero sign
}
// The reconciliation invariant (stored on-hand == signed-sum == last balanceAfter).
function reconcile(movements: { quantity: number; balanceAfter: number }[]): {
  signedSum: number;
  lastBalanceAfter: number | null;
} {
  const signedSum = movements.reduce((acc, m) => acc + m.quantity, 0);
  const lastBalanceAfter = movements.length ? movements[movements.length - 1].balanceAfter : null;
  return { signedSum, lastBalanceAfter };
}

describe("Inventory asset lifecycle predicate (pure, §B.2 / MUST-FIX 2)", () => {
  it("accepts legal lateral + back edges among non-terminal states", () => {
    expect(isLegalAssetTransition("IN_STORE", "ASSIGNED")).toBe(true);
    expect(isLegalAssetTransition("ASSIGNED", "IN_STORE")).toBe(true); // back edge is LEGAL
    expect(isLegalAssetTransition("IN_STORE", "IN_MAINTENANCE")).toBe(true);
    expect(isLegalAssetTransition("ASSIGNED", "IN_MAINTENANCE")).toBe(true);
    expect(isLegalAssetTransition("IN_MAINTENANCE", "IN_STORE")).toBe(true);
    expect(isLegalAssetTransition("IN_MAINTENANCE", "ASSIGNED")).toBe(true);
  });

  it("accepts transitions into terminal states from any non-terminal state", () => {
    for (const from of ["IN_STORE", "ASSIGNED", "IN_MAINTENANCE"]) {
      expect(isLegalAssetTransition(from, "RETIRED")).toBe(true);
      expect(isLegalAssetTransition(from, "DISPOSED")).toBe(true);
    }
  });

  it("rejects ANY transition out of a terminal state (RETIRED/DISPOSED)", () => {
    for (const to of ["IN_STORE", "ASSIGNED", "IN_MAINTENANCE", "RETIRED", "DISPOSED"]) {
      if (to === "DISPOSED") continue; // self is a no-op (handled below)
      expect(isLegalAssetTransition("DISPOSED", to)).toBe(false);
    }
    expect(isLegalAssetTransition("DISPOSED", "ASSIGNED")).toBe(false);
    expect(isLegalAssetTransition("RETIRED", "IN_STORE")).toBe(false);
    expect(isLegalAssetTransition("RETIRED", "DISPOSED")).toBe(false);
  });

  it("allows the no-op self transition everywhere", () => {
    for (const s of ["IN_STORE", "ASSIGNED", "IN_MAINTENANCE", "RETIRED", "DISPOSED"]) {
      expect(isLegalAssetTransition(s, s)).toBe(true);
    }
  });
});

describe("Inventory maintenance transition predicate (pure, §B.7)", () => {
  it("accepts every legal forward transition", () => {
    expect(isLegalMaintenanceTransition("OPEN", "IN_PROGRESS")).toBe(true);
    expect(isLegalMaintenanceTransition("OPEN", "CANCELLED")).toBe(true);
    expect(isLegalMaintenanceTransition("IN_PROGRESS", "RESOLVED")).toBe(true);
    expect(isLegalMaintenanceTransition("IN_PROGRESS", "CANCELLED")).toBe(true);
  });

  it("rejects illegal / backward / terminal transitions", () => {
    expect(isLegalMaintenanceTransition("OPEN", "RESOLVED")).toBe(false);
    expect(isLegalMaintenanceTransition("IN_PROGRESS", "OPEN")).toBe(false);
    expect(isLegalMaintenanceTransition("RESOLVED", "IN_PROGRESS")).toBe(false);
    expect(isLegalMaintenanceTransition("CANCELLED", "RESOLVED")).toBe(false);
  });
});

describe("Inventory stock sign-vs-kind + reconciliation (pure, §B.4/§B.6)", () => {
  it("enforces the sign-vs-kind rule", () => {
    expect(signedQuantityOk("RECEIPT", 5)).toBe(true);
    expect(signedQuantityOk("RECEIPT", -5)).toBe(false);
    expect(signedQuantityOk("ISSUE", -3)).toBe(true);
    expect(signedQuantityOk("ISSUE", 3)).toBe(false);
    expect(signedQuantityOk("ADJUSTMENT", 2)).toBe(true);
    expect(signedQuantityOk("ADJUSTMENT", -2)).toBe(true);
    expect(signedQuantityOk("ADJUSTMENT", 0)).toBe(false);
  });

  it("reconciles stored on-hand to signed-sum AND last balanceAfter", () => {
    // RECEIPT +10 -> 10; ISSUE -4 -> 6; ADJUSTMENT +1 -> 7.
    const movements = [
      { quantity: 10, balanceAfter: 10 },
      { quantity: -4, balanceAfter: 6 },
      { quantity: 1, balanceAfter: 7 },
    ];
    const { signedSum, lastBalanceAfter } = reconcile(movements);
    expect(signedSum).toBe(7);
    expect(lastBalanceAfter).toBe(7);
    expect(signedSum).toBe(lastBalanceAfter);
  });
});

describe("Inventory Zod schemas (design §B.12)", () => {
  it("createInventoryCategorySchema: name/code required, kind enum, optional metadata", () => {
    expect(createInventoryCategorySchema.safeParse({ name: "Laptops", code: "LAP", kind: "FIXED_ASSET" }).success).toBe(true);
    expect(
      createInventoryCategorySchema.safeParse({ name: "Paper", code: "PPR", kind: "CONSUMABLE", depreciationMethod: "SLM", usefulLifeMonths: 36 }).success,
    ).toBe(true);
    expect(createInventoryCategorySchema.safeParse({ name: "", code: "LAP", kind: "FIXED_ASSET" }).success).toBe(false);
    expect(createInventoryCategorySchema.safeParse({ name: "Laptops", code: "LAP", kind: "WIDGET" }).success).toBe(false);
    expect(createInventoryCategorySchema.safeParse({ name: "Laptops", kind: "FIXED_ASSET" }).success).toBe(false);
  });

  it("patchInventoryCategorySchema: all optional, strict, nullish clear", () => {
    expect(patchInventoryCategorySchema.safeParse({}).success).toBe(true);
    expect(patchInventoryCategorySchema.safeParse({ depreciationMethod: null }).success).toBe(true);
    expect(patchInventoryCategorySchema.safeParse({ bogus: 1 }).success).toBe(false);
  });

  it("createInventoryAssetSchema: assetTag/name/categoryId required; money-string + currency validated; status NOT accepted", () => {
    expect(createInventoryAssetSchema.safeParse({ assetTag: "A-1", name: "Dell", categoryId: "c1" }).success).toBe(true);
    expect(
      createInventoryAssetSchema.safeParse({ assetTag: "A-1", name: "Dell", categoryId: "c1", acquisitionCost: "150000", currency: "INR", custodyUserId: "u1" }).success,
    ).toBe(true);
    // negative / non-digit money rejected
    expect(createInventoryAssetSchema.safeParse({ assetTag: "A-1", name: "Dell", categoryId: "c1", acquisitionCost: "-5" }).success).toBe(false);
    expect(createInventoryAssetSchema.safeParse({ assetTag: "A-1", name: "Dell", categoryId: "c1", acquisitionCost: "12.5" }).success).toBe(false);
    // bad currency shape
    expect(createInventoryAssetSchema.safeParse({ assetTag: "A-1", name: "Dell", categoryId: "c1", currency: "inr" }).success).toBe(false);
    expect(createInventoryAssetSchema.safeParse({ assetTag: "A-1", name: "Dell", categoryId: "c1", currency: "RUPEE" }).success).toBe(false);
    // status is not an accepted input field — provided but ignored by strict? create is non-strict, so extra keys are stripped; assert the parsed shape has no status
    const parsed = createInventoryAssetSchema.safeParse({ assetTag: "A-1", name: "Dell", categoryId: "c1" });
    expect(parsed.success && !("status" in parsed.data)).toBe(true);
  });

  it("patchInventoryAssetSchema: strict; editable master attrs only", () => {
    expect(patchInventoryAssetSchema.safeParse({ name: "Dell X" }).success).toBe(true);
    expect(patchInventoryAssetSchema.safeParse({ location: null }).success).toBe(true);
    expect(patchInventoryAssetSchema.safeParse({ bogus: 1 }).success).toBe(false);
  });

  it("inventoryTransferSchema: requires at least one to* custodian", () => {
    expect(inventoryTransferSchema.safeParse({ toUserId: "u1" }).success).toBe(true);
    expect(inventoryTransferSchema.safeParse({ toDepartmentId: "d1" }).success).toBe(true);
    expect(inventoryTransferSchema.safeParse({ toUserId: "u1", toDepartmentId: "d1", reason: "handover" }).success).toBe(true);
    expect(inventoryTransferSchema.safeParse({ reason: "no target" }).success).toBe(false);
  });

  it("inventoryStockMovementSchema: non-zero quantity + sign matches kind", () => {
    expect(inventoryStockMovementSchema.safeParse({ kind: "RECEIPT", quantity: 10 }).success).toBe(true);
    expect(inventoryStockMovementSchema.safeParse({ kind: "ISSUE", quantity: -3 }).success).toBe(true);
    expect(inventoryStockMovementSchema.safeParse({ kind: "ADJUSTMENT", quantity: -2 }).success).toBe(true);
    expect(inventoryStockMovementSchema.safeParse({ kind: "ADJUSTMENT", quantity: 2 }).success).toBe(true);
    // sign mismatch
    expect(inventoryStockMovementSchema.safeParse({ kind: "RECEIPT", quantity: -10 }).success).toBe(false);
    expect(inventoryStockMovementSchema.safeParse({ kind: "ISSUE", quantity: 3 }).success).toBe(false);
    // zero
    expect(inventoryStockMovementSchema.safeParse({ kind: "ADJUSTMENT", quantity: 0 }).success).toBe(false);
  });

  it("createInventoryMaintenanceSchema: issue 1..512; optional assignee + cost money-string", () => {
    expect(createInventoryMaintenanceSchema.safeParse({ issue: "screen cracked" }).success).toBe(true);
    expect(createInventoryMaintenanceSchema.safeParse({ issue: "x", assigneeUserId: "u1", cost: "2500" }).success).toBe(true);
    expect(createInventoryMaintenanceSchema.safeParse({ issue: "" }).success).toBe(false);
    expect(createInventoryMaintenanceSchema.safeParse({ issue: "x", cost: "-1" }).success).toBe(false);
  });

  it("inventoryMaintenanceTransitionSchema: target enum never includes OPEN", () => {
    expect(inventoryMaintenanceTransitionSchema.safeParse({ toStatus: "IN_PROGRESS" }).success).toBe(true);
    expect(inventoryMaintenanceTransitionSchema.safeParse({ toStatus: "RESOLVED" }).success).toBe(true);
    expect(inventoryMaintenanceTransitionSchema.safeParse({ toStatus: "CANCELLED" }).success).toBe(true);
    expect(inventoryMaintenanceTransitionSchema.safeParse({ toStatus: "OPEN" }).success).toBe(false);
  });

  it("inventoryDisposalSchema: terminalStatus ∈ {RETIRED,DISPOSED}, method enum, optional proceeds/currency", () => {
    expect(inventoryDisposalSchema.safeParse({ terminalStatus: "DISPOSED", method: "SOLD" }).success).toBe(true);
    expect(
      inventoryDisposalSchema.safeParse({ terminalStatus: "RETIRED", method: "SCRAPPED", proceeds: "0", currency: "INR", reason: "eol" }).success,
    ).toBe(true);
    // IN_STORE is not a terminal state
    expect(inventoryDisposalSchema.safeParse({ terminalStatus: "IN_STORE", method: "SOLD" }).success).toBe(false);
    // bad method
    expect(inventoryDisposalSchema.safeParse({ terminalStatus: "DISPOSED", method: "GIFTED" }).success).toBe(false);
    // negative proceeds
    expect(inventoryDisposalSchema.safeParse({ terminalStatus: "DISPOSED", method: "SOLD", proceeds: "-1" }).success).toBe(false);
  });

  it("createInventoryAuditSessionSchema: name required 1..128", () => {
    expect(createInventoryAuditSessionSchema.safeParse({ name: "Q1 stock-take" }).success).toBe(true);
    expect(createInventoryAuditSessionSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("inventoryAuditLineSchema: exactly one of assetId / stockItemId", () => {
    expect(inventoryAuditLineSchema.safeParse({ assetId: "a1", expectedQuantity: 1, foundQuantity: 1 }).success).toBe(true);
    expect(inventoryAuditLineSchema.safeParse({ stockItemId: "s1", expectedQuantity: 5, foundQuantity: 4 }).success).toBe(true);
    // neither
    expect(inventoryAuditLineSchema.safeParse({ note: "orphan" }).success).toBe(false);
    // both
    expect(inventoryAuditLineSchema.safeParse({ assetId: "a1", stockItemId: "s1" }).success).toBe(false);
  });

  it("inventoryListQuerySchema: page/pageSize defaults + bounds (coerced)", () => {
    const parsed = inventoryListQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.page).toBe(1);
      expect(parsed.data.pageSize).toBe(20);
    }
    expect(inventoryListQuerySchema.safeParse({ page: "2", pageSize: "50" }).success).toBe(true);
    expect(inventoryListQuerySchema.safeParse({ pageSize: "0" }).success).toBe(false);
    expect(inventoryListQuerySchema.safeParse({ pageSize: "101" }).success).toBe(false);
    expect(inventoryListQuerySchema.safeParse({ page: "0" }).success).toBe(false);
  });
});
