import { describe, expect, it } from "vitest";
import {
  BAD_STATUSES,
  GOOD_STATUSES,
  MUTED_STATUSES,
  STATUS_LABELS,
  allocationStatusLabel,
  buildingTypeLabel,
  checkEventLabel,
  leaveStatusLabel,
  maintenanceStatusLabel,
  roomStatusLabel,
} from "../labels";

describe("hostel labels", () => {
  it("cover every enum value", () => {
    expect(Object.keys(buildingTypeLabel)).toEqual(["BOYS", "GIRLS", "MIXED", "STAFF"]);
    expect(Object.keys(roomStatusLabel)).toEqual(["AVAILABLE", "FULL", "MAINTENANCE", "CLOSED"]);
    expect(Object.keys(allocationStatusLabel)).toEqual(["ACTIVE", "VACATED", "TRANSFERRED"]);
    expect(Object.keys(leaveStatusLabel)).toEqual(["REQUESTED", "APPROVED", "REJECTED", "CANCELLED"]);
    expect(Object.keys(maintenanceStatusLabel)).toEqual(["OPEN", "IN_PROGRESS", "RESOLVED", "CANCELLED"]);
    expect(Object.keys(checkEventLabel)).toEqual(["CHECK_IN", "CHECK_OUT"]);
  });
  it("never use invented words", () => {
    for (const map of Object.values(STATUS_LABELS)) {
      for (const label of Object.values(map)) {
        expect(label).not.toMatch(/resume|reopen|delete|waitlist/i);
      }
    }
  });
  it("every status has a tone bucket or falls to warning intentionally", () => {
    const toned = new Set([...GOOD_STATUSES, ...BAD_STATUSES, ...MUTED_STATUSES]);
    for (const s of ["ACTIVE", "VACATED", "TRANSFERRED", "APPROVED", "REJECTED", "CANCELLED", "RESOLVED", "AVAILABLE", "FULL", "CLOSED"]) {
      expect(toned.has(s)).toBe(true);
    }
  });
});
