import { describe, it, expect } from "vitest";
import {
  categoryLabel,
  assetLabel,
  custodianLabel,
  onHandLabel,
  discrepancy,
  isTerminalAsset,
  mergeOptionPages,
  filterByText,
} from "../format";
import type { Asset } from "../types";

function asset(p: Partial<Asset>): Asset {
  return {
    id: "a1",
    assetTag: "TAG1",
    name: "Chair",
    categoryId: "c1",
    status: "IN_STORE",
    acquisitionDate: null,
    acquisitionCost: null,
    currency: null,
    location: null,
    custodyUserId: null,
    custodyDepartmentId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...p,
  };
}

describe("inventory format", () => {
  it("categoryLabel / assetLabel", () => {
    expect(categoryLabel({ code: "FUR", name: "Furniture" })).toBe("FUR - Furniture");
    expect(assetLabel({ assetTag: "T1", name: "Chair" })).toBe("T1 - Chair");
  });
  it("custodianLabel without ids", () => {
    expect(custodianLabel({ custodyUserId: "u1", custodyDepartmentId: null })).toBe("Assigned (user)");
    expect(custodianLabel({ custodyUserId: null, custodyDepartmentId: "d1" })).toBe("Assigned (dept)");
    expect(custodianLabel({ custodyUserId: null, custodyDepartmentId: null })).toBe("In store");
  });
  it("onHandLabel with/without reorder", () => {
    expect(onHandLabel({ onHandQuantity: 12, reorderLevel: 5 })).toBe("12 (reorder at 5)");
    expect(onHandLabel({ onHandQuantity: 12, reorderLevel: null })).toBe("12");
  });
  it("discrepancy", () => {
    expect(discrepancy({ expectedQuantity: 10, foundQuantity: 7 })).toBe(-3);
    expect(discrepancy({ expectedQuantity: null, foundQuantity: 7 })).toBeNull();
    expect(discrepancy({ expectedQuantity: 10, foundQuantity: null })).toBeNull();
  });
  it("isTerminalAsset", () => {
    expect(isTerminalAsset("RETIRED")).toBe(true);
    expect(isTerminalAsset("DISPOSED")).toBe(true);
    expect(isTerminalAsset("IN_STORE")).toBe(false);
  });
  it("mergeOptionPages concatenates and dedupes by id", () => {
    const a = asset({ id: "1", assetTag: "A1" });
    const b = asset({ id: "2", assetTag: "B2" });
    const merged = mergeOptionPages([a], [a, b]);
    expect(merged.map((m) => m.id)).toEqual(["1", "2"]);
  });
  it("filterByText substring-filters by tag", () => {
    const a = asset({ id: "1", assetTag: "DESK-9" });
    const b = asset({ id: "2", assetTag: "CHAIR-3" });
    expect(filterByText([a, b], "desk").map((m) => m.id)).toEqual(["1"]);
    expect(filterByText([a, b], "").length).toBe(2);
  });
});
