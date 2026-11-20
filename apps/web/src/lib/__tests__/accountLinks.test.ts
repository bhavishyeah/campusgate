import { describe, it, expect } from "vitest";
import { parseTokenFromHash, passwordByteLength, validateNewPassword } from "@/lib/accountLinks";

const TOKEN = "A".repeat(43);

describe("parseTokenFromHash", () => {
  it("reads a 43-char base64url token", () => {
    expect(parseTokenFromHash(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(parseTokenFromHash(`token=${TOKEN}`)).toBe(TOKEN);
    expect(parseTokenFromHash(`#x=1&token=${TOKEN}`)).toBe(TOKEN);
  });

  it("returns null for missing, short or malformed tokens", () => {
    expect(parseTokenFromHash("")).toBeNull();
    expect(parseTokenFromHash("#")).toBeNull();
    expect(parseTokenFromHash("#token=")).toBeNull();
    expect(parseTokenFromHash("#token=abc")).toBeNull();
    expect(parseTokenFromHash(`#token=${TOKEN}!`)).toBeNull();
    expect(parseTokenFromHash(`#other=${TOKEN}`)).toBeNull();
  });
});

describe("validateNewPassword", () => {
  it("requires 8 characters and a matching confirmation", () => {
    expect(validateNewPassword("short", "short")).toMatch(/at least 8/);
    expect(validateNewPassword("longenough", "different1")).toMatch(/do not match/);
    expect(validateNewPassword("longenough", "longenough")).toBeNull();
  });

  it("limits the password to 72 bytes, not characters", () => {
    const ascii72 = "a".repeat(72);
    expect(validateNewPassword(ascii72, ascii72)).toBeNull();
    expect(validateNewPassword("a".repeat(73), "a".repeat(73))).toMatch(/72 bytes/);
    const twoByte40 = "\u00e9".repeat(40);
    expect(passwordByteLength(twoByte40)).toBe(80);
    expect(validateNewPassword(twoByte40, twoByte40)).toMatch(/72 bytes/);
  });
});
