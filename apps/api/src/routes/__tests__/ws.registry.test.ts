import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => ({ privilegedPrisma: {}, prisma: {}, withTenant: vi.fn() }));

import {
  forEachInstitutionSocket,
  registerSocket,
  sendToUser,
  unregisterSocket,
  wsConnections,
  type ConnectionMeta,
} from "../ws.js";
import { broadcastToInstitution } from "../../services/notifications.js";

function sock(readyState = 1, throws = false) {
  return { readyState, send: vi.fn(() => { if (throws) throw new Error("dead"); }), close: vi.fn() } as any;
}
const meta = (socket: any, institutionId = "i1"): ConnectionMeta => ({ socket, institutionId });

beforeEach(() => wsConnections.clear());

describe("ws registry", () => {
  it("delivers to every open socket of a user and keeps the other when one closes", () => {
    const phone = meta(sock());
    const laptop = meta(sock());
    registerSocket("u1", phone);
    registerSocket("u1", laptop);
    expect(sendToUser("u1", "hi")).toBe(2);
    expect(phone.socket.send).toHaveBeenCalledWith("hi");
    expect(laptop.socket.send).toHaveBeenCalledWith("hi");
    unregisterSocket("u1", phone);
    expect(wsConnections.get("u1")!.size).toBe(1);
    expect(sendToUser("u1", "again")).toBe(1);
  });

  it("unregister is idempotent (close and error both fire) and removes the key when empty", () => {
    const m = meta(sock());
    registerSocket("u1", m);
    unregisterSocket("u1", m);
    unregisterSocket("u1", m);
    expect(wsConnections.has("u1")).toBe(false);
    unregisterSocket("nobody", m);
  });

  it("caps at 8 sockets per user, closing the oldest with 4008", () => {
    const metas = Array.from({ length: 9 }, () => meta(sock()));
    metas.forEach((m) => registerSocket("u1", m));
    expect(wsConnections.get("u1")!.size).toBe(8);
    expect(metas[0].socket.close).toHaveBeenCalledWith(4008, "Too many connections");
    expect(wsConnections.get("u1")!.has(metas[0])).toBe(false);
  });

  it("sendToUser skips non-open sockets and drops one that throws", () => {
    const closed = meta(sock(3));
    const dead = meta(sock(1, true));
    const live = meta(sock());
    [closed, dead, live].forEach((m) => registerSocket("u1", m));
    expect(sendToUser("u1", "x")).toBe(1);
    expect(closed.socket.send).not.toHaveBeenCalled();
    expect(wsConnections.get("u1")!.has(dead)).toBe(false);
    expect(sendToUser("ghost", "x")).toBe(0);
  });

  it("broadcastToInstitution reaches only that institution's sockets", () => {
    const a1 = meta(sock(), "iA");
    const a2 = meta(sock(), "iA");
    const b = meta(sock(), "iB");
    registerSocket("u1", a1);
    registerSocket("u1", a2);
    registerSocket("u2", b);
    broadcastToInstitution("iA", { type: "emergency", data: { x: 1 } });
    expect(a1.socket.send).toHaveBeenCalledTimes(1);
    expect(a2.socket.send).toHaveBeenCalledTimes(1);
    expect(b.socket.send).not.toHaveBeenCalled();
    const seen: string[] = [];
    forEachInstitutionSocket("iB", (_m, uid) => seen.push(uid));
    expect(seen).toEqual(["u2"]);
  });
});
