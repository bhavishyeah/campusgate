import { describe, it, expect } from "vitest";
import {
  typeLabel,
  slaLabel,
  priorityRank,
  overdueBadge,
  volumeJoin,
  fieldDefSort,
  groupActiveTypes,
  resolvePreselectType,
} from "../format";
import type { ActiveType, FieldDef } from "../types";

function activeType(p: Partial<ActiveType>): ActiveType {
  return { id: "t1", name: "Wifi", category: "IT", description: null, requiresApproval: false, slaTargetHours: 24, hasFields: false, ...p };
}

describe("service-requests format", () => {
  it("typeLabel / slaLabel", () => {
    expect(typeLabel({ category: "IT", name: "Wifi" })).toBe("IT · Wifi");
    expect(slaLabel({ slaTargetHours: 48 })).toBe("48h SLA");
  });
  it("priorityRank orders", () => {
    expect(priorityRank("LOW")).toBeLessThan(priorityRank("URGENT"));
  });
  it("overdueBadge reads the flag, never computes", () => {
    expect(overdueBadge({ isOverdue: true })).toBe("Overdue");
    expect(overdueBadge({ isOverdue: false })).toBeNull();
  });
  it("volumeJoin maps type names and flags orphans", () => {
    const rows = volumeJoin([{ requestTypeId: "t1", count: 3 }, { requestTypeId: "x", count: 1 }], [{ id: "t1", name: "Wifi" }]);
    expect(rows[0]).toEqual({ requestTypeId: "t1", name: "Wifi", count: 3 });
    expect(rows[1].name).toBe("Unknown type");
  });
  it("fieldDefSort sorts by sortOrder", () => {
    const fields: FieldDef[] = [
      { id: "b", fieldKey: "b", label: "B", dataType: "TEXT", required: false, options: null, sortOrder: 2 },
      { id: "a", fieldKey: "a", label: "A", dataType: "TEXT", required: false, options: null, sortOrder: 1 },
    ];
    expect(fieldDefSort(fields).map((f) => f.id)).toEqual(["a", "b"]);
  });
  it("groupActiveTypes groups by category keeping server order", () => {
    const groups = groupActiveTypes([
      activeType({ id: "1", category: "IT", name: "Wifi" }),
      activeType({ id: "2", category: "Facilities", name: "AC" }),
      activeType({ id: "3", category: "IT", name: "Email" }),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["IT", "Facilities"]);
    expect(groups[0].types.map((t) => t.id)).toEqual(["1", "3"]);
  });
  it("resolvePreselectType returns id when found, '' otherwise", () => {
    const types = [activeType({ id: "1" })];
    expect(resolvePreselectType("1", types)).toBe("1");
    expect(resolvePreselectType("x", types)).toBe("");
    expect(resolvePreselectType(undefined, types)).toBe("");
  });
});
