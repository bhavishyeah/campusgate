import { describe, expect, it } from "vitest";
import {
  createFacultyQualificationSchema,
  patchFacultyQualificationSchema,
  putWorkloadPolicySchema,
  patchFacultyWorkloadSchema,
} from "@campusgate/shared";

// Fast/mocked unit tests for the four faculty Zod schemas (design §B.11).

describe("createFacultyQualificationSchema", () => {
  it("accepts a minimal valid payload (title only, kind defaults absent)", () => {
    const r = createFacultyQualificationSchema.safeParse({ title: "B.Sc" });
    expect(r.success).toBe(true);
  });

  it("rejects an empty title", () => {
    expect(createFacultyQualificationSchema.safeParse({ title: "" }).success).toBe(false);
  });

  it("rejects a missing title", () => {
    expect(createFacultyQualificationSchema.safeParse({ issuingBody: "X" }).success).toBe(false);
  });

  it("rejects an out-of-range year", () => {
    expect(
      createFacultyQualificationSchema.safeParse({ title: "X", year: 1800 }).success,
    ).toBe(false);
    expect(
      createFacultyQualificationSchema.safeParse({
        title: "X",
        year: new Date().getFullYear() + 5,
      }).success,
    ).toBe(false);
  });

  it("accepts a well-formed full payload", () => {
    const r = createFacultyQualificationSchema.safeParse({
      title: "M.Tech CS",
      kind: "DEGREE",
      issuingBody: "IIT",
      field: "Computer Science",
      year: 2015,
      documentRef: "https://example.com/doc",
    });
    expect(r.success).toBe(true);
  });
});

describe("patchFacultyQualificationSchema", () => {
  it("requires at least one field", () => {
    expect(patchFacultyQualificationSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a single field", () => {
    expect(patchFacultyQualificationSchema.safeParse({ field: "ML" }).success).toBe(true);
  });
});

describe("putWorkloadPolicySchema", () => {
  it("accepts a sane weekly max", () => {
    expect(putWorkloadPolicySchema.safeParse({ maxWeeklyHours: 40 }).success).toBe(true);
  });

  it("rejects 0 and > 168", () => {
    expect(putWorkloadPolicySchema.safeParse({ maxWeeklyHours: 0 }).success).toBe(false);
    expect(putWorkloadPolicySchema.safeParse({ maxWeeklyHours: 200 }).success).toBe(false);
  });
});

describe("patchFacultyWorkloadSchema", () => {
  it("accepts nonTeachingHours alone", () => {
    expect(patchFacultyWorkloadSchema.safeParse({ nonTeachingHours: 5 }).success).toBe(true);
  });

  it("requires overrideReason when override is true", () => {
    expect(patchFacultyWorkloadSchema.safeParse({ override: true }).success).toBe(false);
    expect(
      patchFacultyWorkloadSchema.safeParse({ override: true, overrideReason: "approved by dean" })
        .success,
    ).toBe(true);
  });

  it("allows override:false without a reason", () => {
    expect(patchFacultyWorkloadSchema.safeParse({ override: false }).success).toBe(true);
  });

  it("rejects negative nonTeachingHours", () => {
    expect(patchFacultyWorkloadSchema.safeParse({ nonTeachingHours: -1 }).success).toBe(false);
  });
});
