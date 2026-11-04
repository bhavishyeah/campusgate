import { describe, expect, it } from "vitest";
import {
  ALLOCATION_TRANSITIONS,
  HOSTEL_LEAVE_TRANSITIONS,
  MAINTENANCE_TRANSITIONS,
  allocationActions,
  maintenanceActions,
  selfLeaveActions,
  staffLeaveActions,
} from "../transitions";

describe("hostel transition tables mirror the server", () => {
  it("allocation", () => {
    expect(ALLOCATION_TRANSITIONS).toEqual({ ACTIVE: ["VACATED", "TRANSFERRED"], VACATED: [], TRANSFERRED: [] });
  });
  it("leave", () => {
    expect(HOSTEL_LEAVE_TRANSITIONS).toEqual({
      REQUESTED: ["APPROVED", "REJECTED", "CANCELLED"],
      APPROVED: [],
      REJECTED: [],
      CANCELLED: [],
    });
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

describe("hostel actions", () => {
  it("allocation actions only for ACTIVE", () => {
    expect(allocationActions("ACTIVE")).toEqual(["TRANSFER", "VACATE", "CHECK"]);
    expect(allocationActions("VACATED")).toEqual([]);
    expect(allocationActions("TRANSFERRED")).toEqual([]);
  });
  it("staff leave actions never include CANCELLED and are empty unless REQUESTED", () => {
    expect(staffLeaveActions("REQUESTED")).toEqual(["APPROVED", "REJECTED"]);
    for (const s of ["APPROVED", "REJECTED", "CANCELLED"] as const) expect(staffLeaveActions(s)).toEqual([]);
  });
  it("self leave actions only for REQUESTED", () => {
    expect(selfLeaveActions("REQUESTED")).toEqual(["CANCELLED"]);
    for (const s of ["APPROVED", "REJECTED", "CANCELLED"] as const) expect(selfLeaveActions(s)).toEqual([]);
  });
  it("maintenance actions never contain OPEN and terminal states are empty", () => {
    expect(maintenanceActions("OPEN")).toEqual(["IN_PROGRESS", "CANCELLED"]);
    expect(maintenanceActions("IN_PROGRESS")).toEqual(["RESOLVED", "CANCELLED"]);
    expect(maintenanceActions("RESOLVED")).toEqual([]);
    expect(maintenanceActions("CANCELLED")).toEqual([]);
    for (const s of ["OPEN", "IN_PROGRESS", "RESOLVED", "CANCELLED"] as const) {
      expect(maintenanceActions(s) as string[]).not.toContain("OPEN");
    }
  });
});
