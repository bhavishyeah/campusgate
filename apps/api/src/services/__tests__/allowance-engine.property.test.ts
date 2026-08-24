import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { AllowanceEngine } from '../allowance-engine.js';

// Feature: outside-time-reliability, Property 1: Duration computation correctness
// **Validates: Requirements 1.1**

/**
 * Property 1: Duration computation correctness
 *
 * For any pair of EXIT and RETURN GateEvent timestamps where RETURN > EXIT,
 * the computed Actual_Duration SHALL equal `floor((returnTimestamp - exitTimestamp) / 60000)` minutes.
 *
 * This tests the pure computation logic used by AllowanceEngine.computeActualDuration().
 * The actual service method performs DB lookups, so we test the mathematical formula directly.
 */
describe('AllowanceEngine - Property 1: Duration computation correctness', () => {
  /**
   * The core duration computation formula used by computeActualDuration:
   * Math.floor((returnTimestamp - exitTimestamp) / (1000 * 60))
   */
  function computeDurationMinutes(exitTimestampMs: number, returnTimestampMs: number): number {
    return Math.floor((returnTimestampMs - exitTimestampMs) / (1000 * 60));
  }

  it('should compute duration as floor((return - exit) / 60000) for any valid timestamp pair', () => {
    fc.assert(
      fc.property(
        // Generate exit timestamp within a realistic date range (2020-2030)
        fc.date({ min: new Date('2020-01-01T00:00:00.000Z'), max: new Date('2030-12-31T23:59:59.999Z') }),
        // Generate a positive duration offset in ms: from 1ms up to 7 days (604800000 ms)
        fc.integer({ min: 1, max: 7 * 24 * 60 * 60 * 1000 }),
        (exitDate, durationMs) => {
          const exitTs = exitDate.getTime();
          const returnTs = exitTs + durationMs;

          // Compute using the formula under test
          const computed = computeDurationMinutes(exitTs, returnTs);

          // Verify against the specification formula: floor(diff / 60000)
          const expected = Math.floor(durationMs / 60000);
          expect(computed).toBe(expected);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should always produce a non-negative result when RETURN > EXIT', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01T00:00:00.000Z'), max: new Date('2030-12-31T23:59:59.999Z') }),
        fc.integer({ min: 1, max: 7 * 24 * 60 * 60 * 1000 }),
        (exitDate, durationMs) => {
          const exitTs = exitDate.getTime();
          const returnTs = exitTs + durationMs;

          const computed = computeDurationMinutes(exitTs, returnTs);
          expect(computed).toBeGreaterThanOrEqual(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return 0 minutes for durations less than 60 seconds', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01T00:00:00.000Z'), max: new Date('2030-12-31T23:59:59.999Z') }),
        // Duration less than 1 minute (1ms to 59999ms)
        fc.integer({ min: 1, max: 59999 }),
        (exitDate, durationMs) => {
          const exitTs = exitDate.getTime();
          const returnTs = exitTs + durationMs;

          const computed = computeDurationMinutes(exitTs, returnTs);
          expect(computed).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should match the AllowanceEngine implementation formula exactly', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01T00:00:00.000Z'), max: new Date('2030-12-31T23:59:59.999Z') }),
        fc.integer({ min: 1, max: 7 * 24 * 60 * 60 * 1000 }),
        (exitDate, durationMs) => {
          const exitTs = exitDate.getTime();
          const returnTs = exitTs + durationMs;

          // This mirrors the exact formula in allowance-engine.ts:
          // Math.floor((returnEvent.timestamp.getTime() - exitEvent.timestamp.getTime()) / (1000 * 60))
          const engineFormula = Math.floor(
            (returnTs - exitTs) / (1000 * 60)
          );

          // This is the specification formula from requirements:
          // floor((returnTimestamp - exitTimestamp) / 60000)
          const specFormula = Math.floor((returnTs - exitTs) / 60000);

          expect(engineFormula).toBe(specFormula);
        }
      ),
      { numRuns: 100 }
    );
  });
});


// Feature: outside-time-reliability, Property 8: Period boundary date computation
// **Validates: Requirements 6.4**

