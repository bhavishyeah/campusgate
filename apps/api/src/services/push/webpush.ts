import webpush from "web-push";
import type { PushMessage, PushOutcome, PushSender, PushTarget } from "./sender.js";

const SEND_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_SEC = 60;

export interface VapidDetails {
  subject: string;
  publicKey: string;
  privateKey: string;
}

function parseRetryAfter(headers: unknown): number | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const h = headers as Record<string, unknown>;
  const raw = h["retry-after"] ?? h["Retry-After"];
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(n, MAX_RETRY_AFTER_SEC);
}

/**
 * Map a web-push failure to an outcome. The WebPushError carries the endpoint and
 * headers, so only the status code and a short code are kept; the error itself is
 * discarded.
 */
export function mapWebPushError(err: unknown): PushOutcome {
  const e = err as { statusCode?: unknown; headers?: unknown; code?: unknown } | null;
  const status = typeof e?.statusCode === "number" ? e.statusCode : undefined;
  if (status === undefined) {
    const code = typeof e?.code === "string" ? e.code : "";
    if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return { status: "retry", reason: "timeout" };
    return { status: "retry", reason: "network" };
  }
  if (status === 404 || status === 410) return { status: "gone" };
  if (status === 429) {
    const retryAfterSec = parseRetryAfter(e?.headers);
    return retryAfterSec === undefined
      ? { status: "retry", reason: "status_429" }
      : { status: "retry", retryAfterSec, reason: "status_429" };
  }
  if (status >= 500) return { status: "retry", reason: `status_${status}` };
  if (status === 413) return { status: "rejected", reason: "payload_too_large" };
  if (status === 401 || status === 403) return { status: "unauthorized", reason: `status_${status}` };
  return { status: "rejected", reason: `status_${status}` };
}

export class WebPushSender implements PushSender {
  readonly kind = "webpush" as const;
  constructor(private readonly vapid: VapidDetails) {}
  isConfigured(): boolean {
    return true;
  }
  publicKey(): string | null {
    return this.vapid.publicKey;
  }
  async send(target: PushTarget, message: PushMessage): Promise<PushOutcome> {
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        message.body,
        {
          vapidDetails: this.vapid,
          TTL: message.ttlSeconds,
          urgency: message.urgency,
          timeout: SEND_TIMEOUT_MS,
        },
      );
      return { status: "sent" };
    } catch (err) {
      return mapWebPushError(err);
    }
  }
}
