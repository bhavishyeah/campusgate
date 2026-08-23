import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";

// Global map of userId → WebSocket connection
export const wsConnections = new Map<string, WebSocket>();

export async function wsRoutes(app: FastifyInstance) {
  app.get("/connect", { websocket: true }, (socket, request) => {
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

      // Register connection
      wsConnections.set(userId, socket);

      app.log.info(`WebSocket connected: ${userId}`);

      // Send welcome
      socket.send(
        JSON.stringify({
          type: "connected",
          data: { userId, role: decoded.role },
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
