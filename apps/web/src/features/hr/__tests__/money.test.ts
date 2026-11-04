import { describe, it, expect } from "vitest";
import { formatSalary, paiseToRupeeInput, parseSalaryRupees } from "../money";

describe("parseSalaryRupees", () => {
  it("converts rupees to paise without float math", () => {
    expect(parseSalaryRupees("0")).toBe(0);
    expect(parseSalaryRupees("1234.5")).toBe(123450);
    expect(parseSalaryRupees("1,234.56")).toBe(123456);
    expect(parseSalaryRupees("0.07")).toBe(7);
  });
  it("rejects invalid input", () => {
    expect(parseSalaryRupees("12.345")).toBeNull();
    expect(parseSalaryRupees("abc")).toBeNull();
    expect(parseSalaryRupees("-5")).toBeNull();
    expect(parseSalaryRupees("")).toBeNull();
  });
  it("rejects values beyond the safe integer range", () => {
    expect(parseSalaryRupees("99999999999999999")).toBeNull();
  });
});

describe("salary display", () => {
  it("paiseToRupeeInput", () => {
    expect(paiseToRupeeInput("123450")).toBe("1234.50");
    expect(paiseToRupeeInput("7")).toBe("0.07");
    expect(paiseToRupeeInput("0")).toBe("0.00");
  });
  it("formatSalary", () => {
    expect(formatSalary(null)).toBe("-");
    expect(formatSalary("123450")).toContain("1,234.50");
  });
});
