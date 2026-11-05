import { describe, it, expect } from "vitest";
import { formatDate } from "../format";

describe("academics format", () => {
  it("formats a UTC-midnight ISO timestamp as a human date without shifting the day", () => {
    const out = formatDate("2026-07-01T00:00:00.000Z");
    expect(out).toContain("2026");
    expect(out).toContain("Jul");
    expect(out).toContain("01");
    // the raw ISO string must never leak through
    expect(out).not.toContain("T00:00:00");
  });

  it("renders a dash for null/empty/invalid dates", () => {
    expect(formatDate(null)).toBe("-");
    expect(formatDate(undefined)).toBe("-");
    expect(formatDate("")).toBe("-");
    expect(formatDate("not a date")).toBe("-");
  });
});
