/**
 * Phase-9 HR leave-balance ENGINE unit suite (design §4.5, FR-5; FEAT-003).
 *
 * The engine (`apps/api/src/services/hr/leave-balance.ts`) is a PURE,
 * integer-only, I/O-free module — it imports NO `@campusgate/db`, so this suite
 * needs no mock and runs in the fast `npm test` pass. It pins:
 *   - ANNUAL_LUMP_SUM returns the full quota for the whole period;
 *   - MONTHLY_ACCRUAL integer-floor arithmetic and its edges
 *     (0 before Jan 1, elapsedMonths = 1 in January, 12 after Dec 31);
 *   - remaining surfaced even when negative (never clamped);
 *   - the same-day agreement: computeEntitlement at the APPROVE reference date
 *     min(approvalDate, Dec 31) equals the READ reference date min(today, Dec 31)
 *     for the same policy/year (the M1 approve-vs-read convergence);
 *   - the folded NIT monotonicity assertion
 *     computeEntitlement(...Feb) >= computeEntitlement(...Jan) for the same
 *     policy/year;
 *   - an approval sized to the mid-year cap is accepted while one day over it
 *     would be rejected (the over-balance gate the approve route enforces).
 */
import { describe, expect, it } from "vitest";
import {
  computeEntitlement,
  computeBalance,
  type LeaveBalancePolicy,
} from "../leave-balance.js";

// UTC date builders so the suite is timezone-independent (the engine uses UTC
// getters). `d(y, m, day)` — m is 1-based for readability.
const d = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day));

const annual = (quota: number): LeaveBalancePolicy => ({
  annualQuotaDays: quota,
  accrualRule: "ANNUAL_LUMP_SUM",
});
const monthly = (quota: number): LeaveBalancePolicy => ({
  annualQuotaDays: quota,
  accrualRule: "MONTHLY_ACCRUAL",
});

describe("computeEntitlement — ANNUAL_LUMP_SUM", () => {
  it("returns the full quota regardless of the reference date inside the period", () => {
    const policy = annual(24);
    expect(computeEntitlement(policy, 2026, d(2026, 1, 1))).toBe(24);
    expect(computeEntitlement(policy, 2026, d(2026, 6, 15))).toBe(24);
    expect(computeEntitlement(policy, 2026, d(2026, 12, 31))).toBe(24);
  });

  it("returns the full quota even before Jan 1 and after Dec 31 (whole-period grant)", () => {
    const policy = annual(24);
    expect(computeEntitlement(policy, 2026, d(2025, 12, 31))).toBe(24);
    expect(computeEntitlement(policy, 2026, d(2027, 1, 1))).toBe(24);
  });

  it("a zero quota yields zero", () => {
    expect(computeEntitlement(annual(0), 2026, d(2026, 6, 1))).toBe(0);
  });
});

describe("computeEntitlement — MONTHLY_ACCRUAL (integer floor, edges)", () => {
  it("is 0 before Jan 1 of the period year", () => {
    expect(computeEntitlement(monthly(24), 2026, d(2025, 12, 31))).toBe(0);
    expect(computeEntitlement(monthly(24), 2026, d(2024, 7, 1))).toBe(0);
  });

  it("elapsedMonths = 1 in January → floor(quota / 12)", () => {
    // 24/12 = 2 exactly.
    expect(computeEntitlement(monthly(24), 2026, d(2026, 1, 1))).toBe(2);
    expect(computeEntitlement(monthly(24), 2026, d(2026, 1, 31))).toBe(2);
    // 25/12 = 2.08… → floor 2 (integer-only, no fractional drift).
    expect(computeEntitlement(monthly(25), 2026, d(2026, 1, 15))).toBe(2);
  });

  it("is 12 months (full quota) after Dec 31 of the period year", () => {
    expect(computeEntitlement(monthly(24), 2026, d(2027, 1, 1))).toBe(24);
    expect(computeEntitlement(monthly(24), 2026, d(2030, 6, 1))).toBe(24);
  });

  it("accrues per the reference month with an integer floor at each step", () => {
    const policy = monthly(24); // 2 days/month exactly
    expect(computeEntitlement(policy, 2026, d(2026, 6, 10))).toBe(12); // floor(24*6/12)
    expect(computeEntitlement(policy, 2026, d(2026, 12, 31))).toBe(24); // floor(24*12/12)
  });

  it("floors a non-divisible quota — no float, no rounding up", () => {
    const policy = monthly(10); // 10/12 per month
    // Jan: floor(10*1/12)=0, Feb: floor(10*2/12)=1, Jun: floor(10*6/12)=5,
    // Dec: floor(10*12/12)=10.
    expect(computeEntitlement(policy, 2026, d(2026, 1, 20))).toBe(0);
    expect(computeEntitlement(policy, 2026, d(2026, 2, 20))).toBe(1);
    expect(computeEntitlement(policy, 2026, d(2026, 6, 20))).toBe(5);
    expect(computeEntitlement(policy, 2026, d(2026, 12, 20))).toBe(10);
    // Every value is an exact integer.
    for (let month = 1; month <= 12; month += 1) {
      expect(Number.isInteger(computeEntitlement(policy, 2026, d(2026, month, 1)))).toBe(true);
    }
  });
});

