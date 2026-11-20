import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { privilegedPrisma } from "@campusgate/db";

export interface ConnectionMeta {
  socket: WebSocket;
  institutionId: string;
}

const MAX_SOCKETS_PER_USER = 8;
const OPEN = 1;

// Global map of userId -> every open socket of that user (phone and laptop), each
// with tenant metadata so broadcasts can be scoped to one institution without a DB
// lookup per message. New code should use the helpers below, not the raw map.
export const wsConnections = new Map<string, Set<ConnectionMeta>>();

/** Add a socket. Past 8 per user, the oldest is closed with code 4008. */
export function registerSocket(userId: string, meta: ConnectionMeta): void {
  let set = wsConnections.get(userId);
  if (!set) {
    set = new Set();
    wsConnections.set(userId, set);
  }
  set.add(meta);
  while (set.size > MAX_SOCKETS_PER_USER) {
    const oldest = set.values().next().value as ConnectionMeta | undefined;
    if (!oldest) break;
    set.delete(oldest);
    try {
      oldest.socket.close(4008, "Too many connections");
    } catch {
      /* already closed */
    }
  }
}

/** Remove exactly this socket (not the user's other sockets). A second call is a no-op. */
export function unregisterSocket(userId: string, meta: ConnectionMeta): void {
  const set = wsConnections.get(userId);
  if (!set) return;
  set.delete(meta);
  if (set.size === 0) wsConnections.delete(userId);
}

/** Send to every open socket of a user. A socket that throws is unregistered. Returns the count sent. */
export function sendToUser(userId: string, message: string): number {
  const set = wsConnections.get(userId);
  if (!set) return 0;
  let sent = 0;
  for (const meta of [...set]) {
    if (meta.socket.readyState !== OPEN) continue;
    try {
      meta.socket.send(message);
      sent++;
    } catch {
      unregisterSocket(userId, meta);
    }
  }
  return sent;
}

export function forEachInstitutionSocket(
  institutionId: string,
  fn: (meta: ConnectionMeta, userId: string) => void,
): void {
  for (const [userId, set] of wsConnections) {
    for (const meta of [...set]) {
      if (meta.institutionId === institutionId) fn(meta, userId);
    }
  }
}

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
      const user = await privilegedPrisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          role: true,
          institutionId: true,
          accountStatus: true,
          institution: { select: { status: true } },
        },
      });
      if (!user || user.accountStatus !== "ACTIVE" || user.institution.status !== "ACTIVE") {
        socket.close(4003, "Unauthorized");
        return;
      }
      // Register connection
      const meta: ConnectionMeta = { socket, institutionId: user.institutionId };
      registerSocket(userId, meta);
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
      // Cleanup on disconnect (close and error both fire; the second is a no-op)
      socket.on("close", () => {
        unregisterSocket(userId, meta);
        app.log.info(`WebSocket disconnected: ${userId}`);
      });
      socket.on("error", () => {
        unregisterSocket(userId, meta);
      });
    } catch {
      socket.close(4003, "Invalid token");
    }
  });
}
