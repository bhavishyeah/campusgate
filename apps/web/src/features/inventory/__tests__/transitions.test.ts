import { describe, it, expect } from "vitest";
import { MAINTENANCE_TRANSITIONS, ASSET_ACTIONS, maintenanceActions, assetActions } from "../transitions";

describe("inventory transitions", () => {
  it("MAINTENANCE_TRANSITIONS equals the documented object", () => {
    expect(MAINTENANCE_TRANSITIONS).toEqual({
      OPEN: ["IN_PROGRESS", "CANCELLED"],
      IN_PROGRESS: ["RESOLVED", "CANCELLED"],
      RESOLVED: [],
      CANCELLED: [],
    });
  });
  it("maintenanceActions never contains OPEN", () => {
    for (const s of ["OPEN", "IN_PROGRESS", "RESOLVED", "CANCELLED"] as const) {
      expect(maintenanceActions(s)).not.toContain("OPEN");
    }
  });
  it("maintenanceActions is [] for terminal states", () => {
    expect(maintenanceActions("RESOLVED")).toEqual([]);
    expect(maintenanceActions("CANCELLED")).toEqual([]);
  });
  it("every maintenance action target is a legal status", () => {
    const legal = new Set(["IN_PROGRESS", "RESOLVED", "CANCELLED"]);
    for (const s of ["OPEN", "IN_PROGRESS"] as const) {
      for (const t of maintenanceActions(s)) expect(legal.has(t)).toBe(true);
    }
  });
  it("assetActions is [] for RETIRED/DISPOSED", () => {
    expect(assetActions("RETIRED")).toEqual([]);
    expect(assetActions("DISPOSED")).toEqual([]);
  });
  it("assetActions omits TRANSFER/MAINTENANCE for IN_MAINTENANCE", () => {
    const a = assetActions("IN_MAINTENANCE");
    expect(a).not.toContain("TRANSFER");
    expect(a).not.toContain("MAINTENANCE");
    expect(a).toContain("DISPOSE");
  });
  it("assetActions offers all three for IN_STORE/ASSIGNED", () => {
    expect(assetActions("IN_STORE")).toEqual(["TRANSFER", "MAINTENANCE", "DISPOSE"]);
    expect(assetActions("ASSIGNED")).toEqual(["TRANSFER", "MAINTENANCE", "DISPOSE"]);
  });
  it("ASSET_ACTIONS is exported and stable", () => {
    expect(ASSET_ACTIONS.RETIRED).toEqual([]);
  });
});
