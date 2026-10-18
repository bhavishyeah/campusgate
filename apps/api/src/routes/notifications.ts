import type { FastifyInstance } from "fastify";
import { withTenant } from "@campusgate/db";
import { authenticate } from "../middleware/auth.js";

export async function notificationRoutes(app: FastifyInstance) {
  // Every notification route is scoped to the authenticated user
  app.addHook("preHandler", authenticate);

  // ─── LIST NOTIFICATIONS ────────────────────────────────────────────────────
  app.get("/", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { page = "1", limit = "20", unreadOnly } = request.query as Record<
      string,
      string
    >;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 20));

    const where: { userId: string; read?: boolean } = { userId };
    if (unreadOnly === "true") where.read = false;

    const [notifications, total, unreadCount] = await withTenant(institutionId, (tx) =>
      Promise.all([
        tx.notification.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (pageNum - 1) * limitNum,
          take: limitNum,
        }),
        tx.notification.count({ where }),
        tx.notification.count({ where: { userId, read: false } }),
      ]),
    );

    return reply.send({
      notifications,
      unreadCount,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  });

  // ─── UNREAD COUNT ──────────────────────────────────────────────────────────
  app.get("/unread-count", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const unreadCount = await withTenant(institutionId, (tx) =>
      tx.notification.count({
        where: { userId, read: false },
      }),
    );
    return reply.send({ unreadCount });
  });

  // ─── MARK ONE AS READ ──────────────────────────────────────────────────────
  app.post("/:id/read", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { id } = request.params as { id: string };

    const result = await withTenant(institutionId, async (tx) => {
      // Scope the update to the owner so users cannot touch others' notifications
      const updated = await tx.notification.updateMany({
        where: { id, userId },
        data: { read: true },
      });

      if (updated.count === 0) return { notFound: true as const };

      const unreadCount = await tx.notification.count({
        where: { userId, read: false },
      });

      return { unreadCount };
    });

    if ("notFound" in result) {
      return reply.status(404).send({ error: "Notification not found" });
    }

    return reply.send({ success: true, unreadCount: result.unreadCount });
  });

  // ─── MARK ALL AS READ ──────────────────────────────────────────────────────
  app.post("/read-all", async (request, reply) => {
    const { userId, institutionId } = request.user;

    const result = await withTenant(institutionId, (tx) =>
      tx.notification.updateMany({
        where: { userId, read: false },
        data: { read: true },
      }),
    );

    return reply.send({ success: true, updated: result.count, unreadCount: 0 });
  });
}
