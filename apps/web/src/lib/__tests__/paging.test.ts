import { describe, it, expect } from "vitest";
import { pageCount, readIdParam, resolveKnownId, slicePage } from "../paging";

describe("pageCount", () => {
  it("is at least 1", () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(51, 50)).toBe(2);
  });
});

describe("slicePage", () => {
  const rows = Array.from({ length: 120 }, (_, i) => i);
  it("slices pages", () => {
    expect(slicePage(rows, 1, 50)).toHaveLength(50);
    expect(slicePage(rows, 3, 50)).toEqual(rows.slice(100));
  });
  it("clamps the page", () => {
    expect(slicePage(rows, 99, 50)).toEqual(rows.slice(100));
    expect(slicePage(rows, 0, 50)[0]).toBe(0);
    expect(slicePage([], 1, 50)).toEqual([]);
  });
});

describe("readIdParam", () => {
  it("drops empty, whitespace, null and undefined", () => {
    expect(readIdParam("")).toBeUndefined();
    expect(readIdParam("   ")).toBeUndefined();
    expect(readIdParam(null)).toBeUndefined();
    expect(readIdParam(undefined)).toBeUndefined();
  });
  it("accepts 64 characters and drops 65", () => {
    expect(readIdParam("a".repeat(64))).toBe("a".repeat(64));
    expect(readIdParam("a".repeat(65))).toBeUndefined();
  });
  it("trims", () => {
    expect(readIdParam("  abc ")).toBe("abc");
  });
});

describe("resolveKnownId", () => {
  const options = [{ id: "b1" }, { id: "b2" }];
  it("drops an unknown id once options are loaded", () => {
    expect(resolveKnownId("zzz", options)).toBeUndefined();
  });
  it("keeps a known id", () => {
    expect(resolveKnownId("b2", options)).toBe("b2");
  });
  it("keeps the id while options are not loaded", () => {
    expect(resolveKnownId("zzz", undefined)).toBe("zzz");
  });
  it("returns undefined for no id", () => {
    expect(resolveKnownId(undefined, options)).toBeUndefined();
  });
});
