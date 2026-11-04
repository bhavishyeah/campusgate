import { describe, it, expect } from "vitest";
import {
  CONTRACT_TRANSITIONS,
  LEAVE_TRANSITIONS,
  contractActions,
  employeeStatusOptions,
  selfLeaveActions,
  staffLeaveActions,
} from "../transitions";

describe("transition tables", () => {
  it("leave table matches the server", () => {
    expect(LEAVE_TRANSITIONS).toEqual({
      REQUESTED: ["APPROVED", "REJECTED", "CANCELLED"],
      APPROVED: [],
      REJECTED: [],
      CANCELLED: [],
    });
  });
  it("contract table matches the server", () => {
    expect(CONTRACT_TRANSITIONS).toEqual({ ACTIVE: ["SUPERSEDED", "ENDED"], SUPERSEDED: [], ENDED: [] });
  });
});

describe("action helpers", () => {
  it("staff leave actions: approve/reject only for REQUESTED, never cancel", () => {
    expect(staffLeaveActions("REQUESTED")).toEqual(["APPROVED", "REJECTED"]);
    for (const s of ["APPROVED", "REJECTED", "CANCELLED"] as const) expect(staffLeaveActions(s)).toEqual([]);
  });
  it("self leave actions: cancel only for REQUESTED", () => {
    expect(selfLeaveActions("REQUESTED")).toEqual(["CANCELLED"]);
    for (const s of ["APPROVED", "REJECTED", "CANCELLED"] as const) expect(selfLeaveActions(s)).toEqual([]);
  });
  it("contract actions only for ACTIVE", () => {
    expect(contractActions("ACTIVE")).toEqual(["SUPERSEDED", "ENDED"]);
    expect(contractActions("SUPERSEDED")).toEqual([]);
    expect(contractActions("ENDED")).toEqual([]);
  });
  it("employee status options are all three", () => {
    expect(employeeStatusOptions()).toEqual(["ACTIVE", "INACTIVE", "TERMINATED"]);
  });
});
