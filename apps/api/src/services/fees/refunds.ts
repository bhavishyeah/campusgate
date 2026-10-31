import type { Prisma } from "@campusgate/db";
import { recordAuditEvent } from "../audit.js";
import {
  computeChargeOutstanding,
  computeChargeStatus,
  planRefundReversal,
  type ReversalAllocation,
} from "./ledger.js";
import { loadChargeLedger } from "./ledger-query.js";

/**
 * Refund service (design §E.4/§E.5/§E.8). Refunds are append-only reversing
 * entries that NEVER mutate a capture/receipt/allocation. Concurrency and
 * idempotency are enforced by:
 *  - a per-transaction advisory lock (HIGH-3) serializing the net-refundable
 *    read-modify-write (`acquireRefundLock` + `computeNetRefundable`);
 *  - a server-minted `idempotencyKey` set at request time (HIGH-2) that lets the
 *    webhook correlate even before `razorpayRefundId` is persisted;
 *  - the "already PROCESSED → no-op" check in `settleRefund`.
 *
 * All functions run INSIDE a `withTenant(institutionId, tx)` transaction.
 */

export interface RefundActor {
  actorUserId: string;
  actorRoleKey: string;
  actorMembershipId?: string | null;
  requestRef?: string | null;
}

/**
 * Take the per-transaction advisory lock for the duration of the current tx
 * (HIGH-3), mirroring the slice-1 receipt-sequence lock. Serializes concurrent
 * refund requests on the SAME payment so two REQUESTED rows cannot both pass a
 * net-refundable check that only one can satisfy. Scoped to the transaction id
 * so refunds on different payments never contend.
 */
