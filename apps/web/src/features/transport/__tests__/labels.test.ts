import { describe, expect, it } from "vitest";
import {
  STATUS_LABELS,
  dayOfWeekLabel,
  driverStatusLabel,
  enrollmentStatusLabel,
  maintenanceStatusLabel,
  routeStatusLabel,
  vehicleStatusLabel,
  vehicleTypeLabel,
} from "../labels";

describe("transport labels", () => {
  it("cover every enum value", () => {
    expect(Object.keys(vehicleTypeLabel)).toEqual(["BUS", "VAN", "CAR", "OTHER"]);
    expect(Object.keys(vehicleStatusLabel)).toEqual(["ACTIVE", "INACTIVE", "MAINTENANCE"]);
    expect(Object.keys(driverStatusLabel)).toEqual(["ACTIVE", "INACTIVE"]);
    expect(Object.keys(routeStatusLabel)).toEqual(["ACTIVE", "INACTIVE"]);
    expect(Object.keys(enrollmentStatusLabel)).toEqual(["ACTIVE", "SUSPENDED", "ENDED"]);
    expect(Object.keys(maintenanceStatusLabel)).toEqual(["OPEN", "IN_PROGRESS", "RESOLVED", "CANCELLED"]);
    expect(Object.keys(dayOfWeekLabel)).toEqual(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);
  });
  it("never use invented words", () => {
    for (const map of Object.values(STATUS_LABELS)) {
      for (const label of Object.values(map)) expect(label).not.toMatch(/resume|reopen|delete|waitlist/i);
    }
  });
});
