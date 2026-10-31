import { describe, expect, it } from "vitest";
import {
  gradeSubject,
  GradingError,
  GRADE_POINTS_SCALE,
  type GradingAssessment,
  type GradingBand,
} from "../grading.js";

// Exhaustive fast/mocked unit tests for the deterministic grading engine
// (design §11 / AC-8). Integer/BigInt only; a single half-up rounding; pure
// integer banding on basis points.

// A standard contiguous, non-overlapping band set (edges in basis points).
const BANDS: GradingBand[] = [
  { minPercentBps: 0, maxPercentBps: 3999, gradeLabel: "F", gradePoints: 0, isPassing: false },
  { minPercentBps: 4000, maxPercentBps: 4999, gradeLabel: "P", gradePoints: 0, isPassing: true }, // passing with 0 points
  { minPercentBps: 5000, maxPercentBps: 5999, gradeLabel: "C", gradePoints: 500, isPassing: true },
  { minPercentBps: 6000, maxPercentBps: 6999, gradeLabel: "B", gradePoints: 600, isPassing: true },
  { minPercentBps: 7000, maxPercentBps: 7999, gradeLabel: "B+", gradePoints: 700, isPassing: true },
  { minPercentBps: 8000, maxPercentBps: 8999, gradeLabel: "A", gradePoints: 800, isPassing: true },
  { minPercentBps: 9000, maxPercentBps: 10000, gradeLabel: "A+", gradePoints: 1000, isPassing: true },
];

const single100: GradingAssessment[] = [{ assessmentId: "a1", maxMarks: 100, weight: 100 }];

