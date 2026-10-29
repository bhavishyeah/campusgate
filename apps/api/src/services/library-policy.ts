/**
 * Pure library-policy helpers (design §6). No I/O — the ONE definition of the
 * circulation policy (loan period, borrowing limit, renewals, fines) resolved
 * from `InstitutionModule.settings` JSON, plus the pure due-date / overdue-days
 * / fine-amount computations used by issue, return, lost and the reports so
 * they can never disagree.
 */

export interface LibraryPolicy {
  /** `dueDate = issueDate + loanPeriodDays`. */
  loanPeriodDays: number;
  /** Borrowing limit; issue refuses when the student's ACTIVE loan count ≥ this. */
  maxActiveLoansPerStudent: number;
  /** Renewal cap. */
  maxRenewals: number;
  /** When false, NO LibraryFine is ever auto-created. */
  finesEnabled: boolean;
  /** Money/day used only when `finesEnabled`. */
  overdueFinePerDay: number;
  /** Flat fine on LOST when `finesEnabled`. */
  lostFineAmount: number;
  /** A RESERVED hold a student does not collect EXPIRES after N days. */
  reservationExpiryDays: number;
}

const DEFAULTS: LibraryPolicy = {
  loanPeriodDays: 14,
  maxActiveLoansPerStudent: 3,
  maxRenewals: 2,
  finesEnabled: false,
  overdueFinePerDay: 0,
  lostFineAmount: 0,
  reservationExpiryDays: 7,
};

/** A finite number clamped to >= 0, else the documented default. */
function nonNegNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 0 ? 0 : value;
  }
  return fallback;
}

/**
 * Resolve an institution's library policy from `InstitutionModule.settings`
 * JSON (unknown shape). Any absent/invalid key falls back to the documented
 * Phase 5 default (design §6); negatives are clamped to 0. Never throws on a
 * malformed settings blob — always returns a complete, safe policy.
 */
export function libraryPolicy(settings: unknown): LibraryPolicy {
  const obj: Record<string, unknown> =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};

  return {
    loanPeriodDays: nonNegNumber(obj.loanPeriodDays, DEFAULTS.loanPeriodDays),
    maxActiveLoansPerStudent: nonNegNumber(
      obj.maxActiveLoansPerStudent,
      DEFAULTS.maxActiveLoansPerStudent,
    ),
    maxRenewals: nonNegNumber(obj.maxRenewals, DEFAULTS.maxRenewals),
    finesEnabled: typeof obj.finesEnabled === "boolean" ? obj.finesEnabled : DEFAULTS.finesEnabled,
    overdueFinePerDay: nonNegNumber(obj.overdueFinePerDay, DEFAULTS.overdueFinePerDay),
    lostFineAmount: nonNegNumber(obj.lostFineAmount, DEFAULTS.lostFineAmount),
    reservationExpiryDays: nonNegNumber(obj.reservationExpiryDays, DEFAULTS.reservationExpiryDays),
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `dueDate = issueDate + loanPeriodDays` (design §6). */
export function computeDueDate(issueDate: Date, loanPeriodDays: number): Date {
  return new Date(issueDate.getTime() + loanPeriodDays * MS_PER_DAY);
}

/**
 * Overdue days = `max(0, ceil((returnDate - dueDate)/day))` (design §8.4).
 * Returns 0 when the loan is returned on or before the due date.
 */
export function computeOverdueDays(dueDate: Date, returnDate: Date): number {
  const diffMs = returnDate.getTime() - dueDate.getTime();
  if (diffMs <= 0) return 0;
  return Math.ceil(diffMs / MS_PER_DAY);
}

/** OVERDUE fine amount = `overdueDays * overdueFinePerDay` (design §8.4). */
export function computeOverdueFine(overdueDays: number, overdueFinePerDay: number): number {
  const amount = overdueDays * overdueFinePerDay;
  return amount < 0 ? 0 : amount;
}
