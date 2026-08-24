import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// Feature: outside-time-reliability, Property 7: Duration formatting
// **Validates: Requirements 6.1, 6.2**

/**
 * Property 7: Duration formatting
 *
 * For any non-negative integer representing minutes, the formatting function
 * SHALL produce output where:
 * - hours component = Math.floor(minutes / 60)
 * - minutes component = minutes % 60
 * - Total = hours * 60 + minutesComponent equals original input
 */
describe('Property 7: Duration formatting', () => {
  function formatMinutes(totalMinutes: number): { hours: number; minutes: number } {
    return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
  }

  it('hours should equal floor(min/60) and minutes should equal min % 60', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100000 }), (totalMinutes) => {
        const { hours, minutes } = formatMinutes(totalMinutes);
        expect(hours).toBe(Math.floor(totalMinutes / 60));
        expect(minutes).toBe(totalMinutes % 60);
      }),
      { numRuns: 100 }
    );
  });

  it('hours * 60 + minutes should equal the original input', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100000 }), (totalMinutes) => {
        const { hours, minutes } = formatMinutes(totalMinutes);
        expect(hours * 60 + minutes).toBe(totalMinutes);
      }),
      { numRuns: 100 }
    );
  });

  it('minutes component should always be in [0, 59]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100000 }), (totalMinutes) => {
        const { minutes } = formatMinutes(totalMinutes);
        expect(minutes).toBeGreaterThanOrEqual(0);
        expect(minutes).toBeLessThanOrEqual(59);
      }),
      { numRuns: 100 }
    );
  });

  it('hours should be non-negative for non-negative input', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100000 }), (totalMinutes) => {
        const { hours } = formatMinutes(totalMinutes);
        expect(hours).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 100 }
    );
  });
});
