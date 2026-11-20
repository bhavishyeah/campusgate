import { sentryEnabled, setSentryUserId } from "./instrument.js"; // must stay first
import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import websocket from "@fastify/websocket";
import { authRoutes } from "./routes/auth.js";
import { accountLifecycleRoutes } from "./routes/account-lifecycle.js";
import { accountInviteRoutes } from "./routes/account-invites.js";
import { drainBackground } from "./services/account-invites.js";
import { mfaRoutes } from "./routes/mfa.js";
import { studentRoutes } from "./routes/student.js";
import { studentAdminRoutes } from "./routes/students.js";
import { classesRoutes } from "./routes/classes.js";
import { attendanceRoutes } from "./routes/attendance.js";
import { libraryRoutes } from "./routes/library.js";
import { admissionsRoutes } from "./routes/admissions.js";
import { feesRoutes } from "./routes/fees.js";
import { examsRoutes } from "./routes/exams.js";
import { facultyRoutes } from "./routes/faculty.js";
import { hrRoutes } from "./routes/hr.js";
import { hostelRoutes } from "./routes/hostel.js";
import { transportRoutes } from "./routes/transport.js";
import { inventoryRoutes } from "./routes/inventory.js";
import { serviceRequestsRoutes } from "./routes/service-requests.js";
import { documentsRoutes } from "./routes/documents.js";
import { razorpayWebhookRoutes } from "./routes/razorpay-webhook.js";
import { hodRoutes } from "./routes/hod.js";
import { guardRoutes } from "./routes/guard.js";
import { adminRoutes } from "./routes/admin.js";
import { notificationRoutes } from "./routes/notifications.js";
import { wsRoutes } from "./routes/ws.js";
import { platformRoutes } from "./routes/platform.js";
import { healthRoutes } from "./routes/health.js";

// Client IP for rate limits comes from the right of X-Forwarded-For. Outside
// development/test (including NODE_ENV unset) assume one proxy hop (Railway);
// override with TRUST_PROXY_HOPS. See docs/email-and-accounts.md.
const devOrTest = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
const proxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? "", 10);
const trustedHops = Number.isFinite(proxyHops) && proxyHops >= 0 ? proxyHops : devOrTest ? 0 : 1;
const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
  },
  // Same semantics as a numeric hop count: trust the nearest N proxies.
  trustProxy: (_address: string, hop: number) => hop < trustedHops,
});

if (sentryEnabled) {
  // Opaque user id only (no email/name) for error reports.
  app.addHook("onError", async (request) => {
    setSentryUserId((request as { user?: { userId?: string } }).user?.userId);
  });
}
// Plugins
await app.register(cors, {
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true,
  exposedHeaders: ["x-session-stale"],
});

const jwtSecret = process.env.JWT_SECRET || "campusgate-dev-secret-change-in-production";
if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET must be set in production");
}

await app.register(jwt, {
  secret: jwtSecret,
  sign: { expiresIn: "24h" },
});

await app.register(websocket);

// Routes
await app.register(authRoutes, { prefix: "/api/auth" });
await app.register(accountLifecycleRoutes, { prefix: "/api/auth" });
await app.register(accountInviteRoutes, { prefix: "/api/account-invites" });
await app.register(mfaRoutes, { prefix: "/api/auth/mfa" });
await app.register(studentRoutes, { prefix: "/api/student" });
await app.register(studentAdminRoutes, { prefix: "/api/students" });
await app.register(classesRoutes, { prefix: "/api/classes" });
await app.register(attendanceRoutes, { prefix: "/api/attendance" });
await app.register(libraryRoutes, { prefix: "/api/library" });
await app.register(admissionsRoutes, { prefix: "/api/admissions" });
await app.register(feesRoutes, { prefix: "/api/fees" });
await app.register(examsRoutes, { prefix: "/api/exams" });
await app.register(facultyRoutes, { prefix: "/api/faculty" });
await app.register(hrRoutes, { prefix: "/api/hr" });
await app.register(hostelRoutes, { prefix: "/api/hostel" });
await app.register(transportRoutes, { prefix: "/api/transport" });
await app.register(inventoryRoutes, { prefix: "/api/inventory" });
await app.register(serviceRequestsRoutes, { prefix: "/api/service-requests" });
await app.register(documentsRoutes, { prefix: "/api/documents" });
await app.register(razorpayWebhookRoutes, { prefix: "/api/webhooks" });
await app.register(hodRoutes, { prefix: "/api/hod" });
await app.register(guardRoutes, { prefix: "/api/guard" });
await app.register(adminRoutes, { prefix: "/api/admin" });
await app.register(platformRoutes, { prefix: "/api/platform" });
await app.register(notificationRoutes, { prefix: "/api/notifications" });
await app.register(wsRoutes, { prefix: "/ws" });

// Health check
app.get("/api/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));
// Readiness check (touches the DB; for uptime monitors)
await app.register(healthRoutes);

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

// Let detached forgot-password sends finish on redeploy (Railway sends SIGTERM).
process.once("SIGTERM", () => {
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000).unref());
  void Promise.race([drainBackground(), timeout])
    .then(() => app.close())
    .finally(() => process.exit(0));
});

export type App = typeof app;