export async function acquireRefundLock(
  tx: Prisma.TransactionClient,
  paymentTransactionId: string,
): Promise<void> {
  const lockKey = `fees_refund:${paymentTransactionId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
}

/**
 * net-refundable(T) = T.amountPaise − Σ refunds(status IN (REQUESTED,PROCESSED)).
 * MUST be called only while `acquireRefundLock` is held in the same tx.
 */
export async function computeNetRefundable(
  tx: Prisma.TransactionClient,
  institutionId: string,
  paymentTransactionId: string,
): Promise<{ captured: bigint; reserved: bigint; net: bigint } | null> {
  const txn = await tx.paymentTransaction.findFirst({
    where: { id: paymentTransactionId, institutionId },
    select: { amountPaise: true, status: true },
  });
  if (!txn) return null;
  const refunds = await tx.refund.findMany({
    where: {
      institutionId,
      paymentTransactionId,
      status: { in: ["REQUESTED", "PROCESSED"] },
    },
    select: { amountPaise: true },
  });
  const reserved = refunds.reduce((acc, r) => acc + r.amountPaise, 0n);
  const net = txn.amountPaise - reserved;
  return { captured: txn.amountPaise, reserved, net: net > 0n ? net : 0n };
}

/**
 * Correlate a webhook refund event to a local Refund row (HIGH-2 order):
 *  1. by razorpayRefundId (exact, once persisted);
 *  2. else by idempotencyKey = receipt, stamping razorpayRefundId on the match.
 * Returns the located row id, or null if neither matches (caller throws → 500).
 */
export async function correlateRefund(
  tx: Prisma.TransactionClient,
  institutionId: string,
  args: { razorpayRefundId: string; receipt?: string | null },
): Promise<{ id: string; status: string } | null> {
  const byId = await tx.refund.findFirst({
    where: { institutionId, razorpayRefundId: args.razorpayRefundId },
    select: { id: true, status: true },
  });
  if (byId) return byId;

  if (args.receipt) {
    const byReceipt = await tx.refund.findFirst({
      where: { institutionId, idempotencyKey: args.receipt },
      select: { id: true, status: true, razorpayRefundId: true },
    });
    if (byReceipt) {
      if (!byReceipt.razorpayRefundId) {
        await tx.refund.update({
          where: { id: byReceipt.id },
          data: { razorpayRefundId: args.razorpayRefundId },
        });
      }
      return { id: byReceipt.id, status: byReceipt.status };
    }
  }
  return null;
}

export interface SettleRefundInput {
  institutionId: string;
  refundId: string;
  actor: RefundActor;
}

export type SettleRefundResult =
  | { settled: true; reversed: bigint; unreversible: bigint }
  | { settled: false; reason: "already_processed" | "not_requested" };

/**
 * The shared idempotent processed-refund routine used by BOTH the sync success
 * path and the webhook, symmetric to `confirmCapture`. No-op if the Refund is
 * already PROCESSED. Otherwise: plan the reversal over the ORIGINAL transaction's
 * allocations newest-first with live per-charge headroom, insert RefundReversal
 * rows, compute + stamp `unreversiblePaise`, flip Refund→PROCESSED + settledAt,
 * recompute affected charge statuses, and audit `fees.refund.processed`.
 */
export async function settleRefund(
  tx: Prisma.TransactionClient,
  input: SettleRefundInput,
): Promise<SettleRefundResult> {
  const { institutionId, refundId } = input;

  const refund = await tx.refund.findFirst({
    where: { id: refundId, institutionId },
    select: {
      id: true,
      status: true,
      amountPaise: true,
      paymentTransactionId: true,
    },
  });
  if (!refund) return { settled: false, reason: "not_requested" };
  if (refund.status === "PROCESSED") return { settled: false, reason: "already_processed" };
  if (refund.status !== "REQUESTED") return { settled: false, reason: "not_requested" };

  // Original allocations of the refunded transaction, newest-first.
  const allocations = await tx.paymentAllocation.findMany({
    where: { institutionId, paymentTransactionId: refund.paymentTransactionId },
    orderBy: { createdAt: "desc" },
    select: { studentChargeId: true, amountPaise: true },
  });

  // Build reversal inputs with live per-charge headroom.
  const reversalInputs: ReversalAllocation[] = [];
  for (const alloc of allocations) {
    const ledger = await loadChargeLedger(tx, institutionId, alloc.studentChargeId);
    if (!ledger) continue;
    const currentOutstanding = ledgerOutstanding(ledger);
    const headroom = ledger.charge.amountPaise - currentOutstanding;
    reversalInputs.push({
      studentChargeId: alloc.studentChargeId,
      amountPaise: alloc.amountPaise,
      currentHeadroom: headroom > 0n ? headroom : 0n,
    });
  }

  const plan = planRefundReversal(refund.amountPaise, reversalInputs);

  for (const r of plan.reversals) {
    await tx.refundReversal.create({
      data: {
        institutionId,
        refundId: refund.id,
        studentChargeId: r.studentChargeId,
        amountPaise: r.amountPaise,
        currency: "INR",
      },
    });
    const after = await loadChargeLedger(tx, institutionId, r.studentChargeId);
    if (after) {
      await tx.studentCharge.update({
        where: { id: r.studentChargeId },
        data: { status: computeChargeStatus(after) },
      });
    }
  }

  await tx.refund.update({
    where: { id: refund.id },
    data: {
      status: "PROCESSED",
      settledAt: new Date(),
      unreversiblePaise: plan.remainder,
    },
  });

  await recordAuditEvent(
    {
      action: "fees.refund.processed",
      result: "SUCCESS",
      actorUserId: input.actor.actorUserId,
      actorRoleKey: input.actor.actorRoleKey,
      actorMembershipId: input.actor.actorMembershipId ?? null,
      requestRef: input.actor.requestRef ?? null,
      institutionId,
      resourceType: "Refund",
      resourceId: refund.id,
      metadata: {
        amountPaise: refund.amountPaise.toString(),
        reversedPaise: (refund.amountPaise - plan.remainder).toString(),
        unreversiblePaise: plan.remainder.toString(),
      },
    },
    tx,
  );

  return { settled: true, reversed: refund.amountPaise - plan.remainder, unreversible: plan.remainder };
}

function ledgerOutstanding(ledger: Parameters<typeof computeChargeOutstanding>[0]): bigint {
  return computeChargeOutstanding(ledger);
}
