import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  subs: [] as any[],
  prefs: [] as any[],
  takeover: vi.fn(),
  upsertFailures: 0,
  seq: 0,
}));

vi.mock("@campusgate/db", () => {
  const tx = {
    pushSubscription: {
      upsert: async ({ where, create, update, select }: any) => {
        if (store.upsertFailures > 0) {
          store.upsertFailures--;
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        let row = store.subs.find((s) => s.endpoint === where.endpoint);
        if (row) Object.assign(row, update);
        else {
          row = { id: `s${++store.seq}`, createdAt: new Date(2026, 0, store.seq), lastSuccessAt: null, failureCount: 0, ...create };
          store.subs.push(row);
        }
        return select ? { id: row.id, deviceLabel: row.deviceLabel } : row;
      },
      findMany: async ({ where }: any) => store.subs.filter((s) => s.userId === where.userId),
      deleteMany: async ({ where }: any) => {
        const before = store.subs.length;
        store.subs = store.subs.filter((s) => {
          if (where.endpoint && s.endpoint !== where.endpoint) return true;
          if (where.id && typeof where.id === "string" && s.id !== where.id) return true;
          if (where.id?.in && !where.id.in.includes(s.id)) return true;
          if (where.userId && s.userId !== where.userId) return true;
          return false;
        });
        return { count: before - store.subs.length };
      },
    },
    notificationPreference: {
      findMany: async ({ where }: any) => store.prefs.filter((p) => p.userId === where.userId),
      upsert: async ({ where, create, update }: any) => {
        const k = where.userId_category;
        const row = store.prefs.find((p) => p.userId === k.userId && p.category === k.category);
        if (row) Object.assign(row, update);
        else store.prefs.push({ ...create });
      },
    },
  };
  return {
    withTenant: (_i: string, fn: any) => fn(tx),
    privilegedPrisma: {
      pushSubscription: {
        deleteMany: async (args: any) => {
          store.takeover(args);
          const { endpoint, userId } = args.where;
          store.subs = store.subs.filter((s) => !(s.endpoint === endpoint && s.userId !== userId.not));
          return { count: 0 };
        },
      },
    },
  };
});

vi.mock("../../middleware/auth.js", () => ({
  authenticate: async (request: any, reply: any) => {
    const who = request.headers["x-test-user"];
    if (!who) return reply.status(401).send({ error: "Unauthorized" });
    if (who === "super") {
      request.user = { userId: "root", institutionId: "platform", role: "SUPER_ADMIN" };
      return;
    }
    request.user = { userId: String(who), institutionId: "inst-1", role: "STUDENT" };
    request.tenant = { institutionId: "inst-1" };
  },
}));

import { notificationPushRoutes } from "../notification-push.js";
import { InMemoryPushSender, setPushSender } from "../../services/push/index.js";
import { resetAllLimiters } from "../../services/rate-limit.js";

const P256 = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url");
const AUTH = Buffer.alloc(16, 9).toString("base64url");
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";
const body = (over: Record<string, unknown> = {}) => ({ endpoint: ENDPOINT, keys: { p256dh: P256, auth: AUTH }, ...over });
const INVALID = { error: "Invalid push subscription" };

async function makeApp() {
  const app = Fastify();
  await app.register(notificationPushRoutes, { prefix: "/api/notifications" });
  return app;
}
type App = Awaited<ReturnType<typeof makeApp>>;
const call = (app: App, method: any, url: string, user: string | null, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url: `/api/notifications${url}`, payload: payload as any, headers: { ...(user ? { "x-test-user": user } : {}), ...headers } });

let app: App;
beforeEach(async () => {
  store.subs = [];
  store.prefs = [];
  store.upsertFailures = 0;
  store.seq = 0;
  store.takeover.mockClear();
  resetAllLimiters();
  setPushSender(new InMemoryPushSender("PUBKEY"));
  app = await makeApp();
});

describe("auth and platform accounts (F3)", () => {
  const routes: Array<[string, string, unknown?]> = [
    ["GET", "/push/config"],
    ["POST", "/push/subscribe", body()],
    ["POST", "/push/unsubscribe", { endpoint: ENDPOINT }],
    ["GET", "/push/devices"],
    ["DELETE", "/push/devices/abc"],
    ["GET", "/preferences"],
    ["PUT", "/preferences", { category: "FEES", push: false }],
  ];
  it.each(routes)("%s %s returns 401 without a session", async (method, url, payload) => {
    expect((await call(app, method, url, null, payload)).statusCode).toBe(401);
  });
  it.each(routes)("%s %s returns 403 for a SUPER_ADMIN (no tenant)", async (method, url, payload) => {
    const r = await call(app, method, url, "super", payload);
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "Push is not available for platform accounts" });
  });
});

