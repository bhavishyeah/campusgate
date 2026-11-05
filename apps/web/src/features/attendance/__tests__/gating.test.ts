import { describe, it, expect } from "vitest";
import { attendanceSessionsAccess } from "../gating";

describe("attendanceSessionsAccess", () => {
  it("lets attendance.view holders list sessions (query enabled, no guidance state)", () => {
    expect(attendanceSessionsAccess(["attendance.view"])).toEqual({
      canList: true,
      markOnly: false,
    });
    // view takes precedence even when mark is also held
    expect(attendanceSessionsAccess(["attendance.view", "attendance.mark"])).toEqual({
      canList: true,
      markOnly: false,
    });
  });

  it("disables the list query for a mark-only faculty and flags the guidance state", () => {
    // Previously this fired GET /sessions and got a 403 error banner.
    expect(attendanceSessionsAccess(["attendance.mark"])).toEqual({
      canList: false,
      markOnly: true,
    });
  });

  it("neither lists nor shows mark guidance when the user holds neither permission", () => {
    expect(attendanceSessionsAccess([])).toEqual({
      canList: false,
      markOnly: false,
    });
  });
});
