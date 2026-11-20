import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => ({ privilegedPrisma: {}, prisma: {}, withTenant: vi.fn() }));

import {
  notifyDepartmentHods,
  notifyInstitution,
  notifyInstitutionAdmins,
  notifyUser,
  notifyUsers,
  MAX_NOTIFY_USERS,
} from "../notifications.js";
import { registerSocket, wsConnections } from "../../routes/ws.js";
import { InMemoryPushSender, setPushSender } from "../push/index.js";
import { PushDispatcher, setPushDispatcher } from "../push/dispatcher.js";

const payload = { title: "T", body: "B", type: "fees.payment.captured", data: { amount: 5 } };

function fakeDb(opts: { users?: string[]; hods?: Array<{ userId: string; user: { institutionId: string } }> } = {}) {
  let seq = 0;
  const known = new Set(opts.users ?? []);
  const db: any = {
    user: {
      findUnique: vi.fn(async ({ where }: any) => (known.has(where.id) ? { institutionId: "inst-1" } : null)),
      findMany: vi.fn(async ({ where }: any) => {
        if (where.id?.in) return where.id.in.filter((id: string) => known.has(id)).map((id: string) => ({ id }));
        return [...known].map((id) => ({ id })); // audience query
      }),
    },
    notification: {
      create: vi.fn(async ({ data }: any) => ({ id: `n${++seq}`, read: false, createdAt: new Date(), ...data })),
      createManyAndReturn: vi.fn(async ({ data }: any) =>
        data.map((d: any) => ({ id: `n${++seq}`, read: false, createdAt: new Date(), ...d })),
      ),
    },
    hodProfile: { findMany: vi.fn(async () => opts.hods ?? []) },
  };
  return db;
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);
let enqueue: ReturnType<typeof vi.fn>;

beforeEach(() => {
  wsConnections.clear();
  setPushSender(new InMemoryPushSender());
  const d = new PushDispatcher({ sender: () => new InMemoryPushSender() });
  enqueue = vi.fn();
  (d as any).enqueue = enqueue;
  setPushDispatcher(d);
});

