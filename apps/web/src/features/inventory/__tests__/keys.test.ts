import { describe, it, expect } from "vitest";
import { inventoryKeys } from "../keys";

describe("inventoryKeys", () => {
  it("categories key includes kind + page", () => {
    expect(inventoryKeys.categories({ kind: "CONSUMABLE", page: 2 })).toEqual([
      "inventory",
      "categories",
      "list",
      { kind: "CONSUMABLE", page: 2 },
    ]);
  });
  it("assets key includes every filter", () => {
    expect(inventoryKeys.assets({ status: "IN_STORE", categoryId: "c1", page: 3 })).toEqual([
      "inventory",
      "assets",
      "list",
      { status: "IN_STORE", categoryId: "c1", page: 3 },
    ]);
  });
  it("maintenance key includes status + assetId + page", () => {
    expect(inventoryKeys.maintenance({ status: "OPEN", assetId: "a1", page: 1 })).toEqual([
      "inventory",
      "maintenance",
      { status: "OPEN", assetId: "a1", page: 1 },
    ]);
  });
  it("detail + lookup keys include their id/q", () => {
    expect(inventoryKeys.asset("a1")).toEqual(["inventory", "assets", "detail", "a1"]);
    expect(inventoryKeys.stockItem("a1")).toEqual(["inventory", "stock", "detail", "a1"]);
    expect(inventoryKeys.userLookup("ab")).toEqual(["inventory", "user-lookup", "ab"]);
  });
  it("prefix keys are stable", () => {
    expect(inventoryKeys.assetsAll()).toEqual(["inventory", "assets"]);
    expect(inventoryKeys.reportsAll()).toEqual(["inventory", "reports"]);
    expect(inventoryKeys.meAssets()).toEqual(["inventory", "me", "assets"]);
  });
});