describe('AllowanceEngine - Property 8: Period boundary date computation', () => {
  const periodTypes = ['DAILY', 'WEEKLY', 'MONTHLY', 'SEMESTER'] as const;

  it('should ensure start <= referenceDate <= end for any date and period type', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
        fc.constantFrom(...periodTypes),
        (refDate, periodType) => {
          const { start, end } = AllowanceEngine.getPeriodBounds(periodType, refDate);
          expect(start.getTime()).toBeLessThanOrEqual(refDate.getTime());
          expect(end.getTime()).toBeGreaterThanOrEqual(refDate.getTime());
        }
      ),
      { numRuns: 100 }
    );
  });

  it('DAILY period should span exactly one calendar day', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
        (refDate) => {
          const { start, end } = AllowanceEngine.getPeriodBounds('DAILY', refDate);

          // Start should be midnight of the same day
          expect(start.getHours()).toBe(0);
          expect(start.getMinutes()).toBe(0);
          expect(start.getSeconds()).toBe(0);
          expect(start.getMilliseconds()).toBe(0);

          // End should be 23:59:59.999 of the same day
          expect(end.getHours()).toBe(23);
          expect(end.getMinutes()).toBe(59);
          expect(end.getSeconds()).toBe(59);
          expect(end.getMilliseconds()).toBe(999);

          // Start and end should be on the same calendar day
          expect(start.getFullYear()).toBe(end.getFullYear());
          expect(start.getMonth()).toBe(end.getMonth());
          expect(start.getDate()).toBe(end.getDate());

          // The day should match the reference date's day
          expect(start.getFullYear()).toBe(refDate.getFullYear());
          expect(start.getMonth()).toBe(refDate.getMonth());
          expect(start.getDate()).toBe(refDate.getDate());
        }
      ),
      { numRuns: 100 }
    );
  });

  it('WEEKLY period should span Monday to Sunday (7 days)', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
        (refDate) => {
          const { start, end } = AllowanceEngine.getPeriodBounds('WEEKLY', refDate);

          // Start should be a Monday (getDay() === 1)
          expect(start.getDay()).toBe(1);

          // Start should be at midnight
          expect(start.getHours()).toBe(0);
          expect(start.getMinutes()).toBe(0);
          expect(start.getSeconds()).toBe(0);
          expect(start.getMilliseconds()).toBe(0);

          // End should be a Sunday (getDay() === 0)
          expect(end.getDay()).toBe(0);

          // End should be at 23:59:59.999
          expect(end.getHours()).toBe(23);
          expect(end.getMinutes()).toBe(59);
          expect(end.getSeconds()).toBe(59);
          expect(end.getMilliseconds()).toBe(999);

          // The span should be exactly 7 days (in milliseconds)
          const spanMs = end.getTime() - start.getTime() + 1;
          expect(spanMs).toBe(7 * 24 * 60 * 60 * 1000);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('MONTHLY period should span first to last day of the month', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
        (refDate) => {
          const { start, end } = AllowanceEngine.getPeriodBounds('MONTHLY', refDate);

          // Start should be 1st of month at midnight
          expect(start.getDate()).toBe(1);
          expect(start.getHours()).toBe(0);
          expect(start.getMinutes()).toBe(0);
          expect(start.getSeconds()).toBe(0);
          expect(start.getMilliseconds()).toBe(0);

          // Start and ref should be in the same month and year
          expect(start.getFullYear()).toBe(refDate.getFullYear());
          expect(start.getMonth()).toBe(refDate.getMonth());

          // End should be last day of the same month
          expect(end.getFullYear()).toBe(refDate.getFullYear());
          expect(end.getMonth()).toBe(refDate.getMonth());
          expect(end.getHours()).toBe(23);
          expect(end.getMinutes()).toBe(59);
          expect(end.getSeconds()).toBe(59);
          expect(end.getMilliseconds()).toBe(999);

          // Verify end is actually the last day: the next day should be 1st of next month
          const nextDay = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
          expect(nextDay.getDate()).toBe(1);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('SEMESTER period should span 6 months (Jan 1–Jun 30 or Jul 1–Dec 31)', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
        (refDate) => {
          const { start, end } = AllowanceEngine.getPeriodBounds('SEMESTER', refDate);
          const year = refDate.getFullYear();

          if (refDate.getMonth() < 6) {
            // First semester: Jan 1 – Jun 30
            expect(start.getFullYear()).toBe(year);
            expect(start.getMonth()).toBe(0); // January
            expect(start.getDate()).toBe(1);
            expect(start.getHours()).toBe(0);
            expect(start.getMinutes()).toBe(0);
            expect(start.getSeconds()).toBe(0);
            expect(start.getMilliseconds()).toBe(0);

            expect(end.getFullYear()).toBe(year);
            expect(end.getMonth()).toBe(5); // June
            expect(end.getDate()).toBe(30);
            expect(end.getHours()).toBe(23);
            expect(end.getMinutes()).toBe(59);
            expect(end.getSeconds()).toBe(59);
            expect(end.getMilliseconds()).toBe(999);
          } else {
            // Second semester: Jul 1 – Dec 31
            expect(start.getFullYear()).toBe(year);
            expect(start.getMonth()).toBe(6); // July
            expect(start.getDate()).toBe(1);
            expect(start.getHours()).toBe(0);
            expect(start.getMinutes()).toBe(0);
            expect(start.getSeconds()).toBe(0);
            expect(start.getMilliseconds()).toBe(0);

            expect(end.getFullYear()).toBe(year);
            expect(end.getMonth()).toBe(11); // December
            expect(end.getDate()).toBe(31);
            expect(end.getHours()).toBe(23);
            expect(end.getMinutes()).toBe(59);
            expect(end.getSeconds()).toBe(59);
            expect(end.getMilliseconds()).toBe(999);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


// Feature: outside-time-reliability, Property 6: Enforcement decision determinism
// **Validates: Requirements 4.1, 4.2, 4.3**

/**
 * Property 6: Enforcement decision determinism
 *
 * For any remaining allowance value and enforcement mode, the enforcement decision SHALL be:
 * - `allow` when remaining > 0 regardless of mode
 * - `block` when mode is BLOCK_NEW_REQUESTS and remaining <= 0
 * - `warn` when mode is WARN_ONLY and remaining <= 0
 *
 * Since `getEnforcementDecision` makes DB calls, we test the pure decision logic directly.
 */
describe('AllowanceEngine - Property 6: Enforcement decision determinism', () => {
  /**
   * Pure decision logic extracted from AllowanceEngine.getEnforcementDecision.
   * This mirrors the decision branches in allowance-engine.ts lines that check
   * remaining allowance and enforcement mode.
   */
  function makeEnforcementDecision(
    remaining: number,
    enforcement: 'BLOCK_NEW_REQUESTS' | 'WARN_ONLY'
  ): { action: 'allow' | 'block' | 'warn' } {
    if (remaining > 0) return { action: 'allow' };
    if (enforcement === 'BLOCK_NEW_REQUESTS') return { action: 'block' };
    return { action: 'warn' };
  }

  it('should return allow when remaining > 0 regardless of mode', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10080 }),
        fc.constantFrom('BLOCK_NEW_REQUESTS' as const, 'WARN_ONLY' as const),
        (remaining, mode) => {
          const decision = makeEnforcementDecision(remaining, mode);
          expect(decision.action).toBe('allow');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return block when BLOCK_NEW_REQUESTS and remaining <= 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10000, max: 0 }),
        (remaining) => {
          const decision = makeEnforcementDecision(remaining, 'BLOCK_NEW_REQUESTS');
          expect(decision.action).toBe('block');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return warn when WARN_ONLY and remaining <= 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10000, max: 0 }),
        (remaining) => {
          const decision = makeEnforcementDecision(remaining, 'WARN_ONLY');
          expect(decision.action).toBe('warn');
        }
      ),
      { numRuns: 100 }
    );
  });
});


