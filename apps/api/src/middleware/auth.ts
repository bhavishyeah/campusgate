import type { FastifyRequest, FastifyReply } from "fastify";
import { prisma, type Role } from "@campusgate/db";

// Extend Fastify's JWT types
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      userId: string;
      role: Role;
      institutionId: string;
    };
    user: {
      userId: string;
      role: Role;
      institutionId: string;
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
  const dbUser = await prisma.user.findUnique({
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

  request.user = {
    userId: dbUser.id,
    role: dbUser.role,
    institutionId: dbUser.institutionId,
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
