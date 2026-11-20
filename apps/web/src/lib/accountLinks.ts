/**
 * Helpers for the emailed reset/activation links. The token travels in the URL
 * fragment (`/reset-password#token=...`) so it is never sent to any server.
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;

/** Returns the token from a location hash such as "#token=abc", or null. */
export function parseTokenFromHash(hash: string): string | null {
  if (!hash) return null;
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const token = params.get("token");
  return token && TOKEN_RE.test(token) ? token : null;
}

/** Reads the token from the current location, or null on the server / when absent. */
export function readTokenFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return parseTokenFromHash(window.location.hash);
}

/** Password length in bytes (bcrypt ignores everything past 72). */
export function passwordByteLength(password: string): number {
  return new TextEncoder().encode(password).length;
}

/** Client-side mirror of the API password rules. Returns an error message or null. */
export function validateNewPassword(password: string, confirm: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters";
  if (passwordByteLength(password) > 72) return "Password must be at most 72 bytes";
  if (password !== confirm) return "Passwords do not match";
  return null;
}
