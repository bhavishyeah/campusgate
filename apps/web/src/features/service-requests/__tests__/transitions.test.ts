import { describe, it, expect } from "vitest";
import { STATUS_TRANSITIONS, staffActions, selfActions } from "../transitions";
import type { RequestStatus } from "../types";

describe("service-requests transitions", () => {
  it("STATUS_TRANSITIONS equals the documented object exactly", () => {
    expect(STATUS_TRANSITIONS).toEqual({
      OPEN: ["ASSIGNED", "CANCELLED"],
      ASSIGNED: ["IN_PROGRESS", "ASSIGNED", "CANCELLED"],
      IN_PROGRESS: ["PENDING_APPROVAL", "RESOLVED", "CANCELLED"],
      PENDING_APPROVAL: ["RESOLVED", "REJECTED"],
      RESOLVED: ["CLOSED"],
      CLOSED: [],
      REJECTED: [],
      CANCELLED: [],
    });
  });
  it("all 8 statuses are keys", () => {
    expect(Object.keys(STATUS_TRANSITIONS).sort()).toEqual(
      ["ASSIGNED", "CANCELLED", "CLOSED", "IN_PROGRESS", "OPEN", "PENDING_APPROVAL", "REJECTED", "RESOLVED"].sort(),
    );
  });

  it("assign only for OPEN", () => {
    expect(staffActions("OPEN", false)).toContain("ASSIGN");
    expect(staffActions("ASSIGNED", false)).not.toContain("ASSIGN");
  });
  it("reassign + in-progress + cancel for ASSIGNED", () => {
    expect(staffActions("ASSIGNED", false)).toEqual(["REASSIGN", "IN_PROGRESS", "CANCEL"]);
  });
  it("resolve only for IN_PROGRESS + non-approval; send-for-approval only when requiresApproval", () => {
    expect(staffActions("IN_PROGRESS", false)).toEqual(["RESOLVE", "CANCEL"]);
    expect(staffActions("IN_PROGRESS", true)).toEqual(["SEND_FOR_APPROVAL", "CANCEL"]);
    expect(staffActions("IN_PROGRESS", false)).not.toContain("SEND_FOR_APPROVAL");
  });
  it("approve/reject only for PENDING_APPROVAL", () => {
    expect(staffActions("PENDING_APPROVAL", true)).toEqual(["APPROVE", "REJECT"]);
  });
  it("close only for RESOLVED", () => {
    expect(staffActions("RESOLVED", false)).toEqual(["CLOSE"]);
  });
  it("cancel only for OPEN/ASSIGNED/IN_PROGRESS (staff)", () => {
    for (const s of ["OPEN", "ASSIGNED", "IN_PROGRESS"] as RequestStatus[]) {
      expect(staffActions(s, false)).toContain("CANCEL");
    }
    for (const s of ["PENDING_APPROVAL", "RESOLVED", "CLOSED", "REJECTED", "CANCELLED"] as RequestStatus[]) {
      expect(staffActions(s, false)).not.toContain("CANCEL");
    }
  });
  it("terminal statuses yield no staff action", () => {
    for (const s of ["CLOSED", "REJECTED", "CANCELLED"] as RequestStatus[]) {
      expect(staffActions(s, false)).toEqual([]);
    }
  });

  it("self: cancel only OPEN, close only RESOLVED, feedback only RESOLVED/CLOSED", () => {
    expect(selfActions("OPEN")).toEqual(["COMMENT", "CANCEL"]);
    expect(selfActions("RESOLVED")).toEqual(["COMMENT", "CLOSE", "FEEDBACK"]);
    expect(selfActions("CLOSED")).toEqual(["FEEDBACK"]);
    expect(selfActions("ASSIGNED")).toEqual(["COMMENT"]);
  });
  it("self: comment allowed on any non-closed own request", () => {
    for (const s of ["OPEN", "ASSIGNED", "IN_PROGRESS", "PENDING_APPROVAL", "RESOLVED"] as RequestStatus[]) {
      expect(selfActions(s)).toContain("COMMENT");
    }
    expect(selfActions("CLOSED")).not.toContain("COMMENT");
  });
});
