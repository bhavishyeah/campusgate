import type { FastifyInstance } from "fastify";
import { privilegedPrisma } from "@campusgate/db";

export const READINESS_TIMEOUT_MS = 3000;

/**
 * GET /api/health/ready — database readiness probe for uptime monitors.
 *
 * Unauthenticated, no tenant context, read-only (`SELECT 1` on the privileged
 * client, the same one the auth bootstrap uses). The response never carries
 * error text; the real error is logged server-side only.
 * `/api/health` (liveness, no DB) is intentionally left untouched.
 */
export async function healthRoutes(
  app: FastifyInstance,
  opts: { timeoutMs?: number } = {},
) {
  const timeoutMs = opts.timeoutMs ?? READINESS_TIMEOUT_MS;

  app.get("/api/health/ready", async (request, reply) => {
    const timestamp = new Date().toISOString();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("readiness probe timed out")), timeoutMs);
      });
      await Promise.race([privilegedPrisma.$queryRaw`SELECT 1`, timeout]);
      return { status: "ok", db: "up", timestamp };
    } catch (err) {
      // Log only the error name/message class, never the full object (Prisma
      // errors can embed connection details).
      request.log.warn(
        {
          errName: err instanceof Error ? err.name : "unknown",
          errCode: (err as { errorCode?: string; code?: string })?.errorCode ??
            (err as { code?: string })?.code,
        },
        "readiness probe: database check failed",
      );
      return reply.code(503).send({ status: "error", db: "down", timestamp });
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}
