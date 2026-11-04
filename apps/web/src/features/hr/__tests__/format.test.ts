import { describe, it, expect } from "vitest";
import {
  formatDate,
  formatMinute,
  inclusiveDays,
  isoYear,
  minuteFromTime,
  toDateInput,
  todayIsoDate,
} from "../format";

describe("hr format", () => {
  it("toDateInput takes the UTC date part", () => {
    expect(toDateInput("2026-04-01T00:00:00.000Z")).toBe("2026-04-01");
    expect(toDateInput("2026-04-01")).toBe("2026-04-01");
  });
  it("formatDate is UTC-stable and tolerant", () => {
    const out = formatDate("2026-04-01T00:00:00.000Z");
    expect(out).toContain("2026");
    expect(out).toContain("01");
    expect(formatDate(null)).toBe("-");
    expect(formatDate("not a date")).toBe("-");
  });
  it("formatMinute and minuteFromTime round-trip", () => {
    expect(formatMinute(540)).toBe("09:00");
    expect(formatMinute(1439)).toBe("23:59");
    expect(minuteFromTime("09:00")).toBe(540);
    expect(minuteFromTime("23:59")).toBe(1439);
    expect(minuteFromTime("24:00")).toBeNull();
    expect(minuteFromTime("9:00")).toBeNull();
  });
  it("todayIsoDate looks like a date", () => {
    expect(todayIsoDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("isoYear", () => {
    expect(isoYear("2026-12-31")).toBe("2026");
  });
  it("inclusiveDays", () => {
    expect(inclusiveDays("2026-04-01", "2026-04-01")).toBe(1);
    expect(inclusiveDays("2026-04-01", "2026-04-03")).toBe(3);
    expect(inclusiveDays("2026-04-03", "2026-04-01")).toBeNull();
    expect(inclusiveDays("", "2026-04-01")).toBeNull();
  });
});
