import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api";
import { isFrozenFields, fieldValueErrors } from "../errors";

describe("service-requests errors", () => {
  it("isFrozenFields matches the exact 409", () => {
    expect(isFrozenFields(new ApiError(409, { error: "field definitions are frozen once the type has requests" }))).toBe(true);
    expect(isFrozenFields(new ApiError(409, { error: "field key already exists for this type" }))).toBe(false);
    expect(isFrozenFields(new Error("x"))).toBe(false);
  });
  it("fieldValueErrors extracts the 422 map", () => {
    const err = new ApiError(422, { errors: { email: "required", age: "invalid_type" } });
    expect(fieldValueErrors(err)).toEqual({ email: "required", age: "invalid_type" });
  });
  it("fieldValueErrors returns null for non-422 / missing map", () => {
    expect(fieldValueErrors(new ApiError(409, { error: "x" }))).toBeNull();
    expect(fieldValueErrors(new ApiError(422, { error: "x" }))).toBeNull();
    expect(fieldValueErrors(new Error("x"))).toBeNull();
  });
});
