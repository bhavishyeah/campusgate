import type { Prisma } from "@campusgate/db";
import { recordAuditEvent } from "../audit.js";
import { computeChargeOutstanding, computeChargeStatus } from "./ledger.js";
import { loadChargeLedger } from "./ledger-query.js";

/**
 * Adjustment service (design §E.3/§E.5): manual corrections — waivers,
 * write-offs, charge corrections — as append-only adjusting ledger entries with
 * a reason + approver. NEVER destructive.
 *
 * `postAdjustment` MUST be called INSIDE a `withTenant(institutionId, tx)`
 * transaction. WAIVER/WRITE_OFF are forced CREDIT; a CORRECTION may be DEBIT. A
 * CREDIT is bounded by the charge's current outstanding; a DEBIT is bounded so
 * outstanding never exceeds the charge's snapshot amount. It inserts the
 * Adjustment row, recomputes status, and audits `fees.adjustment.posted`.
 */

export interface PostAdjustmentActor {
  actorUserId: string;
  actorRoleKey: string;
  actorMembershipId?: string | null;
  requestRef?: string | null;
}

export interface PostAdjustmentInput {
  institutionId: string;
  studentId: string;
  chargeId: string;
  type: "WAIVER" | "WRITE_OFF" | "CORRECTION";
  direction?: "CREDIT" | "DEBIT";
  amountPaise: bigint;
  reason: string;
  actor: PostAdjustmentActor;
}

export type PostAdjustmentResult =
  | { ok: true; adjustmentId: string }
  | { ok: false; status: number; error: string };

export async function postAdjustment(
  tx: Prisma.TransactionClient,
  input: PostAdjustmentInput,
): Promise<PostAdjustmentResult> {
  const { institutionId, studentId, chargeId, type, amountPaise, reason } = input;

  // WAIVER / WRITE_OFF are always CREDIT; only CORRECTION may be DEBIT.
  const direction: "CREDIT" | "DEBIT" =
    type === "CORRECTION" ? input.direction ?? "CREDIT" : "CREDIT";
  if (direction === "DEBIT" && type !== "CORRECTION") {
    return { ok: false, status: 400, error: "only a CORRECTION may be a DEBIT" };
  }

  const owned = await tx.studentCharge.findFirst({
    where: { id: chargeId, institutionId, studentId },
    select: { id: true },
  });
  if (!owned) return { ok: false, status: 404, error: "charge not found for student" };

  const ledger = await loadChargeLedger(tx, institutionId, chargeId);
  if (!ledger) return { ok: false, status: 404, error: "charge not found" };

  const outstanding = computeChargeOutstanding(ledger);
  if (direction === "CREDIT") {
    if (amountPaise > outstanding) {
      return { ok: false, status: 409, error: "credit exceeds outstanding" };
    }
  } else {
    // DEBIT raises outstanding; cap so it never exceeds the snapshot amount.
    const headroom = ledger.charge.amountPaise - outstanding;
    if (amountPaise > headroom) {
      return { ok: false, status: 409, error: "debit would exceed the charge amount" };
    }
  }

  const adjustment = await tx.adjustment.create({
    data: {
      institutionId,
      studentId,
      studentChargeId: chargeId,
      type,
      direction,
      amountPaise,
      currency: "INR",
      reason,
      approvedByUserId: input.actor.actorUserId,
    },
  });

  const after = await loadChargeLedger(tx, institutionId, chargeId);
  if (after) {
    await tx.studentCharge.update({
      where: { id: chargeId },
      data: { status: computeChargeStatus(after) },
    });
  }

  await recordAuditEvent(
    {
      action: "fees.adjustment.posted",
      result: "SUCCESS",
      actorUserId: input.actor.actorUserId,
      actorRoleKey: input.actor.actorRoleKey,
      actorMembershipId: input.actor.actorMembershipId ?? null,
      requestRef: input.actor.requestRef ?? null,
      institutionId,
      resourceType: "Adjustment",
      resourceId: adjustment.id,
      metadata: {
        studentChargeId: chargeId,
        type,
        direction,
        amountPaise: amountPaise.toString(),
      },
    },
    tx,
  );

  return { ok: true, adjustmentId: adjustment.id };
}
