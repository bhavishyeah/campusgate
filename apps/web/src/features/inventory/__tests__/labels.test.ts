import { describe, it, expect } from "vitest";
import {
  assetStatusLabel,
  assetKindLabel,
  maintenanceStatusLabel,
  stockKindLabel,
  disposalMethodLabel,
  STATUS_LABELS,
  toOptions,
} from "../labels";

const BANNED = ["Delete", "Reopen", "Resume"];

describe("inventory labels", () => {
  it("every asset status has a label", () => {
    for (const s of ["IN_STORE", "ASSIGNED", "IN_MAINTENANCE", "RETIRED", "DISPOSED"]) {
      expect(assetStatusLabel[s]).toBeTruthy();
    }
  });
  it("every asset kind, maintenance, stock kind, disposal method has a label", () => {
    for (const s of ["FIXED_ASSET", "CONSUMABLE"]) expect(assetKindLabel[s]).toBeTruthy();
    for (const s of ["OPEN", "IN_PROGRESS", "RESOLVED", "CANCELLED"]) expect(maintenanceStatusLabel[s]).toBeTruthy();
    for (const s of ["RECEIPT", "ISSUE", "ADJUSTMENT"]) expect(stockKindLabel[s]).toBeTruthy();
    for (const s of ["SOLD", "SCRAPPED", "DONATED", "LOST", "WRITTEN_OFF", "OTHER"]) {
      expect(disposalMethodLabel[s]).toBeTruthy();
    }
  });
  it("no label contains a banned word", () => {
    const all = [
      ...Object.values(assetStatusLabel),
      ...Object.values(assetKindLabel),
      ...Object.values(maintenanceStatusLabel),
      ...Object.values(stockKindLabel),
      ...Object.values(disposalMethodLabel),
    ];
    for (const label of all) for (const w of BANNED) expect(label).not.toContain(w);
  });
  it("STATUS_LABELS covers every status kind", () => {
    expect(STATUS_LABELS.asset).toBe(assetStatusLabel);
    expect(STATUS_LABELS.maintenance).toBe(maintenanceStatusLabel);
    expect(STATUS_LABELS.stock).toBe(stockKindLabel);
  });
  it("toOptions maps entries", () => {
    expect(toOptions({ A: "a" })).toEqual([{ value: "A", label: "a" }]);
  });
});
