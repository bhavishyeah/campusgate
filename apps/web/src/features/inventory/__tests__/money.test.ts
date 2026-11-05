import { describe, it, expect } from "vitest";
import { formatMinor, paiseToRupeeInput, rupeesToMinorString, minorUnitString, currencyString } from "../money";
import { digitString } from "@/lib/formFields";

describe("inventory money", () => {
  it("formatMinor(null) -> '-'", () => {
    expect(formatMinor(null)).toBe("-");
    expect(formatMinor(undefined)).toBe("-");
  });
  it("formatMinor formats paise", () => {
    expect(formatMinor("123456")).toBe("₹1,234.56");
  });
  it("rupeesToMinorString converts grouped rupees", () => {
    expect(rupeesToMinorString("1,234.56")).toBe("123456");
  });
  it("rupeesToMinorString rejects invalid / zero", () => {
    expect(() => rupeesToMinorString("1.234")).toThrow();
    expect(() => rupeesToMinorString("0")).toThrow();
    expect(() => rupeesToMinorString("")).toThrow();
  });
  it("paiseToRupeeInput('0') -> ''", () => {
    expect(paiseToRupeeInput("0")).toBe("");
    expect(paiseToRupeeInput("123456")).toBe("1234.56");
  });
  it("minorUnitString message matches server string", () => {
    const r = minorUnitString().safeParse("1.5");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("must be a non-negative integer number of minor units");
  });
  it("currencyString message", () => {
    const r = currencyString().safeParse("usd");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("must be a 3-letter uppercase currency code");
  });
  it("minorUnitString message is DISTINCT from digitString (must stay a local leaf)", () => {
    const mine = minorUnitString().safeParse("x");
    const paise = digitString().safeParse("x");
    expect(mine.success).toBe(false);
    expect(paise.success).toBe(false);
    if (!mine.success && !paise.success) {
      expect(mine.error.issues[0].message).toBe("must be a non-negative integer number of minor units");
      expect(paise.error.issues[0].message).toBe("must be a non-negative integer number of paise");
      expect(mine.error.issues[0].message).not.toBe(paise.error.issues[0].message);
    }
  });
});
