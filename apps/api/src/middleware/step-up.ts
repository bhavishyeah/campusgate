import type { FastifyRequest, FastifyReply } from "fastify";
import { privilegedPrisma } from "@campusgate/db";
import { verifyStepUpToken, type JwtVerifier } from "../services/mfa.js";

// MFA-enrollment endpoints are EXEMPT from the mandatory-MFA gate so a platform
// operator who has not yet enrolled can still reach enrollment (design §5.3).
// These are matched against the request url path (which includes the /api/auth
// prefix of the mfa plugin).
const MFA_ENROLLMENT_EXEMPT = [
  "/api/auth/mfa/enroll/start",
  "/api/auth/mfa/enroll/verify",
  "/api/auth/mfa/verify",
];

/**
 * Mandatory-MFA gate for platform accounts (design §5.3). Wired into the
 * `platformRoutes` plugin AFTER `requireSuperAdmin()`, so `request.auth` /
 * `request.user` are already populated. A `platform.*` holder that has not
 * enrolled MFA is 403'd on every platform route EXCEPT the MFA-enrollment
 * endpoints. The check reads `mfaEnabled` on privilegedPrisma (the user is
 * platform-wide / pre-tenant).
 */
export function requirePlatformMfa() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    // The platform plugin lives behind the super-admin hook; if auth somehow did
    // not run, fail closed.
    const auth = request.auth;
    if (!auth) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    // Exempt the enrollment endpoints so an un-enrolled operator can enroll.
    const url = request.routeOptions?.url ?? request.url;
    if (MFA_ENROLLMENT_EXEMPT.some((p) => url.startsWith(p))) {
      return;
    }

    const user = await privilegedPrisma.user.findUnique({
      where: { id: auth.userId },
      select: { mfaEnabled: true },
    });

    if (!user?.mfaEnabled) {
      request.log.info({ userId: auth.userId }, "requirePlatformMfa: MFA not enrolled");
      return reply.status(403).send({ error: "MFA enrollment required" });
    }
  };
}

/**
 * Step-up gate for a high-risk action (design §5.3). Verifies the `x-step-up`
 * header JWT: signature + expiry (via the same @fastify/jwt signer that mints
 * it), `userId === request.auth.userId`, `stepUp === true`, and
 * `action === actionClass`. Any failure ⇒ 401 { error: "Step-up required" }.
 *
 * Wired on SupportGrant create as `requireStepUp("support_grant.create")`
 * AFTER `requirePermission("platform.support.grant")`. The guard assumes
 * `authenticate` already populated `request.auth`.
 *
 * PHASE-0 SEAM: the other high-risk actions named in spec §5.2 (pass revoke,
 * future refunds / result publish / institution suspend) attach to this SAME
 * guard with their own action class when their modules land. They are NOT wired
 * in Phase 0 — this is the single documented attach-point.
 */
export function requireStepUp(actionClass: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.auth;
    if (!auth) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const token = request.headers["x-step-up"];
    if (typeof token !== "string" || token.length === 0) {
      return reply.status(401).send({ error: "Step-up required" });
    }

    // request.server.jwt is the @fastify/jwt decorator — the same signer that
    // mints the step-up token in POST /api/auth/mfa/verify.
    const verifier: JwtVerifier = {
      verify: <T>(t: string) => request.server.jwt.verify(t) as T,
    };

    const result = verifyStepUpToken(verifier, token, auth.userId, actionClass);
    if (!result.ok) {
      request.log.info(
        { userId: auth.userId, actionClass, reason: result.reason },
        "requireStepUp: rejected",
      );
      return reply.status(401).send({ error: "Step-up required" });
    }
  };
}
