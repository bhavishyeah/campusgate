import type { Prisma } from "@campusgate/db";
import { recordAuditEvent } from "../audit.js";
import { notifyUser } from "../notifications.js";
import {
  planAllocation,
  formatReceiptNumber,
  type ChargeForAllocation,
} from "./allocation.js";

/**
 * The SINGLE idempotent capture+allocate+receipt+audit+notify routine, shared
 * by the webhook (§D.5 Stage 3) and reconciliation (§D.11) so a reconcile and a
 * late webhook can never double-post — idempotency is by DB construction (the
 * processed-event / payment-id / receipt uniques) AND the "already CAPTURED →
 * no-op" status check below.
 *
 * MUST be called INSIDE a `withTenant(resolvedInstitutionId, tx)` transaction
 * whose GUC is already pinned to the resolved tenant, so every INSERT/UPDATE on
 * the tenant-owned fees tables satisfies RLS WITH CHECK.
 *
 * The caller owns the processed-event insert + duplicate handling (the webhook's
 * 23505-only rule, §D.5 step 1) BEFORE calling this; this function performs
 * steps 2–8.
 */

export interface ConfirmActor {
  actorUserId: string;
  actorRoleKey: string;
  actorMembershipId?: string | null;
  requestRef?: string | null;
}

export interface ConfirmCaptureInput {
  institutionId: string;
  /** The loaded payment_transactions row (by (institutionId, razorpayOrderId)). */
  transaction: {
    id: string;
    studentId: string;
    amountPaise: bigint;
    status: string;
    razorpayOrderId: string;
    razorpayPaymentId: string | null;
    targetChargeIds: string[];
    /** The initiating User id (Stage-1 order creator) — audit-actor fallback. */
    initiatedByUserId?: string | null;
  };
  /** The captured payment id from the authoritative source (webhook/Razorpay). */
  razorpayPaymentId: string | null;
  actor: ConfirmActor;
  /** The audit action to emit for the capture (webhook vs reconcile). */
  captureAuditAction: "fees.payment.captured" | "fees.payment.reconciled";
}

export interface ConfirmCaptureResult {
  /** True when this call performed the capture; false on an idempotent no-op. */
  captured: boolean;
  /** 'already_captured' when the row was already terminal-captured. */
  reason?: "already_captured";
  receiptId?: string;
  receiptNumber?: string;
  allocatedPaise?: string;
  /** True when the capture audit was skipped (no resolvable payer/initiator). */
  auditSkipped?: boolean;
}

