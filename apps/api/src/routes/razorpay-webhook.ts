import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { withTenant, privilegedPrisma, Prisma, type DbClient } from "@campusgate/db";
import { recordAuditEvent } from "../services/audit.js";
import { confirmCapture } from "../services/fees/confirmation.js";
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
    //     401, write nothing authoritative (a privileged audit only).
    if (
      !Buffer.isBuffer(rawBody) ||
      !gateway.verifyWebhookSignature(rawBody, signature)
    ) {
      await recordAuditEvent({
        action: "fees.webhook.signature_rejected",
        result: "DENIED",
        actorUserId: "system",
        actorRoleKey: "SYSTEM",
        institutionId: null,
        resourceType: "ProcessedWebhookEvent",
        metadata: { reason: "invalid or absent signature" },
      }).catch(() => {});
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
    const paymentEntity = evt?.payload?.payment?.entity;
    const orderEntity = evt?.payload?.order?.entity;
    const razorpayOrderId: string | undefined =
      paymentEntity?.order_id ?? orderEntity?.id;
    const razorpayPaymentId: string | null = paymentEntity?.id ?? null;

    // If the order id is unresolvable, we cannot attribute the event → 200 no-op
    // (stop Razorpay retrying an event we can't place).
    if (!razorpayOrderId) {
      request.log.warn({ eventType }, "razorpay webhook: unresolved order id");
      return reply.status(200).send({ status: "ignored", reason: "no order id" });
    }
    if (!eventId) {
      request.log.warn({ eventType, razorpayOrderId }, "razorpay webhook: missing event id header");
      return reply.status(200).send({ status: "ignored", reason: "no event id" });
    }

    // (c) Resolve the tenant via the owner-role lookup (fail-closed role probe).
    await assertLookupRoleBypassesRls(lookupClient);
    const txRow = await lookupClient.paymentTransaction.findFirst({
      where: { razorpayOrderId },
      select: { id: true, institutionId: true, status: true },
    });
    if (!txRow) {
      request.log.warn({ razorpayOrderId }, "razorpay webhook: unknown order");
      await recordAuditEvent({
        action: "fees.webhook.received",
        result: "DENIED",
        actorUserId: "system",
        actorRoleKey: "SYSTEM",
        institutionId: null,
        resourceType: "ProcessedWebhookEvent",
        metadata: { reason: "unknown order", razorpayOrderId, eventType },
      }).catch(() => {});
      return reply.status(200).send({ status: "ignored", reason: "unknown order" });
    }
    const resolvedInstitutionId = txRow.institutionId;

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
      await recordAuditEvent({
        action: "fees.webhook.skipped_module_inactive",
        result: "DENIED",
        actorUserId: "system",
        actorRoleKey: "SYSTEM",
        institutionId: resolvedInstitutionId,
        resourceType: "ProcessedWebhookEvent",
        metadata: { razorpayOrderId, eventType, state: moduleRow?.state ?? "NOT_ENTITLED" },
      }).catch(() => {});
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

        if (!isCaptureEvent) {
          await recordAuditEvent(
            {
              action: "fees.webhook.received",
              result: "SUCCESS",
              actorUserId: "system",
              actorRoleKey: "SYSTEM",
              institutionId: resolvedInstitutionId,
              resourceType: "ProcessedWebhookEvent",
              resourceId: txRow.id,
              metadata: { eventType, razorpayOrderId },
            },
            tx,
          );
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
          },
        });
        if (!transaction) return { noop: true as const };

        // (3)–(8) Shared idempotent capture routine.
        const confirm = await confirmCapture(tx, {
          institutionId: resolvedInstitutionId,
          transaction,
          razorpayPaymentId,
          actor: {
            actorUserId: "system",
            actorRoleKey: "SYSTEM",
            actorMembershipId: null,
            requestRef: request.id,
          },
          captureAuditAction: "fees.payment.captured",
        });
        return { captured: confirm.captured, receiptNumber: confirm.receiptNumber };
      });

      if ("duplicate" in result) {
        await recordAuditEvent({
          action: "fees.webhook.duplicate_ignored",
          result: "SUCCESS",
          actorUserId: "system",
          actorRoleKey: "SYSTEM",
          institutionId: resolvedInstitutionId,
          resourceType: "ProcessedWebhookEvent",
          metadata: { eventId, razorpayOrderId, eventType },
        }).catch(() => {});
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
