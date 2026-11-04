import { describe, it, expect } from "vitest";
import {
  LEAVE_TYPES,
  accrualRuleLabel,
  attendanceStatusLabel,
  contractStatusLabel,
  displayName,
  employeeStatusLabel,
  leaveStatusLabel,
  leaveTypeLabel,
  toOptions,
} from "../labels";

describe("hr labels", () => {
  it("leave status labels mirror the enum", () => {
    expect(leaveStatusLabel).toEqual({
      REQUESTED: "Requested",
      APPROVED: "Approved",
      REJECTED: "Rejected",
      CANCELLED: "Cancelled",
    });
  });
  it("covers every enum value", () => {
    expect(Object.keys(contractStatusLabel)).toEqual(["ACTIVE", "SUPERSEDED", "ENDED"]);
    expect(Object.keys(employeeStatusLabel)).toEqual(["ACTIVE", "INACTIVE", "TERMINATED"]);
    expect(Object.keys(attendanceStatusLabel)).toEqual(["PRESENT", "ABSENT", "ON_LEAVE", "HALF_DAY"]);
    expect(Object.keys(accrualRuleLabel)).toEqual(["ANNUAL_LUMP_SUM", "MONTHLY_ACCRUAL"]);
    expect(Object.keys(leaveTypeLabel)).toEqual([...LEAVE_TYPES]);
  });
  it("toOptions keeps order", () => {
    expect(toOptions({ A: "Alpha", B: "Beta" })).toEqual([
      { value: "A", label: "Alpha" },
      { value: "B", label: "Beta" },
    ]);
  });
  it("displayName falls back to email", () => {
    expect(displayName({ name: "Asha", email: "a@x.edu" })).toBe("Asha");
    expect(displayName({ name: null, email: "a@x.edu" })).toBe("a@x.edu");
    expect(displayName({ name: "  ", email: "a@x.edu" })).toBe("a@x.edu");
  });
});
