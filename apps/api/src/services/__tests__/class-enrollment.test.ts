import { describe, expect, it } from "vitest";
import {
  decideEnrollment,
  type EnrollmentDecisionInput,
  type ExistingEnrollment,
} from "../class-enrollment.js";

// ─── Class-enrollment decision (design §6.5 / §10) ───────────────────────────
// DB-free unit tests: no-duplicate resolution by (classSectionId, studentId),
// capacity gating, and re-enroll of a previously-dropped student by reactivating
// the single (section, student) row (never a second copy).

function input(overrides: Partial<EnrollmentDecisionInput> = {}): EnrollmentDecisionInput {
  return {
    classSectionId: "sec_1",
    studentId: "stu_1",
    existing: null,
    capacity: null,
    enrolledCount: 0,
    ...overrides,
  };
}

describe("decideEnrollment", () => {
  it("fresh student with no prior row => enroll", () => {
    expect(decideEnrollment(input())).toEqual({ action: "enroll" });
  });

  it("an existing ENROLLED row => reject(duplicate) — no second copy", () => {
    const existing: ExistingEnrollment = { id: "enr_1", status: "ENROLLED" };
    expect(decideEnrollment(input({ existing }))).toEqual({
      action: "reject",
      reason: "duplicate",
    });
  });

  it("capacity full (count >= capacity) => reject(capacity_full)", () => {
    expect(decideEnrollment(input({ capacity: 30, enrolledCount: 30 }))).toEqual({
      action: "reject",
      reason: "capacity_full",
    });
  });

  it("under capacity => enroll", () => {
    expect(decideEnrollment(input({ capacity: 30, enrolledCount: 29 }))).toEqual({
      action: "enroll",
    });
  });

  it("null capacity never blocks on count", () => {
    expect(decideEnrollment(input({ capacity: null, enrolledCount: 9999 }))).toEqual({
      action: "enroll",
    });
  });

  it("a prior DROPPED row => reenroll (reactivate the same row, single identity)", () => {
    const existing: ExistingEnrollment = { id: "enr_1", status: "DROPPED" };
    expect(decideEnrollment(input({ existing }))).toEqual({
      action: "reenroll",
      enrollmentId: "enr_1",
    });
  });

  it("a prior COMPLETED row => reenroll (not a duplicate, not a new row)", () => {
    const existing: ExistingEnrollment = { id: "enr_1", status: "COMPLETED" };
    expect(decideEnrollment(input({ existing }))).toEqual({
      action: "reenroll",
      enrollmentId: "enr_1",
    });
  });

  it("re-enroll is still capacity-gated", () => {
    const existing: ExistingEnrollment = { id: "enr_1", status: "DROPPED" };
    expect(
      decideEnrollment(input({ existing, capacity: 10, enrolledCount: 10 })),
    ).toEqual({ action: "reject", reason: "capacity_full" });
  });

  it("a live duplicate is rejected even when the section is full (duplicate wins)", () => {
    const existing: ExistingEnrollment = { id: "enr_1", status: "ENROLLED" };
    expect(
      decideEnrollment(input({ existing, capacity: 10, enrolledCount: 10 })),
    ).toEqual({ action: "reject", reason: "duplicate" });
  });
});
