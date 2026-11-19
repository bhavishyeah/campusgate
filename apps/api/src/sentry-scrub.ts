/**
 * Pure PII/secret scrubber for Sentry events (no SDK import so it is unit-testable
 * and costs nothing when Sentry is disabled).
 *
 * Removes: Authorization / Cookie / X-Step-Up headers, request bodies for
 * /api/auth/* and /api/platform/*, any field named password/passwordHash/token/
 * stepUpToken/code/secret/razorpay_signature (at any depth), `token` query params
 * in URLs/breadcrumbs (the websocket URL carries ?token=<JWT>), and every user
 * attribute except the opaque id.
 */

const FILTERED = "[Filtered]";

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordhash",
  "token",
  "stepuptoken",
  "code",
  "secret",
  "razorpay_signature",
  "authorization",
  "cookie",
  "set-cookie",
  "x-step-up",
]);

const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-step-up"]);

const BODYLESS_PATH = /^\/(api\/(auth|platform)|ws)(\/|\?|$)/i;

const MAX_DEPTH = 12;

/** Replace the value of any `token` query/fragment parameter inside a string. */
export function scrubUrlString(value: string): string {
  return value.replace(/([?&#]token=)[^&#\s"']*/gi, `$1${FILTERED}`);
}

function pathOf(url: unknown): string {
  if (typeof url !== "string") return "";
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return url;
  }
}

function deepScrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubUrlString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return FILTERED;
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? FILTERED : deepScrub(v, depth + 1);
  }
  return out;
}

/**
 * Scrub a Sentry error event. Generic over the event type so it satisfies the
 * SDK's `beforeSend` signature in both apps without importing the SDK.
 */
export function scrubEvent<T extends object>(event: T): T {
  const e = event as Record<string, any>;

  const request = e.request as Record<string, any> | undefined;
  if (request) {
    if (request.headers && typeof request.headers === "object") {
      for (const name of Object.keys(request.headers)) {
        if (SENSITIVE_HEADERS.has(name.toLowerCase())) delete request.headers[name];
      }
    }
    delete request.cookies;
    if (BODYLESS_PATH.test(pathOf(request.url))) delete request.data;
    if (typeof request.query_string === "string") {
      request.query_string = scrubUrlString(`?${request.query_string}`).slice(1);
    } else if (request.query_string && typeof request.query_string === "object") {
      request.query_string = deepScrub(request.query_string);
    }
  }

  // Keep the opaque id only.
  if (e.user && typeof e.user === "object") {
    e.user = e.user.id !== undefined ? { id: String(e.user.id) } : undefined;
    if (e.user === undefined) delete e.user;
  }

  // Deep pass over everything else: sensitive keys + token URLs in any string.
  for (const key of Object.keys(e)) {
    if (key === "user") continue;
    e[key] = deepScrub(e[key]);
  }
  return event;
}

/** Scrub a breadcrumb (URLs in message/data). Returns the same breadcrumb. */
export function scrubBreadcrumb<T extends object>(crumb: T): T {
  const c = crumb as Record<string, any>;
  if (typeof c.message === "string") c.message = scrubUrlString(c.message);
  if (c.data) c.data = deepScrub(c.data);
  return crumb;
}
