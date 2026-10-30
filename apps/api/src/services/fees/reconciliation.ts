import type { Prisma } from "@campusgate/db";
import { recordAuditEvent } from "../audit.js";
import { confirmCapture, type ConfirmActor } from "./confirmation.js";
import { RazorpayGateway } from "./razorpay.js";

/**
 * Reconciliation service (design §D.11). Surfaces payment_transactions stuck in
 * CREATED/AUTHORIZED past a threshold (webhook missed) and drives a
 * captured-but-stuck transaction through the SAME idempotent confirmation
 * routine the webhook uses (so a reconcile + late webhook cannot double-post).
 *
 * NIT-2: mark FAILED ONLY on an authoritative Razorpay terminal-failed signal
 * (a payment with status 'failed', or the order reporting a confirmed terminal
 * state). A still-open order stays CREATED/AUTHORIZED for a later sweep — never
 * marked FAILED merely because it is "not yet paid".
 */

/** A stuck transaction row as the sweep needs it. */
export interface StuckTransaction {
  id: string;
  studentId: string;
  amountPaise: bigint;
  status: string;
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  targetChargeIds: string[];
  createdAt: Date;
}

/** Select CREATED/AUTHORIZED transactions older than the threshold (uses the
 * (institutionId, status, createdAt) index). */
export async function findStuck(
  tx: Prisma.TransactionClient,
  institutionId: string,
  thresholdMins: number,
  limit = 100,
): Promise<StuckTransaction[]> {
  const cutoff = new Date(Date.now() - thresholdMins * 60_000);
  return tx.paymentTransaction.findMany({
    where: {
      institutionId,
      status: { in: ["CREATED", "AUTHORIZED"] },
      createdAt: { lt: cutoff },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      studentId: true,
      amountPaise: true,
      status: true,
      razorpayOrderId: true,
      razorpayPaymentId: true,
      targetChargeIds: true,
      createdAt: true,
    },
  });
}

export type ReconcileOutcome =
  | { kind: "captured"; receiptNumber?: string }
  | { kind: "already_captured" }
  | { kind: "failed" }
  | { kind: "still_open" };

/**
 * Reconcile ONE stuck transaction against Razorpay. If Razorpay reports the
 * payment captured / order paid, drive it through the shared confirmation
 * routine (idempotent). If an authoritative terminal-failed signal is present,
 * move it CREATED/AUTHORIZED → FAILED (forward-only, trigger-allowed). Otherwise
 * leave it open for a later sweep.
 *
 * Runs inside the caller's `withTenant(institutionId, tx)` transaction.
 */
export async function reconcileOne(
  tx: Prisma.TransactionClient,
  gateway: RazorpayGateway,
  institutionId: string,
  transaction: StuckTransaction,
  actor: ConfirmActor,
): Promise<ReconcileOutcome> {
  const order = await gateway.fetchOrder(transaction.razorpayOrderId);
  const payments = await gateway.fetchOrderPayments(transaction.razorpayOrderId);

  const captured = payments.find((p) => p.status === "captured");
  if (order.status === "paid" || captured) {
    const result = await confirmCapture(tx, {
      institutionId,
      transaction,
      razorpayPaymentId: captured?.id ?? transaction.razorpayPaymentId ?? null,
      actor,
      captureAuditAction: "fees.payment.reconciled",
    });
    return result.captured
      ? { kind: "captured", receiptNumber: result.receiptNumber }
      : { kind: "already_captured" };
  }

  // Authoritative terminal-failed ONLY: a payment attempt that itself failed.
  // "not yet paid" (no payments, order still 'created'/'attempted') is NOT a
  // terminal failure — leave it open (NIT-2).
  const hasFailed = payments.some((p) => p.status === "failed");
  const noOpenAttempts = !payments.some(
    (p) => p.status === "created" || p.status === "authorized",
  );
  if (hasFailed && noOpenAttempts) {
    await tx.paymentTransaction.update({
      where: { id: transaction.id },
      data: { status: "FAILED" },
    });
    await recordAuditEvent(
      {
        action: "fees.payment.failed",
        result: "SUCCESS",
        actorUserId: actor.actorUserId,
        actorRoleKey: actor.actorRoleKey,
        actorMembershipId: actor.actorMembershipId ?? null,
        requestRef: actor.requestRef ?? null,
        institutionId,
        resourceType: "PaymentTransaction",
        resourceId: transaction.id,
        metadata: { razorpayOrderId: transaction.razorpayOrderId, reason: "terminal_failed" },
      },
      tx,
    );
    return { kind: "failed" };
  }

  return { kind: "still_open" };
}
