import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

const sendNotification = vi.fn();
vi.mock("web-push", () => ({ default: { sendNotification: (...a: unknown[]) => sendNotification(...a) } }));

import { createPushSenderFromEnv, getPushSender, setPushSender, WebPushSender } from "../index.js";
import { InMemoryPushSender, UnconfiguredPushSender } from "../sender.js";
import { mapWebPushError } from "../webpush.js";

function vapid() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const priv = privateKey.export({ format: "jwk" }) as { d: string };
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]);
  return { VAPID_PUBLIC_KEY: raw.toString("base64url"), VAPID_PRIVATE_KEY: priv.d, VAPID_SUBJECT: "mailto:ops@example.edu" };
}

afterEach(() => {
  vi.restoreAllMocks();
  sendNotification.mockReset();
  setPushSender(null);
});

describe("createPushSenderFromEnv", () => {
  it("returns a WebPushSender for valid keys", () => {
    const s = createPushSenderFromEnv({ NODE_ENV: "production", ...vapid() } as NodeJS.ProcessEnv);
    expect(s.kind).toBe("webpush");
    expect(s.isConfigured()).toBe(true);
    expect(s.publicKey()).toBeTruthy();
  });

  it("is unconfigured (never throws) for missing or invalid values and warns with names only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const v = vapid();
    const cases: Array<Record<string, string>> = [
      {},
      { ...v, VAPID_PRIVATE_KEY: "short" },
      { ...v, VAPID_PUBLIC_KEY: "AAAA" },
      { ...v, VAPID_SUBJECT: "ops@example.edu" },
      { ...v, VAPID_SUBJECT: "http://insecure.example" },
      { VAPID_PUBLIC_KEY: v.VAPID_PUBLIC_KEY },
    ];
    for (const c of cases) {
      const s = createPushSenderFromEnv({ NODE_ENV: "production", ...c } as NodeJS.ProcessEnv);
      expect(s).toBeInstanceOf(UnconfiguredPushSender);
      expect(s.isConfigured()).toBe(false);
      expect(s.publicKey()).toBeNull();
    }
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("VAPID_PRIVATE_KEY");
    expect(logged).not.toContain(v.VAPID_PRIVATE_KEY);
    expect(logged).not.toContain(v.VAPID_PUBLIC_KEY);
  });

  it("returns an in-memory sender under test with no keys", () => {
    expect(createPushSenderFromEnv({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBeInstanceOf(InMemoryPushSender);
  });

  it("getPushSender is a singleton with a test seam", () => {
    const stub = new InMemoryPushSender();
    setPushSender(stub);
    expect(getPushSender()).toBe(stub);
  });
});

describe("WebPushSender outcome mapping", () => {
  const target = { endpoint: "https://fcm.googleapis.com/fcm/send/SECRET", p256dh: "pk", auth: "ak" };
  const message = { body: "{}", ttlSeconds: 60, urgency: "normal" as const };
  const sender = new WebPushSender({ subject: "mailto:a@b.c", publicKey: "pub", privateKey: "priv" });
  const fail = (statusCode: number, headers: Record<string, string> = {}) =>
    sendNotification.mockRejectedValueOnce(Object.assign(new Error("boom https://fcm.googleapis.com/fcm/send/SECRET"), { statusCode, headers, endpoint: target.endpoint }));

  it("sent on success and passes per-call vapid details, ttl and urgency", async () => {
    sendNotification.mockResolvedValueOnce({ statusCode: 201 });
    expect(await sender.send(target, message)).toEqual({ status: "sent" });
    const [sub, body, opts] = sendNotification.mock.calls[0];
    expect(sub).toEqual({ endpoint: target.endpoint, keys: { p256dh: "pk", auth: "ak" } });
    expect(body).toBe("{}");
    expect(opts).toMatchObject({ TTL: 60, urgency: "normal", timeout: 10_000, vapidDetails: { subject: "mailto:a@b.c" } });
  });

  it.each([
    [404, { status: "gone" }],
    [410, { status: "gone" }],
    [500, { status: "retry", reason: "status_500" }],
    [503, { status: "retry", reason: "status_503" }],
    [413, { status: "rejected", reason: "payload_too_large" }],
    [400, { status: "rejected", reason: "status_400" }],
    [401, { status: "unauthorized", reason: "status_401" }],
    [403, { status: "unauthorized", reason: "status_403" }],
  ])("maps %i", async (code, expected) => {
    fail(code);
    expect(await sender.send(target, message)).toEqual(expected);
  });

  it("429 honours Retry-After capped at 60 s", async () => {
    fail(429, { "retry-after": "20" });
    expect(await sender.send(target, message)).toEqual({ status: "retry", retryAfterSec: 20, reason: "status_429" });
    fail(429, { "retry-after": "9999" });
    expect(await sender.send(target, message)).toMatchObject({ retryAfterSec: 60 });
    fail(429);
    expect(await sender.send(target, message)).toEqual({ status: "retry", reason: "status_429" });
  });

  it("network and timeout errors are retries and never leak the endpoint", async () => {
    sendNotification.mockRejectedValueOnce(Object.assign(new Error("connect ECONNRESET https://fcm.googleapis.com/x"), { code: "ECONNRESET" }));
    const a = await sender.send(target, message);
    sendNotification.mockRejectedValueOnce(Object.assign(new Error("t"), { code: "ETIMEDOUT" }));
    const b = await sender.send(target, message);
    expect(a).toEqual({ status: "retry", reason: "network" });
    expect(b).toEqual({ status: "retry", reason: "timeout" });
    fail(500);
    expect(JSON.stringify(await sender.send(target, message))).not.toMatch(/SECRET|googleapis/);
  });

  it("mapWebPushError tolerates odd input", () => {
    expect(mapWebPushError(null)).toEqual({ status: "retry", reason: "network" });
    expect(mapWebPushError("x")).toEqual({ status: "retry", reason: "network" });
  });
});
