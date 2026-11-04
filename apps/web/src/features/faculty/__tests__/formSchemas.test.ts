import { describe, it, expect } from "vitest";
import {
  buildQualificationCreate,
  buildQualificationPatch,
  buildWorkloadPatch,
  qualificationPatchSchema,
  qualificationSchema,
  workloadEditSchema,
  workloadPolicySchema,
} from "../formSchemas";

const base = { title: "MSc", kind: "DEGREE" as const, issuingBody: "", field: "", year: "", documentRef: "" };
const thisYear = new Date().getFullYear();

describe("qualificationSchema", () => {
  it("title limit 200/201", () => {
    expect(qualificationSchema.safeParse({ ...base, title: "a".repeat(200) }).success).toBe(true);
    expect(qualificationSchema.safeParse({ ...base, title: "a".repeat(201) }).success).toBe(false);
    expect(qualificationSchema.safeParse({ ...base, title: "  " }).success).toBe(false);
  });
  it("year bounds", () => {
    expect(qualificationSchema.safeParse({ ...base, year: "1899" }).success).toBe(false);
    expect(qualificationSchema.safeParse({ ...base, year: "1900" }).success).toBe(true);
    expect(qualificationSchema.safeParse({ ...base, year: String(thisYear + 1) }).success).toBe(true);
    expect(qualificationSchema.safeParse({ ...base, year: String(thisYear + 2) }).success).toBe(false);
    expect(qualificationSchema.safeParse({ ...base, year: "20x0" }).success).toBe(false);
  });
  it("documentRef limit 2048", () => {
    expect(qualificationSchema.safeParse({ ...base, documentRef: "a".repeat(2048) }).success).toBe(true);
    expect(qualificationSchema.safeParse({ ...base, documentRef: "a".repeat(2049) }).success).toBe(false);
  });
});

describe("qualification bodies", () => {
  it("create omits blank optionals", () => {
    expect(buildQualificationCreate({ ...base, title: " MSc " })).toEqual({ title: "MSc", kind: "DEGREE" });
    expect(buildQualificationCreate({ ...base, issuingBody: "IIT", year: "2010" })).toEqual({
      title: "MSc",
      kind: "DEGREE",
      issuingBody: "IIT",
      year: 2010,
    });
  });
  it("patch sends only dirty non-blank fields", () => {
    expect(buildQualificationPatch({ ...base, field: "" }, { field: true })).toEqual({});
    expect(buildQualificationPatch({ ...base, field: "Physics" }, { field: true })).toEqual({ field: "Physics" });
  });
  it("patch with no fields yields the exact server message", () => {
    const r = qualificationPatchSchema.safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("no updatable fields provided");
    expect(qualificationPatchSchema.safeParse({ title: "x" }).success).toBe(true);
  });
});

describe("workloadEditSchema", () => {
  const ok = { nonTeachingHours: "10", override: false, overrideReason: "" };
  it("hours 0..168", () => {
    expect(workloadEditSchema.safeParse({ ...ok, nonTeachingHours: "168" }).success).toBe(true);
    expect(workloadEditSchema.safeParse({ ...ok, nonTeachingHours: "169" }).success).toBe(false);
    expect(workloadEditSchema.safeParse({ ...ok, nonTeachingHours: "0" }).success).toBe(true);
    expect(workloadEditSchema.safeParse({ ...ok, nonTeachingHours: "-1" }).success).toBe(false);
    expect(workloadEditSchema.safeParse({ ...ok, nonTeachingHours: "1.5" }).success).toBe(false);
  });
  it("override without a reason yields the exact server message on overrideReason", () => {
    const r = workloadEditSchema.safeParse({ ...ok, override: true });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe("overrideReason is required when override is true");
      expect(r.error.issues[0].path).toEqual(["overrideReason"]);
    }
    expect(workloadEditSchema.safeParse({ ...ok, override: true, overrideReason: "Covering" }).success).toBe(true);
  });
  it("reason limit 500", () => {
    expect(
      workloadEditSchema.safeParse({ ...ok, override: true, overrideReason: "a".repeat(501) }).success,
    ).toBe(false);
  });
  it("does not send overrideReason when override is false", () => {
    expect(buildWorkloadPatch({ ...ok, overrideReason: "stale" })).toEqual({
      nonTeachingHours: 10,
      override: false,
    });
    expect(buildWorkloadPatch({ ...ok, override: true, overrideReason: " why " })).toEqual({
      nonTeachingHours: 10,
      override: true,
      overrideReason: "why",
    });
  });
});

describe("workloadPolicySchema", () => {
  it("1..168", () => {
    expect(workloadPolicySchema.safeParse({ maxWeeklyHours: "1" }).success).toBe(true);
    expect(workloadPolicySchema.safeParse({ maxWeeklyHours: "168" }).success).toBe(true);
    expect(workloadPolicySchema.safeParse({ maxWeeklyHours: "0" }).success).toBe(false);
    expect(workloadPolicySchema.safeParse({ maxWeeklyHours: "169" }).success).toBe(false);
    expect(workloadPolicySchema.safeParse({ maxWeeklyHours: "" }).success).toBe(false);
  });
});
