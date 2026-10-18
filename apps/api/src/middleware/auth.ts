import type { FastifyRequest, FastifyReply } from "fastify";
import { privilegedPrisma, type Role } from "@campusgate/db";

// Extend Fastify's JWT types
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      userId: string;
      role: Role;
      institutionId: string;
      jti?: string;
    };
    user: {
      userId: string;
      role: Role;
      institutionId: string;
      jti?: string;
    };
  }
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  const tokenUser = request.user;

  // Check session revocation before anything else.
  // If the token carries a jti, that session must exist and not be revoked.
  if (tokenUser.jti) {
    const session = await privilegedPrisma.session.findFirst({
      where: { jti: tokenUser.jti, revoked: false },
      select: { id: true, expiresAt: true },
    });

    if (!session) {
      return reply.status(401).send({ error: "Session revoked or expired" });
    }

    // Update lastActiveAt in background so it doesn't slow down requests
    privilegedPrisma.session
      .update({ where: { jti: tokenUser.jti }, data: { lastActiveAt: new Date() } })
      .catch(() => {});
  }

  const dbUser = await privilegedPrisma.user.findUnique({
    where: { id: tokenUser.userId },
    select: {
      id: true,
      role: true,
      institutionId: true,
      accountStatus: true,
      institution: { select: { status: true } },
    },
  });

  if (!dbUser || dbUser.accountStatus !== "ACTIVE") {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  if (dbUser.institution.status !== "ACTIVE") {
    return reply.status(403).send({ error: "Institution is suspended" });
  }

  // Preserve jti so logout/session endpoints can reference the right session
  request.user = {
    userId: dbUser.id,
    role: dbUser.role,
    institutionId: dbUser.institutionId,
    jti: tokenUser.jti,
  };
}

export function requireRole(...roles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await authenticate(request, reply);
    if (reply.sent) return;

    const user = request.user;
    if (!roles.includes(user.role)) {
      return reply.status(403).send({ error: "Forbidden: insufficient role" });
    }
  };
}

export function requireSuperAdmin() {
  return requireRole("SUPER_ADMIN");
}

export function requireTenantRole(...roles: Exclude<Role, "SUPER_ADMIN">[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await authenticate(request, reply);
    if (reply.sent) return;

    const user = request.user;
    if (user.role === "SUPER_ADMIN") {
      return reply.status(403).send({ error: "Forbidden: platform role cannot access tenant endpoint" });
    }

    if (!roles.includes(user.role as Exclude<Role, "SUPER_ADMIN">)) {
      return reply.status(403).send({ error: "Forbidden: insufficient role" });
    }
  };
}
