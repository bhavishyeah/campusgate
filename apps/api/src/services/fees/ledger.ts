import type { StudentChargeStatusValue } from "@campusgate/shared";
import { nextChargeStatus } from "./allocation.js";

/**
 * The single source of truth for a charge's effective state in slice 7.1
 * (design §E.5). Pure BigInt, no I/O. Both the read path (ledger / reports) and
 * the write path (status recompute after any posting) call these helpers so the
 * outstanding/status math never diverges.
 *
 * outstanding =
 *     charge.amountPaise
 *   − Σ payment_allocations          (slice 1, money in)
 *   − Σ concession_credits           (7.1, scholarship)
 *   − Σ adjustment CREDITs           (7.1, waiver/write-off/correction−)
 *   + Σ adjustment DEBITs            (7.1, correction+)
 *   + Σ refund_reversals             (7.1, money out → restores outstanding)
 *   , floored at 0, capped at amountPaise.
 *
 * It COMPOSES the slice-1 `allocation.ts` helpers (`nextChargeStatus`), never
 * forks them.
 */

export interface LedgerInputs {
  charge: { amountPaise: bigint };
  /** slice-1 payment_allocations against this charge. */
  allocations: { amountPaise: bigint }[];
  /** 7.1 concession credits against this charge. */
  concessionCredits: { amountPaise: bigint }[];
  /** 7.1 adjustment CREDITs (reduce outstanding). */
  adjustmentCredits: { amountPaise: bigint }[];
  /** 7.1 adjustment DEBITs (increase outstanding). */
  adjustmentDebits: { amountPaise: bigint }[];
  /** 7.1 refund reversals (restore outstanding when a refund settles). */
  refundReversals: { amountPaise: bigint }[];
}

function sum(rows: { amountPaise: bigint }[]): bigint {
  return rows.reduce((acc, r) => acc + r.amountPaise, 0n);
}

/** Outstanding for one charge from all five ledger streams, clamped [0, amount]. */
export function computeChargeOutstanding(i: LedgerInputs): bigint {
  const amount = i.charge.amountPaise;
  const raw =
    amount -
    sum(i.allocations) -
    sum(i.concessionCredits) -
    sum(i.adjustmentCredits) +
    sum(i.adjustmentDebits) +
    sum(i.refundReversals);
  if (raw <= 0n) return 0n;
  return raw > amount ? amount : raw;
}

/**
 * Effective status as a pure projection of outstanding:
 *   outstanding === 0        → PAID
 *   0 < outstanding < amount → PARTIALLY_PAID
 *   outstanding === amount   → PENDING
 * Adds the PENDING branch alongside the slice-1 `nextChargeStatus` PAID/
 * PARTIALLY_PAID mapping (which has no PENDING case because money only ever went
 * in). Backward moves are legitimate in 7.1 (a refund can take PAID→PENDING).
 */
export function computeChargeStatus(i: LedgerInputs): StudentChargeStatusValue {
  const outstanding = computeChargeOutstanding(i);
  if (outstanding >= i.charge.amountPaise) return "PENDING";
  return nextChargeStatus(outstanding);
}

export interface RefundReversalLine {
  studentChargeId: string;
  amountPaise: bigint;
}

export interface ReversalAllocation {
  studentChargeId: string;
  /** The original allocation amount the refunded transaction put on this charge. */
  amountPaise: bigint;
  /**
   * The room still available to restore on this charge right now =
   * charge.amountPaise − currentOutstanding (never push outstanding above the
   * snapshot). A charge concession-/waiver-zeroed since capture has less headroom
   * than the original allocation.
   */
  currentHeadroom: bigint;
}

export interface RefundReversalPlan {
  reversals: RefundReversalLine[];
  /**
   * Refunded paise that could not be restored to a charge (headroom consumed by
   * a later credit, or unallocated overpayment). Surfaced as
   * Refund.unreversiblePaise (MEDIUM-3) so cash-out always reconciles against
   * ledger-restored.
   */
  remainder: bigint;
}

/**
 * Distribute a refund's amount across the charges the ORIGINAL transaction's
 * allocations touched, newest-allocation-first, each line clamped to
 * min(originalAllocationToCharge, currentOutstandingHeadroom). Symmetric to
 * `planAllocation` but it RESTORES outstanding instead of consuming it.
 *
 * `allocationsNewestFirst` must already be ordered newest-allocation-first by
 * the caller (the service queries them `ORDER BY createdAt DESC`).
 */
export function planRefundReversal(
  refundAmount: bigint,
  allocationsNewestFirst: ReversalAllocation[],
): RefundReversalPlan {
  const reversals: RefundReversalLine[] = [];
  let remaining = refundAmount;

  for (const alloc of allocationsNewestFirst) {
    if (remaining <= 0n) break;
    const cap = alloc.amountPaise < alloc.currentHeadroom ? alloc.amountPaise : alloc.currentHeadroom;
    if (cap <= 0n) continue;
    const take = remaining < cap ? remaining : cap;
    if (take <= 0n) continue;
    reversals.push({ studentChargeId: alloc.studentChargeId, amountPaise: take });
    remaining -= take;
  }

  return { reversals, remainder: remaining > 0n ? remaining : 0n };
}