describe("GET /push/config", () => {
  it("returns the public key when configured and nulls when disabled", async () => {
    expect((await call(app, "GET", "/push/config", "u1")).json()).toEqual({ enabled: true, publicKey: "PUBKEY" });
    setPushSender(new InMemoryPushSender(null));
    expect((await call(app, "GET", "/push/config", "u1")).json()).toEqual({ enabled: false, publicKey: null });
  });
});

describe("POST /push/subscribe", () => {
  it("stores a valid subscription and returns only id and label", async () => {
    const r = await call(app, "POST", "/push/subscribe", "u1", body(), { "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: "s1", deviceLabel: "Chrome on Android" });
    expect(store.subs).toHaveLength(1);
    expect(store.subs[0]).toMatchObject({ userId: "u1", institutionId: "inst-1", endpoint: ENDPOINT });
  });

  it("a caller label wins, trimmed and capped", async () => {
    const r = await call(app, "POST", "/push/subscribe", "u1", body({ label: `  My phone\u0007 ${"x".repeat(150)}` }));
    expect(r.json().deviceLabel.length).toBeLessThanOrEqual(80);
    expect(r.json().deviceLabel.startsWith("My phone")).toBe(true);
  });

  it("subscribing the same endpoint twice yields one row", async () => {
    await call(app, "POST", "/push/subscribe", "u1", body());
    await call(app, "POST", "/push/subscribe", "u1", body());
    expect(store.subs).toHaveLength(1);
  });

  it("re-binds an endpoint to a different user via the owner-client takeover", async () => {
    await call(app, "POST", "/push/subscribe", "u1", body());
    await call(app, "POST", "/push/subscribe", "u2", body());
    expect(store.takeover).toHaveBeenLastCalledWith({ where: { endpoint: ENDPOINT, userId: { not: "u2" } } });
    expect(store.subs.map((s) => s.userId)).toEqual(["u2"]);
    const list = (await call(app, "GET", "/push/devices", "u1")).json();
    expect(list.devices).toEqual([]);
  });

  const invalid: Array<[string, unknown]> = [
    ["http endpoint", body({ endpoint: "http://fcm.googleapis.com/x" })],
    ["storage.googleapis.com", body({ endpoint: "https://storage.googleapis.com/x" })],
    ["fcm lookalike", body({ endpoint: "https://fcm.googleapis.com.evil.com/x" })],
    ["IP literal", body({ endpoint: "https://127.0.0.1/x" })],
    ["bad p256dh length", body({ keys: { p256dh: Buffer.alloc(65, 4).toString("base64url").slice(0, 80), auth: AUTH } })],
    ["p256dh without 0x04", body({ keys: { p256dh: Buffer.alloc(65, 1).toString("base64url"), auth: AUTH } })],
    ["auth wrong size", body({ keys: { p256dh: P256, auth: Buffer.alloc(20, 1).toString("base64url") } })],
    ["missing keys", { endpoint: ENDPOINT }],
    ["not an object", [1]],
  ];
  it.each(invalid)("400 with a generic body and nothing stored: %s", async (_n, payload) => {
    const r = await call(app, "POST", "/push/subscribe", "u1", payload);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual(INVALID);
    expect(r.body).not.toMatch(/googleapis|evil|127\.0/);
    expect(store.subs).toHaveLength(0);
    expect(store.takeover).not.toHaveBeenCalled();
  });

  it("413 for a body over 4 KB, without echoing it, and nothing stored", async () => {
    const r = await call(app, "POST", "/push/subscribe", "u1", body({ label: "x".repeat(5000) }));
    expect(r.statusCode).toBe(413);
    expect(r.body).not.toContain("xxxxx");
    expect(store.subs).toHaveLength(0);
  });

  it("503 when push is not configured, before any validation or write", async () => {
    setPushSender(new InMemoryPushSender(null));
    const r = await call(app, "POST", "/push/subscribe", "u1", body());
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: "Push notifications are not configured" });
    expect(store.takeover).not.toHaveBeenCalled();
  });

  it("429 with Retry-After after 20 requests in the window", async () => {
    for (let i = 0; i < 20; i++) expect((await call(app, "POST", "/push/subscribe", "u1", body())).statusCode).toBe(200);
    const r = await call(app, "POST", "/push/subscribe", "u1", body());
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("caps at 10 devices per user, evicting the oldest", async () => {
    for (let i = 0; i < 11; i++) {
      await call(app, "POST", "/push/subscribe", "u1", body({ endpoint: `https://fcm.googleapis.com/fcm/send/d${i}` }));
    }
    const mine = store.subs.filter((s) => s.userId === "u1");
    expect(mine).toHaveLength(10);
    expect(mine.some((s) => s.endpoint.endsWith("/d0"))).toBe(false);
    expect(mine.some((s) => s.endpoint.endsWith("/d10"))).toBe(true);
  });

  it("retries a unique race once, then returns 409", async () => {
    store.upsertFailures = 1;
    expect((await call(app, "POST", "/push/subscribe", "u1", body())).statusCode).toBe(200);
    store.upsertFailures = 2;
    const r = await call(app, "POST", "/push/subscribe", "u1", body({ endpoint: "https://fcm.googleapis.com/fcm/send/other" }));
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "Could not register device, please retry" });
  });
});

