/**
 * Shared environment loader for the LIVE-DB integration suites.
 *
 * Importing this module (statically, at the top of a live suite / helper) loads
 * apps/api/.env.test and packages/db/.env.test, runs the production guard, and
 * throws BEFORE any database connection if anything is wrong. It never reads
 * apps/api/.env or packages/db/.env (those point at production).
 *
 * It does NOT mutate process.env on import; the suite calls `pinLiveTestEnv()`
 * in its module body (before it loads @campusgate/db, exactly where the old
 * copy-pasted block pinned) so the shared prisma singletons connect to the TEST
 * project. Fast suites must never import this file.
 *
 * Never import this from server code: it lives under __tests__ (excluded from
 * the production tsc build).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLiveTestEnv, type LiveTestEnv } from "./live-test-env-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../../..");

const env: LiveTestEnv = resolveLiveTestEnv({
  apiEnvPath: path.join(repoRoot, "apps", "api", ".env.test"),
  dbEnvPath: path.join(repoRoot, "packages", "db", ".env.test"),
});

const g = globalThis as { __cgLiveTestEnvAnnounced?: boolean };
if (!g.__cgLiveTestEnvAnnounced) {
  g.__cgLiveTestEnvAnnounced = true;
  console.log(`live tests -> project ${env.ref ?? "(non-supabase host)"} (test) host ${env.host}`);
}

export const appDatabaseUrl = env.appDatabaseUrl; // campass_app (RLS-subject)
export const adminDatabaseUrl = env.adminDatabaseUrl; // postgres (owner)

/**
 * Pin process.env for the shared @campusgate/db singleton.
 *  - "full" (default): DATABASE_URL = app role; PRIVILEGED_DATABASE_URL and
 *    DIRECT_URL = owner role; SUPABASE_* storage vars = the test project's (or
 *    removed, so a production value in the shell can never leak in).
 *  - "app-only": DATABASE_URL only (what tenant-escape-setup always did).
 */
export function pinLiveTestEnv(scope: "full" | "app-only" = "full"): void {
  process.env.DATABASE_URL = env.appDatabaseUrl;
  if (scope === "app-only") return;
  process.env.PRIVILEGED_DATABASE_URL = env.adminDatabaseUrl;
  process.env.DIRECT_URL = env.adminDatabaseUrl;
  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_STORAGE_BUCKET"] as const) {
    const value = env.storage[key];
    if (value) process.env[key] = value;
    else delete process.env[key];
  }
}
