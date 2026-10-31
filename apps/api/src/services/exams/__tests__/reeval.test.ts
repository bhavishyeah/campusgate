import { describe, expect, it } from "vitest";
import {
  reevalTransitionLegal,
  computeSupplementaryEligible,
  type EligibilitySnapshot,
} from "../reeval.js";
import {
  createReevalRequestSchema,
  transitionReevalSchema,
  remarkReevalSchema,
  listReevalQuerySchema,
  registerSupplementaryCandidatesSchema,
} from "@campusgate/shared";

// Fast/mocked unit tests for the slice-8.2 pure helpers + Zod schemas (design
// §13). No DB. These extend the existing fast exam/validation suite.

describe("reevalTransitionLegal (mirrors reeval_requests_guard)", () => {
  it("accepts every legal forward edge", () => {
    expect(reevalTransitionLegal("REQUESTED", "UNDER_REVIEW")).toBe(true);
    expect(reevalTransitionLegal("UNDER_REVIEW", "REMARKED")).toBe(true);
    expect(reevalTransitionLegal("REMARKED", "CLOSED")).toBe(true);
    expect(reevalTransitionLegal("REQUESTED", "REJECTED")).toBe(true);
    expect(reevalTransitionLegal("UNDER_REVIEW", "REJECTED")).toBe(true);
  });

  it("rejects skips, backward edges, and edges out of terminal states", () => {
    // skips
    expect(reevalTransitionLegal("REQUESTED", "REMARKED")).toBe(false);
    expect(reevalTransitionLegal("REQUESTED", "CLOSED")).toBe(false);
    expect(reevalTransitionLegal("UNDER_REVIEW", "CLOSED")).toBe(false);
    // once remarked, the outcome is closed, not rejected
    expect(reevalTransitionLegal("REMARKED", "REJECTED")).toBe(false);
    // backward
    expect(reevalTransitionLegal("UNDER_REVIEW", "REQUESTED")).toBe(false);
    expect(reevalTransitionLegal("REMARKED", "UNDER_REVIEW")).toBe(false);
    // terminal states have no outgoing legal edge
    for (const to of ["REQUESTED", "UNDER_REVIEW", "REMARKED", "CLOSED", "REJECTED"]) {
      expect(reevalTransitionLegal("CLOSED", to)).toBe(false);
      expect(reevalTransitionLegal("REJECTED", to)).toBe(false);
    }
  });

  it("rejects the no-op self transition (the route never advances to the same state)", () => {
    expect(reevalTransitionLegal("REQUESTED", "REQUESTED")).toBe(false);
    expect(reevalTransitionLegal("UNDER_REVIEW", "UNDER_REVIEW")).toBe(false);
  });
});

describe("computeSupplementaryEligible", () => {
  it("returns the distinct non-passing union across subjects", () => {
    const snaps: EligibilitySnapshot[] = [
      { studentId: "s1", passed: false }, // fail subject A
      { studentId: "s1", passed: false }, // fail subject B too — still just s1 once
      { studentId: "s2", passed: true }, // passed everything so far
      { studentId: "s3", passed: false },
    ];
    const eligible = computeSupplementaryEligible(snaps);
    expect([...eligible].sort()).toEqual(["s1", "s3"]);
  });

  it("includes a student who failed one subject even if they passed another", () => {
    const snaps: EligibilitySnapshot[] = [
      { studentId: "s2", passed: true },
      { studentId: "s2", passed: false },
    ];
    expect([...computeSupplementaryEligible(snaps)]).toEqual(["s2"]);
  });

  it("is empty when every snapshot passed", () => {
    const snaps: EligibilitySnapshot[] = [
      { studentId: "s1", passed: true },
      { studentId: "s2", passed: true },
    ];
    expect(computeSupplementaryEligible(snaps).size).toBe(0);
  });

  it("is empty for no snapshots", () => {
    expect(computeSupplementaryEligible([]).size).toBe(0);
  });
});

describe("slice-8.2 Zod schemas", () => {
  it("createReevalRequestSchema accepts a valid body and rejects an empty reason", () => {
    expect(createReevalRequestSchema.safeParse({ examId: "e1", subjectId: "s1", reason: "wrong total" }).success).toBe(true);
    expect(createReevalRequestSchema.safeParse({ examId: "e1", subjectId: "s1", reason: "" }).success).toBe(false);
    expect(createReevalRequestSchema.safeParse({ examId: "e1", subjectId: "s1" }).success).toBe(false);
  });

  it("transitionReevalSchema requires note for REJECTED", () => {
    expect(transitionReevalSchema.safeParse({ to: "REJECTED" }).success).toBe(false);
    expect(transitionReevalSchema.safeParse({ to: "REJECTED", note: "not justified" }).success).toBe(true);
    expect(transitionReevalSchema.safeParse({ to: "UNDER_REVIEW" }).success).toBe(true);
    expect(transitionReevalSchema.safeParse({ to: "CLOSED" }).success).toBe(true);
  });

  it("transitionReevalSchema permits outcomePublicationId ONLY for REMARKED", () => {
    expect(transitionReevalSchema.safeParse({ to: "REMARKED", outcomePublicationId: "p2" }).success).toBe(true);
    expect(transitionReevalSchema.safeParse({ to: "CLOSED", outcomePublicationId: "p2" }).success).toBe(false);
    expect(transitionReevalSchema.safeParse({ to: "REJECTED", note: "x", outcomePublicationId: "p2" }).success).toBe(false);
    // REQUESTED is not an allowed target at all
    expect(transitionReevalSchema.safeParse({ to: "REQUESTED" }).success).toBe(false);
  });

  it("remarkReevalSchema requires a non-negative integer mark + a reason", () => {
    expect(remarkReevalSchema.safeParse({ marksRecordId: "m1", marks: 55, reason: "recount" }).success).toBe(true);
    expect(remarkReevalSchema.safeParse({ marksRecordId: "m1", marks: -1, reason: "recount" }).success).toBe(false);
    expect(remarkReevalSchema.safeParse({ marksRecordId: "m1", marks: 5.5, reason: "recount" }).success).toBe(false);
    expect(remarkReevalSchema.safeParse({ marksRecordId: "m1", marks: 55, reason: "" }).success).toBe(false);
  });

  it("listReevalQuerySchema accepts optional status/examId and rejects a bad status", () => {
    expect(listReevalQuerySchema.safeParse({}).success).toBe(true);
    expect(listReevalQuerySchema.safeParse({ status: "UNDER_REVIEW", examId: "e1" }).success).toBe(true);
    expect(listReevalQuerySchema.safeParse({ status: "NOPE" }).success).toBe(false);
  });

  it("registerSupplementaryCandidatesSchema requires >=1 subjectId; studentIds optional", () => {
    expect(registerSupplementaryCandidatesSchema.safeParse({ subjectIds: ["s1"] }).success).toBe(true);
    expect(registerSupplementaryCandidatesSchema.safeParse({ subjectIds: ["s1"], studentIds: ["a", "b"] }).success).toBe(true);
    expect(registerSupplementaryCandidatesSchema.safeParse({ subjectIds: [] }).success).toBe(false);
    expect(registerSupplementaryCandidatesSchema.safeParse({ studentIds: ["a"] }).success).toBe(false);
  });
});
