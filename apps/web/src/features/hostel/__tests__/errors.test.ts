import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { isNoStudentProfile } from "../errors";

describe("isNoStudentProfile", () => {
  it("matches 404 with the exact string only", () => {
    expect(isNoStudentProfile(new ApiError(404, { error: "no student profile" }))).toBe(true);
    expect(isNoStudentProfile(new ApiError(404, { error: "room not found" }))).toBe(false);
    expect(isNoStudentProfile(new ApiError(403, { error: "no student profile" }))).toBe(false);
    expect(isNoStudentProfile(new Error("no student profile"))).toBe(false);
  });
});