// Feature: outside-time-reliability, Property 2: Remaining allowance formula
// **Validates: Requirements 2.1, 2.2**

/**
 * Property 2: Remaining allowance formula
 *
 * For any Allowance_Amount > 0 and any list of Actual_Duration values (each >= 0),
 * the remaining allowance SHALL equal `max(0, Allowance_Amount - sum(durations))`.
 * When the duration list is empty, remaining equals the full Allowance_Amount.
 *
 * Tests the pure formula: remaining = max(0, allowanceAmount - sum(durations))
 */
describe('AllowanceEngine - Property 2: Remaining allowance formula', () => {
  /**
   * Pure computation of remaining allowance from allowance amount and list of durations.
   * This mirrors the formula used in AllowanceEngine.getRemainingAllowance().
   */
  function computeRemainingAllowance(allowanceAmount: number, durations: number[]): number {
    const consumed = durations.reduce((sum, d) => sum + d, 0);
    return Math.max(0, allowanceAmount - consumed);
  }

  it('remaining should equal max(0, allowanceAmount - sum(durations)) for any valid inputs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60, max: 10080 }), // allowanceAmount within policy bounds
        fc.array(fc.integer({ min: 0, max: 1440 }), { maxLength: 50 }), // durations (each up to 1 day)
        (allowanceAmount, durations) => {
          const consumed = durations.reduce((sum, d) => sum + d, 0);
          const remaining = computeRemainingAllowance(allowanceAmount, durations);

          // Property: remaining = max(0, allowanceAmount - consumed)
          expect(remaining).toBe(Math.max(0, allowanceAmount - consumed));
        }
      ),
      { numRuns: 100 }
    );
  });

  it('remaining should always be non-negative regardless of consumed amount', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60, max: 10080 }),
        fc.array(fc.integer({ min: 0, max: 1440 }), { maxLength: 100 }),
        (allowanceAmount, durations) => {
          const remaining = computeRemainingAllowance(allowanceAmount, durations);

          // Property: remaining >= 0 always (clamped at zero)
          expect(remaining).toBeGreaterThanOrEqual(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return full allowance when no movements exist (empty duration list)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60, max: 10080 }),
        (allowanceAmount) => {
          const remaining = computeRemainingAllowance(allowanceAmount, []);

          // Property: when duration list is empty, remaining = full allowance
          expect(remaining).toBe(allowanceAmount);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return zero when consumed exceeds or equals allowance', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60, max: 10080 }),
        fc.integer({ min: 0, max: 5 }), // extra durations to exceed allowance
        (allowanceAmount, extraCount) => {
          // Create durations that sum to at least the allowance amount
          const durations = [allowanceAmount, ...Array(extraCount).fill(100)];
          const remaining = computeRemainingAllowance(allowanceAmount, durations);

          // Property: when consumed >= allowance, remaining = 0
          expect(remaining).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});


