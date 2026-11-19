import { createHash } from "crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Small in-memory fixed-window limiter (design D4). Counters are per API
 * process and reset on restart; the DB throttle in account-tokens.ts is
 * instance-independent and backs the email-flood case.
 */
export interface Limiter {
  hit(key: string, now?: number): { allowed: boolean; retryAfterSec: number };
  size(): number;
  reset(): void;
}

export function createLimiter(opts: { max: number; windowMs: number; maxKeys?: number }): Limiter {
  const { max, windowMs, maxKeys = 10_000 } = opts;
  const map = new Map<string, { count: number; resetAt: number }>();

  function prune(now: number) {
    for (const [k, v] of map) if (v.resetAt <= now) map.delete(k);
    // Still too large: evict oldest insertions (Map preserves insertion order).
    while (map.size > maxKeys) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  return {
    hit(key, now = Date.now()) {
      let e = map.get(key);
      if (!e || e.resetAt <= now) {
        e = { count: 0, resetAt: now + windowMs };
        map.set(key, e);
        if (map.size > maxKeys) prune(now);
      }
      e.count += 1;
      if (e.count > max) {
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((e.resetAt - now) / 1000)) };
      }
      return { allowed: true, retryAfterSec: 0 };
    },
    size: () => map.size,
    reset: () => map.clear(),
  };
}

/** SHA-256 of the trimmed, lowercased value; keeps raw emails out of limiter memory. */
export function hashKey(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

/** True for loopback, RFC1918, CGNAT and unique-local addresses. */
export function isPrivateOrCgnatIp(ip: string): boolean {
  let v = ip.trim().toLowerCase();
  if (v.startsWith("::ffff:")) v = v.slice(7);
  if (v === "::1" || v === "localhost") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(v)) return true; // fc00::/7
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function isDevOrTest(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "development" || env.NODE_ENV === "test";
}

let warnedInternalIp = false;

/**
 * The client IP to rate-limit on, or null when it should be skipped. Outside
 * dev/test a private/CGNAT address means the proxy hop count is wrong; every
 * user would share one bucket, so IP limiters are skipped (fail-safe) and the
 * per-email, per-user and per-admin limits keep working.
 */
export function clientIpKey(
  request: Pick<FastifyRequest, "ip" | "log">,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const ip = request.ip;
  if (!ip) return null;
  if (!isDevOrTest(env) && isPrivateOrCgnatIp(ip)) {
    if (!warnedInternalIp) {
      warnedInternalIp = true;
      request.log.warn("client IP looks like an internal proxy; check TRUST_PROXY_HOPS");
    }
    return null;
  }
  return ip;
}

/** Hit a limiter; on denial send 429 + Retry-After and return false. */
export function enforce(
  limiter: Limiter,
  key: string | null,
  reply: FastifyReply,
): boolean {
  if (key === null) return true;
  const r = limiter.hit(key);
  if (r.allowed) return true;
  reply
    .header("Retry-After", String(r.retryAfterSec))
    .status(429)
    .send({ error: "Too many requests. Try again later." });
  return false;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** One instance per row of the design 7.3 limiter table. */
export const limiters = {
  forgotIp: createLimiter({ max: 60, windowMs: 15 * MIN }),
  forgotIpDaily: createLimiter({ max: 150, windowMs: DAY }),
  forgotEmail: createLimiter({ max: 3, windowMs: HOUR }),
  tokenIp: createLimiter({ max: 600, windowMs: 15 * MIN }),
  registerIp: createLimiter({ max: 30, windowMs: HOUR }),
  registerEmail: createLimiter({ max: 5, windowMs: HOUR }),
  inviteAdmin: createLimiter({ max: 30, windowMs: MIN }),
  bulkAdmin: createLimiter({ max: 6, windowMs: HOUR }),
};

/** Test helper: clear every shared limiter. */
export function resetAllLimiters(): void {
  for (const l of Object.values(limiters)) l.reset();
}
