/**
 * Push subscriptions / preferences LIVE suite. TEST Supabase project only
 * (live-test-env.ts refuses the production ref). Self-contained under the PUSHT_TEST_
 * prefix. Run alone: npx vitest run --config vitest.integration.config.ts push-subscriptions
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pinLiveTestEnv } from "./helpers/live-test-env.js";

pinLiveTestEnv("full");

const PFX = "PUSHT_TEST_";
const instA = `${PFX}instA`;
const instB = `${PFX}instB`;
const P256 = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url");
const AUTH = Buffer.alloc(16, 9).toString("base64url");
const FCM = (id: string) => `https://fcm.googleapis.com/fcm/send/${PFX}${id}`;

let db: typeof import("@campusgate/db");
let dispatcherMod: typeof import("../../services/push/dispatcher.js");
let senderMod: typeof import("../../services/push/sender.js");
let notifs: typeof import("../../services/notifications.js");
let o: any; // owner client
let seq = 0;

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const transient = ["Can't reach database server", "P1001", "Timed out", "ECONNRESET", "max clients reached", "EMAXCONNSESSION", "Transaction API error", "connection pool"].some((s) => msg.includes(s));
      if (!transient || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
}

async function mkUser(institutionId: string, over: Record<string, unknown> = {}) {
  const n = ++seq;
  return withRetry(() =>
    o.user.create({
      data: { email: `${PFX.toLowerCase()}u${n}@example.test`, role: "STUDENT", institutionId, accountStatus: "ACTIVE", ...over },
    }),
  );
}

const subData = (userId: string, institutionId: string, id: string) => ({
  userId,
  institutionId,
  endpoint: FCM(id),
  p256dh: P256,
  auth: AUTH,
});

async function teardown() {
  const where = { institutionId: { startsWith: PFX } };
  await withRetry(() => o.pushSubscription.deleteMany({ where }));
  await withRetry(() => o.notificationPreference.deleteMany({ where }));
  await withRetry(() => o.notification.deleteMany({ where }));
  await withRetry(() => o.user.deleteMany({ where }));
  await withRetry(() => o.institution.deleteMany({ where: { id: { startsWith: PFX } } }));
}

beforeAll(async () => {
  db = await import("@campusgate/db");
  dispatcherMod = await import("../../services/push/dispatcher.js");
  senderMod = await import("../../services/push/sender.js");
  notifs = await import("../../services/notifications.js");
  o = db.privilegedPrisma;
  await teardown();
  await withRetry(() => o.institution.create({ data: { id: instA, name: `${PFX}A`, code: `${PFX}CA`, status: "ACTIVE" } }));
  await withRetry(() => o.institution.create({ data: { id: instB, name: `${PFX}B`, code: `${PFX}CB`, status: "ACTIVE" } }));
}, 120_000);

afterAll(async () => {
  await teardown().catch(() => {});
  await db.privilegedPrisma.$disconnect();
  await db.prisma.$disconnect();
}, 120_000);

describe("push_subscriptions and notification_preferences tables", () => {
  it("tenant A cannot read, update or delete tenant B's rows; a spoofed insert is rejected", async () => {
    const ua = await mkUser(instA);
    const ub = await mkUser(instB);
    const subB = await withRetry(() => o.pushSubscription.create({ data: subData(ub.id, instB, "iso-b") }));
    await withRetry(() => o.notificationPreference.create({ data: { userId: ub.id, institutionId: instB, category: "FEES", pushEnabled: false } }));

    const seen = await withRetry(() => db.withTenant(instA, (tx: any) => tx.pushSubscription.findMany({ where: { userId: ub.id } })));
    expect(seen).toHaveLength(0);
    const prefs = await withRetry(() => db.withTenant(instA, (tx: any) => tx.notificationPreference.findMany({ where: { userId: ub.id } })));
    expect(prefs).toHaveLength(0);
    const upd = await withRetry(() => db.withTenant(instA, (tx: any) => tx.pushSubscription.updateMany({ where: { id: subB.id }, data: { failureCount: 5 } })));
    expect(upd.count).toBe(0);
    const del = await withRetry(() => db.withTenant(instA, (tx: any) => tx.pushSubscription.deleteMany({ where: { id: subB.id } })));
    expect(del.count).toBe(0);
    expect((await o.pushSubscription.findUnique({ where: { id: subB.id } })).failureCount).toBe(0);

    // WITH CHECK: tenant A cannot insert a row stamped for B
    await expect(
      db.withTenant(instA, (tx: any) => tx.pushSubscription.create({ data: subData(ub.id, instB, "spoof") })),
    ).rejects.toThrow();
    // and own-tenant insert works
    await expect(
      db.withTenant(instA, (tx: any) => tx.pushSubscription.create({ data: subData(ua.id, instA, "own-a") })),
    ).resolves.toBeTruthy();
  }, 90_000);

  it("the composite FK rejects a user with a mismatched institution, and the endpoint is unique", async () => {
    const ua = await mkUser(instA);
    await expect(o.pushSubscription.create({ data: subData(ua.id, instB, "fk-mismatch") })).rejects.toThrow();
    await o.pushSubscription.create({ data: subData(ua.id, instA, "uniq") });
    await expect(o.pushSubscription.create({ data: subData(ua.id, instA, "uniq") })).rejects.toMatchObject({ code: "P2002" });
  }, 60_000);

  it("CHECKs reject a non-https endpoint and wrong key sizes", async () => {
    const ua = await mkUser(instA);
    await expect(o.pushSubscription.create({ data: { ...subData(ua.id, instA, "chk1"), endpoint: "http://fcm.googleapis.com/x" } })).rejects.toThrow();
    await expect(o.pushSubscription.create({ data: { ...subData(ua.id, instA, "chk2"), p256dh: "short" } })).rejects.toThrow();
    await expect(o.pushSubscription.create({ data: { ...subData(ua.id, instA, "chk3"), auth: "x" } })).rejects.toThrow();
  }, 60_000);

  it("takeover with the owner client frees the endpoint for a user of another tenant", async () => {
    const ua = await mkUser(instA);
    const ub = await mkUser(instB);
    await o.pushSubscription.create({ data: subData(ua.id, instA, "takeover") });
    // Without the takeover the global unique index collides even though RLS hides the row.
    await expect(
      db.withTenant(instB, (tx: any) => tx.pushSubscription.create({ data: subData(ub.id, instB, "takeover") })),
    ).rejects.toThrow();
    await o.pushSubscription.deleteMany({ where: { endpoint: FCM("takeover"), userId: { not: ub.id } } });
    const row = await db.withTenant(instB, (tx: any) =>
      tx.pushSubscription.upsert({
        where: { endpoint: FCM("takeover") },
        create: subData(ub.id, instB, "takeover"),
        update: {},
      }),
    );
    expect(row.userId).toBe(ub.id);
    expect(await o.pushSubscription.count({ where: { endpoint: FCM("takeover") } })).toBe(1);
  }, 60_000);

  it("campass_app can toggle preferences but cannot DELETE them", async () => {
    const ua = await mkUser(instA);
    const row = await db.withTenant(instA, (tx: any) =>
      tx.notificationPreference.create({ data: { userId: ua.id, institutionId: instA, category: "FEES", pushEnabled: false } }),
    );
    await db.withTenant(instA, (tx: any) => tx.notificationPreference.update({ where: { id: row.id }, data: { pushEnabled: true } }));
    await expect(db.withTenant(instA, (tx: any) => tx.notificationPreference.delete({ where: { id: row.id } }))).rejects.toThrow();
    await expect(
      db.withTenant(instA, (tx: any) => tx.notificationPreference.create({ data: { userId: ua.id, institutionId: instA, category: "FEES", pushEnabled: false } })),
    ).rejects.toMatchObject({ code: "P2002" }); // one row per (user, category)
  }, 60_000);
});

describe("fan-out against the real database", () => {
  it("notifyUsers writes 1,200 notifications under withTenant and returns every id", async () => {
    const stamp = Date.now();
    await withRetry(() =>
      o.user.createMany({
        data: Array.from({ length: 1200 }, (_, i) => ({
          email: `${PFX.toLowerCase()}bulk${stamp}_${i}@example.test`,
          role: "STUDENT",
          institutionId: instA,
          accountStatus: "ACTIVE",
        })),
      }),
    );
    const users = await o.user.findMany({ where: { institutionId: instA, email: { contains: `bulk${stamp}_` } }, select: { id: true } });
    expect(users).toHaveLength(1200);
    const t0 = Date.now();
    const result = await db.withTenant(instA, (tx: any) =>
      notifs.notifyUsers(instA, users.map((u: any) => u.id), { title: "T", body: "B", type: "library.overdue" }, tx, { push: false }),
    );
    console.log(`notifyUsers 1,200 recipients: ${Date.now() - t0} ms`);
    expect(result.recipients).toHaveLength(1200);
    expect(new Set(result.recipients.map((r) => r.notificationId)).size).toBe(1200);
    expect(result.skippedUserIds).toEqual([]);
    expect(await o.notification.count({ where: { institutionId: instA, type: "library.overdue" } })).toBe(1200);
  }, 240_000);
});

describe("dispatcher against the real tables", () => {
  function make(sender: InstanceType<typeof senderMod.InMemoryPushSender>) {
    return new dispatcherMod.PushDispatcher({
      sender: () => sender,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
  }
  const job = (institutionId: string, items: Array<[string, string]>) => ({
    institutionId,
    items: items.map(([notificationId, userId]) => ({ notificationId, userId })),
    msg: { title: "T", body: "B", category: "FEES" as const, priority: "NORMAL" as const, ts: Date.now() },
  });

  it("sends to an active user, sends nothing to a suspended account, and a 410 removes the row", async () => {
    const active = await mkUser(instA);
    const suspended = await mkUser(instA, { accountStatus: "INACTIVE" });
    const n1 = await o.notification.create({ data: { userId: active.id, institutionId: instA, title: "T", body: "B", type: "fees.x" } });
    const n2 = await o.notification.create({ data: { userId: suspended.id, institutionId: instA, title: "T", body: "B", type: "fees.x" } });
    await o.pushSubscription.create({ data: subData(active.id, instA, "disp-active") });
    await o.pushSubscription.create({ data: subData(suspended.id, instA, "disp-susp") });

    const sender = new senderMod.InMemoryPushSender();
    const d = make(sender);
    d.enqueue(job(instA, [[n1.id, active.id], [n2.id, suspended.id]]));
    await d.idle();
    expect(sender.sent.map((s) => s.target.endpoint)).toEqual([FCM("disp-active")]);
    expect((await o.pushSubscription.findFirst({ where: { endpoint: FCM("disp-active") } })).lastSuccessAt).not.toBeNull();

    sender.respond = () => ({ status: "gone" });
    d.enqueue(job(instA, [[n1.id, active.id]]));
    await d.idle();
    expect(await o.pushSubscription.count({ where: { endpoint: FCM("disp-active") } })).toBe(0);
  }, 120_000);

  it("a suspended institution produces zero sends", async () => {
    const u = await mkUser(instB);
    const n = await o.notification.create({ data: { userId: u.id, institutionId: instB, title: "T", body: "B", type: "fees.x" } });
    await o.pushSubscription.create({ data: subData(u.id, instB, "disp-inst") });
    await o.institution.update({ where: { id: instB }, data: { status: "SUSPENDED" } });
    try {
      const sender = new senderMod.InMemoryPushSender();
      const d = make(sender);
      d.enqueue(job(instB, [[n.id, u.id]]));
      await d.idle();
      expect(sender.sent).toHaveLength(0);
    } finally {
      await o.institution.update({ where: { id: instB }, data: { status: "ACTIVE" } });
    }
  }, 120_000);
});
