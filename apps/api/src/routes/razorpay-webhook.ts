import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { withTenant, privilegedPrisma, Prisma, type DbClient } from "@campusgate/db";
import { recordAuditEvent } from "../services/audit.js";
import { confirmCapture } from "../services/fees/confirmation.js";
import { correlateRefund, settleRefund } from "../services/fees/refunds.js";
import { getRazorpayGateway, type RazorpayGateway } from "../services/fees/razorpay.js";

/**
 * PUBLIC Razorpay webhook (design §D.5 Stage 3 / §D.7 / §D.8), mounted at
 * `/api/webhooks` as its OWN encapsulated Fastify plugin so the raw-body
 * content-type parser does NOT affect any other route's JSON parsing.
 *
 * POST /razorpay is PUBLIC: NO `authenticate`, NO `requirePermission`, NO
 * `requireModuleActive`. It is gated by the HMAC signature only. The webhook is
 * the SOLE authoritative writer of CAPTURED/allocations/receipt; idempotency is
 * by DB construction (processed-event global unique + payment-id partial unique
 * + receipt uniques) AND the "already CAPTURED → no-op" check.
 *
 * Tenant resolution: there is no JWT. The pre-tenant order lookup MUST run on a
 * true owner-role (BYPASSRLS) connection — `privilegedPrisma` in production — and
 * a fail-closed role probe (mirrors `assertBreakGlassRoleIsRlsSubject` INVERTED)
 * throws if the lookup role does NOT bypass RLS, so a misconfigured deployment
 * fails CLOSED rather than silently 200-acking every real payment into the void.
 * The lookup client is INJECTABLE so the integration suite injects its BYPASSRLS
 * `adminClient` seam (DATABASE_URL is pinned to campass_app there).
 */

export interface RazorpayWebhookOptions {
  /** Injectable owner-capable lookup client (default: privilegedPrisma). */
  lookupClient?: DbClient;
  /** Injectable gateway (default: the process-wide singleton). */
  gateway?: RazorpayGateway;
}

// Cache the role-probe result per lookup client so we probe once.
const probedClients = new WeakSet<object>();

/**
 * Fail-closed role probe (INVERSE of assertBreakGlassRoleIsRlsSubject). The
 * pre-tenant lookup runs with NO tenant GUC, so it only returns rows if the
 * connected role BYPASSES RLS. If it does NOT, throw loudly — otherwise the
 * webhook would treat every real captured payment as an "unknown order".
 */
