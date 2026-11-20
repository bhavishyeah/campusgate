import { describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => ({ privilegedPrisma: {}, prisma: {}, withTenant: vi.fn() }));

import {
  backoffMs,
  MAX_PENDING_ITEMS,
  PushDispatcher,
  type DeliveryEvent,
  type NewPushJob,
} from "../dispatcher.js";
import { InMemoryPushSender, type PushOutcome } from "../sender.js";

const DAY = 24 * 3_600_000;
const FCM = (id: string) => `https://fcm.googleapis.com/fcm/send/${id}`;
const MOZ = (id: string) => `https://updates.push.services.mozilla.com/wpush/${id}`;

interface Sub {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failureCount: number;
  lastFailureAt: Date | null;
  lastSuccessAt: Date | null;
  createdAt: Date;
  status: string;
}

function harness(start = 10 * DAY) {
  const s = {
    clock: start,
    instActive: true,
    notifications: new Map<string, { id: string; userId: string; read: boolean }>(),
    prefs: [] as Array<{ userId: string; category: string; pushEnabled: boolean }>,
    subs: [] as Sub[],
    logs: [] as Array<{ level: string; msg?: string; obj: any }>,
    onSleep: (_ms: number) => {},
  };
  const addNotification = (id: string, userId: string, read = false) => s.notifications.set(id, { id, userId, read });
  const addSub = (id: string, userId: string, endpoint: string, extra: Partial<Sub> = {}) =>
    s.subs.push({
      id,
      userId,
      endpoint,
      p256dh: "p",
      auth: "a",
      failureCount: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      createdAt: new Date(start - 30 * DAY),
      status: "ACTIVE",
      ...extra,
    });
  const tx: any = {
    notification: {
      findMany: async ({ where }: any) => [...s.notifications.values()].filter((n) => where.id.in.includes(n.id)),
    },
    notificationPreference: {
      findMany: async ({ where }: any) =>
        s.prefs.filter(
          (p) => where.userId.in.includes(p.userId) && p.category === where.category && p.pushEnabled === where.pushEnabled,
        ),
    },
    pushSubscription: {
      findMany: async ({ where }: any) =>
        s.subs
          .filter((x) => where.userId.in.includes(x.userId) && (!where.id || where.id.in.includes(x.id)))
          .map((x) => ({ ...x, user: { accountStatus: x.status } })),
      updateMany: async ({ where, data }: any) => {
        for (const x of s.subs.filter((y) => where.id.in.includes(y.id))) {
          if (data.failureCount?.increment) x.failureCount += data.failureCount.increment;
          else if (typeof data.failureCount === "number") x.failureCount = data.failureCount;
          if ("lastSuccessAt" in data) x.lastSuccessAt = data.lastSuccessAt;
          if ("lastFailureAt" in data) x.lastFailureAt = data.lastFailureAt;
        }
      },
      deleteMany: async ({ where }: any) => {
        s.subs = s.subs.filter((x) => {
          if (!where.id.in.includes(x.id)) return true;
          if (where.failureCount) {
            if (x.failureCount < where.failureCount.gte) return true;
            const cutoff = where.OR[0].lastSuccessAt.lt as Date;
            const old = x.lastSuccessAt ? x.lastSuccessAt < cutoff : x.createdAt < cutoff;
            return !old;
          }
          return false;
        });
      },
    },
  };
  const sender = new InMemoryPushSender();
  const log = {
    info: (obj: any, msg?: string) => s.logs.push({ level: "info", msg, obj }),
    warn: (obj: any, msg?: string) => s.logs.push({ level: "warn", msg, obj }),
    error: (obj: any, msg?: string) => s.logs.push({ level: "error", msg, obj }),
  };
  const d = new PushDispatcher({
    sender: () => sender,
    runTenant: (_id, fn) => fn(tx),
    institutionActive: async () => s.instActive,
    now: () => s.clock,
    sleep: async (ms) => {
      s.clock += ms;
      s.onSleep(ms);
    },
    log,
  });
  const events: DeliveryEvent[] = [];
  const job = (items: Array<[string, string]>, over: Partial<NewPushJob["msg"]> = {}, extra: Partial<NewPushJob> = {}): NewPushJob => ({
    institutionId: "inst-1",
    items: items.map(([notificationId, userId]) => ({ notificationId, userId })),
    msg: { title: "Hi", body: "Body", category: "FEES", priority: "NORMAL", ts: s.clock, ...over },
    onDelivery: (e) => void events.push(...e),
    ...extra,
  });
  return { s, d, sender, tx, events, addNotification, addSub, job };
}

