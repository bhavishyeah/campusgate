/**
 * HR leave-balance engine (design §4.5, FR-5) — a PURE, deterministic,
 * integer-only module. It has NO `@campusgate/db` import and performs NO I/O:
 * it is the single source of truth for leave entitlement/balance, unit-testable
 * without a database.
 *
 * There is exactly ONE entitlement function (`computeEntitlement`) and ONE
 * reference-date rule — `referenceDate = min(operationDate, Dec 31 of
 * periodYear)` — applied identically by the authoritative balance READ
 * (`operationDate = today`) and by the APPROVE decision (`operationDate =
 * approvalDate`), so the two can never disagree for the same
 * `(employee, leaveType, year)` (closes the MONTHLY_ACCRUAL approve-vs-read
 * divergence, design §4.5 M1).
 *
 * Integer days only — no float: MONTHLY_ACCRUAL uses integer floor via
 * Math.floor over an integer product, so there is no binary-fraction drift.
 */

/** The accrual rules supported by the engine (mirrors the pg `HrAccrualRule`). */
export type AccrualRule = "ANNUAL_LUMP_SUM" | "MONTHLY_ACCRUAL";

/** The subset of an `hr_leave_policies` row the engine needs. */
export interface LeaveBalancePolicy {
  annualQuotaDays: number; // integer >= 0 (validated upstream + DB CHECK)
  accrualRule: AccrualRule;
}

/** The computed balance triple (all integer days). */
export interface LeaveBalance {
  entitlement: number;
  taken: number;
  remaining: number; // entitlement - taken; surfaced even if negative
}

/**
 * Elapsed months of `referenceDate` within `periodYear`, defined deterministically
 * (design §4.5):
 *   - 0  if referenceDate is before Jan 1 of periodYear;
 *   - the reference month number 1..12 (Jan=1 … Dec=12) if referenceDate falls
 *     inside periodYear;
 *   - 12 if referenceDate is after Dec 31 of periodYear.
 * Uses UTC getters so the result is timezone-independent.
 */
function elapsedMonths(periodYear: number, referenceDate: Date): number {
  const refYear = referenceDate.getUTCFullYear();
  if (refYear < periodYear) return 0;
  if (refYear > periodYear) return 12;
  return referenceDate.getUTCMonth() + 1; // 0-based month → 1..12
}

/**
 * Entitlement in integer days for a policy as of `referenceDate` within
 * `periodYear`.
 *   - ANNUAL_LUMP_SUM: the full `annualQuotaDays` for the whole period.
 *   - MONTHLY_ACCRUAL: floor(annualQuotaDays * elapsedMonths / 12) — pure integer
 *     arithmetic, no float. A January reference → elapsedMonths = 1 →
 *     floor(annualQuotaDays / 12); the only way to reach 0 is a reference date
 *     before the period's Jan 1.
 */
export function computeEntitlement(
  policy: LeaveBalancePolicy,
  periodYear: number,
  referenceDate: Date,
): number {
  if (policy.accrualRule === "ANNUAL_LUMP_SUM") {
    return policy.annualQuotaDays;
  }
  // MONTHLY_ACCRUAL
  const months = elapsedMonths(periodYear, referenceDate);
  return Math.floor((policy.annualQuotaDays * months) / 12);
}

/**
 * The balance triple for a policy given the sum of APPROVED leave days
 * (`approvedDaysSum`) in that `(employee, leaveType, periodYear)` accrual period.
 * `remaining = entitlement - taken` (integer), surfaced even if negative — never
 * silently clamped (a negative value signals data that predates a quota cut and
 * must be visible).
 */
export function computeBalance(
  policy: LeaveBalancePolicy,
  periodYear: number,
  referenceDate: Date,
  approvedDaysSum: number,
): LeaveBalance {
  const entitlement = computeEntitlement(policy, periodYear, referenceDate);
  const taken = approvedDaysSum;
  return { entitlement, taken, remaining: entitlement - taken };
}
