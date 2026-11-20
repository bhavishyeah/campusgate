import type { NotificationCategoryOrEmergency, NotificationPriority } from "./categories.js";

export const GENERIC_BODY = "Open CampusGate to see the details.";
const FULL_BODY_CATEGORIES = new Set<NotificationCategoryOrEmergency>(["EMERGENCY", "ANNOUNCEMENTS", "LIBRARY"]);
const MAX_TITLE = 60;
const MAX_BODY = 120;
const MAX_WIRE_BYTES = 2048;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
// eslint-disable-next-line no-control-regex
const HAS_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function clean(value: string, max: number): string {
  const s = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** A relative deep link: single leading `/`, no `//`, no `\`, no scheme, max 200 chars. */
export function safeRelativeUrl(url: string | undefined): string {
  if (!url) return "/";
  if (url.length > 200 || !url.startsWith("/") || url.startsWith("//") || url.includes("\\")) return "/";
  if (HAS_CONTROL_CHARS.test(url)) return "/";
  return url;
}

export interface BuildPayloadInput {
  notificationId: string;
  title: string;
  body: string;
  url?: string;
  category: NotificationCategoryOrEmergency;
  priority: NotificationPriority;
  ts: number;
  /** Caller override (for example the guardian phase); goes through the same cleaning. */
  push?: { title?: string; body?: string };
}

/**
 * Lock-screen payload. Carries the minimum: never `data`, ids of users or tenants,
 * amounts, receipt/pass numbers or names. Body is generic unless the category is
 * one whose text is written for the whole audience.
 */
export function buildPushPayload(input: BuildPayloadInput): string {
  const title = clean(input.push?.title ?? input.title, MAX_TITLE) || "CampusGate";
  let body: string;
  if (input.push?.body !== undefined) body = clean(input.push.body, MAX_BODY);
  else if (FULL_BODY_CATEGORIES.has(input.category)) body = clean(input.body, MAX_BODY);
  else body = GENERIC_BODY;
  const p = input.priority === "EMERGENCY" ? "e" : input.priority === "HIGH" ? "h" : "n";
  const make = (b: string) =>
    JSON.stringify({
      v: 1,
      id: input.notificationId,
      t: title,
      b,
      u: safeRelativeUrl(input.url),
      c: input.category,
      p,
      ts: input.ts,
    });
  let wire = make(body);
  if (Buffer.byteLength(wire, "utf8") > MAX_WIRE_BYTES) {
    body = clean(body, 80);
    wire = make(body);
  }
  return wire;
}