describe("backoffMs", () => {
  it("is 0 below 3 failures, then 15 min doubling to a 24 h cap", () => {
    expect(backoffMs(2)).toBe(0);
    expect(backoffMs(3)).toBe(15 * 60_000);
    expect(backoffMs(4)).toBe(30 * 60_000);
    expect(backoffMs(9)).toBe(16 * 3_600_000);
    expect(backoffMs(10)).toBe(24 * 3_600_000);
    expect(backoffMs(40)).toBe(24 * 3_600_000);
  });
});

describe("PushDispatcher", () => {
  it("sends once per device after enqueue and records success", async () => {
    const h = harness();
    h.addNotification("n1", "u1");
    h.addSub("s1", "u1", FCM("1"));
    h.addSub("s2", "u1", MOZ("2"));
    h.d.enqueue(h.job([["n1", "u1"]]));
    expect(h.sender.sent).toHaveLength(0); // nothing runs inside the caller's turn
    await h.d.idle();
    expect(h.sender.sent).toHaveLength(2);
    expect(h.s.subs.every((x) => x.lastSuccessAt !== null && x.failureCount === 0)).toBe(true);
    expect(h.events).toEqual([{ notificationId: "n1", userId: "u1", result: "pushed" }]);
    expect(JSON.parse(h.sender.sent[0].message.body)).toMatchObject({ v: 1, id: "n1", b: "Open CampusGate to see the details." });
  });

  it("push disabled enqueues nothing", async () => {
    const h = harness();
    const off = new PushDispatcher({ sender: () => new InMemoryPushSender(null), runTenant: (_i, fn) => fn(h.tx) });
    h.addNotification("n1", "u1");
    off.enqueue(h.job([["n1", "u1"]]));
    expect(off.pendingItems()).toBe(0);
  });

  it("mutes a disabled category but EMERGENCY bypasses preferences", async () => {
    const h = harness();
    h.addNotification("n1", "u1");
    h.addNotification("n2", "u1");
    h.addSub("s1", "u1", FCM("1"));
    h.s.prefs.push({ userId: "u1", category: "FEES", pushEnabled: false });
    h.d.enqueue(h.job([["n1", "u1"]]));
    await h.d.idle();
    expect(h.sender.sent).toHaveLength(0);
    expect(h.events[0].result).toBe("muted");
    h.d.enqueue(h.job([["n2", "u1"]], { category: "EMERGENCY", priority: "EMERGENCY" }));
    await h.d.idle();
    expect(h.sender.sent).toHaveLength(1);
    // also bypassed when the priority is EMERGENCY but the category is a muted one
    h.d.enqueue(h.job([["n2", "u1"]], { category: "FEES", priority: "EMERGENCY" }));
    await h.d.idle();
    expect(h.sender.sent).toHaveLength(2);
  });

  it("sends nothing for an inactive account or a suspended institution", async () => {
    const h = harness();
    h.addNotification("n1", "u1");
    h.addSub("s1", "u1", FCM("1"), { status: "SUSPENDED" });
    h.d.enqueue(h.job([["n1", "u1"]]));
    await h.d.idle();
    expect(h.sender.sent).toHaveLength(0);
    expect(h.events[0].result).toBe("inactive");
    h.events.length = 0;
    h.s.instActive = false;
    h.d.enqueue(h.job([["n1", "u1"]]));
    await h.d.idle();
    expect(h.sender.sent).toHaveLength(0);
    expect(h.events[0].result).toBe("inactive");
  });

  it("reports no_device for a user with no subscriptions", async () => {
    const h = harness();
    h.addNotification("n1", "u1");
    h.d.enqueue(h.job([["n1", "u1"]]));
    await h.d.idle();
    expect(h.events).toEqual([{ notificationId: "n1", userId: "u1", result: "no_device" }]);
  });

  it("410 deletes the subscription", async () => {
    const h = harness();
    h.addNotification("n1", "u1");
    h.addSub("s1", "u1", FCM("1"));
    h.sender.respond = () => ({ status: "gone" });
    h.d.enqueue(h.job([["n1", "u1"]]));
    await h.d.idle();
    expect(h.s.subs).toHaveLength(0);
  });

  it("a 5xx increments failureCount; backoff skips the device until its window passes", async () => {
    const h = harness();
    h.addNotification("n1", "u1");
    h.addSub("s1", "u1", FCM("1"));
    h.sender.respond = () => ({ status: "retry", reason: "status_503" });
    h.d.enqueue(h.job([["n1", "u1"]]));
    await h.d.idle();
    expect(h.s.subs[0].failureCount).toBe(1);
    expect(h.events[0].result).toBe("failed");

    // 3 failures, last one 1 minute ago: skipped
    h.sender.sent.length = 0;
    h.s.subs[0].failureCount = 3;
    h.s.subs[0].lastFailureAt = new Date(h.s.clock - 60_000);
    h.d.enqueue(h.job([["n1", "u1"]]));
    await h.d.idle();
    expect(h.sender.sent).toHaveLength(0);
    // after the 15 minute window it is tried again
    h.s.clock += 16 * 60_000;
    h.d.enqueue(h.job([["n1", "u1"]]));
    await h.d.idle();
    expect(h.sender.sent).toHaveLength(1);
  });

  it("deletes at 8 failures only when there was no success for 7 days", async () => {
    const h = harness();
    h.addNotification("n1", "u1");
    h.addNotification("n2", "u2");
    const longAgo = new Date(h.s.clock - 10 * 3_600_000);
    h.addSub("recent", "u1", FCM("1"), { failureCount: 7, lastFailureAt: longAgo, lastSuccessAt: new Date(h.s.clock - 2 * DAY) });
    h.addSub("dead", "u2", FCM("2"), { failureCount: 7, lastFailureAt: longAgo, lastSuccessAt: new Date(h.s.clock - 8 * DAY) });
    h.sender.respond = () => ({ status: "rejected", reason: "status_400" });
    h.d.enqueue(h.job([["n1", "u1"], ["n2", "u2"]]));
    await h.d.idle();
    expect(h.s.subs.map((x) => x.id)).toEqual(["recent"]);
    expect(h.s.subs[0].failureCount).toBe(8);
  });

  it("retries a row that is not visible yet and still sends when it appears (visAttempt 2)", async () => {
    const h = harness();
    h.addSub("s1", "u1", FCM("1"));
    const t0 = h.s.clock;
    h.s.onSleep = () => {
      if (h.s.clock - t0 >= 9_000) h.addNotification("n1", "u1");
    };
    h.d.enqueue(h.job([["n1", "u1"]]));
    await h.d.idle();
    expect(h.sender.sent).toHaveLength(1);
    expect(h.events).toEqual([{ notificationId: "n1", userId: "u1", result: "pushed" }]);
  });

  it("drops rows still missing after visAttempt 5 with push.job.rows_missing", async () => {
    const h = harness();
    h.addSub("s1", "u1", FCM("1"));
    h.d.enqueue(h.job([["n1", "u1"]]));
    await h.d.idle();
    expect(h.sender.sent).toHaveLength(0);
    expect(h.events).toEqual([{ notificationId: "n1", userId: "u1", result: "dropped" }]);
    expect(h.s.logs.filter((l) => l.msg === "push.job.rows_missing")).toHaveLength(1);
    expect(h.s.logs.find((l) => l.msg === "push.job.rows_missing")!.obj).toMatchObject({ missing: 1, attempts: 6 });
  });

  it("F1: an already-read row is never retried or logged as missing", async () => {
    const h = harness();
    h.addNotification("n1", "u1", true);
    h.addSub("s1", "u1", FCM("1"));
    const t0 = h.s.clock;
    h.d.enqueue(h.job([["n1", "u1"]]));
    await h.d.idle();
    expect(h.sender.sent).toHaveLength(0);
    expect(h.events).toEqual([{ notificationId: "n1", userId: "u1", result: "skipped_read" }]);
    expect(h.s.logs.some((l) => l.msg === "push.job.rows_missing")).toBe(false);
    expect(h.s.clock).toBe(t0);
  });

  it("401/403 does not change failureCount and logs push.vapid_rejected", async () => {
    const h = harness();
    h.addNotification("n1", "u1");
    h.addSub("s1", "u1", FCM("1"));
    h.sender.respond = () => ({ status: "unauthorized", reason: "status_403" });
    h.d.enqueue(h.job([["n1", "u1"]]));
    await h.d.idle();
    expect(h.s.subs[0].failureCount).toBe(0);
    expect(h.s.logs.some((l) => l.msg === "push.vapid_rejected" && l.level === "error")).toBe(true);
    expect(h.events[0].result).toBe("failed");
  });

  it("F2: a 429 pauses only its own host; other hosts (including EMERGENCY) send immediately", async () => {
    const h = harness();
    h.addNotification("n1", "uA");
    h.addNotification("n2", "uB");
    h.addSub("sA", "uA", FCM("1"));
    h.addSub("sB", "uB", MOZ("2"));
    const t0 = h.s.clock;
    const sentAt: Record<string, number> = {};
    let fcmCalls = 0;
    h.sender.respond = (target): PushOutcome => {
      if (target.endpoint.includes("fcm.googleapis.com")) {
        fcmCalls++;
        if (fcmCalls === 1) return { status: "retry", retryAfterSec: 30, reason: "status_429" };
      }
      sentAt[target.endpoint] = h.s.clock;
      return { status: "sent" };
    };
    h.d.enqueue(h.job([["n1", "uA"], ["n2", "uB"]], { category: "EMERGENCY", priority: "EMERGENCY" }));
    await h.d.idle();
    expect(h.d.pausedUntilByHost.get("fcm.googleapis.com")).toBe(t0 + 30_000);
    expect(h.d.pausedUntilByHost.has("updates.push.services.mozilla.com")).toBe(false);
    expect(sentAt[MOZ("2")]).toBe(t0);
    expect(sentAt[FCM("1")]).toBeGreaterThanOrEqual(t0 + 30_000);
    expect(h.s.subs.every((x) => x.failureCount === 0)).toBe(true);
    expect(h.events.map((e) => `${e.userId}:${e.result}`).sort()).toEqual(["uA:pushed", "uB:pushed"]);
    expect(JSON.stringify(h.s.logs)).not.toContain("fcm.googleapis.com");
  });

  it("F2: a second 429 for the same item is reported failed with no failureCount change", async () => {
    const h = harness();
    h.addNotification("n1", "uA");
    h.addSub("sA", "uA", FCM("1"));
    h.sender.respond = () => ({ status: "retry", retryAfterSec: 5, reason: "status_429" });
    h.d.enqueue(h.job([["n1", "uA"]]));
    await h.d.idle();
    expect(h.sender.sent).toHaveLength(2);
    expect(h.s.subs[0].failureCount).toBe(0);
    expect(h.events).toEqual([{ notificationId: "n1", userId: "uA", result: "failed" }]);
  });

  it("F6: a 429 re-enqueue keeps visAttempt (separate counters)", async () => {
    const h = harness();
    h.addSub("sA", "uA", FCM("1"));
    const t0 = h.s.clock;
    h.s.onSleep = () => {
      if (h.s.clock - t0 >= 3_000) h.addNotification("n1", "uA");
    };
    let n = 0;
    h.sender.respond = () => (++n === 1 ? { status: "retry", retryAfterSec: 1, reason: "status_429" } : { status: "sent" });
    h.d.enqueue(h.job([["n1", "uA"]]));
    await h.d.idle();
    // visAttempt 1 found the row, the 429 re-enqueue (attempt 1) then sent; no drop
    expect(h.events).toEqual([{ notificationId: "n1", userId: "uA", result: "pushed" }]);
    expect(h.s.logs.some((l) => l.msg === "push.job.rows_missing")).toBe(false);
  });

  it("runs an EMERGENCY job before 50 queued NORMAL jobs", async () => {
    const h = harness();
    for (let i = 0; i < 50; i++) {
      h.addNotification(`n${i}`, `u${i}`);
      h.addSub(`s${i}`, `u${i}`, FCM(`n${i}`));
      h.d.enqueue(h.job([[`n${i}`, `u${i}`]]));
    }
    h.addNotification("e1", "boss");
    h.addSub("se", "boss", FCM("boss"));
    h.d.enqueue(h.job([["e1", "boss"]], { category: "EMERGENCY", priority: "EMERGENCY" }));
    await h.d.idle();
    expect(h.sender.sent).toHaveLength(51);
    expect(JSON.parse(h.sender.sent[0].message.body).id).toBe("e1");
  });

  it("a running NORMAL job yields to an urgent job after a 16-send batch", async () => {
    const h = harness();
    const items: Array<[string, string]> = [];
    for (let i = 0; i < 40; i++) {
      h.addNotification(`n${i}`, `u${i}`);
      h.addSub(`s${i}`, `u${i}`, FCM(`n${i}`));
      items.push([`n${i}`, `u${i}`]);
    }
    h.addNotification("e1", "boss");
    h.addSub("se", "boss", FCM("boss"));
    let injected = false;
    h.sender.respond = () => {
      if (!injected) {
        injected = true;
        h.d.enqueue(h.job([["e1", "boss"]], { category: "EMERGENCY", priority: "EMERGENCY" }));
      }
      return { status: "sent" };
    };
    h.d.enqueue(h.job(items));
    await h.d.idle();
    const order = h.sender.sent.map((x) => JSON.parse(x.message.body).id as string);
    expect(order).toHaveLength(41);
    expect(order.indexOf("e1")).toBe(16);
    expect(new Set(order).size).toBe(41);
  });

  it("never exceeds 16 concurrent sends", async () => {
    const h = harness();
    const items: Array<[string, string]> = [];
    for (let i = 0; i < 50; i++) {
      h.addNotification(`n${i}`, `u${i}`);
      h.addSub(`s${i}`, `u${i}`, FCM(`n${i}`));
      items.push([`n${i}`, `u${i}`]);
    }
    let inFlight = 0;
    let peak = 0;
    h.sender.respond = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return { status: "sent" };
    };
    h.d.enqueue(h.job(items));
    await h.d.idle();
    expect(h.sender.sent).toHaveLength(50);
    expect(peak).toBe(16);
  });

  it("drops new jobs on overflow (warn once), but accepts EMERGENCY while urgent has room", async () => {
    const h = harness();
    h.s.instActive = false; // jobs finish instantly
    const per = 200;
    for (let i = 0; i < MAX_PENDING_ITEMS / per; i++) {
      h.d.enqueue(h.job(Array.from({ length: per }, (_, k) => [`n${i}-${k}`, `u${i}-${k}`] as [string, string])));
    }
    expect(h.d.pendingItems()).toBe(MAX_PENDING_ITEMS);
    h.d.enqueue(h.job([["x1", "ux"]]));
    h.d.enqueue(h.job([["x2", "ux"]]));
    expect(h.events.filter((e) => e.result === "dropped")).toHaveLength(2);
    expect(h.s.logs.filter((l) => l.msg === "push.queue.overflow")).toHaveLength(1);
    h.d.enqueue(h.job([["e1", "ux"]], { category: "EMERGENCY", priority: "EMERGENCY" }));
    expect(h.d.pendingItems()).toBe(MAX_PENDING_ITEMS + 1);
    await h.d.idle();
  });

  it("an error in one job does not stop the next", async () => {
    const h = harness();
    h.addNotification("n1", "u1");
    h.addSub("s1", "u1", FCM("1"));
    let first = true;
    const d = new PushDispatcher({
      sender: () => h.sender,
      runTenant: (id, fn) => {
        if (first) {
          first = false;
          throw new Error("db down");
        }
        return fn(h.tx);
      },
      institutionActive: async () => true,
      now: () => h.s.clock,
      sleep: async (ms) => void (h.s.clock += ms),
      log: { info: () => {}, warn: () => {}, error: (o: any, m?: string) => h.s.logs.push({ level: "error", msg: m, obj: o }) },
    });
    d.enqueue(h.job([["n1", "u1"]]));
    d.enqueue(h.job([["n1", "u1"]]));
    await d.idle();
    expect(h.sender.sent).toHaveLength(1);
    expect(h.s.logs.some((l) => l.msg === "push.job.failed")).toBe(true);
  });

  it("a throwing sender is contained and no endpoint reaches the logs", async () => {
    const h = harness();
    h.addNotification("n1", "u1");
    h.addSub("s1", "u1", FCM("secret-token"));
    h.sender.respond = () => {
      throw new Error(`failed for ${FCM("secret-token")}`);
    };
    h.d.enqueue(h.job([["n1", "u1"]]));
    await h.d.idle();
    expect(h.s.subs[0].failureCount).toBe(1);
    expect(JSON.stringify(h.s.logs)).not.toMatch(/secret-token|googleapis/);
  });

  it("drain resolves after the current job and stops further jobs", async () => {
    const h = harness();
    h.addNotification("n1", "u1");
    h.addSub("s1", "u1", FCM("1"));
    h.d.enqueue(h.job([["n1", "u1"]]));
    await h.d.drain();
    h.d.enqueue(h.job([["n1", "u1"]]));
    expect(h.d.pendingItems()).toBe(1);
    await h.d.idle();
  });
});
