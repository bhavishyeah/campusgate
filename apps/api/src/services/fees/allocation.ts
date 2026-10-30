import type { StudentChargeStatusValue } from "@campusgate/shared";

/**
 * Allocation + outstanding + charge-status + receipt-number helpers (design
 * §D.1/§D.5 step 5/§D.2 receipt note). ALL money math is BigInt — no money
 * value ever round-trips through JS `Number` here.
 */

/** A charge as the allocation planner needs it (money is BigInt). */
export interface ChargeForAllocation {
  id: string;
  amountPaise: bigint;
  /** Already-allocated total against this charge (BigInt). */
  allocatedPaise: bigint;
  /** dueDate ASC NULLS LAST, then postedAt ASC — the ordering key inputs. */
  dueDate: Date | null;
  postedAt: Date;
}

/** One planned allocation line (not yet persisted). */
export interface PlannedAllocation {
  studentChargeId: string;
  amountPaise: bigint;
  /** The charge's status AFTER this allocation (forward-only). */
  nextStatus: StudentChargeStatusValue;
}

export interface AllocationPlan {
  allocations: PlannedAllocation[];
  /** Sum of all planned allocation amounts (BigInt). Invariant: <= payment amount. */
  allocatedTotal: bigint;
  /** Captured amount left unallocated (overpayment credit; >= 0). */
  unallocatedRemainder: bigint;
}

/** Outstanding for one charge = amount − already-allocated, floored at 0. */
export function chargeOutstanding(charge: {
  amountPaise: bigint;
  allocatedPaise: bigint;
}): bigint {
  const out = charge.amountPaise - charge.allocatedPaise;
  return out > 0n ? out : 0n;
}

/**
 * Total outstanding across a set of charges and their allocations. Both inputs
 * carry BigInt money; computed on read, never stored (FR-11).
 */
export function computeOutstanding(
  charges: { id: string; amountPaise: bigint }[],
  allocations: { studentChargeId: string; amountPaise: bigint }[],
): bigint {
  const chargeSum = charges.reduce((acc, c) => acc + c.amountPaise, 0n);
  const allocSum = allocations.reduce((acc, a) => acc + a.amountPaise, 0n);
  const out = chargeSum - allocSum;
  return out > 0n ? out : 0n;
}

/** Map a charge's outstanding to its forward-only status. */
export function nextChargeStatus(outstanding: bigint): StudentChargeStatusValue {
  if (outstanding <= 0n) return "PAID";
  return "PARTIALLY_PAID";
}

/**
 * Deterministic oldest-due-first allocation (§D.5 step 5). Walk the charges
 * ordered dueDate ASC NULLS LAST then postedAt ASC; for each, allocate
 * min(remaining, charge.outstanding). Overpayment leaves the remainder
 * unallocated (a slice-7.1 credit; the receipt is still for the full captured
 * amount); shortfall allocates what arrived. Invariant: sum(allocations) <=
 * amountPaise and each allocation <= that charge's outstanding.
 */
export function planAllocation(
  amountPaise: bigint,
  orderedCharges: ChargeForAllocation[],
): AllocationPlan {
  const sorted = [...orderedCharges].sort(compareChargesForAllocation);
  const allocations: PlannedAllocation[] = [];
  let remaining = amountPaise;
  let allocatedTotal = 0n;

  for (const charge of sorted) {
    if (remaining <= 0n) break;
    const outstanding = chargeOutstanding(charge);
    if (outstanding <= 0n) continue; // already PAID → contributes nothing
    const take = remaining < outstanding ? remaining : outstanding;
    if (take <= 0n) continue;
    const newOutstanding = outstanding - take;
    allocations.push({
      studentChargeId: charge.id,
      amountPaise: take,
      nextStatus: nextChargeStatus(newOutstanding),
    });
    allocatedTotal += take;
    remaining -= take;
  }

  const unallocatedRemainder = amountPaise - allocatedTotal;
  return {
    allocations,
    allocatedTotal,
    unallocatedRemainder: unallocatedRemainder > 0n ? unallocatedRemainder : 0n,
  };
}

/** dueDate ASC NULLS LAST, then postedAt ASC. */
export function compareChargesForAllocation(
  a: ChargeForAllocation,
  b: ChargeForAllocation,
): number {
  const aDue = a.dueDate ? a.dueDate.getTime() : null;
  const bDue = b.dueDate ? b.dueDate.getTime() : null;
  if (aDue !== bDue) {
    if (aDue === null) return 1; // NULLS LAST
    if (bDue === null) return -1;
    return aDue - bDue;
  }
  const aPosted = a.postedAt.getTime();
  const bPosted = b.postedAt.getTime();
  if (aPosted !== bPosted) return aPosted - bPosted;
  // stable tie-break by id so the plan is deterministic
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Format a human-readable receipt number from the monotonic per-institution
 * sequence (§D.2 NIT-3): RCPT-<institutionShort>-<YYYY>-<zero-padded sequence>.
 */
export function formatReceiptNumber(
  institutionId: string,
  year: number,
  sequence: number,
): string {
  const short = institutionShort(institutionId);
  const padded = String(sequence).padStart(6, "0");
  return `RCPT-${short}-${year}-${padded}`;
}

/** A short, stable uppercase token derived from the institution id. */
export function institutionShort(institutionId: string): string {
  const cleaned = institutionId.replace(/[^a-zA-Z0-9]/g, "");
  return cleaned.slice(-6).toUpperCase() || "INST";
}
