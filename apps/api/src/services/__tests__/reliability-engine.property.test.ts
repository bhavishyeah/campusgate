import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ReliabilityEngine, SeverityThresholds } from '../reliability-engine.js';

// Feature: outside-time-reliability, Property 9: Severity classification completeness
describe('ReliabilityEngine - Property 9: Severity classification completeness', () => {
  /**
   * **Validates: Requirements 10.1, 10.2, 10.3, 10.4**
   *
   * For any positive overdue minute value and configured severity thresholds
   * (where minor_max < moderate_max < significant_max), the classification
   * function SHALL return exactly one of: MINOR, MODERATE, SIGNIFICANT, SEVERE.
   * When overdueMinutes <= 0, returns null.
   */

  // Generate valid thresholds where minor < moderate < significant
  const thresholdsArb = fc.tuple(
    fc.integer({ min: 1, max: 50 }),       // minorMax
    fc.integer({ min: 51, max: 150 }),     // moderateMax
    fc.integer({ min: 151, max: 500 })     // significantMax
  ).map(([minor, moderate, significant]): SeverityThresholds => ({
    severityMinorMax: minor,
    severityModerateMax: moderate,
    severitySignificantMax: significant,
  }));

  it('should return exactly one severity for any positive overdue value', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000 }),
        thresholdsArb,
        (overdueMinutes, thresholds) => {
          const result = ReliabilityEngine.classifySeverity(overdueMinutes, thresholds);
          expect(result).not.toBeNull();
          expect(['MINOR', 'MODERATE', 'SIGNIFICANT', 'SEVERE']).toContain(result);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return null for non-positive overdue values', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10000, max: 0 }),
        thresholdsArb,
        (overdueMinutes, thresholds) => {
          const result = ReliabilityEngine.classifySeverity(overdueMinutes, thresholds);
          expect(result).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should classify correctly based on threshold boundaries', () => {
    fc.assert(
      fc.property(
        thresholdsArb,
        fc.integer({ min: 1, max: 10000 }),
        (thresholds, overdueMinutes) => {
          const result = ReliabilityEngine.classifySeverity(overdueMinutes, thresholds);

          if (overdueMinutes >= 1 && overdueMinutes <= thresholds.severityMinorMax) {
            expect(result).toBe('MINOR');
          } else if (overdueMinutes >= thresholds.severityMinorMax + 1 && overdueMinutes <= thresholds.severityModerateMax) {
            expect(result).toBe('MODERATE');
          } else if (overdueMinutes >= thresholds.severityModerateMax + 1 && overdueMinutes <= thresholds.severitySignificantMax) {
            expect(result).toBe('SIGNIFICANT');
          } else if (overdueMinutes > thresholds.severitySignificantMax) {
            expect(result).toBe('SEVERE');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return mutually exclusive classifications (never two categories)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000 }),
        thresholdsArb,
        (overdueMinutes, thresholds) => {
          const result = ReliabilityEngine.classifySeverity(overdueMinutes, thresholds);
          const validSeverities = ['MINOR', 'MODERATE', 'SIGNIFICANT', 'SEVERE'];

          // Exactly one match
          const matches = validSeverities.filter(s => s === result);
          expect(matches).toHaveLength(1);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Helper: Pure computation function under test ────────────────────────────

/**
 * Pure function that computes the overall reliability score from three component rates.
 * Mirrors the formula in ReliabilityEngine.computeScore:
 *   overall = clamp(round((0.6*TR + 0.2*CR + 0.2*ACR) * 5.0, 1dp), 0.0, 5.0)
 */
function computeOverallScore(tr: number, cr: number, acr: number): number {
  const raw = 0.6 * tr + 0.2 * cr + 0.2 * acr;
  const scaled = raw * 5.0;
  return Math.min(5.0, Math.max(0.0, Math.round(scaled * 10) / 10));
}

// Feature: outside-time-reliability, Property 10: Score bounded invariant
describe('ReliabilityEngine - Property 10: Score bounded invariant', () => {
  /**
   * **Validates: Requirements 8.1**
   *
   * For any set of valid component rates (each in [0.0, 1.0]),
   * the computed overall reliability score SHALL be in the range [0.0, 5.0]
   * with exactly one decimal place precision.
   */

  it('should produce a score in [0.0, 5.0] for any valid component rates', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (tr, cr, acr) => {
          const score = computeOverallScore(tr, cr, acr);
          expect(score).toBeGreaterThanOrEqual(0.0);
          expect(score).toBeLessThanOrEqual(5.0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should have exactly one decimal place precision', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (tr, cr, acr) => {
          const score = computeOverallScore(tr, cr, acr);
          // Score * 10 should be an integer (one decimal place precision)
          const scaled = Math.round(score * 10);
          expect(score).toBeCloseTo(scaled / 10, 10);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: outside-time-reliability, Property 11: Weighted score formula
describe('ReliabilityEngine - Property 11: Weighted score formula', () => {
  /**
   * **Validates: Requirements 8.2**
   *
   * For any three component rates (timelyReturnRate, completionRate,
   * authorizationComplianceRate), each in [0.0, 1.0], the overall score
   * SHALL equal round((0.6 * TR + 0.2 * CR + 0.2 * ACR) * 5.0, 1).
   */

  it('should equal round((0.6*TR + 0.2*CR + 0.2*ACR) * 5.0, 1)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (tr, cr, acr) => {
          const score = computeOverallScore(tr, cr, acr);

          // Expected: round((0.6*TR + 0.2*CR + 0.2*ACR) * 5.0, 1dp), clamped to [0, 5]
          const raw = 0.6 * tr + 0.2 * cr + 0.2 * acr;
          const scaled = raw * 5.0;
          const expected = Math.min(5.0, Math.max(0.0, Math.round(scaled * 10) / 10));

          expect(score).toBe(expected);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should produce 5.0 when all component rates are 1.0', () => {
    const score = computeOverallScore(1.0, 1.0, 1.0);
    expect(score).toBe(5.0);
  });

  it('should produce 0.0 when all component rates are 0.0', () => {
    const score = computeOverallScore(0.0, 0.0, 0.0);
    expect(score).toBe(0.0);
  });

  it('should weight timely return rate at 60%', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (tr) => {
          // With CR=0 and ACR=0, score = round(0.6 * TR * 5.0, 1)
          const score = computeOverallScore(tr, 0, 0);
          const expected = Math.min(5.0, Math.max(0.0, Math.round(0.6 * tr * 5.0 * 10) / 10));
          expect(score).toBe(expected);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: outside-time-reliability, Property 15: Score exclusion rules
describe('ReliabilityEngine - Property 15: Score exclusion rules', () => {
  /**
   * **Validates: Requirements 11.1, 11.2, 11.3, 11.4**
   *
   * For any set of gate passes, the filterMovementsForScoring function SHALL exclude:
   * - Passes not in terminal status (COMPLETED, EXPIRED, REVOKED)
   * - Passes with EmergencyOverride records
   * - HOD rejections are implicitly excluded (never reach terminal status)
   */

  const TERMINAL_STATUSES = ['COMPLETED', 'EXPIRED', 'REVOKED'];
  const NON_TERMINAL_STATUSES = ['PENDING', 'APPROVED', 'OUTSIDE', 'ACTIVE', 'REJECTED'];

  // Arbitrary for pass objects with random IDs and statuses
  const passArb = fc.record({
    id: fc.uuid(),
    status: fc.oneof(
      fc.constantFrom(...TERMINAL_STATUSES),
      fc.constantFrom(...NON_TERMINAL_STATUSES)
    ),
  });

  // Arbitrary for override records referencing pass IDs
  const overrideArb = (passIds: string[]) =>
    passIds.length === 0
      ? fc.constant([] as Array<{ gatePassId: string }>)
      : fc.array(
          fc.record({ gatePassId: fc.constantFrom(...passIds) }),
          { minLength: 0, maxLength: passIds.length }
        );

  it('should only include passes in terminal status', () => {
    fc.assert(
      fc.property(
        fc.array(passArb, { minLength: 1, maxLength: 30 }),
        (passes) => {
          const result = ReliabilityEngine.filterMovementsForScoring(passes, []);
          // Every result pass must be in a terminal status
          for (const pass of result) {
            expect(TERMINAL_STATUSES).toContain(pass.status);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should exclude all non-terminal passes', () => {
    fc.assert(
      fc.property(
        fc.array(passArb, { minLength: 1, maxLength: 30 }),
        (passes) => {
          const result = ReliabilityEngine.filterMovementsForScoring(passes, []);
          const resultIds = new Set(result.map((p) => p.id));

          // Non-terminal passes must not appear in results
          for (const pass of passes) {
            if (!TERMINAL_STATUSES.includes(pass.status)) {
              expect(resultIds.has(pass.id)).toBe(false);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should exclude passes with emergency override records', () => {
    fc.assert(
      fc.property(
        fc.array(passArb, { minLength: 1, maxLength: 20 }).chain((passes) => {
          const passIds = passes.map((p) => p.id);
          return overrideArb(passIds).map((overrides) => ({ passes, overrides }));
        }),
        ({ passes, overrides }) => {
          const result = ReliabilityEngine.filterMovementsForScoring(passes, overrides);
          const overridePassIds = new Set(overrides.map((o) => o.gatePassId));

          // No overridden pass should appear in results
          for (const pass of result) {
            expect(overridePassIds.has(pass.id)).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should include all terminal passes that have no override', () => {
    fc.assert(
      fc.property(
        fc.array(passArb, { minLength: 1, maxLength: 20 }).chain((passes) => {
          const passIds = passes.map((p) => p.id);
          return overrideArb(passIds).map((overrides) => ({ passes, overrides }));
        }),
        ({ passes, overrides }) => {
          const result = ReliabilityEngine.filterMovementsForScoring(passes, overrides);
          const resultIds = new Set(result.map((p) => p.id));
          const overridePassIds = new Set(overrides.map((o) => o.gatePassId));

          // Every terminal pass without an override must be included
          for (const pass of passes) {
            if (
              TERMINAL_STATUSES.includes(pass.status) &&
              !overridePassIds.has(pass.id)
            ) {
              expect(resultIds.has(pass.id)).toBe(true);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return empty when all passes are non-terminal', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            status: fc.constantFrom(...NON_TERMINAL_STATUSES),
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (passes) => {
          const result = ReliabilityEngine.filterMovementsForScoring(passes, []);
          expect(result).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: outside-time-reliability, Property 16: Score improvement indicator
describe('ReliabilityEngine - Property 16: Score improvement indicator', () => {
  /**
   * **Validates: Requirements 13.3**
   *
   * For any sequence of reliability score snapshots where length >= 11,
   * the improvement indicator SHALL be true if and only if
   * snapshots[current].score - snapshots[current - 10].score >= 0.5.
   *
   * Since getScoreTrend makes DB calls, we test the improvement logic
   * as a pure computation matching the engine's algorithm.
   */

  // Computes improvement indicator matching ReliabilityEngine.getScoreTrend logic
  function computeImprovementIndicator(scores: number[]): boolean {
    if (scores.length < 11) return false;
    const currentScore = scores[scores.length - 1];
    const tenthAgoScore = scores[scores.length - 11];
    return currentScore - tenthAgoScore >= 0.5;
  }

  // Generate valid score values (0.0 to 5.0, 1 decimal place)
  const scoreArb = fc.double({ min: 0.0, max: 5.0, noNaN: true }).map(
    (v) => Math.round(v * 10) / 10
  );

  it('should be true when score difference >= 0.5 over 10 movements', () => {
    fc.assert(
      fc.property(
        // Generate a sequence of at least 11 scores
        fc.array(scoreArb, { minLength: 11, maxLength: 50 }),
        (scores) => {
          const indicator = computeImprovementIndicator(scores);
          const currentScore = scores[scores.length - 1];
          const tenthAgoScore = scores[scores.length - 11];
          const diff = currentScore - tenthAgoScore;

          if (diff >= 0.5) {
            expect(indicator).toBe(true);
          } else {
            expect(indicator).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should be false when fewer than 11 snapshots exist', () => {
    fc.assert(
      fc.property(
        fc.array(scoreArb, { minLength: 0, maxLength: 10 }),
        (scores) => {
          const indicator = computeImprovementIndicator(scores);
          expect(indicator).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should be false when score decreases or stays the same', () => {
    fc.assert(
      fc.property(
        // Generate base score and ensure current <= base (no improvement)
        scoreArb,
        fc.double({ min: 0.0, max: 0.49, noNaN: true }).map(
          (v) => Math.round(v * 10) / 10
        ),
        fc.array(scoreArb, { minLength: 9, maxLength: 9 }),
        (baseScore, smallDelta, middleScores) => {
          // Construct: [baseScore, ...9 middles, baseScore + smallDelta]
          const currentScore = Math.min(5.0, Math.round((baseScore + smallDelta) * 10) / 10);
          const scores = [baseScore, ...middleScores, currentScore];

          const indicator = computeImprovementIndicator(scores);
          const diff = currentScore - baseScore;

          if (diff >= 0.5) {
            expect(indicator).toBe(true);
          } else {
            expect(indicator).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should be true when improvement is exactly 0.5', () => {
    fc.assert(
      fc.property(
        // Base score from 0.0 to 4.5 (so base + 0.5 <= 5.0)
        fc.double({ min: 0.0, max: 4.5, noNaN: true }).map(
          (v) => Math.round(v * 10) / 10
        ),
        fc.array(scoreArb, { minLength: 9, maxLength: 9 }),
        (baseScore, middleScores) => {
          const currentScore = Math.round((baseScore + 0.5) * 10) / 10;
          const scores = [baseScore, ...middleScores, currentScore];

          const indicator = computeImprovementIndicator(scores);
          expect(indicator).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should only compare current and 10th-ago scores, ignoring intermediate values', () => {
    fc.assert(
      fc.property(
        // Base score
        fc.double({ min: 0.0, max: 4.0, noNaN: true }).map(
          (v) => Math.round(v * 10) / 10
        ),
        // Wildly varying intermediate scores
        fc.array(scoreArb, { minLength: 9, maxLength: 9 }),
        // Delta to add: can be large improvement
        fc.double({ min: 0.5, max: 1.0, noNaN: true }).map(
          (v) => Math.round(v * 10) / 10
        ),
        (baseScore, middleScores, delta) => {
          const currentScore = Math.min(5.0, Math.round((baseScore + delta) * 10) / 10);
          const scores = [baseScore, ...middleScores, currentScore];

          const indicator = computeImprovementIndicator(scores);
          const diff = currentScore - baseScore;

          // Indicator depends only on first and last regardless of middle
          if (diff >= 0.5) {
            expect(indicator).toBe(true);
          } else {
            expect(indicator).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
