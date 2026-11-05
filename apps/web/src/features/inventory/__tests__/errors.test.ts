import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api";
import { isInsufficientStock, isAssetTerminal } from "../errors";

describe("inventory errors", () => {
  it("isInsufficientStock matches the exact 409", () => {
    expect(isInsufficientStock(new ApiError(409, { error: "insufficient stock" }))).toBe(true);
    expect(isInsufficientStock(new ApiError(409, { error: "asset is terminal" }))).toBe(false);
    expect(isInsufficientStock(new ApiError(404, { error: "insufficient stock" }))).toBe(false);
    expect(isInsufficientStock(new Error("x"))).toBe(false);
  });
  it("isAssetTerminal matches the exact 409", () => {
    expect(isAssetTerminal(new ApiError(409, { error: "asset is terminal" }))).toBe(true);
    expect(isAssetTerminal(new ApiError(409, { error: "insufficient stock" }))).toBe(false);
  });
});
