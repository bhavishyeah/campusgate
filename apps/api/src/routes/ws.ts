import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { prisma } from "@campusgate/db";

// Global map of userId → WebSocket connection
export const wsConnections = new Map<string, WebSocket>();

export async function wsRoutes(app: FastifyInstance) {
  app.get("/connect", { websocket: true }, async (socket, request) => {
    // Authenticate via query param token
    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get("token");

    if (!token) {
      socket.close(4001, "Missing token");
      return;
    }

    try {
      const decoded = app.jwt.verify<{
        userId: string;
        role: string;
        institutionId: string;
      }>(token);

      const userId = decoded.userId;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          role: true,
          accountStatus: true,
          institution: { select: { status: true } },
        },
      });

      if (!user || user.accountStatus !== "ACTIVE" || user.institution.status !== "ACTIVE") {
        socket.close(4003, "Unauthorized");
        return;
      }

      // Register connection
      wsConnections.set(userId, socket);

      app.log.info(`WebSocket connected: ${userId}`);

      // Send welcome
      socket.send(
        JSON.stringify({
          type: "connected",
          data: { userId, role: user.role },
        })
      );

      // Handle ping/pong for keepalive
      socket.on("message", (msg: any) => {
        const message = msg.toString();
        if (message === "ping") {
          socket.send("pong");
        }
      });

      // Cleanup on disconnect
      socket.on("close", () => {
        wsConnections.delete(userId);
        app.log.info(`WebSocket disconnected: ${userId}`);
      });

      socket.on("error", () => {
        wsConnections.delete(userId);
      });
    } catch {
      socket.close(4003, "Invalid token");
    }
  });
}
