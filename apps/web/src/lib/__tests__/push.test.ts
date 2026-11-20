import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enablePush, getPushState, unsubscribeThisDevice, urlBase64ToUint8Array } from "@/lib/push";
import { useAuthStore } from "@/stores/auth";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(async () => ({})) },
  API_BASE: "http://api.test",
  ApiError: class extends Error {
    status = 0;
  },
}));

const enabled = { enabled: true, publicKey: "BAAA" };

function setNavigator(opts: { ua?: string; standalone?: boolean; push?: boolean; permission?: NotificationPermission }) {
  vi.stubGlobal("navigator", {
    userAgent: opts.ua ?? "Mozilla/5.0 Chrome",
    platform: "Win32",
    maxTouchPoints: 0,
    standalone: opts.standalone,
    serviceWorker: opts.push === false ? undefined : { getRegistration: vi.fn(async () => undefined), ready: Promise.resolve({}) },
  });
  if (opts.push === false) delete (globalThis.navigator as any).serviceWorker;
  const w = window as any;
  if (opts.push === false) {
    delete w.PushManager;
    delete w.Notification;
  } else {
    w.PushManager = class {};
    w.Notification = Object.assign(vi.fn(), {
      permission: opts.permission ?? "default",
      requestPermission: vi.fn(async () => "granted"),
    });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as any).Notification;
  delete (window as any).PushManager;
});

describe("urlBase64ToUint8Array", () => {
  it("decodes base64url with padding restored", () => {
    expect(Array.from(urlBase64ToUint8Array("AQID"))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([251, 255]);
  });
});

describe("getPushState", () => {
  it("reports unsupported without push APIs", async () => {
    setNavigator({ push: false });
    expect(await getPushState(enabled)).toBe("unsupported");
  });
  it("reports ios-install on iOS outside standalone and never prompts", async () => {
    setNavigator({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", standalone: false });
    expect(await getPushState(enabled)).toBe("ios-install");
    expect((window as any).Notification.requestPermission).not.toHaveBeenCalled();
  });
  it("allows iOS in standalone mode", async () => {
    setNavigator({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", standalone: true });
    expect(await getPushState(enabled)).toBe("default");
  });
  it("reports denied, default, not-configured and granted-not-subscribed", async () => {
    setNavigator({ permission: "denied" });
    expect(await getPushState(enabled)).toBe("denied");
    setNavigator({ permission: "default" });
    expect(await getPushState(enabled)).toBe("default");
    expect(await getPushState({ enabled: false, publicKey: null })).toBe("not-configured");
    setNavigator({ permission: "granted" });
    expect(await getPushState(enabled)).toBe("granted-not-subscribed");
  });
  it("never calls requestPermission", async () => {
    setNavigator({ permission: "default" });
    await getPushState(enabled);
    expect((window as any).Notification.requestPermission).not.toHaveBeenCalled();
  });
});

describe("enablePush", () => {
  it("returns not-configured without a key and does not ask permission", async () => {
    setNavigator({});
    expect(await enablePush(null)).toEqual({ ok: false, reason: "not-configured" });
    expect((window as any).Notification.requestPermission).not.toHaveBeenCalled();
  });
  it("maps a denied permission", async () => {
    setNavigator({});
    (window as any).Notification.requestPermission = vi.fn(async () => "denied");
    expect(await enablePush("AQID")).toEqual({ ok: false, reason: "denied" });
  });
});

describe("logout wiring", () => {
  const fetchMock = vi.fn(async () => ({ status: 200 }) as Response);
  beforeEach(() => {
    fetchMock.mockClear();
  });

  it("calls unsubscribeThisDevice with the token read before clearing", async () => {
    const sub = { endpoint: "https://fcm.googleapis.com/x", unsubscribe: vi.fn(async () => true) };
    setNavigator({});
    (navigator as any).serviceWorker.getRegistration = vi.fn(async () => ({
      pushManager: { getSubscription: async () => sub },
    }));
    vi.stubGlobal("fetch", fetchMock);
    useAuthStore.setState({ token: "tok-123", user: { id: "u1", email: "a@x", role: "STUDENT", accountStatus: "ACTIVE" } });

    useAuthStore.getState().logout();
    expect(useAuthStore.getState().token).toBeNull();
    await vi.waitFor(() => expect(sub.unsubscribe).toHaveBeenCalled());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/api/notifications/push/unsubscribe");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
  });

  it("still unsubscribes locally when the server call fails", async () => {
    const sub = { endpoint: "https://fcm.googleapis.com/x", unsubscribe: vi.fn(async () => true) };
    setNavigator({});
    (navigator as any).serviceWorker.getRegistration = vi.fn(async () => ({
      pushManager: { getSubscription: async () => sub },
    }));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await unsubscribeThisDevice("tok");
    expect(sub.unsubscribe).toHaveBeenCalled();
  });
});
