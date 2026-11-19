import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privilegedPrisma, withTenant } from "@campusgate/db";
import { bulkInviteSchema } from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../services/authz-engine.js";
import { recordAuditEvent } from "../services/audit.js";
import { isPlatformAccount } from "../services/account-tokens.js";
import { inviteCeiling, inviteRemaining, issueAndSend, runBulkInvite } from "../services/account-invites.js";
import { getEmailSender } from "../services/email/index.js";
import { enforce, limiters } from "../services/rate-limit.js";

type Kind = "student" | "staff";

function actorRole(request: FastifyRequest): string {
  return request.auth?.roles[0] ?? request.user.role;
}

/** Audit failures after a successful send cannot undo the mail: log and carry on. */
async function auditSafely(request: FastifyRequest, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    request.log.error({ errClass: err instanceof Error ? err.name : "unknown" }, "invite audit write failed after send");
  }
}

export async function accountInviteRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  async function singleInvite(kind: Kind, request: FastifyRequest, reply: FastifyReply) {
    const { userId: actorId, institutionId } = request.user;
    const { userId } = request.params as { userId: string };

    if (!enforce(limiters.inviteAdmin, actorId, reply)) return reply;

    // Tenant step: load the target inside the actor's institution.
    const target = await withTenant(institutionId, (tx) =>
      tx.user.findFirst({
        where: { id: userId, institutionId },
        select: {
          id: true,
          email: true,
          role: true,
          institutionId: true,
          accountStatus: true,
          passwordHash: true,
          studentProfile: { select: { status: true } },
        },
      }),
    );
    const roleOk =
      !!target &&
      (kind === "student"
        ? target.role === "STUDENT" && !!target.studentProfile
        : target.role !== "STUDENT" && target.role !== "SUPER_ADMIN");
    if (!target || !roleOk || (await isPlatformAccount(privilegedPrisma as never, target))) {
      return reply.status(404).send({ error: "User not found" });
    }
    if (target.passwordHash != null) {
      return reply.status(409).send({
        code: "ALREADY_ACTIVATED",
        error: "This account already has a password. The user can use Forgot password.",
      });
    }
    if (target.accountStatus !== "ACTIVE" || (kind === "student" && target.studentProfile?.status !== "ACTIVE")) {
      return reply.status(409).send({ code: "ACCOUNT_NOT_ACTIVE", error: "This account is not active." });
    }
    if (!getEmailSender().isConfigured()) {
      return reply.status(503).send({ code: "EMAIL_NOT_CONFIGURED", error: "Email delivery is not configured." });
    }

    const [institution, previous] = await Promise.all([
      privilegedPrisma.institution.findUnique({ where: { id: institutionId }, select: { name: true } }),
      privilegedPrisma.accountToken.count({
        where: { userId: target.id, purpose: "ACCOUNT_ACTIVATION", emailSentAt: { not: null } },
      }),
    ]);

    const r = await issueAndSend({
      userId: target.id,
      institutionId,
      institutionName: institution?.name ?? "your institution",
      email: target.email,
      purpose: "ACCOUNT_ACTIVATION",
      createdByUserId: actorId,
      budgetCeiling: inviteCeiling(),
    });

    switch (r.status) {
      case "SENT":
        break;
      case "THROTTLED":
        return reply.status(429).send({ code: "INVITE_THROTTLED", error: "Too many invites for this user. Try again later." });
      case "BUDGET":
      case "ANON_HOURLY":
      case "ANON_DAILY":
        return reply.status(429).send({ code: "EMAIL_DAILY_LIMIT", remaining: 0, error: "Daily email limit reached." });
      case "PROVIDER_LIMIT":
        request.log.warn("email provider limit reached on invite");
        return reply.status(429).send({ code: "EMAIL_PROVIDER_LIMIT", error: "Email provider limit reached." });
      case "INELIGIBLE":
        return reply.status(404).send({ error: "User not found" });
      case "NOT_CONFIGURED":
        return reply.status(503).send({ code: "EMAIL_NOT_CONFIGURED", error: "Email delivery is not configured." });
      default:
        request.log.warn({ reason: r.reason }, "email send failed on invite");
        return reply.status(502).send({ code: "EMAIL_SEND_FAILED", error: "The email could not be sent. Try again." });
    }

    await auditSafely(request, () =>
      withTenant(institutionId, (tx) =>
        recordAuditEvent(
          {
            action: "admin.user.invite_sent",
            result: "SUCCESS",
            actorUserId: actorId,
            actorRoleKey: actorRole(request),
            institutionId,
            actorMembershipId: request.auth?.membershipId,
            resourceType: "User",
            resourceId: target.id,
            requestRef: request.id,
            metadata: { role: target.role, resend: previous > 0 },
          },
          tx,
        ),
      ),
    );
    return reply.send({ sent: true, expiresAt: r.expiresAt });
  }

  app.post("/students/:userId", { preHandler: [requirePermission("students.create")] }, (request, reply) =>
    singleInvite("student", request, reply),
  );
  app.post("/users/:userId", { preHandler: [requirePermission("admin.users.create")] }, (request, reply) =>
    singleInvite("staff", request, reply),
  );

  // ─── BULK ──────────────────────────────────────────────────────────────────
  app.post("/bulk-students", { preHandler: [requirePermission("students.create")] }, async (request, reply) => {
    const { userId: actorId, institutionId } = request.user;
    const parsed = bulkInviteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const body = parsed.data;

    if (!body.dryRun) {
      if (!enforce(limiters.bulkAdmin, actorId, reply)) return reply;
      if (!getEmailSender().isConfigured()) {
        return reply.status(503).send({ code: "EMAIL_NOT_CONFIGURED", error: "Email delivery is not configured." });
      }
      const remaining = await inviteRemaining();
      if (remaining <= 0) {
        return reply.status(429).send({
          code: "EMAIL_DAILY_LIMIT",
          error: "Daily email limit reached.",
          budget: { inviteCeiling: inviteCeiling(), inviteRemaining: 0 },
        });
      }
    }

    const result = await runBulkInvite({ institutionId, actorUserId: actorId, body });

    if (!body.dryRun) {
      await auditSafely(request, () =>
        withTenant(institutionId, (tx) =>
          recordAuditEvent(
            {
              action: "admin.users.invites_bulk_sent",
              result: "SUCCESS",
              actorUserId: actorId,
              actorRoleKey: actorRole(request),
              institutionId,
              actorMembershipId: request.auth?.membershipId,
              resourceType: "User",
              requestRef: request.id,
              metadata: {
                mode: body.mode,
                attempted: result.attempted,
                sent: result.sent,
                failed: result.failed,
              },
            },
            tx,
          ),
        ),
      );
    }
    return reply.send(result);
  });

  // ─── SUMMARY ───────────────────────────────────────────────────────────────
  app.get("/summary", { preHandler: [requirePermission("students.create")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const notActivatedStudents = await withTenant(institutionId, (tx) =>
      tx.user.count({
        where: {
          institutionId,
          role: "STUDENT",
          accountStatus: "ACTIVE",
          passwordHash: null,
          studentProfile: { status: "ACTIVE" },
        },
      }),
    );
    return reply.send({
      notActivatedStudents,
      emailConfigured: getEmailSender().isConfigured(),
      budget: { inviteCeiling: inviteCeiling(), inviteRemaining: await inviteRemaining() },
    });
  });
}