describe("grading engine — pure deterministic (AC-8)", () => {
  it("exposes GRADE_POINTS_SCALE = 100", () => {
    expect(GRADE_POINTS_SCALE).toBe(100);
  });

  it("mark == 0 ⇒ percentBps 0, lands in the fail band", () => {
    const r = gradeSubject(single100, [{ assessmentId: "a1", marks: 0 }], BANDS);
    expect(r.percentBps).toBe(0);
    expect(r.gradeLabel).toBe("F");
    expect(r.passed).toBe(false);
  });

  it("mark == maxMarks ⇒ percentBps 10000, top band", () => {
    const r = gradeSubject(single100, [{ assessmentId: "a1", marks: 100 }], BANDS);
    expect(r.percentBps).toBe(10000);
    expect(r.gradeLabel).toBe("A+");
    expect(r.gradePoints).toBe(1000);
    expect(r.passed).toBe(true);
  });

  it("exact basis-point boundary (90.00% ⇒ 9000) lands in the band whose min is 9000", () => {
    const r = gradeSubject(single100, [{ assessmentId: "a1", marks: 90 }], BANDS);
    expect(r.percentBps).toBe(9000);
    expect(r.gradeLabel).toBe("A+");
  });

  it("boundary just below (89.99% target) lands in the A band, not A+", () => {
    // 8999/10000 of maxMarks on a maxMarks that yields exactly 8999 bps.
    // With maxMarks = 10000 and marks = 8999 ⇒ percentBps = 8999.
    const assess: GradingAssessment[] = [{ assessmentId: "a1", maxMarks: 10000, weight: 100 }];
    const r = gradeSubject(assess, [{ assessmentId: "a1", marks: 8999 }], BANDS);
    expect(r.percentBps).toBe(8999);
    expect(r.gradeLabel).toBe("A");
  });

  it("integer half-up: a true-89.995% input rounds UP to 9000 (the float path is NOT taken)", () => {
    // Construct inputs where the exact percentage is 89.995%, which MUST round
    // half-up to 9000 (90.00% ⇒ A+). marks/maxMarks*100 = 89.995 ⇒ marks = 89995,
    // maxMarks = 100000. The integer pipeline computes this exactly.
    const assess: GradingAssessment[] = [{ assessmentId: "a1", maxMarks: 100000, weight: 100 }];
    const r = gradeSubject(assess, [{ assessmentId: "a1", marks: 89995 }], BANDS);
    expect(r.percentBps).toBe(9000); // integer half-up ⇒ 9000 (correct)
    expect(r.gradeLabel).toBe("A+");

    // Document WHY the integer path exists: the canonical non-representable
    // decimal 1.005 is stored as 1.00499999... in a double, so the naive float
    // `Math.round(1.005 * 100)` yields 100 (1.00%) — one bps LOW — whereas the
    // exact half-up answer is 101 (1.01%). A true-1.005% input (1005/100000) must
    // produce 101 through the integer pipeline, proving the float path is NOT taken.
    expect(Math.round(1.005 * 100)).toBe(100); // naive float ⇒ 100 (wrong, one low)
    const r2 = gradeSubject(
      [{ assessmentId: "a1", maxMarks: 100000, weight: 100 }],
      [{ assessmentId: "a1", marks: 1005 }],
      BANDS,
    );
    expect(r2.percentBps).toBe(101); // integer half-up ⇒ 101 (correct)
  });

  it("weighted sum across multiple components (60/40 weights)", () => {
    const assess: GradingAssessment[] = [
      { assessmentId: "internal", maxMarks: 50, weight: 40 },
      { assessmentId: "external", maxMarks: 100, weight: 60 },
    ];
    // internal 40/50 = 80% * 40 = 32 ; external 90/100 = 90% * 60 = 54 ; total 86%.
    const r = gradeSubject(
      assess,
      [
        { assessmentId: "internal", marks: 40 },
        { assessmentId: "external", marks: 90 },
      ],
      BANDS,
    );
    expect(r.percentBps).toBe(8600);
    expect(r.gradeLabel).toBe("A");
  });

  it("absent mark is treated as 0 (never excluded; grade is not inflated)", () => {
    const assess: GradingAssessment[] = [
      { assessmentId: "internal", maxMarks: 50, weight: 40 },
      { assessmentId: "external", maxMarks: 100, weight: 60 },
    ];
    // Only the internal mark is present (40/50 = 80% * 40 = 32); external absent ⇒ 0.
    const r = gradeSubject(assess, [{ assessmentId: "internal", marks: 40 }], BANDS);
    expect(r.percentBps).toBe(3200);
    expect(r.gradeLabel).toBe("F");
    expect(r.passed).toBe(false);
  });

  it("passing band with gradePoints == 0 ⇒ passed is true (isPassing authoritative, not gradePoints > 0)", () => {
    // 45% lands in the 'P' band (4000..4999), isPassing true, gradePoints 0.
    const r = gradeSubject(single100, [{ assessmentId: "a1", marks: 45 }], BANDS);
    expect(r.percentBps).toBe(4500);
    expect(r.gradeLabel).toBe("P");
    expect(r.gradePoints).toBe(0);
    expect(r.passed).toBe(true);
  });

  it("single-assessment subject (weight 100)", () => {
    const r = gradeSubject(single100, [{ assessmentId: "a1", marks: 73 }], BANDS);
    expect(r.percentBps).toBe(7300);
    expect(r.gradeLabel).toBe("B+");
  });

  it("throws GradingError when weights do not sum to 100", () => {
    const bad: GradingAssessment[] = [
      { assessmentId: "a1", maxMarks: 100, weight: 40 },
      { assessmentId: "a2", maxMarks: 100, weight: 40 },
    ];
    expect(() =>
      gradeSubject(bad, [{ assessmentId: "a1", marks: 50 }], BANDS),
    ).toThrow(GradingError);
  });

  it("throws GradingError on a band gap (no matching band)", () => {
    const gapped: GradingBand[] = [
      { minPercentBps: 0, maxPercentBps: 4999, gradeLabel: "F", gradePoints: 0, isPassing: false },
      // gap 5000..5999
      { minPercentBps: 6000, maxPercentBps: 10000, gradeLabel: "A", gradePoints: 1000, isPassing: true },
    ];
    expect(() =>
      gradeSubject(single100, [{ assessmentId: "a1", marks: 55 }], gapped),
    ).toThrow(GradingError);
  });

  it("throws GradingError on an empty assessment list", () => {
    expect(() => gradeSubject([], [], BANDS)).toThrow(GradingError);
  });

  it("is deterministic: identical inputs ⇒ identical result", () => {
    const r1 = gradeSubject(single100, [{ assessmentId: "a1", marks: 67 }], BANDS);
    const r2 = gradeSubject(single100, [{ assessmentId: "a1", marks: 67 }], BANDS);
    expect(r1).toEqual(r2);
  });
});
