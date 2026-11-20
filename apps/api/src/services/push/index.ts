import { InMemoryPushSender, UnconfiguredPushSender, type PushSender } from "./sender.js";
import { WebPushSender } from "./webpush.js";

export * from "./sender.js";
export { WebPushSender } from "./webpush.js";

const SUBJECT_RE = /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/;

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  return Buffer.from(value, "base64url");
}

/**
 * Selection: all three VAPID variables present and well-formed, else an
 * UnconfiguredPushSender (push disabled). Never throws. Under test with no keys an
 * InMemoryPushSender is returned (like email) so route tests run.
 */
export function createPushSenderFromEnv(env: NodeJS.ProcessEnv = process.env): PushSender {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  const subject = env.VAPID_SUBJECT;
  if (!publicKey && !privateKey && !subject && (env.NODE_ENV === "test" || env.VITEST)) {
    return new InMemoryPushSender();
  }
  const bad: string[] = [];
  if (!publicKey) bad.push("VAPID_PUBLIC_KEY");
  if (!privateKey) bad.push("VAPID_PRIVATE_KEY");
  if (!subject) bad.push("VAPID_SUBJECT");
  if (bad.length === 0) {
    const pub = decodeBase64Url(publicKey!);
    const priv = decodeBase64Url(privateKey!);
    if (!pub || pub.length !== 65 || pub[0] !== 0x04) bad.push("VAPID_PUBLIC_KEY");
    if (!priv || priv.length !== 32) bad.push("VAPID_PRIVATE_KEY");
    if (!SUBJECT_RE.test(subject!)) bad.push("VAPID_SUBJECT");
  }
  if (bad.length > 0) {
    // Variable names only, never values.
    console.warn(`push disabled: missing or invalid ${[...new Set(bad)].join(", ")}`);
    return new UnconfiguredPushSender(`invalid ${[...new Set(bad)].join(", ")}`);
  }
  return new WebPushSender({ subject: subject!, publicKey: publicKey!, privateKey: privateKey! });
}

let singleton: PushSender | null = null;

export function getPushSender(): PushSender {
  if (!singleton) singleton = createPushSenderFromEnv();
  return singleton;
}

/** Test seam: pass a stub, or null to reset to env-based selection. */
export function setPushSender(s: PushSender | null): void {
  singleton = s;
}
