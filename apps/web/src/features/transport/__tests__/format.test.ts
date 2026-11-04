import { describe, expect, it } from "vitest";
import { dayLabel, pickupOffsetLabel, scheduleTimes, scheduleWhen, stopLabel, utilizationLabel } from "../format";

describe("transport format", () => {
  it("dayLabel", () => {
    expect(dayLabel("MON")).toBe("Mon");
    expect(dayLabel("SUN")).toBe("Sun");
  });
  it("scheduleWhen", () => {
    expect(scheduleWhen({ dayOfWeek: "MON", date: null })).toBe("Every Mon");
    expect(scheduleWhen({ dayOfWeek: null, date: "2026-03-05T00:00:00.000Z" })).toBe("05 Mar 2026");
  });
  it("scheduleTimes", () => {
    expect(scheduleTimes({ departureTime: 480, arrivalTime: 555 })).toBe("08:00 - 09:15");
    expect(scheduleTimes({ departureTime: 480, arrivalTime: null })).toBe("08:00");
    expect(scheduleTimes({ departureTime: 0, arrivalTime: null })).toBe("00:00");
  });
  it("pickupOffsetLabel", () => {
    expect(pickupOffsetLabel(5)).toBe("+5 min");
    expect(pickupOffsetLabel(0)).toBe("+0 min");
    expect(pickupOffsetLabel(null)).toBe("-");
  });
  it("utilizationLabel", () => {
    expect(utilizationLabel({ capacity: null, enrolled: 0, utilization: null })).toBe("No active vehicle");
    expect(utilizationLabel({ capacity: 40, enrolled: 30, utilization: 0.75 })).toBe("30 of 40 (75%)");
    expect(utilizationLabel({ capacity: 40, enrolled: 40, utilization: 1 })).toBe("40 of 40 (100%)");
  });
  it("stopLabel", () => {
    expect(stopLabel({ sequence: 2, name: "Main Gate" })).toBe("2. Main Gate");
  });
});
