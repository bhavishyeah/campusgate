import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  digitString,
  optInt,
  optNumber,
  optText,
  reqDate,
  reqEnum,
  reqId,
  reqInt,
  reqText,
  reqTime,
} from "../formFields";

function firstMessage(schema: z.ZodTypeAny, input: unknown): string | null {
  const r = schema.safeParse(input);
  return r.success ? null : r.error.issues[0].message;
}

describe("reqText", () => {
  const s = reqText("Name is required", 120);
  it("pins the required message for blank and whitespace-only input", () => {
    expect(firstMessage(s, "")).toBe("Name is required");
    expect(firstMessage(s, "   ")).toBe("Name is required");
  });
  it("accepts the max length and rejects one over", () => {
    expect(s.safeParse("a".repeat(120)).success).toBe(true);
    expect(firstMessage(s, "a".repeat(121))).toBe("String must contain at most 120 character(s)");
  });
  it("trims", () => {
    expect(s.parse("  x  ")).toBe("x");
  });
});

describe("optText", () => {
  const s = optText(32);
  it("maps blank to undefined", () => {
    expect(s.parse("")).toBeUndefined();
    expect(s.parse("  ")).toBeUndefined();
  });
  it("enforces the max", () => {
    expect(s.safeParse("a".repeat(32)).success).toBe(true);
    expect(firstMessage(s, "a".repeat(33))).toBe("String must contain at most 32 character(s)");
  });
});

describe("reqInt", () => {
  const s = reqInt({ min: 1, max: 64 });
  it("pins the blank and zero messages", () => {
    expect(firstMessage(s, "")).toBe("Number must be greater than or equal to 1");
    expect(firstMessage(s, "0")).toBe("Number must be greater than or equal to 1");
  });
  it("pins NaN and float messages", () => {
    expect(firstMessage(s, "abc")).toBe("Expected number, received nan");
    expect(firstMessage(s, "1.5")).toBe("Expected integer, received float");
  });
  it("pins the max overflow", () => {
    expect(s.parse("64")).toBe(64);
    expect(firstMessage(s, "65")).toBe("Number must be less than or equal to 64");
  });
  it("has no upper bound when max is omitted", () => {
    expect(reqInt({ min: 1 }).parse("100000")).toBe(100000);
  });
});

describe("optInt / optNumber", () => {
  it("maps blank to undefined", () => {
    expect(optInt({ min: 0, max: 200 }).parse("")).toBeUndefined();
    expect(optNumber().parse(" ")).toBeUndefined();
  });
  it("validates present values like the server", () => {
    expect(optInt({ min: 0, max: 200 }).parse("0")).toBe(0);
    expect(firstMessage(optInt({ min: 0, max: 200 }), "201")).toBe("Number must be less than or equal to 200");
    expect(firstMessage(optInt({ min: 0 }), "-1")).toBe("Number must be greater than or equal to 0");
    expect(optNumber().parse("12.5")).toBe(12.5);
    expect(firstMessage(optNumber(), "abc")).toBe("Expected number, received nan");
  });
});

describe("reqDate", () => {
  it("blank and invalid give Invalid date", () => {
    expect(firstMessage(reqDate(), "")).toBe("Invalid date");
    expect(firstMessage(reqDate(), "nope")).toBe("Invalid date");
  });
  it("parses a date", () => {
    expect(reqDate().parse("2026-01-02").toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });
});

describe("reqEnum / reqId", () => {
  it("blank gives Required", () => {
    expect(firstMessage(reqEnum(["A", "B"] as const), "")).toBe("Required");
    expect(firstMessage(reqId(), "")).toBe("Required");
  });
  it("unknown enum value gives the zod enum message", () => {
    expect(firstMessage(reqEnum(["A", "B"] as const), "x")).toBe(
      "Invalid enum value. Expected 'A' | 'B', received 'x'",
    );
  });
  it("accepts a member and an id", () => {
    expect(reqEnum(["A", "B"] as const).parse("A")).toBe("A");
    expect(reqId().parse("abc")).toBe("abc");
  });
});

describe("reqTime", () => {
  it("blank and invalid times fail with the nan message, never 00:00", () => {
    expect(firstMessage(reqTime(), "")).toBe("Expected number, received nan");
    expect(firstMessage(reqTime(), "25:00")).toBe("Expected number, received nan");
    expect(firstMessage(reqTime(), "9:00")).toBe("Expected number, received nan");
  });
  it("converts to minutes", () => {
    expect(reqTime().parse("00:00")).toBe(0);
    expect(reqTime().parse("23:59")).toBe(1439);
    expect(reqTime().parse("08:30")).toBe(510);
  });
});

describe("digitString", () => {
  it("pins the paise message", () => {
    expect(firstMessage(digitString(), "1.5")).toBe("must be a non-negative integer number of paise");
    expect(digitString().safeParse("150000").success).toBe(true);
  });
});
