import { describe, expect, it } from "vitest";
import { costToPaiseString, formatCost, formatFee, paiseToRupeeInput, rupeesToPaise } from "../money";

describe("transport money", () => {
  it("formatFee", () => {
    expect(formatFee(null)).toBe("No fee");
    expect(formatFee("150000")).toBe("₹1,500.00");
    expect(formatFee("0")).toBe("₹0.00");
  });
  it("costToPaiseString accepts only non-negative integers and digit strings", () => {
    expect(costToPaiseString(12345)).toBe("12345");
    expect(costToPaiseString("12345")).toBe("12345");
    expect(costToPaiseString(0)).toBe("0");
    expect(costToPaiseString(null)).toBeNull();
    expect(costToPaiseString(1.5)).toBeNull();
    expect(costToPaiseString(-1)).toBeNull();
    expect(costToPaiseString("abc")).toBeNull();
  });
  it("formatCost", () => {
    expect(formatCost(12345)).toBe("₹123.45");
    expect(formatCost("12345")).toBe("₹123.45");
    expect(formatCost(null)).toBe("-");
    expect(formatCost(1.5)).toBe("-");
  });
  it("paiseToRupeeInput splits strings", () => {
    expect(paiseToRupeeInput("123450")).toBe("1234.50");
    expect(paiseToRupeeInput("5")).toBe("0.05");
    expect(paiseToRupeeInput("100")).toBe("1.00");
    expect(paiseToRupeeInput("0")).toBe("");
  });
  it("rupeesToPaise", () => {
    expect(rupeesToPaise("1,500.5")).toBe("150050");
    expect(rupeesToPaise("12")).toBe("1200");
    expect(() => rupeesToPaise("0")).toThrow("Amount must be greater than zero.");
    expect(() => rupeesToPaise("1.234")).toThrow("Enter a valid amount (digits with up to two decimals).");
  });
});
