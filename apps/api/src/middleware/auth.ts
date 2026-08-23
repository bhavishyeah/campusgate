import type { FastifyRequest, FastifyReply } from "fastify";
import type { Role } from "@campusgate/db";

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
