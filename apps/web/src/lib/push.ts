import { api, API_BASE, ApiError } from "@/lib/api";

export type PushState =
  | "unsupported"
  | "ios-install"
  | "denied"
  | "default"
  | "subscribed"
  | "granted-not-subscribed"
  | "not-configured";

export interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
}

export type EnableResult =
  | { ok: true }
  | { ok: false; reason: "denied" | "dismissed" | "not-configured" | "failed" };

export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    (navigator as any).standalone === true ||
    (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches)
  );
}

function pushApisPresent(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function fetchPushConfig(): Promise<PushConfig> {
  return api.get<PushConfig>("/api/notifications/push/config");
}

/** Never prompts and never calls requestPermission. */
export async function getPushState(config: PushConfig | null): Promise<PushState> {
  if (isIos() && !isStandalone()) return "ios-install";
  if (!pushApisPresent()) return "unsupported";
  if (config && !config.enabled) return "not-configured";
  const permission = Notification.permission;
  if (permission === "denied") return "denied";
  if (permission === "default") return "default";
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return sub ? "subscribed" : "granted-not-subscribed";
  } catch {
    return "granted-not-subscribed";
  }
}

async function postSubscription(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON();
  await api.post("/api/notifications/push/subscribe", { endpoint: json.endpoint, keys: json.keys });
}

/**
 * Must be called straight from a click handler. `publicKey` is prefetched so no
 * await sits between the click and requestPermission.
 */
export async function enablePush(publicKey: string | null): Promise<EnableResult> {
  if (!publicKey) return { ok: false, reason: "not-configured" };
  const permission = await Notification.requestPermission();
  if (permission === "denied") return { ok: false, reason: "denied" };
  if (permission !== "granted") return { ok: false, reason: "dismissed" };
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
    await postSubscription(sub);
    return { ok: true };
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) return { ok: false, reason: "not-configured" };
    return { ok: false, reason: "failed" };
  }
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** Once per session, only when permission is already granted (never prompts). */
export async function resyncPush(): Promise<void> {
  try {
    if (!pushApisPresent() || Notification.permission !== "granted") return;
    const config = await fetchPushConfig();
    if (!config.enabled || !config.publicKey) return;
    const reg = await navigator.serviceWorker.ready;
    const key = urlBase64ToUint8Array(config.publicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
    }
    await postSubscription(sub);
  } catch {
    // best effort; nothing sensitive is logged
  }
}

/**
 * Called by logout with the token read BEFORE it was cleared. Best effort on the
 * server; the local unsubscribe always runs. A 403 (platform account) is success.
 */
export async function unsubscribeThisDevice(token: string | null): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (!sub) return;
    try {
      if (token) {
        // Any response counts as done. A 403 means a platform account: nothing was stored.
        await fetch(`${API_BASE}/api/notifications/push/unsubscribe`, {
          method: "POST",
          keepalive: true,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
      }
    } catch {
      // network failure: the local unsubscribe below still invalidates the endpoint
    } finally {
      await sub.unsubscribe().catch(() => {});
    }
  } catch {
    // swallowed on purpose
  }
}
