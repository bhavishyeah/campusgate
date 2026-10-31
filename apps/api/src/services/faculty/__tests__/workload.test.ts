import { describe, expect, it } from "vitest";
import { computeWorkload, type WorkloadAssignment } from "../workload.js";

// Fast/mocked unit tests for the pure workload derivation (design §B.4, §B.13).
// Rules: ACTIVE only; PRIMARY only (SUBSTITUTE/ASSISTANT excluded); de-dup on
// distinct (subjectId, classSectionId) counting each section separately; null
// contactHoursPerWeek → 0 + unestimatedSubjectIds; overAllocated vs policy max.

const a = (over: Partial<WorkloadAssignment> & { id: string }): WorkloadAssignment => ({
  subjectId: "subjA",
  classSectionId: null,
  role: "PRIMARY",
  status: "ACTIVE",
  ...over,
});

describe("computeWorkload — pure (design §B.4)", () => {
  it("two sections of ONE subject count as two loads", () => {
    const r = computeWorkload(
      [
        a({ id: "x1", subjectId: "subjA", classSectionId: "secA" }),
        a({ id: "x2", subjectId: "subjA", classSectionId: "secB" }),
      ],
      new Map([["subjA", 4]]),
      0,
      null,
    );
    expect(r.teachingHours).toBe(8); // 4 + 4
    expect(r.unestimatedSubjectIds).toEqual([]);
    expect(r.excludedAssignmentIds).toEqual([]);
  });

  it("a section-less + a section-specific assignment of the same subject are two units", () => {
    const r = computeWorkload(
      [
        a({ id: "x1", subjectId: "subjA", classSectionId: null }),
        a({ id: "x2", subjectId: "subjA", classSectionId: "secB" }),
      ],
      new Map([["subjA", 3]]),
      0,
      null,
    );
    expect(r.teachingHours).toBe(6); // null-unit + secB-unit
  });

  it("collapses an EXACT duplicate (subjectId, classSectionId) unit", () => {
    const r = computeWorkload(
      [
        a({ id: "x1", subjectId: "subjA", classSectionId: "secA" }),
        a({ id: "x2", subjectId: "subjA", classSectionId: "secA" }),
      ],
      new Map([["subjA", 5]]),
      0,
      null,
    );
    expect(r.teachingHours).toBe(5); // counted once
  });

  it("excludes SUBSTITUTE and ASSISTANT, surfacing them as excludedAssignmentIds", () => {
    const r = computeWorkload(
      [
        a({ id: "p1", subjectId: "subjA", classSectionId: "secA", role: "PRIMARY" }),
        a({ id: "s1", subjectId: "subjB", classSectionId: "secB", role: "SUBSTITUTE" }),
        a({ id: "t1", subjectId: "subjC", classSectionId: "secC", role: "ASSISTANT" }),
      ],
      new Map([
        ["subjA", 4],
        ["subjB", 4],
        ["subjC", 4],
      ]),
      0,
      null,
    );
    expect(r.teachingHours).toBe(4); // only the PRIMARY subjA
    expect(r.excludedAssignmentIds.sort()).toEqual(["s1", "t1"]);
  });

  it("excludes ENDED assignments", () => {
    const r = computeWorkload(
      [
        a({ id: "p1", subjectId: "subjA", classSectionId: "secA", status: "ENDED" }),
        a({ id: "p2", subjectId: "subjB", classSectionId: "secB", status: "ACTIVE" }),
      ],
      new Map([
        ["subjA", 4],
        ["subjB", 3],
      ]),
      0,
      null,
    );
    expect(r.teachingHours).toBe(3); // only the ACTIVE subjB
    expect(r.excludedAssignmentIds).toEqual([]); // ENDED is not "excluded by role"
  });

  it("surfaces a subject with null contactHoursPerWeek as unestimated (contributes 0)", () => {
    const r = computeWorkload(
      [
        a({ id: "x1", subjectId: "subjA", classSectionId: "secA" }),
        a({ id: "x2", subjectId: "subjNull", classSectionId: "secB" }),
      ],
      new Map<string, number | null>([
        ["subjA", 4],
        ["subjNull", null],
      ]),
      0,
      null,
    );
    expect(r.teachingHours).toBe(4);
    expect(r.unestimatedSubjectIds).toEqual(["subjNull"]);
  });

  it("adds nonTeachingHours into totalHours", () => {
    const r = computeWorkload(
      [a({ id: "x1", subjectId: "subjA", classSectionId: "secA" })],
      new Map([["subjA", 10]]),
      6,
      null,
    );
    expect(r.teachingHours).toBe(10);
    expect(r.totalHours).toBe(16);
  });

  it("over-allocation: total over the policy max flips overAllocated", () => {
    const r = computeWorkload(
      [a({ id: "x1", subjectId: "subjA", classSectionId: "secA" })],
      new Map([["subjA", 30]]),
      10,
      35, // cap below 40
    );
    expect(r.totalHours).toBe(40);
    expect(r.overAllocated).toBe(true);
  });

  it("not over-allocated when total <= policy max", () => {
    const r = computeWorkload(
      [a({ id: "x1", subjectId: "subjA", classSectionId: "secA" })],
      new Map([["subjA", 30]]),
      5,
      40,
    );
    expect(r.totalHours).toBe(35);
    expect(r.overAllocated).toBe(false);
  });

  it("uncapped (policyMax null) is never overAllocated", () => {
    const r = computeWorkload(
      [a({ id: "x1", subjectId: "subjA", classSectionId: "secA" })],
      new Map([["subjA", 200]]),
      0,
      null,
    );
    expect(r.overAllocated).toBe(false);
  });
});
