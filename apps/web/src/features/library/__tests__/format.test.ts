import { describe, it, expect } from "vitest";
import { formatRupeeDecimal, parseRupeeInput } from "../format";

describe("formatRupeeDecimal", () => {
  it("formats a one-decimal value", () => {
    expect(formatRupeeDecimal("12.5")).toBe("₹12.50");
  });
  it("formats zero", () => {
    expect(formatRupeeDecimal("0")).toBe("₹0.00");
  });
  it("formats a large value with grouping", () => {
    expect(formatRupeeDecimal("1000000.00")).toBe("₹1,000,000.00");
  });
  it("falls back to the raw string for unparsable input", () => {
    expect(formatRupeeDecimal("abc")).toBe("abc");
  });
  it("formats a negative value", () => {
    expect(formatRupeeDecimal("-5")).toBe("-₹5.00");
  });
});

describe("parseRupeeInput", () => {
  it("accepts a valid two-decimal amount", () => {
    expect(parseRupeeInput("12.50")).toBe(12.5);
  });
  it("rejects three decimal places", () => {
    expect(parseRupeeInput("12.505")).toBeNull();
  });
  it("rejects an empty string", () => {
    expect(parseRupeeInput("")).toBeNull();
  });
  it("rejects a negative amount", () => {
    expect(parseRupeeInput("-5")).toBeNull();
  });
});