describe("notifyUsers", () => {
  it("1,200 ids: 2 verification queries, 3 inserts (500/500/200), <= 6 push jobs of <= 200 items", async () => {
    const db = fakeDb({ users: ids(1200) });
    const r = await notifyUsers("inst-1", ids(1200), payload, db);
    expect(db.user.findMany).toHaveBeenCalledTimes(2);
    expect(db.notification.createManyAndReturn.mock.calls.map((c: any) => c[0].data.length)).toEqual([500, 500, 200]);
    expect(r.recipients).toHaveLength(1200);
    expect(r.skippedUserIds).toEqual([]);
    expect(r.batchId).toBeTruthy();
    expect(enqueue).toHaveBeenCalledTimes(6);
    for (const [job] of enqueue.mock.calls) expect(job.items.length).toBeLessThanOrEqual(200);
    expect(enqueue.mock.calls[0][0].msg).toMatchObject({ category: "FEES", priority: "NORMAL" });
  });

  it("dedupes, skips foreign ids and returns the mapping", async () => {
    const db = fakeDb({ users: ["a", "b"] });
    const r = await notifyUsers("inst-1", ["a", "b", "a", "foreign"], payload, db);
    expect(r.recipients.map((x) => x.userId)).toEqual(["a", "b"]);
    expect(r.recipients.every((x) => x.notificationId.startsWith("n"))).toBe(true);
    expect(r.skippedUserIds).toEqual(["foreign"]);
    expect(db.notification.createManyAndReturn.mock.calls[0][0].data.every((d: any) => d.institutionId === "inst-1")).toBe(true);
  });

  it("no ids means no queries; over the cap throws RangeError", async () => {
    const db = fakeDb();
    expect((await notifyUsers("inst-1", [], payload, db)).recipients).toEqual([]);
    expect(db.user.findMany).not.toHaveBeenCalled();
    await expect(notifyUsers("inst-1", ids(MAX_NOTIFY_USERS + 1), payload, db)).rejects.toBeInstanceOf(RangeError);
  });

  it("push: false sends in-app and WebSocket only", async () => {
    const db = fakeDb({ users: ["a"] });
    const sock = { readyState: 1, send: vi.fn(), close: vi.fn() } as any;
    registerSocket("a", { socket: sock, institutionId: "inst-1" });
    await notifyUsers("inst-1", ["a"], payload, db, { push: false });
    expect(sock.send).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("push enqueue failure never fails the caller; DB errors still propagate", async () => {
    const db = fakeDb({ users: ["a"] });
    enqueue.mockImplementation(() => {
      throw new Error("queue exploded");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(notifyUsers("inst-1", ["a"], payload, db)).resolves.toBeTruthy();
    db.notification.createManyAndReturn.mockRejectedValueOnce(new Error("db down"));
    await expect(notifyUsers("inst-1", ["a"], payload, db)).rejects.toThrow("db down");
  });

  it("no push when the sender is not configured", async () => {
    setPushSender(new InMemoryPushSender(null));
    const db = fakeDb({ users: ["a"] });
    await notifyUsers("inst-1", ["a"], payload, db);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("notifyUser", () => {
  it("returns the created row, sends to every socket and enqueues push", async () => {
    const db = fakeDb({ users: ["a"] });
    const s1 = { readyState: 1, send: vi.fn(), close: vi.fn() } as any;
    const s2 = { readyState: 1, send: vi.fn(), close: vi.fn() } as any;
    registerSocket("a", { socket: s1, institutionId: "inst-1" });
    registerSocket("a", { socket: s2, institutionId: "inst-1" });
    const row = await notifyUser("a", payload, db);
    expect(row).toMatchObject({ id: "n1", userId: "a", institutionId: "inst-1", title: "T", type: payload.type });
    expect(JSON.parse(s1.send.mock.calls[0][0])).toMatchObject({ type: "notification", data: { id: "n1" } });
    expect(s2.send).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].items).toEqual([{ notificationId: "n1", userId: "a" }]);
  });

  it("throws the original error for an unknown user", async () => {
    await expect(notifyUser("ghost", payload, fakeDb())).rejects.toThrow("notifyUser: user ghost not found");
  });

  it("uses the type to choose category and priority, with opts overrides", async () => {
    const db = fakeDb({ users: ["a"] });
    await notifyUser("a", { ...payload, type: "PASS_REVOKED" }, db);
    expect(enqueue.mock.calls[0][0].msg).toMatchObject({ category: "GATEPASS", priority: "HIGH" });
    await notifyUser("a", payload, db, { category: "ANNOUNCEMENTS", priority: "EMERGENCY", url: "/x" });
    expect(enqueue.mock.calls[1][0].msg).toMatchObject({ category: "ANNOUNCEMENTS", priority: "EMERGENCY", url: "/x" });
  });
});

describe("helpers", () => {
  it("notifyInstitution notifies the ACTIVE audience", async () => {
    const db = fakeDb({ users: ["a", "b", "c"] });
    await notifyInstitution("inst-1", payload, db);
    expect(db.user.findMany.mock.calls[0][0].where).toEqual({ institutionId: "inst-1", accountStatus: "ACTIVE" });
    expect(db.notification.createManyAndReturn.mock.calls[0][0].data).toHaveLength(3);
  });

  it("F4: 25,000 ids through notifyInstitution succeed with chunked inserts and bounded push jobs", async () => {
    const db = fakeDb({ users: ids(25_000) });
    await expect(notifyInstitution("inst-1", { ...payload, type: "EMERGENCY_DECLARED" }, db)).resolves.toBeUndefined();
    const sizes = db.notification.createManyAndReturn.mock.calls.map((c: any) => c[0].data.length);
    expect(sizes.reduce((a: number, b: number) => a + b, 0)).toBe(25_000);
    expect(Math.max(...sizes)).toBe(500);
    expect(enqueue).toHaveBeenCalledTimes(125);
    expect(enqueue.mock.calls[0][0].msg).toMatchObject({ category: "EMERGENCY", priority: "EMERGENCY" });
  });

  it("notifyInstitutionAdmins filters ADMIN + ACTIVE", async () => {
    const db = fakeDb({ users: ["a"] });
    await notifyInstitutionAdmins("inst-1", payload, db);
    expect(db.user.findMany.mock.calls[0][0].where).toEqual({ institutionId: "inst-1", role: "ADMIN", accountStatus: "ACTIVE" });
  });

  it("notifyDepartmentHods takes the institution from the first HOD; empty is a no-op", async () => {
    const db = fakeDb({
      users: ["h1", "h2"],
      hods: [
        { userId: "h1", user: { institutionId: "inst-1" } },
        { userId: "h2", user: { institutionId: "inst-1" } },
      ],
    });
    await notifyDepartmentHods("dep-1", payload, db);
    expect(db.notification.createManyAndReturn.mock.calls[0][0].data.map((d: any) => d.userId)).toEqual(["h1", "h2"]);
    const empty = fakeDb();
    await notifyDepartmentHods("dep-2", payload, empty);
    expect(empty.notification.createManyAndReturn).not.toHaveBeenCalled();
  });
});
