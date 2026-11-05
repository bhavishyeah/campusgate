import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api";
import { isMfaEnrollmentRequired, isStepUpRequired } from "../errors";

describe("isMfaEnrollmentRequired", () => {
  it("is true only for 403 + exact 'MFA enrollment required'", () => {
    expect(
      isMfaEnrollmentRequired(new ApiError(403, { error: "MFA enrollment required" })),
    ).toBe(true);
  });

  it("is false for a different 403 error string", () => {
    expect(
      isMfaEnrollmentRequired(new ApiError(403, { error: "Forbidden: insufficient role" })),
    ).toBe(false);
    expect(
      isMfaEnrollmentRequired(new ApiError(403, { error: "mfa enrollment required" })),
    ).toBe(false);
  });

  it("is false for the right string at the wrong status", () => {
    expect(
      isMfaEnrollmentRequired(new ApiError(401, { error: "MFA enrollment required" })),
    ).toBe(false);
  });

  it("is false for a non-ApiError", () => {
    expect(isMfaEnrollmentRequired(new Error("MFA enrollment required"))).toBe(false);
    expect(isMfaEnrollmentRequired(null)).toBe(false);
    expect(isMfaEnrollmentRequired({ status: 403, data: { error: "MFA enrollment required" } })).toBe(
      false,
    );
  });
});

describe("isStepUpRequired", () => {
  it("is true only for 401 + exact 'Step-up required'", () => {
    expect(isStepUpRequired(new ApiError(401, { error: "Step-up required" }))).toBe(true);
  });

  it("is false for a different 401 error string", () => {
    expect(isStepUpRequired(new ApiError(401, { error: "Unauthorized" }))).toBe(false);
    expect(isStepUpRequired(new ApiError(401, { error: "step-up required" }))).toBe(false);
  });

  it("is false for the right string at the wrong status", () => {
    expect(isStepUpRequired(new ApiError(403, { error: "Step-up required" }))).toBe(false);
  });

  it("is false for a non-ApiError", () => {
    expect(isStepUpRequired(new Error("Step-up required"))).toBe(false);
    expect(isStepUpRequired(undefined)).toBe(false);
  });
});