describe("the folded NIT: monthly accrual is monotonic non-decreasing within a year", () => {
  it("computeEntitlement(...Feb) >= computeEntitlement(...Jan) for the same policy/year", () => {
    const policy = monthly(17); // deliberately non-divisible
    const jan = computeEntitlement(policy, 2026, d(2026, 1, 1));
    const feb = computeEntitlement(policy, 2026, d(2026, 2, 1));
    expect(feb).toBeGreaterThanOrEqual(jan);
  });

  it("holds across every consecutive month pair for a range of quotas", () => {
    for (const quota of [0, 1, 7, 10, 12, 17, 24, 25, 100]) {
      const policy = monthly(quota);
      let prev = computeEntitlement(policy, 2026, d(2025, 12, 31)); // 0 (before period)
      for (let month = 1; month <= 12; month += 1) {
        const cur = computeEntitlement(policy, 2026, d(2026, month, 15));
        expect(cur).toBeGreaterThanOrEqual(prev);
        prev = cur;
      }
      // After Dec 31 never drops below December's value.
      expect(computeEntitlement(policy, 2026, d(2027, 1, 1))).toBeGreaterThanOrEqual(prev);
    }
  });
});

describe("the M1 approve-vs-read agreement at the shared min(date, Dec 31) reference", () => {
  // The route applies referenceDate = min(operationDate, Dec 31 of periodYear)
  // identically for the balance READ (operationDate = today) and the APPROVE
  // decision (operationDate = approvalDate). This asserts the engine makes the
  // two agree when both reduce to the same clamped reference date.
  const refRule = (operationDate: Date, periodYear: number) => {
    const eoy = d(periodYear, 12, 31);
    return operationDate.getTime() < eoy.getTime() ? operationDate : eoy;
  };

  it("an approval and a read on the same in-period day compute the same entitlement", () => {
    const policy = monthly(24);
    const sameDay = d(2026, 6, 15);
    const approveRef = refRule(sameDay, 2026);
    const readRef = refRule(sameDay, 2026);
    expect(computeEntitlement(policy, 2026, approveRef)).toBe(
      computeEntitlement(policy, 2026, readRef),
    );
  });

  it("an approval after year-end and a read after year-end both clamp to Dec 31 → equal", () => {
    const policy = monthly(24);
    const approveRef = refRule(d(2027, 3, 1), 2026); // clamps to Dec 31 2026
    const readRef = refRule(d(2028, 1, 1), 2026); // also clamps to Dec 31 2026
    expect(computeEntitlement(policy, 2026, approveRef)).toBe(24);
    expect(computeEntitlement(policy, 2026, readRef)).toBe(24);
    expect(computeEntitlement(policy, 2026, approveRef)).toBe(
      computeEntitlement(policy, 2026, readRef),
    );
  });
});

describe("computeBalance — remaining surfaced even when negative", () => {
  it("returns the integer triple { entitlement, taken, remaining }", () => {
    const balance = computeBalance(annual(24), 2026, d(2026, 6, 1), 10);
    expect(balance).toEqual({ entitlement: 24, taken: 10, remaining: 14 });
  });

  it("surfaces a negative remaining (never clamps to zero)", () => {
    // Quota cut mid-year leaves more taken than entitled — must stay visible.
    const balance = computeBalance(annual(5), 2026, d(2026, 6, 1), 8);
    expect(balance.remaining).toBe(-3);
  });

  it("a mid-year accrual balance tracks the floored entitlement", () => {
    // MONTHLY_ACCRUAL 24/yr, June → entitlement 12; 4 taken → 8 remaining.
    const balance = computeBalance(monthly(24), 2026, d(2026, 6, 1), 4);
    expect(balance).toEqual({ entitlement: 12, taken: 4, remaining: 8 });
  });
});

describe("the mid-year cap gate: at-cap accepted, one day over rejected", () => {
  // The approve route denies when takenExcludingThis + requestedDays > entitlement.
  // These assert the engine's entitlement makes an at-cap approval pass and a
  // one-day-over approval fail for a MONTHLY_ACCRUAL policy at mid-year.
  const policy = monthly(24); // June entitlement = 12
  const approvalDate = d(2026, 6, 15);
  const periodYear = 2026;
  const entitlement = computeEntitlement(policy, periodYear, approvalDate);

  it("the entitlement at the mid-year approval date is the floored accrual", () => {
    expect(entitlement).toBe(12);
  });

  it("an approval sized exactly to the remaining cap is within balance", () => {
    const takenExcludingThis = 10;
    const requestedDays = 2; // 10 + 2 === 12 (== entitlement) → accepted
    expect(takenExcludingThis + requestedDays).toBeLessThanOrEqual(entitlement);
  });

  it("one day over the cap exceeds the balance", () => {
    const takenExcludingThis = 10;
    const requestedDays = 3; // 10 + 3 === 13 (> 12) → rejected
    expect(takenExcludingThis + requestedDays).toBeGreaterThan(entitlement);
  });
});
