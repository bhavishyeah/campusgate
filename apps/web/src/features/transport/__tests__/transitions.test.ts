import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_TRANSITIONS,
  ENROLLMENT_TRANSITIONS,
  MAINTENANCE_TRANSITIONS,
  assignmentActions,
  enrollmentActions,
  maintenanceActions,
} from "../transitions";

describe("transport transition tables mirror the server", () => {
  it("enrollment", () => {
    expect(ENROLLMENT_TRANSITIONS).toEqual({ ACTIVE: ["SUSPENDED", "ENDED"], SUSPENDED: ["ENDED"], ENDED: [] });
  });
  it("assignment", () => {
    expect(ASSIGNMENT_TRANSITIONS).toEqual({ ACTIVE: ["ENDED"], ENDED: [] });
  });
  it("maintenance", () => {
    expect(MAINTENANCE_TRANSITIONS).toEqual({
      OPEN: ["IN_PROGRESS", "CANCELLED"],
      IN_PROGRESS: ["RESOLVED", "CANCELLED"],
      RESOLVED: [],
      CANCELLED: [],
    });
  });
});

describe("transport actions", () => {
  it("enrollment has no resume", () => {
    expect(enrollmentActions("ACTIVE")).toEqual(["suspend", "end"]);
    expect(enrollmentActions("SUSPENDED")).toEqual(["end"]);
    expect(enrollmentActions("ENDED")).toEqual([]);
  });
  it("assignment", () => {
    expect(assignmentActions("ACTIVE")).toEqual(["end"]);
    expect(assignmentActions("ENDED")).toEqual([]);
  });
  it("maintenance never offers OPEN", () => {
    for (const s of ["OPEN", "IN_PROGRESS", "RESOLVED", "CANCELLED"] as const) {
      expect(maintenanceActions(s) as string[]).not.toContain("OPEN");
    }
    expect(maintenanceActions("OPEN")).toEqual(["IN_PROGRESS", "CANCELLED"]);
    expect(maintenanceActions("IN_PROGRESS")).toEqual(["RESOLVED", "CANCELLED"]);
    expect(maintenanceActions("RESOLVED")).toEqual([]);
  });
  it("every action target is a member of its table row", () => {
    for (const s of ["OPEN", "IN_PROGRESS"] as const) {
      for (const t of maintenanceActions(s)) expect(MAINTENANCE_TRANSITIONS[s] as readonly string[]).toContain(t);
    }
  });
});
