/**
 * Pure PII/secret scrubber for browser + server Sentry events (no SDK import,
 * so it is unit-testable and adds nothing to the bundle when Sentry is off).
 *
 * Removes: `token` query params in any URL string (the WS URL carries
 * ?token=<JWT>), anything that looks like a JWT, Authorization/Cookie/X-Step-Up
 * headers, any field named password/token/secret/code/etc., the persisted auth
 * store (`campusgate-auth` in localStorage) wherever it shows up, and every user
 * attribute except the opaque id.
 */

const FILTERED = "[Filtered]";

const AUTH_STORE_KEY = "campusgate-auth";

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordhash",
  "newpassword",
  "confirmpassword",
  "confirm",
  "token",
  "resettoken",
  "invitetoken",
  "activationtoken",
  "tokenhash",
  "accesstoken",
  "access_token",
  "stepuptoken",
  "code",
  "secret",
  "razorpay_signature",
  "authorization",
  "cookie",
  "set-cookie",
  "x-step-up",
  AUTH_STORE_KEY,
  "localstorage",
  "sessionstorage",
  "endpoint",
  "p256dh",
  "auth",
  "keys",
  "subscription",
  "pushsubscription",
  "vapid_private_key",
  "vapidprivatekey",
  "vapid_public_key",
]);

const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-step-up"]);

const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const TOKEN_PARAM_RE = /([?&#](?:token|resettoken|invitetoken|activationtoken)=)[^&#\s"']*/gi;

const PUSH_URL_RE =
  /https:\/\/(?:fcm\.googleapis\.com|(?:[a-z0-9-]+\.)*push\.services\.mozilla\.com|web\.push\.apple\.com|(?:[a-z0-9-]+\.)*notify\.windows\.com)[^\s"']*/gi;
const MAX_DEPTH = 12;

export function scrubString(value: string): string {
  if (value.includes(AUTH_STORE_KEY)) return FILTERED;
  return value.replace(TOKEN_PARAM_RE, `$1${FILTERED}`).replace(JWT_RE, FILTERED).replace(PUSH_URL_RE, FILTERED);
}

function deepScrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return FILTERED;
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? FILTERED : deepScrub(v, depth + 1);
  }
  return out;
}

/** Scrub a Sentry event in place-compatible fashion; generic so it fits `beforeSend`. */
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
    delete request.data;
  }

  if (e.user && typeof e.user === "object") {
    if (e.user.id !== undefined) e.user = { id: String(e.user.id) };
    else delete e.user;
  }

  for (const key of Object.keys(e)) {
    if (key === "user") continue;
    e[key] = deepScrub(e[key]);
  }
  return event;
}

export function scrubBreadcrumb<T extends object>(crumb: T): T {
  const c = crumb as Record<string, any>;
  if (typeof c.message === "string") c.message = scrubString(c.message);
  if (c.data) c.data = deepScrub(c.data);
  return crumb;
}
