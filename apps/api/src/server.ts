import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import websocket from "@fastify/websocket";
import { authRoutes } from "./routes/auth.js";
import { studentRoutes } from "./routes/student.js";
import { hodRoutes } from "./routes/hod.js";
import { guardRoutes } from "./routes/guard.js";
import { adminRoutes } from "./routes/admin.js";
import { wsRoutes } from "./routes/ws.js";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
  },
});

// Plugins
await app.register(cors, {
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true,
});

await app.register(jwt, {
  secret: process.env.JWT_SECRET || "campusgate-dev-secret-change-in-production",
  sign: { expiresIn: "24h" },
});

await app.register(websocket);

// Routes
await app.register(authRoutes, { prefix: "/api/auth" });
await app.register(studentRoutes, { prefix: "/api/student" });
await app.register(hodRoutes, { prefix: "/api/hod" });
await app.register(guardRoutes, { prefix: "/api/guard" });
await app.register(adminRoutes, { prefix: "/api/admin" });
await app.register(wsRoutes, { prefix: "/ws" });

// Health check
app.get("/api/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

// Start
const port = Number(process.env.PORT) || 4000;
const host = process.env.HOST || "0.0.0.0";

try {
  await app.listen({ port, host });
  app.log.info(`CAMPUSGATE API running on http://${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

export type App = typeof app;
