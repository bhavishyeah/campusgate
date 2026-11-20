import { isIP } from "node:net";

const BUILTIN_HOSTS =
  /^(fcm\.googleapis\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com|web\.push\.apple\.com|([a-z0-9-]+\.)*notify\.windows\.com)$/;

function extraHosts(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    (env.PUSH_ENDPOINT_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0 && !h.includes("*") && !h.includes("/") && !h.includes(":")),
  );
}

/** Hostname of the endpoint, or null when it is not a valid https URL. Used for per-host pausing. */
export function endpointHost(endpoint: string): string | null {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * SSRF control for subscribe: the server will POST to this URL, so it must be a
 * known push service over https on 443, with no credentials and no IP literal.
 * `PUSH_ENDPOINT_HOSTS` adds EXACT hostnames only (no wildcards).
 */
export function isAllowedPushEndpoint(endpoint: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (endpoint.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  const host = u.hostname.toLowerCase();
  if (!host || isIP(host) !== 0 || host.startsWith("[")) return false;
  return BUILTIN_HOSTS.test(host) || extraHosts(env).has(host);
}