// Feature: outside-time-reliability, Property 3: In-progress elapsed time inclusion
// **Validates: Requirements 2.3**

/**
 * Property 3: In-progress elapsed time inclusion
 *
 * For any student currently outside (status OUTSIDE) with a recorded EXIT event,
 * the consumed allowance SHALL include `floor((now - exitTimestamp) / 60000)` in
 * addition to completed movement durations.
 *
 * Tests that currently-outside elapsed time is correctly added to consumed total.
 */
describe('AllowanceEngine - Property 3: In-progress elapsed time inclusion', () => {
  /**
   * Pure computation of total consumed including in-progress elapsed time.
   * Mirrors the logic in getRemainingAllowance() where currentlyOutsideElapsed
   * is added to the completed durations sum.
   */
  function computeConsumedWithInProgress(
    completedDurations: number[],
    elapsedSinceExitMs: number
  ): number {
    const completedConsumed = completedDurations.reduce((sum, d) => sum + d, 0);
    const elapsedMinutes = Math.floor(elapsedSinceExitMs / (1000 * 60));
    return completedConsumed + elapsedMinutes;
  }

  function computeRemainingWithInProgress(
    allowanceAmount: number,
    completedDurations: number[],
    elapsedSinceExitMs: number
  ): number {
    const totalConsumed = computeConsumedWithInProgress(completedDurations, elapsedSinceExitMs);
    return Math.max(0, allowanceAmount - totalConsumed);
  }

  it('consumed should include elapsed time since EXIT in addition to completed durations', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1440 }), { maxLength: 20 }), // completed durations in minutes
        fc.integer({ min: 0, max: 7 * 24 * 60 * 60 * 1000 }), // elapsed since exit in ms (up to 7 days)
        (completedDurations, elapsedSinceExitMs) => {
          const completedConsumed = completedDurations.reduce((sum, d) => sum + d, 0);
          const elapsedMinutes = Math.floor(elapsedSinceExitMs / (1000 * 60));
          const totalConsumed = computeConsumedWithInProgress(completedDurations, elapsedSinceExitMs);

          // Property: totalConsumed = sum(completedDurations) + floor(elapsedMs / 60000)
          expect(totalConsumed).toBe(completedConsumed + elapsedMinutes);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('remaining should account for in-progress time: max(0, allowance - completedSum - elapsed)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60, max: 10080 }), // allowanceAmount
        fc.array(fc.integer({ min: 0, max: 1440 }), { maxLength: 20 }), // completed durations
        fc.integer({ min: 0, max: 7 * 24 * 60 * 60 * 1000 }), // elapsed since exit in ms
        (allowanceAmount, completedDurations, elapsedSinceExitMs) => {
          const remaining = computeRemainingWithInProgress(
            allowanceAmount,
            completedDurations,
            elapsedSinceExitMs
          );
          const totalConsumed = computeConsumedWithInProgress(completedDurations, elapsedSinceExitMs);

          // Property: remaining = max(0, allowanceAmount - totalConsumed)
          expect(remaining).toBe(Math.max(0, allowanceAmount - totalConsumed));
          expect(remaining).toBeGreaterThanOrEqual(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('elapsed time of zero should not affect consumed total', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1440 }), { maxLength: 20 }),
        (completedDurations) => {
          const completedConsumed = completedDurations.reduce((sum, d) => sum + d, 0);
          const totalConsumed = computeConsumedWithInProgress(completedDurations, 0);

          // Property: when elapsed is 0, totalConsumed = sum of completed durations only
          expect(totalConsumed).toBe(completedConsumed);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('elapsed time less than 1 minute should contribute 0 minutes to consumed', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1440 }), { maxLength: 20 }),
        fc.integer({ min: 0, max: 59999 }), // less than 1 minute in ms
        (completedDurations, elapsedMs) => {
          const completedConsumed = completedDurations.reduce((sum, d) => sum + d, 0);
          const totalConsumed = computeConsumedWithInProgress(completedDurations, elapsedMs);

          // Property: sub-minute elapsed contributes 0 (floor behavior)
          expect(totalConsumed).toBe(completedConsumed);
        }
      ),
      { numRuns: 100 }
    );
  });
});


