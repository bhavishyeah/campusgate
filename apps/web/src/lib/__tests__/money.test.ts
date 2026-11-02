import { describe, it, expect } from "vitest";
import { formatPaise, rupeesToPaiseString } from "@/lib/money";

describe("formatPaise", () => {
  it("formats zero", () => {
    expect(formatPaise("0")).toBe("₹0.00");
  });

  it("formats a single paise", () => {
    expect(formatPaise("1")).toBe("₹0.01");
  });

  it("formats one rupee", () => {
    expect(formatPaise("100")).toBe("₹1.00");
  });

  it("formats with Indian digit grouping", () => {
    expect(formatPaise("123456789")).toBe("₹12,34,567.89");
  });

  it("formats a negative paise string", () => {
    expect(formatPaise("-100")).toBe("-₹1.00");
  });

  it("tolerates leading-zero input", () => {
    expect(formatPaise("000100")).toBe("₹1.00");
  });

  it("does not lose precision near Number.MAX_SAFE_INTEGER", () => {
    // 9007199254740993 paise = 90071992547409.93 rupees. If this ran through a
    // JS float it would collapse to ...992 and the trailing paise would be wrong.
    const paise = "9007199254740993";
    expect(formatPaise(paise)).toBe("₹9,00,71,99,25,47,409.93");
  });
});

describe("rupeesToPaiseString", () => {
  it("converts a whole-rupee string", () => {
    expect(rupeesToPaiseString("1234")).toBe("123400");
  });

  it("strips grouping commas and keeps two decimals", () => {
    expect(rupeesToPaiseString("1,234.50")).toBe("123450");
  });

  it("converts a sub-rupee amount", () => {
    expect(rupeesToPaiseString("0.99")).toBe("99");
  });

  it("rejects zero", () => {
    expect(() => rupeesToPaiseString("0")).toThrow();
  });

  it("rejects empty input", () => {
    expect(() => rupeesToPaiseString("")).toThrow();
  });

  it("rejects more than two decimal places", () => {
    expect(() => rupeesToPaiseString("1.234")).toThrow();
  });

  it("rejects non-numeric input", () => {
    expect(() => rupeesToPaiseString("abc")).toThrow();
  });

  it("round-trips a large value without precision loss", () => {
    const rupees = "90071992547409.93";
    expect(rupeesToPaiseString(rupees)).toBe("9007199254740993");
  });
});
