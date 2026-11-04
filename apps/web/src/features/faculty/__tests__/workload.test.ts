import { describe, it, expect } from "vitest";
import { formatHours, utilization, workloadForTerm } from "../workload";
import type { WorkloadRow } from "../types";

function row(over: Partial<WorkloadRow>): WorkloadRow {
  return {
    id: "w1",
    facultyId: "f1",
    academicTermId: "t1",
    academicTerm: { id: "t1", name: "Term 1" },
    teachingHours: 10,
    nonTeachingHours: 5,
    totalHours: 15,
    overAllocated: false,
    overrideReason: null,
    policyMaxWeeklyHours: 40,
    lastReconciledAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("workload helpers", () => {
  it("workloadForTerm finds by term id", () => {
    const rows = [row({ id: "a", academicTermId: "t1" }), row({ id: "b", academicTermId: "t2" })];
    expect(workloadForTerm(rows, "t2")?.id).toBe("b");
    expect(workloadForTerm(rows, "t3")).toBeUndefined();
  });
  it("utilization trusts the server flag and handles a null cap", () => {
    expect(utilization(row({ overAllocated: true, totalHours: 50 }))).toEqual({ total: 50, max: 40, over: true });
    expect(utilization(row({ policyMaxWeeklyHours: null }))).toEqual({ total: 15, max: null, over: false });
  });
  it("formatHours", () => {
    expect(formatHours(12)).toBe("12 h");
  });
});
