import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api";
import { describeWorkloadExceeded, isModuleInactiveError } from "../errors";

describe("describeWorkloadExceeded", () => {
  it("formats numeric extras", () => {
    expect(describeWorkloadExceeded({ error: "workload exceeds policy max", maxWeeklyHours: 40, totalHours: 52 })).toBe(
      "Total 52 h exceeds the policy maximum of 40 h.",
    );
  });
  it("returns null when extras are missing or not numbers", () => {
    expect(describeWorkloadExceeded({ error: "x" })).toBeNull();
    expect(describeWorkloadExceeded({ maxWeeklyHours: "40", totalHours: 52 })).toBeNull();
    expect(describeWorkloadExceeded(null)).toBeNull();
    expect(describeWorkloadExceeded(undefined)).toBeNull();
  });
});

describe("isModuleInactiveError", () => {
  it("detects the module-not-active 403 only", () => {
    expect(isModuleInactiveError(new ApiError(403, { error: "Module not active: hr_management" }))).toBe(true);
    expect(isModuleInactiveError(new ApiError(403, { error: "Forbidden" }))).toBe(false);
    expect(isModuleInactiveError(new ApiError(404, { error: "Module not active" }))).toBe(false);
    expect(isModuleInactiveError(new Error("x"))).toBe(false);
  });
});