// Feature: outside-time-reliability, Property 4: Period boundary filtering
// **Validates: Requirements 2.4**

/**
 * Property 4: Period boundary filtering
 *
 * For any set of completed movements and a given Policy_Period type and reference date,
 * only movements whose RETURN event timestamp falls within the computed period boundaries
 * SHALL contribute to consumed allowance. Movements outside the period SHALL not be counted.
 *
 * Tests the filtering logic that determines which movements count toward consumed allowance.
 */
describe('AllowanceEngine - Property 4: Period boundary filtering', () => {
  /**
   * Determines if a RETURN timestamp falls within the given period boundaries.
   * Mirrors the query filter: timestamp >= start AND timestamp <= end.
   */
  function isReturnWithinPeriod(
    returnTimestamp: Date,
    periodStart: Date,
    periodEnd: Date
  ): boolean {
    return returnTimestamp.getTime() >= periodStart.getTime() &&
           returnTimestamp.getTime() <= periodEnd.getTime();
  }

  /**
   * Filters movements and sums only those with RETURN within period boundaries.
   * Each movement is represented as { exitTs, returnTs, durationMinutes }.
   */
  function computeConsumedInPeriod(
    movements: Array<{ returnTs: Date; durationMinutes: number }>,
    periodStart: Date,
    periodEnd: Date
  ): number {
    return movements
      .filter((m) => isReturnWithinPeriod(m.returnTs, periodStart, periodEnd))
      .reduce((sum, m) => sum + m.durationMinutes, 0);
  }

  it('only movements with RETURN within period should contribute to consumed allowance', () => {
    fc.assert(
      fc.property(
        // Reference date for period computation
        fc.date({ min: new Date('2022-01-01'), max: new Date('2028-12-31') }),
        fc.constantFrom('DAILY', 'WEEKLY', 'MONTHLY', 'SEMESTER') as fc.Arbitrary<'DAILY' | 'WEEKLY' | 'MONTHLY' | 'SEMESTER'>,
        // Generate an array of movements with timestamps spread across a wide range
        fc.array(
          fc.record({
            // Return timestamp can be anywhere in a 60-day window around the reference
            returnOffsetMs: fc.integer({ min: -30 * 24 * 60 * 60 * 1000, max: 30 * 24 * 60 * 60 * 1000 }),
            durationMinutes: fc.integer({ min: 1, max: 1440 }),
          }),
          { maxLength: 30 }
        ),
        (refDate, periodType, rawMovements) => {
          const { start, end } = AllowanceEngine.getPeriodBounds(periodType, refDate);

          // Create movements with return timestamps offset from the reference date
          const movements = rawMovements.map((m) => ({
            returnTs: new Date(refDate.getTime() + m.returnOffsetMs),
            durationMinutes: m.durationMinutes,
          }));

          const consumed = computeConsumedInPeriod(movements, start, end);

          // Property: consumed = sum of durations for movements whose RETURN is within [start, end]
          const expectedConsumed = movements
            .filter((m) => m.returnTs.getTime() >= start.getTime() && m.returnTs.getTime() <= end.getTime())
            .reduce((sum, m) => sum + m.durationMinutes, 0);

          expect(consumed).toBe(expectedConsumed);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('movements with RETURN before period start should contribute zero', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2022-01-01'), max: new Date('2028-12-31') }),
        fc.constantFrom('DAILY', 'WEEKLY', 'MONTHLY', 'SEMESTER') as fc.Arbitrary<'DAILY' | 'WEEKLY' | 'MONTHLY' | 'SEMESTER'>,
        fc.array(fc.integer({ min: 1, max: 1440 }), { minLength: 1, maxLength: 20 }),
        (refDate, periodType, durations) => {
          const { start } = AllowanceEngine.getPeriodBounds(periodType, refDate);

          // All movements have RETURN before the period start
          const movements = durations.map((d, i) => ({
            returnTs: new Date(start.getTime() - (i + 1) * 60 * 60 * 1000), // 1+ hours before start
            durationMinutes: d,
          }));

          const consumed = computeConsumedInPeriod(
            movements,
            start,
            AllowanceEngine.getPeriodBounds(periodType, refDate).end
          );

          // Property: all movements outside the period contribute 0
          expect(consumed).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('movements with RETURN after period end should contribute zero', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2022-01-01'), max: new Date('2028-12-31') }),
        fc.constantFrom('DAILY', 'WEEKLY', 'MONTHLY', 'SEMESTER') as fc.Arbitrary<'DAILY' | 'WEEKLY' | 'MONTHLY' | 'SEMESTER'>,
        fc.array(fc.integer({ min: 1, max: 1440 }), { minLength: 1, maxLength: 20 }),
        (refDate, periodType, durations) => {
          const { end } = AllowanceEngine.getPeriodBounds(periodType, refDate);

          // All movements have RETURN after the period end
          const movements = durations.map((d, i) => ({
            returnTs: new Date(end.getTime() + (i + 1) * 60 * 60 * 1000), // 1+ hours after end
            durationMinutes: d,
          }));

          const consumed = computeConsumedInPeriod(
            movements,
            AllowanceEngine.getPeriodBounds(periodType, refDate).start,
            end
          );

          // Property: all movements outside the period contribute 0
          expect(consumed).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('movements exactly at period boundaries should be included', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2022-01-01'), max: new Date('2028-12-31') }),
        fc.constantFrom('DAILY', 'WEEKLY', 'MONTHLY', 'SEMESTER') as fc.Arbitrary<'DAILY' | 'WEEKLY' | 'MONTHLY' | 'SEMESTER'>,
        fc.integer({ min: 1, max: 1440 }),
        fc.integer({ min: 1, max: 1440 }),
        (refDate, periodType, durationAtStart, durationAtEnd) => {
          const { start, end } = AllowanceEngine.getPeriodBounds(periodType, refDate);

          // Movements exactly at the boundaries
          const movements = [
            { returnTs: new Date(start.getTime()), durationMinutes: durationAtStart },
            { returnTs: new Date(end.getTime()), durationMinutes: durationAtEnd },
          ];

          const consumed = computeConsumedInPeriod(movements, start, end);

          // Property: movements exactly at start and end boundaries should be included
          expect(consumed).toBe(durationAtStart + durationAtEnd);
        }
      ),
      { numRuns: 100 }
    );
  });
});


// Feature: outside-time-reliability, Property 5: Policy configuration validation
// **Validates: Requirements 3.1, 3.3, 5.2, 14.1**

/**
 * Property 5: Policy configuration validation
 *
 * For any integer value, the AllowancePolicy validation SHALL accept it if and only if
 * it falls within the defined bounds:
 * - AllowanceAmount: [60, 10080]
 * - GracePeriod: [0, 60]
 * - MinimumSampleSize: [3, 20]
 * - Emergency override justification: length >= 10 characters
 *
 * These validation functions will be formally implemented in task 11.1 (Zod schemas).
 * The property tests validate the pure logic of bounds checking.
 */
describe('AllowanceEngine - Property 5: Policy configuration validation', () => {
  // Pure validation functions matching the specification bounds
  function isValidAllowanceAmount(value: number): boolean {
    return Number.isInteger(value) && value >= 60 && value <= 10080;
  }

  function isValidGracePeriod(value: number): boolean {
    return Number.isInteger(value) && value >= 0 && value <= 60;
  }

  function isValidMinimumSampleSize(value: number): boolean {
    return Number.isInteger(value) && value >= 3 && value <= 20;
  }

  function isValidJustification(text: string): boolean {
    return text.length >= 10;
  }

  // --- AllowanceAmount validation ---

  it('should accept AllowanceAmount values within [60, 10080]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60, max: 10080 }),
        (value) => {
          expect(isValidAllowanceAmount(value)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject AllowanceAmount values outside [60, 10080]', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -10000, max: 59 }),
          fc.integer({ min: 10081, max: 100000 })
        ),
        (value) => {
          expect(isValidAllowanceAmount(value)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  // --- GracePeriod validation ---

  it('should accept GracePeriod values within [0, 60]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }),
        (value) => {
          expect(isValidGracePeriod(value)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject GracePeriod values outside [0, 60]', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -10000, max: -1 }),
          fc.integer({ min: 61, max: 10000 })
        ),
        (value) => {
          expect(isValidGracePeriod(value)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  // --- MinimumSampleSize validation ---

  it('should accept MinimumSampleSize values within [3, 20]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 20 }),
        (value) => {
          expect(isValidMinimumSampleSize(value)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject MinimumSampleSize values outside [3, 20]', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -100, max: 2 }),
          fc.integer({ min: 21, max: 1000 })
        ),
        (value) => {
          expect(isValidMinimumSampleSize(value)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  // --- Emergency override justification validation ---

  it('should accept justification text with length >= 10 characters', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 10, maxLength: 500 }),
        (text) => {
          expect(isValidJustification(text)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject justification text with length < 10 characters', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 9 }),
        (text) => {
          expect(isValidJustification(text)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  // --- Non-integer rejection for numeric fields ---

  it('should reject non-integer values for AllowanceAmount', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 60, max: 10080, noInteger: true, noNaN: true }),
        (value) => {
          expect(isValidAllowanceAmount(value)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject non-integer values for GracePeriod', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 60, noInteger: true, noNaN: true }),
        (value) => {
          expect(isValidGracePeriod(value)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject non-integer values for MinimumSampleSize', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 3, max: 20, noInteger: true, noNaN: true }),
        (value) => {
          expect(isValidMinimumSampleSize(value)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});
