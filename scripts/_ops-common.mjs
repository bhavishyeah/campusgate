/**
 * Shared helpers for the production ops scripts in this folder
 * (rotate-seed-passwords.mjs, cleanup-test-institutions.mjs).
 *
 * Conventions mirrored from packages/db/activate-modules.mjs and the API:
 *   - owner/privileged connection: PRIVILEGED_DATABASE_URL, falling back to
 *     DIRECT_URL (same precedence as privilegedPrisma in packages/db/src/index.ts)
 *   - env files: packages/db/.env then apps/api/.env; real process.env wins
 *   - connection strings and credentials are NEVER printed (only the host)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseEnvFile(p) {
  const out = {};
  let raw;
  try { raw = readFileSync(p, "utf8"); } catch { return out; }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    let v = t.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

export function resolveOwnerUrl() {
  const fileEnv = {
    ...parseEnvFile(path.join(repoRoot, "packages", "db", ".env")),
    ...parseEnvFile(path.join(repoRoot, "apps", "api", ".env")),
  };
  const get = (k) => process.env[k] ?? fileEnv[k];
  const url = get("PRIVILEGED_DATABASE_URL") ?? get("DIRECT_URL");
  if (!url) {
    throw new Error("No owner connection string: set PRIVILEGED_DATABASE_URL or DIRECT_URL (packages/db/.env or apps/api/.env).");
  }
  return url;
}

/** host:port only. Never includes user, password, or query. */
export function describeHost(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}`;
  } catch {
    return "(unparseable url)";
  }
}

export function makeClient(url) {
  return new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
}

const TRANSIENT = /P1001|EMAXCONNSESSION|max clients reached|Can't reach database|Timed out|ECONNRESET|ENOTFOUND/i;

/** Connect; on a transient failure (paused project / pooler cap) wait 70s and retry once. */
export async function connectWithRetry(db) {
  try {
    await db.$queryRawUnsafe("SELECT 1");
  } catch (e) {
    if (!TRANSIENT.test(String(e?.message ?? e))) throw e;
    console.error("DB unreachable (transient). Waiting 70s, then retrying once...");
    await new Promise((r) => setTimeout(r, 70_000));
    await db.$queryRawUnsafe("SELECT 1");
  }
}

/** True when `git check-ignore -q <relPath>` succeeds (path is ignored). */
export function isGitIgnored(relPath) {
  return spawnSync("git", ["check-ignore", "-q", relPath], { cwd: repoRoot }).status === 0;
}

/** Tiny argv parser: --flag, --key value, --key=value. */
export function parseArgs(argv, valueKeys = []) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument: ${a}`);
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    if (valueKeys.includes(k)) {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${k} needs a value`);
      values[k] = v;
    } else {
      flags.add(k);
    }
  }
  return { flags, values };
}

export function assertSelf(cond, msg) {
  if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`);
}
