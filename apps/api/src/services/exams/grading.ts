// CAMPASS Phase 8 — deterministic grading engine (design §11, D-B, D-C).
//
// Pure + deterministic: NO DB access, integer/BigInt ONLY, no float anywhere in
// the computation or at a band boundary. Identical inputs always produce an
// identical result (NFR-3). This is the single source of truth for the grading
// math; the publish/persistence wrapper + scope/status checks live in the route
// and are integration-tested. The configurable surface is DATA (bands + weights
// + maxMarks) — there is NO formula interpreter (D-C).
//
// Rounding (D-B): the weighted percentage is accumulated scaled by 1e6 in a
// BigInt and rounded ONCE at the end, half-up, to percentBps (0..10000 = pct*100)
// via (num + 5000n) / 10000n. The naive `Math.round(pct * 100)` path is REJECTED:
// e.g. 89.995 is not representable in a double, so Math.round(89.995 * 100) ===
// 8999 (89.99), silently mis-banding at a boundary — exactly the failure mode
// this access-and-correctness-critical code must not have.
//
// Banding is a PURE-INTEGER comparison: percentBps and the band edges are both
// in basis points, so a band matches when minPercentBps <= percentBps <=
// maxPercentBps. Bands are contiguous + non-overlapping by construction
// (validated at scheme save), so exactly one matches; none ⇒ a typed GradingError
// (fatal; the route maps it to 409).

/** Shared scale: gradePoints are stored as points×100 (e.g. 1000 = 10.00). */
export const GRADE_POINTS_SCALE = 100;

/** A fatal, typed grading failure (misconfigured scheme / invalid inputs). */
export class GradingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GradingError";
  }
}

/** A weighted assessment component of a (exam, subject) evaluation. */
export interface GradingAssessment {
  assessmentId: string;
  maxMarks: number; // > 0
  weight: number; // percent points; the ACTIVE set per (exam,subject) sums to 100
}

/** A candidate's raw mark for one assessment (absent marks are omitted ⇒ 0). */
export interface GradingMark {
  assessmentId: string;
  marks: number; // 0 <= marks <= maxMarks
}

/** One grade band of a scheme (edges in basis points; pure-integer banding). */
export interface GradingBand {
  minPercentBps: number; // 0..10000
  maxPercentBps: number; // 0..10000, minPercentBps <= maxPercentBps
  gradeLabel: string;
  gradePoints: number; // points*100 (GRADE_POINTS_SCALE)
  isPassing: boolean; // authoritative pass/fail flag for this band
}

/** The computed result for one (candidate, subject). */
export interface GradingResult {
  percentBps: number; // 0..10000 (pct*100), half-up rounded ONCE
  gradeLabel: string; // copied from the matched band
  gradePoints: number; // copied from the matched band
  passed: boolean; // = matched band's isPassing
}

/**
 * Compute the weighted percentage (in basis points) for one (candidate, subject)
 * and band it to a grade. Integer/BigInt only; a single half-up rounding.
 *
 * @throws GradingError on weight-sum != 100, an empty assessment list used with
 *         marks, or a percentBps that matches no band (misconfigured scheme).
 */
export function gradeSubject(
  assessments: readonly GradingAssessment[],
  marks: readonly GradingMark[],
  bands: readonly GradingBand[],
): GradingResult {
  if (assessments.length === 0) {
    throw new GradingError("no assessments to grade");
  }

  // Defense-in-depth: the caller validates the weight sum at assessment save,
  // but the engine re-asserts it so the math is never run on a bad weighting.
  let weightSum = 0;
  for (const a of assessments) {
    if (a.maxMarks <= 0) {
      throw new GradingError(`assessment ${a.assessmentId} has non-positive maxMarks`);
    }
    weightSum += a.weight;
  }
  if (weightSum !== 100) {
    throw new GradingError(`assessment weights must sum to 100 (got ${weightSum})`);
  }

  const marksByAssessment = new Map<string, number>();
  for (const m of marks) {
    marksByAssessment.set(m.assessmentId, m.marks);
  }

  // Accumulate (percentage * 1e6) in BigInt so each per-assessment /maxMarks
  // division keeps guard digits before the single final rounding. Absent marks
  // contribute 0 (a missing mark is a 0, never "excluded").
  let num = 0n;
  for (const a of assessments) {
    const raw = marksByAssessment.get(a.assessmentId) ?? 0; // absent ⇒ 0
    const m = BigInt(raw);
    num += (m * BigInt(a.weight) * 1_000_000n) / BigInt(a.maxMarks);
  }

  // Half-up from (percentage * 1e6) to percentBps (percentage * 1e2): divide by
  // 1e4 with a +0.5-at-the-bps-scale bias on the non-negative BigInt.
  const percentBps = Number((num + 5_000n) / 10_000n);

  // Band with a pure-integer predicate. Exactly one band matches by construction.
  const band = bands.find(
    (b) => b.minPercentBps <= percentBps && percentBps <= b.maxPercentBps,
  );
  if (!band) {
    throw new GradingError(`no grade band matches percentBps=${percentBps}`);
  }

  return {
    percentBps,
    gradeLabel: band.gradeLabel,
    gradePoints: band.gradePoints,
    passed: band.isPassing,
  };
}
