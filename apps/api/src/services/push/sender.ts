/**
 * PushSender seam (mirrors services/email/sender.ts). Everything push-related goes
 * through getPushSender() so tests and a future FCM/OneSignal adapter can swap it.
 */

/** The stored subscription row. Never logged. */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushUrgency = "very-low" | "low" | "normal" | "high";

/** `body` is the serialized JSON payload, at most 2048 bytes. */
export interface PushMessage {
  body: string;
  ttlSeconds: number;
  urgency: PushUrgency;
}

export type PushOutcome =
  | { status: "sent" }
  /** 404/410: delete the subscription. */
  | { status: "gone" }
  /** 429, 5xx, network, timeout. */
  | { status: "retry"; retryAfterSec?: number; reason: string }
  /** 400/413 and other 4xx: this device failed. */
  | { status: "rejected"; reason: string }
  /** 401/403: VAPID key or subject fault. Sender-level, not the device's fault. */
  | { status: "unauthorized"; reason: string };

export interface PushSender {
  readonly kind: "webpush" | "memory" | "unconfigured";
  isConfigured(): boolean;
  /** VAPID application server key (base64url), or null. */
  publicKey(): string | null;
  /** Never throws for provider/network failures; returns an outcome. */
  send(target: PushTarget, message: PushMessage): Promise<PushOutcome>;
}

/** Used when VAPID is unset or invalid: push is disabled safely. */
export class UnconfiguredPushSender implements PushSender {
  readonly kind = "unconfigured" as const;
  constructor(public readonly reason: string) {}
  isConfigured(): boolean {
    return false;
  }
  publicKey(): string | null {
    return null;
  }
  async send(): Promise<PushOutcome> {
    return { status: "rejected", reason: "unconfigured" };
  }
}

export interface InMemorySent {
  target: PushTarget;
  message: PushMessage;
}

/** Test sender: records sends; `respond` decides the outcome per target. */
export class InMemoryPushSender implements PushSender {
  readonly kind = "memory" as const;
  readonly sent: InMemorySent[] = [];
  respond: (target: PushTarget, message: PushMessage) => PushOutcome | Promise<PushOutcome> = () => ({
    status: "sent",
  });
  constructor(private readonly key: string | null = "test-public-key") {}
  isConfigured(): boolean {
    return this.key !== null;
  }
  publicKey(): string | null {
    return this.key;
  }
  async send(target: PushTarget, message: PushMessage): Promise<PushOutcome> {
    this.sent.push({ target, message });
    return this.respond(target, message);
  }
}
