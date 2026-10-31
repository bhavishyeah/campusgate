import type { Prisma } from "@campusgate/db";
import type { LedgerInputs } from "./ledger.js";

/**
 * Load the live per-charge ledger inputs (all five slice-7.1 streams) for one
 * charge inside a `withTenant` tx — the single DB query that feeds
 * `computeChargeOutstanding` / `computeChargeStatus`. Shared by the concession,
 * adjustment and refund services so the ledger aggregate is read one way.
 */
export async function loadChargeLedger(
  tx: Prisma.TransactionClient,
  institutionId: string,
  chargeId: string,
): Promise<(LedgerInputs & { chargeId: string }) | null> {
  const charge = await tx.studentCharge.findFirst({
    where: { id: chargeId, institutionId },
    select: {
      id: true,
      amountPaise: true,
      allocations: { select: { amountPaise: true } },
      concessionCredits: { select: { amountPaise: true } },
      refundReversals: { select: { amountPaise: true } },
      adjustments: { select: { amountPaise: true, direction: true } },
    },
  });
  if (!charge) return null;
  return {
    chargeId: charge.id,
    charge: { amountPaise: charge.amountPaise },
    allocations: charge.allocations,
    concessionCredits: charge.concessionCredits,
    adjustmentCredits: charge.adjustments.filter((a) => a.direction === "CREDIT"),
    adjustmentDebits: charge.adjustments.filter((a) => a.direction === "DEBIT"),
    refundReversals: charge.refundReversals,
  };
}
