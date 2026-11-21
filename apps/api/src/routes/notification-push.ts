import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privilegedPrisma, withTenant } from "@campusgate/db";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_LABELS,
  notificationPreferenceSchema,
  pushSubscribeSchema,
  pushUnsubscribeSchema,
} from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { enforce, limiters } from "../services/rate-limit.js";
import { getPushSender } from "../services/push/index.js";
import { isAllowedPushEndpoint } from "../services/push/endpoint.js";
import { buildPushPayload } from "../services/push/payload.js";
import { ttlSecondsFor, urgencyFor } from "../services/push/categories.js";

const MAX_DEVICES_PER_USER = 10;
const FAILING_AT = 3;
const BODY_LIMIT = 4096;
const INVALID = { error: "Invalid push subscription" };

function decodedLength(value: string): { len: number; first: number } {
  const buf = Buffer.from(value, "base64url");
  return { len: buf.length, first: buf[0] };
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

function parseUserAgent(ua: string): string {
  const browser = /Edg(?:e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/.test(ua)
      ? "iOS"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux|X11/.test(ua)
            ? "Linux"
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Browser";
}

function cleanLabel(label: string | undefined): string | null {
  if (label === undefined) return null;
  const s = label.replace(CONTROL, "").trim().slice(0, 80);
  return s.length > 0 ? s : null;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/** One shared preHandler (F3): authenticate, then platform accounts (no tenant) get 403 on EVERY route. */
async function pushAuth(request: FastifyRequest, reply: FastifyReply) {
  await authenticate(request, reply);
  if (reply.sent) return reply;
  if (!request.tenant) {
    return reply.status(403).send({ error: "Push is not available for platform accounts" });
  }
}

async function preferencesBody(userId: string, institutionId: string) {
  const rows = await withTenant(institutionId, (tx) =>
    tx.notificationPreference.findMany({ where: { userId }, select: { category: true, pushEnabled: true } }),
  );
  const off = new Set(rows.filter((r) => !r.pushEnabled).map((r) => r.category as string));
  return {
    categories: NOTIFICATION_CATEGORIES.map((category) => ({
      category,
      label: NOTIFICATION_CATEGORY_LABELS[category],
      push: !off.has(category),
    })),
    emergency: { locked: true, push: true },
  };
}

export async function notificationPushRoutes(app: FastifyInstance) {
  app.addHook("preHandler", pushAuth);

  // ─── CONFIG ────────────────────────────────────────────────────────────────
  app.get("/push/config", async (_request, reply) => {
    const sender = getPushSender();
    const enabled = sender.isConfigured();
    return reply.send({ enabled, publicKey: enabled ? sender.publicKey() : null });
  });

  // ─── SUBSCRIBE ─────────────────────────────────────────────────────────────
  // Check order: Fastify enforces bodyLimit (413, never echoing input) BEFORE every
  // handler-level check, including authentication (F5); then authenticate (401),
  // platform account (403), rate limit (429), push disabled (503), validation (400),
  // takeover, upsert.
  app.post("/push/subscribe", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    if (!enforce(limiters.pushSubscribe, userId, reply)) return;
    if (!getPushSender().isConfigured()) {
      return reply.status(503).send({ error: "Push notifications are not configured" });
    }

    const parsed = pushSubscribeSchema.safeParse(request.body);
    let reason: string | null = null;
    if (!parsed.success) reason = "schema";
    else if (!isAllowedPushEndpoint(parsed.data.endpoint)) reason = "endpoint";
    else {
      const p = decodedLength(parsed.data.keys.p256dh);
      const a = decodedLength(parsed.data.keys.auth);
      if (p.len !== 65 || p.first !== 0x04) reason = "p256dh";
      else if (a.len !== 16) reason = "auth";
    }
    if (reason || !parsed.success) {
      request.log.info({ userId, reason }, "push.subscribe.invalid");
      return reply.status(400).send(INVALID);
    }
    const { endpoint, keys, label } = parsed.data;
    const rawUa = request.headers["user-agent"];
    const ua = (typeof rawUa === "string" ? rawUa : "").replace(CONTROL, "").slice(0, 255);
    const deviceLabel = cleanLabel(label) ?? parseUserAgent(ua);

    // Takeover: the endpoint is a bearer secret only the browser holds, so whoever
    // presents it owns the device (shared lab computer). RLS hides another tenant's
    // row while the global unique index still collides, hence the owner client.
    await privilegedPrisma.pushSubscription.deleteMany({ where: { endpoint, userId: { not: userId } } });

    const write = () =>
      withTenant(institutionId, async (tx) => {
        const row = await tx.pushSubscription.upsert({
          where: { endpoint },
          create: {
            userId,
            institutionId,
            endpoint,
            p256dh: keys.p256dh,
            auth: keys.auth,
            userAgent: ua || null,
            deviceLabel,
          },
          update: {
            p256dh: keys.p256dh,
            auth: keys.auth,
            userAgent: ua || null,
            deviceLabel,
            failureCount: 0,
            lastFailureAt: null,
          },
          select: { id: true, deviceLabel: true },
        });
        const mine = await tx.pushSubscription.findMany({
          where: { userId },
          select: { id: true, lastSuccessAt: true, createdAt: true },
        });
        if (mine.length > MAX_DEVICES_PER_USER) {
          const evict = mine
            .filter((m) => m.id !== row.id)
            .sort(
              (a, b) =>
                (a.lastSuccessAt ?? a.createdAt).getTime() - (b.lastSuccessAt ?? b.createdAt).getTime(),
            )
            .slice(0, mine.length - MAX_DEVICES_PER_USER)
            .map((m) => m.id);
          if (evict.length) await tx.pushSubscription.deleteMany({ where: { id: { in: evict } } });
        }
        return row;
      });

    let row;
    try {
      row = await write();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      try {
        row = await write();
      } catch (err2) {
        if (!isUniqueViolation(err2)) throw err2;
        request.log.warn({ userId }, "push.subscribe.race");
        return reply.status(409).send({ error: "Could not register device, please retry" });
      }
    }
    return reply.send({ id: row.id, deviceLabel: row.deviceLabel });
  });

  // ─── UNSUBSCRIBE (this device) ─────────────────────────────────────────────
  app.post("/push/unsubscribe", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    if (!enforce(limiters.pushManage, userId, reply)) return;
    const parsed = pushUnsubscribeSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(INVALID);
    const result = await withTenant(institutionId, (tx) =>
      tx.pushSubscription.deleteMany({ where: { endpoint: parsed.data.endpoint, userId } }),
    );
    return reply.send({ removed: result.count > 0 });
  });

  // ─── MY DEVICES ────────────────────────────────────────────────────────────
  app.get("/push/devices", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const rows = await withTenant(institutionId, (tx) =>
      tx.pushSubscription.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: { id: true, deviceLabel: true, createdAt: true, lastSuccessAt: true, failureCount: true },
      }),
    );
    return reply.send({
      devices: rows.map((r) => ({
        id: r.id,
        deviceLabel: r.deviceLabel,
        createdAt: r.createdAt,
        lastSuccessAt: r.lastSuccessAt,
        failing: r.failureCount >= FAILING_AT,
      })),
    });
  });

  app.delete("/push/devices/:id", async (request, reply) => {
    const { userId, institutionId } = request.user;
    if (!enforce(limiters.pushManage, userId, reply)) return;
    const { id } = request.params as { id: string };
    const result = await withTenant(institutionId, (tx) =>
      tx.pushSubscription.deleteMany({ where: { id, userId } }),
    );
    if (result.count === 0) return reply.status(404).send({ error: "Device not found" });
    return reply.send({ removed: true });
  });

  // ─── THIS DEVICE STATUS ────────────────────────────────────────────────────
  // POST (not GET) so the endpoint, a bearer secret, never lands in a URL or access log.
  app.post("/push/status", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    if (!enforce(limiters.pushManage, userId, reply)) return;
    const parsed = pushUnsubscribeSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(INVALID);
    const row = await withTenant(institutionId, (tx) =>
      tx.pushSubscription.findFirst({
        where: { endpoint: parsed.data.endpoint, userId },
        select: { lastSuccessAt: true, failureCount: true },
      }),
    );
    return reply.send({
      known: !!row,
      lastSuccessAt: row?.lastSuccessAt ?? null,
      failing: row ? row.failureCount >= FAILING_AT : false,
    });
  });

  // ─── TEST PUSH (caller's own devices only) ─────────────────────────────────
  // No in-app notification row is created. Results never carry endpoints or keys.
  app.post("/push/test", async (request, reply) => {
    const { userId, institutionId } = request.user;
    if (!enforce(limiters.pushTest, userId, reply)) return;
    const sender = getPushSender();
    if (!sender.isConfigured()) {
      return reply.status(503).send({ error: "Push notifications are not configured" });
    }
    const subs = await withTenant(institutionId, (tx) =>
      tx.pushSubscription.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: { id: true, deviceLabel: true, endpoint: true, p256dh: true, auth: true },
      }),
    );
    if (subs.length === 0) return reply.send({ sent: 0, failed: 0, devices: [] });
    const now = Date.now();
    const text = "Test notification from CampusGate";
    const message = {
      body: buildPushPayload({
        notificationId: `test-${now}`,
        title: "CampusGate",
        body: text,
        category: "SYSTEM",
        priority: "HIGH",
        ts: now,
        push: { title: "CampusGate", body: text },
      }),
      ttlSeconds: ttlSecondsFor("HIGH"),
      urgency: urgencyFor("HIGH"),
    };
    const devices: Array<{ id: string; deviceLabel: string | null; result: "sent" | "failed" | "removed" }> = [];
    const okIds: string[] = [];
    const goneIds: string[] = [];
    for (const s of subs) {
      let result: "sent" | "failed" | "removed" = "failed";
      try {
        const out = await sender.send({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, message);
        if (out.status === "sent") {
          result = "sent";
          okIds.push(s.id);
        } else if (out.status === "gone") {
          result = "removed";
          goneIds.push(s.id);
        }
      } catch {
        // a provider fault is reported as failed
      }
      devices.push({ id: s.id, deviceLabel: s.deviceLabel, result });
    }
    await withTenant(institutionId, async (tx) => {
      if (okIds.length) {
        await tx.pushSubscription.updateMany({
          where: { id: { in: okIds }, userId },
          data: { lastSuccessAt: new Date(), failureCount: 0, lastFailureAt: null },
        });
      }
      if (goneIds.length) await tx.pushSubscription.deleteMany({ where: { id: { in: goneIds }, userId } });
    }).catch(() => {});
    return reply.send({ sent: okIds.length, failed: devices.length - okIds.length, devices });
  });

  // ─── PREFERENCES ───────────────────────────────────────────────────────────
  app.get("/preferences", async (request, reply) => {
    const { userId, institutionId } = request.user;
    return reply.send(await preferencesBody(userId, institutionId));
  });

  app.put("/preferences", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const parsed = notificationPreferenceSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid notification preference" });
    const { category, push } = parsed.data;
    const upsert = () =>
      withTenant(institutionId, (tx) =>
        tx.notificationPreference.upsert({
          where: { userId_category: { userId, category } },
          create: { userId, institutionId, category, pushEnabled: push },
          update: { pushEnabled: push },
        }),
      );
    try {
      await upsert();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await upsert();
    }
    return reply.send(await preferencesBody(userId, institutionId));
  });
}
