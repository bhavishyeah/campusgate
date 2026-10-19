import type { FastifyInstance } from "fastify";
import { privilegedPrisma } from "@campusgate/db";
import { authenticate } from "../middleware/auth.js";
import { recordAuditEvent } from "../services/audit.js";
import {
  consumeRecoveryCode,
  generateMfaEnrollmentSecret,
  generateRecoveryCodes,
  mintStepUpToken,
  verifyTotp,
  type JwtSigner,
} from "../services/mfa.js";

/**
 * MFA enrollment / verification endpoints (design §5.2), registered under
 * /api/auth/mfa with `authenticate` as the only preHandler (MFA is available to
 * any authenticated user; it is MANDATORY only for platform accounts, enforced
 * by `requirePlatformMfa` on the platform plugin).
 */
export async function mfaRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  const roleSnapshot = (request: {
    auth?: { roles: string[] };
    user: { role: string };
  }): string => request.auth?.roles[0] ?? request.user.role;

  // POST /enroll/start — generate a TOTP secret, store it WITHOUT enabling MFA,
  // return the otpauth URI + QR data URL.
  app.post("/enroll/start", async (request, reply) => {
    const { userId } = request.user;

    const user = await privilegedPrisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const { secret, otpauthUri, qrCodeDataUrl } = await generateMfaEnrollmentSecret(
      user.email,
    );

    // Store the pending secret; do NOT flip mfaEnabled until a code is verified.
    await privilegedPrisma.user.update({
      where: { id: userId },
      data: { mfaSecret: secret },
    });

    return reply.send({ otpauthUri, qrCodeDataUrl });
  });

  // POST /enroll/verify { code } — verify the first TOTP code, enable MFA, and
  // issue the one-time recovery codes (returned plaintext ONCE).
  app.post("/enroll/verify", async (request, reply) => {
    const { userId } = request.user;
    const { code } = (request.body ?? {}) as { code?: string };

    if (typeof code !== "string" || code.trim().length === 0) {
      return reply.status(400).send({ error: "Invalid code" });
    }

    const user = await privilegedPrisma.user.findUnique({
      where: { id: userId },
      select: { mfaSecret: true, institutionId: true },
    });
    if (!user?.mfaSecret) {
      return reply.status(400).send({ error: "Enrollment not started" });
    }

    if (!verifyTotp(code, user.mfaSecret)) {
      await recordAuditEvent({
        action: "platform.mfa.enrolled",
        result: "DENIED",
        actorUserId: userId,
        actorRoleKey: roleSnapshot(request),
        institutionId: null,
        resourceType: "User",
        resourceId: userId,
        requestRef: request.id,
      }).catch((err) =>
        request.log.error({ err }, "mfa enroll/verify DENIED audit failed"),
      );
      return reply.status(400).send({ error: "Invalid code" });
    }

    // Success: generate recovery codes, store hashes, flip mfaEnabled.
    const recoveryCodes = await generateRecoveryCodes();
    await privilegedPrisma.user.update({
      where: { id: userId },
      data: {
        mfaEnabled: true,
        mfaEnrolledAt: new Date(),
        mfaRecoveryCodes: recoveryCodes.map((c) => c.hash),
      },
    });

    await recordAuditEvent({
      action: "platform.mfa.enrolled",
      result: "SUCCESS",
      actorUserId: userId,
      actorRoleKey: roleSnapshot(request),
      institutionId: null,
      resourceType: "User",
      resourceId: userId,
      requestRef: request.id,
    });

    // Return the plaintext recovery codes ONCE — never persisted in plaintext.
    return reply.send({
      enabled: true,
      recoveryCodes: recoveryCodes.map((c) => c.plaintext),
    });
  });

  // POST /verify { code } — a fresh MFA assertion (TOTP or recovery code) that
  // mints a short-lived step-up token. The action class the token is bound to is
  // taken from the body (`action`, default "support_grant.create").
  app.post("/verify", async (request, reply) => {
    const { userId } = request.user;
    const { code, action = "support_grant.create" } = (request.body ?? {}) as {
      code?: string;
      action?: string;
    };

    if (typeof code !== "string" || code.trim().length === 0) {
      return reply.status(400).send({ error: "Invalid code" });
    }

    const user = await privilegedPrisma.user.findUnique({
      where: { id: userId },
      select: { mfaEnabled: true, mfaSecret: true, mfaRecoveryCodes: true },
    });
    if (!user?.mfaEnabled || !user.mfaSecret) {
      return reply.status(400).send({ error: "MFA not enrolled" });
    }

    let verified = false;

    // Try TOTP first.
    if (verifyTotp(code, user.mfaSecret)) {
      verified = true;
    } else {
      // Fall back to a single-use recovery code.
      const hashes = Array.isArray(user.mfaRecoveryCodes)
        ? (user.mfaRecoveryCodes as string[])
        : [];
      const consumed = await consumeRecoveryCode(code, hashes);
      if (consumed) {
        verified = true;
        // Remove the consumed hash so the code cannot be reused.
        await privilegedPrisma.user.update({
          where: { id: userId },
          data: { mfaRecoveryCodes: hashes.filter((h) => h !== consumed.matchedHash) },
        });
      }
    }

    if (!verified) {
      await recordAuditEvent({
        action: "platform.mfa.step_up",
        result: "DENIED",
        actorUserId: userId,
        actorRoleKey: roleSnapshot(request),
        institutionId: null,
        resourceType: "StepUp",
        resourceId: action,
        requestRef: request.id,
      }).catch((err) =>
        request.log.error({ err }, "mfa verify DENIED audit failed"),
      );
      return reply.status(400).send({ error: "Invalid code" });
    }

    const signer: JwtSigner = {
      sign: (payload, options) => app.jwt.sign(payload as never, options as never),
    };
    const stepUpToken = mintStepUpToken(signer, userId, action);

    await recordAuditEvent({
      action: "platform.mfa.step_up",
      result: "SUCCESS",
      actorUserId: userId,
      actorRoleKey: roleSnapshot(request),
      institutionId: null,
      resourceType: "StepUp",
      resourceId: action,
      requestRef: request.id,
    }).catch((err) => request.log.error({ err }, "mfa verify SUCCESS audit failed"));

    return reply.send({ stepUpToken, action, expiresIn: 300 });
  });
}