async function assertLookupRoleBypassesRls(client: DbClient): Promise<void> {
  if (probedClients.has(client as object)) return;
  const rows = await client.$queryRawUnsafe<Array<{ rolbypassrls: boolean }>>(
    `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  );
  const bypasses = rows[0]?.rolbypassrls ?? false; // unknown => treat as unsafe
  if (!bypasses) {
    throw new Error(
      "razorpay webhook lookup client is an RLS-subject role; refusing to process webhooks — " +
        "PRIVILEGED_DATABASE_URL/DIRECT_URL must point at the owner role",
    );
  }
  probedClients.add(client as object);
}

export async function razorpayWebhookRoutes(
  app: FastifyInstance,
  options: RazorpayWebhookOptions = {},
) {
  // Encapsulated raw-body parser: keep the exact bytes so the HMAC is computed
  // over what Razorpay signed. Because content-type parsers are encapsulated,
  // this does NOT affect the default JSON parser on the authenticated API routes.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  app.post("/razorpay", async (request: FastifyRequest, reply) => {
    const gateway = options.gateway ?? getRazorpayGateway();
    const lookupClient: DbClient = options.lookupClient ?? privilegedPrisma;

    const rawBody = request.body as Buffer;
    const signature = request.headers["x-razorpay-signature"] as string | undefined;
    const eventId = request.headers["x-razorpay-event-id"] as string | undefined;

    // (a) Verify HMAC over the raw Buffer BEFORE any DB access. Bad/absent →
    //     401. There is NO tenant and NO payer here, so there is no valid audit
    //     actor (audit_events.actorUserId FKs users(id) — a literal "system"
    //     would violate it). Record the rejection as a structured server log
    //     instead of a DB audit (Option A §2); nothing authoritative is written.
    if (
      !Buffer.isBuffer(rawBody) ||
      !gateway.verifyWebhookSignature(rawBody, signature)
    ) {
      request.log.warn(
        { reason: "invalid or absent signature" },
        "razorpay webhook: signature rejected",
      );
      return reply.status(401).send({ error: "invalid signature" });
    }

    // (b) Parse + extract fields from the CORRECT nested locations (HIGH-1).
    let evt: any;
    try {
      evt = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return reply.status(400).send({ error: "invalid JSON" });
    }
    const eventType: string = evt?.event ?? "";
    const isRefundEvent = eventType.startsWith("refund.");
    const paymentEntity = evt?.payload?.payment?.entity;
    const orderEntity = evt?.payload?.order?.entity;
    const refundEntity = evt?.payload?.refund?.entity; // refund.* events
    const razorpayOrderId: string | undefined =
      paymentEntity?.order_id ?? orderEntity?.id;
    // Refund events carry no order_id; the tenant key is the payment id (HIGH-1).
    const razorpayPaymentId: string | null =
      (isRefundEvent ? refundEntity?.payment_id : paymentEntity?.id) ?? paymentEntity?.id ?? null;

    // Unresolvable-attribution guard BRANCHES by event family (HIGH-1): refund
    // events require a payment_id; capture events keep the order_id guard.
    if (isRefundEvent) {
      if (!razorpayPaymentId) {
        request.log.warn({ eventType }, "razorpay webhook: refund event without payment_id");
        return reply.status(200).send({ status: "ignored", reason: "no payment id" });
      }
    } else if (!razorpayOrderId) {
      request.log.warn({ eventType }, "razorpay webhook: unresolved order id");
      return reply.status(200).send({ status: "ignored", reason: "no order id" });
    }

    // (b') UNCHANGED from slice 1 — the `!eventId` guard fires for BOTH families,
    //      immediately after the branched attribution guard and before tenant
    //      resolution. eventId (x-razorpay-event-id) is the SOLE front-door
    //      idempotency key (processed_webhook_events.razorpayEventId NOT NULL +
    //      global unique); no event id ⇒ we cannot de-dupe a redelivery ⇒ ignore.
    if (!eventId) {
      request.log.warn({ eventType }, "razorpay webhook: missing event id header");
      return reply.status(200).send({ status: "ignored", reason: "no event id" });
    }

    // (c) Resolve the tenant via the owner-role lookup (fail-closed role probe).
    //     Capture events resolve by razorpayOrderId; refund events by
    //     razorpayPaymentId (NEW-2: no institutionId filter by design — the
    //     webhook has no tenant token and Razorpay ids are globally unique, the
    //     identical slice-1 capture-path rationale).
    await assertLookupRoleBypassesRls(lookupClient);
    const txRow = isRefundEvent
      ? await lookupClient.paymentTransaction.findFirst({
          where: { razorpayPaymentId: razorpayPaymentId ?? undefined },
          select: { id: true, institutionId: true, status: true },
        })
      : await lookupClient.paymentTransaction.findFirst({
          where: { razorpayOrderId },
          select: { id: true, institutionId: true, status: true },
        });
    if (!txRow) {
      // Unattributable (no transaction row) → no tenant and no payer, so there is
      // no valid audit actor. Record a structured log, not a DB audit (Option A
      // §2), and 200 so Razorpay stops retrying an event we cannot place.
      request.log.warn(
        { reason: "unknown order", razorpayOrderId, eventType },
        "razorpay webhook: unknown order",
      );
      return reply.status(200).send({ status: "ignored", reason: "unknown order" });
    }
    const resolvedInstitutionId = txRow.institutionId;

    // Resolve the PAYER's User id for the resolved transaction — the real audit
    // actor for any webhook audit under this tenant (Option A §1). Uses the
    // owner-role lookup client (no tenant GUC yet). studentId is a StudentProfile
    // id, so join to its userId; fall back to the initiating user.
    const payerRow = await lookupClient.paymentTransaction.findFirst({
      where: { id: txRow.id },
      select: { initiatedByUserId: true, student: { select: { userId: true } } },
    });
    const payerUserId: string | null =
      payerRow?.student?.userId ?? payerRow?.initiatedByUserId ?? null;

    // Only payment.captured / order.paid are terminal-capture events; anything
    // else is acknowledged as a no-op.
    const isCaptureEvent = eventType === "payment.captured" || eventType === "order.paid";

    // Module-inactive → 200 no-op + privileged audit (§D.8). Do NOT open a tenant
    // write path.
    const moduleRow = await privilegedPrisma.institutionModule.findUnique({
      where: { institutionId_moduleKey: { institutionId: resolvedInstitutionId, moduleKey: "fees" } },
      select: { state: true },
    });
    if (!moduleRow || moduleRow.state !== "ACTIVE") {
      // Audited under the resolved payer's User id (Option A §1). If no payer
      // resolves (data anomaly), fall back to a structured log rather than a
      // FK-violating "system" actor.
      if (payerUserId) {
        await recordAuditEvent({
          action: "fees.webhook.skipped_module_inactive",
          result: "DENIED",
          actorUserId: payerUserId,
          actorRoleKey: "STUDENT",
          institutionId: resolvedInstitutionId,
          resourceType: "ProcessedWebhookEvent",
          resourceId: txRow.id,
          metadata: { razorpayOrderId, eventType, state: moduleRow?.state ?? "NOT_ENTITLED" },
        }).catch(() => {});
      } else {
        request.log.warn(
          { razorpayOrderId, eventType, state: moduleRow?.state ?? "NOT_ENTITLED" },
          "razorpay webhook: skipped (module inactive), no payer actor to audit",
        );
      }
      return reply.status(200).send({ status: "ignored", reason: "module inactive" });
    }

    // (d) ONE tenant transaction: idempotency insert → load tx → capture.
    const payloadDigest = crypto_digest(rawBody);
    try {
      const result = await withTenant(resolvedInstitutionId, async (tx) => {
        // (1) Record the processed event. ONLY a 23505 on razorpayEventId maps to
        //     a 200 no-op; any OTHER error propagates (rollback → retry). NIT-3.
        try {
          await tx.processedWebhookEvent.create({
            data: {
              institutionId: resolvedInstitutionId,
              razorpayEventId: eventId,
              eventType,
              paymentTransactionId: txRow.id,
              payloadDigest,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            return { duplicate: true as const };
          }
          throw err; // any other insert error rolls the tx back
        }

        // Refund events (§E.8): correlate the local Refund by razorpayRefundId
        // then by receipt=idempotencyKey (HIGH-2), then settle/fail/ack.
        if (isRefundEvent) {
          const refundActor = {
            actorUserId: payerUserId ?? "system",
            actorRoleKey: "STUDENT",
            actorMembershipId: null,
            requestRef: request.id,
          };
          const razorpayRefundId: string | undefined = refundEntity?.id;
          const receipt: string | null = refundEntity?.receipt ?? null;

          if (eventType === "refund.created") {
            // REQUESTED already exists locally; acknowledge as a no-op.
            if (payerUserId) {
              await recordAuditEvent(
                {
                  action: "fees.webhook.received",
                  result: "SUCCESS",
                  actorUserId: payerUserId,
                  actorRoleKey: "STUDENT",
                  institutionId: resolvedInstitutionId,
                  resourceType: "ProcessedWebhookEvent",
                  resourceId: txRow.id,
                  metadata: { eventType, razorpayRefundId: razorpayRefundId ?? null },
                },
                tx,
              );
            }
            return { noop: true as const };
          }

          if (eventType === "refund.processed") {
            if (!razorpayRefundId) throw new Error("refund.processed without refund id");
            const located = await correlateRefund(tx, resolvedInstitutionId, {
              razorpayRefundId,
              receipt,
            });
            if (!located) {
              // No local refund yet (request route may not have persisted) → throw
              // so the tx rolls back and Razorpay redelivers (retryable 500).
              throw new Error("refund.processed: no local refund to correlate");
            }
            if (located.status === "PROCESSED") return { noop: true as const };
            await settleRefund(tx, {
              institutionId: resolvedInstitutionId,
              refundId: located.id,
              actor: refundActor,
            });
            return { refundSettled: true as const };
          }

          if (eventType === "refund.failed") {
            if (!razorpayRefundId) throw new Error("refund.failed without refund id");
            const located = await correlateRefund(tx, resolvedInstitutionId, {
              razorpayRefundId,
              receipt,
            });
            if (!located) {
              throw new Error("refund.failed: no local refund to correlate");
            }
            if (located.status === "REQUESTED") {
              await tx.refund.update({
                where: { id: located.id },
                data: { status: "FAILED", settledAt: new Date() },
              });
              if (payerUserId) {
                await recordAuditEvent(
                  {
                    action: "fees.refund.failed",
                    result: "SUCCESS",
                    actorUserId: payerUserId,
                    actorRoleKey: "STUDENT",
                    institutionId: resolvedInstitutionId,
                    resourceType: "Refund",
                    resourceId: located.id,
                    metadata: { razorpayRefundId },
                  },
                  tx,
                );
              }
            }
            return { refundFailed: true as const };
          }

          // Any other refund.* event: acknowledge no-op.
          if (payerUserId) {
            await recordAuditEvent(
              {
                action: "fees.webhook.received",
                result: "SUCCESS",
                actorUserId: payerUserId,
                actorRoleKey: "STUDENT",
                institutionId: resolvedInstitutionId,
                resourceType: "ProcessedWebhookEvent",
                resourceId: txRow.id,
                metadata: { eventType },
              },
              tx,
            );
          }
          return { noop: true as const };
        }

        if (!isCaptureEvent) {
          // Non-capture event acknowledgement — audited under the payer (Option
          // A §1); skip best-effort if no payer resolved.
          if (payerUserId) {
            await recordAuditEvent(
              {
                action: "fees.webhook.received",
                result: "SUCCESS",
                actorUserId: payerUserId,
                actorRoleKey: "STUDENT",
                institutionId: resolvedInstitutionId,
                resourceType: "ProcessedWebhookEvent",
                resourceId: txRow.id,
                metadata: { eventType, razorpayOrderId },
              },
              tx,
            );
          } else {
            request.log.warn(
              { eventType, razorpayOrderId },
              "razorpay webhook: received non-capture event, no payer actor to audit",
            );
          }
          return { noop: true as const };
        }

        // (2) Load the full transaction row for the capture routine.
        const transaction = await tx.paymentTransaction.findFirst({
          where: { institutionId: resolvedInstitutionId, razorpayOrderId },
          select: {
            id: true,
            studentId: true,
            amountPaise: true,
            status: true,
            razorpayOrderId: true,
            razorpayPaymentId: true,
            targetChargeIds: true,
            initiatedByUserId: true,
          },
        });
        if (!transaction) return { noop: true as const };

        // (3)–(8) Shared idempotent capture routine. confirmCapture OWNS the
        // audit-actor resolution (the payer's User id, Option A §1); the actor
        // below is only the last-resort fallback it uses when no payer/initiator
        // resolves (and in that case the capture still commits, audit skipped).
        const confirm = await confirmCapture(tx, {
          institutionId: resolvedInstitutionId,
          transaction,
          razorpayPaymentId,
          actor: {
            actorUserId: payerUserId ?? transaction.initiatedByUserId ?? "system",
            actorRoleKey: "STUDENT",
            actorMembershipId: null,
            requestRef: request.id,
          },
          captureAuditAction: "fees.payment.captured",
        });
        if (confirm.auditSkipped) {
          request.log.warn(
            { razorpayOrderId, transactionId: transaction.id },
            "razorpay webhook: capture committed but audit skipped (no resolvable payer actor)",
          );
        }
        return { captured: confirm.captured, receiptNumber: confirm.receiptNumber };
      });

      if ("duplicate" in result) {
        // Audited under the resolved payer (Option A §1); skip best-effort if none.
        if (payerUserId) {
          await recordAuditEvent({
            action: "fees.webhook.duplicate_ignored",
            result: "SUCCESS",
            actorUserId: payerUserId,
            actorRoleKey: "STUDENT",
            institutionId: resolvedInstitutionId,
            resourceType: "ProcessedWebhookEvent",
            resourceId: txRow.id,
            metadata: { eventId, razorpayOrderId, eventType },
          }).catch(() => {});
        } else {
          request.log.warn(
            { eventId, razorpayOrderId, eventType },
            "razorpay webhook: duplicate ignored, no payer actor to audit",
          );
        }
        return reply.status(200).send({ status: "duplicate" });
      }
      return reply.status(200).send({ status: "ok" });
    } catch (err) {
      // Any failure in the capture tx rolls back; return non-2xx so Razorpay
      // retries (the retry is idempotent).
      request.log.error({ err, razorpayOrderId }, "razorpay webhook: capture tx failed");
      return reply.status(500).send({ error: "processing failed" });
    }
  });
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// Short, non-reversible digest of the raw body for diagnostics (not a secret).
function crypto_digest(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
