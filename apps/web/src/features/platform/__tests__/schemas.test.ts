import { describe, it, expect } from "vitest";
import {
  clampAuditLimit,
  createInstitutionSchema,
  createSupportGrantSchema,
} from "../schemas";

function firstMessage(result: ReturnType<typeof createInstitutionSchema.safeParse>): string {
  if (result.success) return "";
  return result.error.issues[0]?.message ?? "";
}

describe("createInstitutionSchema", () => {
  const REQ = "name, code and adminEmail are required";

  it("accepts a valid body (domain optional)", () => {
    const ok = createInstitutionSchema.safeParse({
      name: "Acme University",
      code: "ACME",
      adminEmail: "admin@acme.edu",
    });
    expect(ok.success).toBe(true);
  });

  it("uses the exact server message for a missing name", () => {
    const r = createInstitutionSchema.safeParse({
      name: "",
      code: "ACME",
      adminEmail: "admin@acme.edu",
    });
    expect(r.success).toBe(false);
    expect(firstMessage(r)).toBe(REQ);
  });

  it("uses the exact server message for a missing code", () => {
    const r = createInstitutionSchema.safeParse({
      name: "Acme",
      code: "   ",
      adminEmail: "admin@acme.edu",
    });
    expect(r.success).toBe(false);
    expect(firstMessage(r)).toBe(REQ);
  });

  it("uses the exact server message for a missing adminEmail", () => {
    const r = createInstitutionSchema.safeParse({
      name: "Acme",
      code: "ACME",
      adminEmail: "",
    });
    expect(r.success).toBe(false);
    expect(firstMessage(r)).toBe(REQ);
  });

  it("uses the email message for a malformed adminEmail", () => {
    const r = createInstitutionSchema.safeParse({
      name: "Acme",
      code: "ACME",
      adminEmail: "not-an-email",
    });
    expect(r.success).toBe(false);
    expect(firstMessage(r)).toBe("adminEmail must be a valid email");
  });
});

describe("createSupportGrantSchema", () => {
  const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();

  const base = {
    institutionId: "inst-1",
    purpose: "Investigating a reported gate anomaly",
    expiresAt: inFuture(60 * 60 * 1000),
  };

  it("accepts a valid grant request within 4 hours", () => {
    expect(createSupportGrantSchema.safeParse(base).success).toBe(true);
  });

  it("requires institutionId", () => {
    const r = createSupportGrantSchema.safeParse({ ...base, institutionId: "" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe("institutionId is required");
  });

  it("requires purpose (min 1)", () => {
    const r = createSupportGrantSchema.safeParse({ ...base, purpose: "" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe("purpose is required");
  });

  it("rejects a purpose over 500 characters", () => {
    const r = createSupportGrantSchema.safeParse({ ...base, purpose: "x".repeat(501) });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues[0]?.message).toBe("purpose must be at most 500 characters");
  });

  it("accepts a purpose of exactly 500 characters", () => {
    expect(
      createSupportGrantSchema.safeParse({ ...base, purpose: "x".repeat(500) }).success,
    ).toBe(true);
  });

  it("rejects a past expiresAt", () => {
    const r = createSupportGrantSchema.safeParse({ ...base, expiresAt: inFuture(-1000) });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues[0]?.message).toBe(
        "expiresAt must be in the future and within 4 hours",
      );
  });

  it("rejects an expiresAt more than 4 hours out", () => {
    const r = createSupportGrantSchema.safeParse({
      ...base,
      expiresAt: inFuture(4 * 60 * 60 * 1000 + 60 * 1000),
    });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues[0]?.message).toBe(
        "expiresAt must be in the future and within 4 hours",
      );
  });

  it("rejects a non-date expiresAt", () => {
    const r = createSupportGrantSchema.safeParse({ ...base, expiresAt: "not-a-date" });
    expect(r.success).toBe(false);
  });

  it("accepts optional scope arrays up to 50 items", () => {
    expect(
      createSupportGrantSchema.safeParse({
        ...base,
        scope: { modules: Array.from({ length: 50 }, (_, i) => `m${i}`) },
      }).success,
    ).toBe(true);
  });

  it("rejects a scope array over 50 items", () => {
    expect(
      createSupportGrantSchema.safeParse({
        ...base,
        scope: { resources: Array.from({ length: 51 }, (_, i) => `r${i}`) },
      }).success,
    ).toBe(false);
  });
});

describe("clampAuditLimit", () => {
  it("defaults non-finite input to 50", () => {
    expect(clampAuditLimit(Number.NaN)).toBe(50);
    expect(clampAuditLimit(Number.POSITIVE_INFINITY)).toBe(50);
  });

  it("clamps below 1 up to 1", () => {
    expect(clampAuditLimit(0)).toBe(1);
    expect(clampAuditLimit(-5)).toBe(1);
  });

  it("clamps above 100 down to 100", () => {
    expect(clampAuditLimit(101)).toBe(100);
    expect(clampAuditLimit(9999)).toBe(100);
  });

  it("passes valid values through (floored)", () => {
    expect(clampAuditLimit(1)).toBe(1);
    expect(clampAuditLimit(50)).toBe(50);
    expect(clampAuditLimit(100)).toBe(100);
    expect(clampAuditLimit(42.9)).toBe(42);
  });
});