export async function confirmCapture(
  tx: Prisma.TransactionClient,
  input: ConfirmCaptureInput,
): Promise<ConfirmCaptureResult> {
  const { institutionId, transaction } = input;

  // (3) Already CAPTURED → idempotent no-op.
  if (transaction.status === "CAPTURED") {
    return { captured: false, reason: "already_captured" };
  }

  // Resolve the PAYER's User id up-front (NIT-1: studentId is a StudentProfile
  // id, not a User id). This single resolution is reused as (a) the audit actor
  // — a system-initiated webhook/reconcile records the capture under the payer's
  // real User id, never a literal "system" that FK-violates audit_events — and
  // (b) the notify recipient (step 8). FEAT-002 passed actorUserId:"system",
  // which has no users(id) row, rolling back every real capture; resolving the
  // payer here fixes that in place without weakening the audit FK (Option A).
  const payerProfile = await tx.studentProfile.findFirst({
    where: { id: transaction.studentId, institutionId },
    select: { userId: true },
  });
  // Fall back to the initiating user if the profile has no linked user (should
  // not happen for a payer-initiated charge, but money capture must NEVER fail
  // on an audit-actor gap). If neither resolves, the audit is best-effort (skip
  // with a warning) rather than a rollback.
  const auditActorUserId =
    payerProfile?.userId ?? transaction.initiatedByUserId ?? null;
  const actor: ConfirmActor = {
    actorUserId: auditActorUserId ?? input.actor.actorUserId,
    actorRoleKey: payerProfile?.userId ? "STUDENT" : input.actor.actorRoleKey,
    actorMembershipId: input.actor.actorMembershipId ?? null,
    requestRef: input.actor.requestRef ?? null,
  };

  const now = new Date();

  // (4) Move the transaction to CAPTURED (forward-only; the column-guard trigger
  //     allows CREATED/AUTHORIZED → CAPTURED). Persist the payment id if given.
  await tx.paymentTransaction.update({
    where: { id: transaction.id },
    data: {
      status: "CAPTURED",
      capturedAt: now,
      ...(input.razorpayPaymentId && !transaction.razorpayPaymentId
        ? { razorpayPaymentId: input.razorpayPaymentId }
        : {}),
    },
  });

  // (5) Recompute allocation authoritatively from the STORED targetChargeIds
  //     (MEDIUM-3 — never order.notes), re-validated as still tenant-owned and
  //     not already PAID. A foreign/absent id simply drops out (NIT-1).
  const targetIds = transaction.targetChargeIds ?? [];
  const charges =
    targetIds.length === 0
      ? []
      : await tx.studentCharge.findMany({
          where: {
            id: { in: targetIds },
            institutionId,
            studentId: transaction.studentId,
            status: { not: "PAID" },
          },
          select: {
            id: true,
            amountPaise: true,
            dueDate: true,
            postedAt: true,
            allocations: { select: { amountPaise: true } },
          },
        });

  const forAllocation: ChargeForAllocation[] = charges.map((c) => ({
    id: c.id,
    amountPaise: c.amountPaise,
    allocatedPaise: c.allocations.reduce((acc, a) => acc + a.amountPaise, 0n),
    dueDate: c.dueDate,
    postedAt: c.postedAt,
  }));

  const plan = planAllocation(transaction.amountPaise, forAllocation);

  for (const alloc of plan.allocations) {
    await tx.paymentAllocation.create({
      data: {
        institutionId,
        paymentTransactionId: transaction.id,
        studentChargeId: alloc.studentChargeId,
        amountPaise: alloc.amountPaise,
        currency: "INR",
      },
    });
    await tx.studentCharge.update({
      where: { id: alloc.studentChargeId },
      data: { status: alloc.nextStatus },
    });
  }

  // (6) Advisory-lock per institution, then MAX(sequence)+1, then insert the
  //     receipt for the FULL captured amount (independent of how much was
  //     allocated; the (institutionId, paymentTransactionId) unique prevents a
  //     dup, the (institutionId, sequence) unique backstops the counter).
  const lockKey = `fees_receipt:${institutionId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
  const maxRows = await tx.$queryRaw<Array<{ max: number | null }>>`
    SELECT COALESCE(MAX("sequence"), 0) AS max FROM "receipts" WHERE "institutionId" = ${institutionId}
  `;
  const nextSequence = Number(maxRows[0]?.max ?? 0) + 1;
  const receiptNumber = formatReceiptNumber(
    institutionId,
    now.getUTCFullYear(),
    nextSequence,
  );
  const receipt = await tx.receipt.create({
    data: {
      institutionId,
      paymentTransactionId: transaction.id,
      receiptNumber,
      sequence: nextSequence,
      amountPaise: transaction.amountPaise,
      currency: "INR",
      issuedAt: now,
    },
  });

  // (7) Audit capture + receipt issuance in-tx — under the PAYER's real User id.
  //     If no actor resolved (no payer user + no initiator — a data anomaly), the
  //     audit is skipped best-effort rather than rolling back a captured payment
  //     on an audit-actor gap (Option A). A warning is left by the caller.
  if (auditActorUserId) {
    await recordAuditEvent(
      {
        action: input.captureAuditAction,
        result: "SUCCESS",
        actorUserId: actor.actorUserId,
        actorRoleKey: actor.actorRoleKey,
        actorMembershipId: actor.actorMembershipId ?? null,
        requestRef: actor.requestRef ?? null,
        institutionId,
        resourceType: "PaymentTransaction",
        resourceId: transaction.id,
        metadata: {
          razorpayOrderId: transaction.razorpayOrderId,
          allocatedPaise: plan.allocatedTotal.toString(),
          amountPaise: transaction.amountPaise.toString(),
        },
      },
      tx,
    );
    await recordAuditEvent(
      {
        action: "fees.receipt.issued",
        result: "SUCCESS",
        actorUserId: actor.actorUserId,
        actorRoleKey: actor.actorRoleKey,
        actorMembershipId: actor.actorMembershipId ?? null,
        requestRef: actor.requestRef ?? null,
        institutionId,
        resourceType: "Receipt",
        resourceId: receipt.id,
        metadata: { receiptNumber, amountPaise: transaction.amountPaise.toString() },
      },
      tx,
    );
  }

  // (8) Notify the payer inside the same tx (reusing the up-front resolution).
  if (payerProfile?.userId) {
    await notifyUser(
      payerProfile.userId,
      {
        title: "Payment received",
        body: `Your payment has been confirmed. Receipt ${receiptNumber}.`,
        type: "fees.payment.captured",
        data: { receiptNumber, paymentTransactionId: transaction.id },
      },
      tx,
    );
  }

  return {
    captured: true,
    receiptId: receipt.id,
    receiptNumber,
    allocatedPaise: plan.allocatedTotal.toString(),
    auditSkipped: !auditActorUserId,
  };
}