describe("unsubscribe, devices", () => {
  it("unsubscribe removes only my row and is idempotent", async () => {
    await call(app, "POST", "/push/subscribe", "u1", body());
    expect((await call(app, "POST", "/push/unsubscribe", "u2", { endpoint: ENDPOINT })).json()).toEqual({ removed: false });
    expect((await call(app, "POST", "/push/unsubscribe", "u1", { endpoint: ENDPOINT })).json()).toEqual({ removed: true });
    expect((await call(app, "POST", "/push/unsubscribe", "u1", { endpoint: ENDPOINT })).json()).toEqual({ removed: false });
  });

  it("lists devices without endpoint or keys and flags failing ones", async () => {
    await call(app, "POST", "/push/subscribe", "u1", body());
    store.subs[0].failureCount = 3;
    const r = await call(app, "GET", "/push/devices", "u1");
    const d = r.json().devices[0];
    expect(Object.keys(d).sort()).toEqual(["createdAt", "deviceLabel", "failing", "id", "lastSuccessAt"]);
    expect(d.failing).toBe(true);
    expect(r.body).not.toMatch(/googleapis|p256dh|auth/);
  });

  it("removes my device; a foreign or unknown id is 404", async () => {
    await call(app, "POST", "/push/subscribe", "u1", body());
    expect((await call(app, "DELETE", "/push/devices/s1", "u2")).statusCode).toBe(404);
    expect((await call(app, "DELETE", "/push/devices/s1", "u1")).json()).toEqual({ removed: true });
    expect((await call(app, "DELETE", "/push/devices/s1", "u1")).statusCode).toBe(404);
  });
});

describe("preferences", () => {
  it("GET defaults to everything on with EMERGENCY locked", async () => {
    const j = (await call(app, "GET", "/preferences", "u1")).json();
    expect(j.categories).toHaveLength(8);
    expect(j.categories.every((c: any) => c.push === true && typeof c.label === "string")).toBe(true);
    expect(j.categories.some((c: any) => c.category === "EMERGENCY")).toBe(false);
    expect(j.emergency).toEqual({ locked: true, push: true });
  });

  it("PUT toggles a category and returns the new state", async () => {
    const j = (await call(app, "PUT", "/preferences", "u1", { category: "FEES", push: false })).json();
    expect(j.categories.find((c: any) => c.category === "FEES").push).toBe(false);
    expect(j.categories.find((c: any) => c.category === "EXAMS").push).toBe(true);
    const back = (await call(app, "PUT", "/preferences", "u1", { category: "FEES", push: true })).json();
    expect(back.categories.find((c: any) => c.category === "FEES").push).toBe(true);
    expect(store.prefs).toHaveLength(1);
  });

  it("rejects EMERGENCY and unknown categories", async () => {
    expect((await call(app, "PUT", "/preferences", "u1", { category: "EMERGENCY", push: false })).statusCode).toBe(400);
    expect((await call(app, "PUT", "/preferences", "u1", { category: "NOPE", push: false })).statusCode).toBe(400);
    expect(store.prefs).toHaveLength(0);
  });
});

