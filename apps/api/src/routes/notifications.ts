import type { FastifyInstance } from "fastify";
import { prisma } from "@campusgate/db";
import { authenticate } from "../middleware/auth.js";

export async function notificationRoutes(app: FastifyInstance) {
  // Every notification route is scoped to the authenticated user
  app.addHook("preHandler", authenticate);

  // ─── LIST NOTIFICATIONS ────────────────────────────────────────────────────
  app.get("/", async (request, reply) => {
    const { userId } = request.user;
    const { page = "1", limit = "20", unreadOnly } = request.query as Record<
      string,
      string
    >;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 20));

    const where: { userId: string; read?: boolean } = { userId };
    if (unreadOnly === "true") where.read = false;

    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId, read: false } }),
    ]);

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
    const { userId } = request.user;
    const unreadCount = await prisma.notification.count({
      where: { userId, read: false },
    });
    return reply.send({ unreadCount });
  });

  // ─── MARK ONE AS READ ──────────────────────────────────────────────────────
  app.post("/:id/read", async (request, reply) => {
    const { userId } = request.user;
    const { id } = request.params as { id: string };

    // Scope the update to the owner so users cannot touch others' notifications
    const result = await prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true },
    });

    if (result.count === 0) {
      return reply.status(404).send({ error: "Notification not found" });
    }

    const unreadCount = await prisma.notification.count({
      where: { userId, read: false },
    });

    return reply.send({ success: true, unreadCount });
  });

  // ─── MARK ALL AS READ ──────────────────────────────────────────────────────
  app.post("/read-all", async (request, reply) => {
    const { userId } = request.user;

    const result = await prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });

    return reply.send({ success: true, updated: result.count, unreadCount: 0 });
  });
}
