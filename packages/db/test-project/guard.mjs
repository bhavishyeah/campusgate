// Test-project env loader + production guard for the bootstrap scripts.
// Plain-JS twin of apps/api/src/routes/__tests__/helpers/live-test-env-core.ts
// (keep the rules in sync). Fails closed: only reads the .env.test files, never
// .env, and refuses protected project refs. No bypass for the production ref.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCTION_PROJECT_REF = "vybsvmvcdmoomuoxvmbc";
export const DOCS_HINT = "docs/test-database.md";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../..");
export const API_ENV_TEST = path.join(repoRoot, "apps", "api", ".env.test");
export const DB_ENV_TEST = path.join(repoRoot, "packages", "db", ".env.test");

export function parseEnvText(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function protectedRefs(env = process.env) {
  const extra = (env.CG_PROTECTED_PROJECT_REFS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([PRODUCTION_PROJECT_REF, ...extra])];
}

export function extractProjectRef(url) {
  if (!url) return null;
  const at = url.lastIndexOf("@");
  const userInfo = at === -1 ? "" : url.slice(url.indexOf("//") + 2, at);
  const hostPart = at === -1 ? url.slice(url.indexOf("//") + 2) : url.slice(at + 1);
  const hostMatch = /^(?:db\.)?([a-z0-9]+)\.supabase\.(?:co|com)(?=[:/?]|$)/i.exec(hostPart);
  if (hostMatch && (/^db\./i.test(hostPart) || at === -1)) return hostMatch[1].toLowerCase();
  const userMatch = /^[^.]+\.([a-z0-9]+)$/i.exec(userInfo.split(":")[0] ?? "");
  return userMatch ? userMatch[1].toLowerCase() : null;
}

export function safeHost(url) {
  if (!url) return "(unset)";
  const at = url.lastIndexOf("@");
  const rest = at === -1 ? url.slice(url.indexOf("//") + 2) : url.slice(at + 1);
  return rest.split(/[/?]/)[0] || "(unparseable)";
}

function fail(msg) {
  const e = new Error(msg);
  e.name = "LiveTestEnvError";
  return e;
}

/** @param {{apiEnvPath?: string, dbEnvPath?: string, processEnv?: object}} [opts] */
export function loadTestEnv(opts = {}) {
  const apiEnvPath = opts.apiEnvPath ?? API_ENV_TEST;
  const dbEnvPath = opts.dbEnvPath ?? DB_ENV_TEST;
  const processEnv = opts.processEnv ?? process.env;
  if (!existsSync(dbEnvPath)) {
    throw fail(
      `Test-database settings not found: packages/db/.env.test\n` +
        `Never falls back to the production .env. Create it (copy packages/db/.env.test.example) with: ` +
        `DIRECT_URL (postgres owner, session pooler 5432), DATABASE_URL, optional PRIVILEGED_DATABASE_URL.\n` +
        `Setup guide: ${DOCS_HINT}`,
    );
  }
  const dbEnv = parseEnvText(readFileSync(dbEnvPath, "utf8"));
  // apps/api/.env.test is optional here (only --check reports on it).
  const apiEnv = existsSync(apiEnvPath) ? parseEnvText(readFileSync(apiEnvPath, "utf8")) : null;

  const adminUrl = dbEnv.DIRECT_URL ?? dbEnv.DATABASE_URL;
  if (!adminUrl) throw fail(`packages/db/.env.test DIRECT_URL not found. See ${DOCS_HINT}`);

  const urls = [
    ["packages/db/.env.test DIRECT_URL/DATABASE_URL", adminUrl],
    ["packages/db/.env.test DATABASE_URL", dbEnv.DATABASE_URL],
    ["packages/db/.env.test PRIVILEGED_DATABASE_URL", dbEnv.PRIVILEGED_DATABASE_URL],
    ["apps/api/.env.test DATABASE_URL", apiEnv?.DATABASE_URL],
    ["apps/api/.env.test SUPABASE_URL", apiEnv?.SUPABASE_URL],
  ].filter(([, u]) => Boolean(u));

  const prot = protectedRefs(processEnv);
  for (const [label, url] of urls) {
    const ref = extractProjectRef(url);
    const hit = prot.find((p) => ref === p || url.toLowerCase().includes(p));
    if (hit) {
      throw fail(
        `REFUSING TO RUN: ${label} points at protected project "${hit}" (production). ` +
          `The test tooling only runs against the dedicated TEST Supabase project. ` +
          `Fix the .env.test files. See ${DOCS_HINT}.`,
      );
    }
  }
  const refs = urls.map(([label, url]) => [label, extractProjectRef(url)]);
  const odd = refs.find(([, r]) => r !== refs[0][1]);
  if (odd) {
    throw fail(
      `REFUSING TO RUN: ${refs[0][0]} (project ${refs[0][1] ?? "non-supabase host"}) and ${odd[0]} ` +
        `(project ${odd[1] ?? "non-supabase host"}) reference different projects. See ${DOCS_HINT}.`,
    );
  }
  return {
    ref: refs[0][1],
    host: safeHost(adminUrl),
    directUrl: adminUrl,
    databaseUrl: dbEnv.DATABASE_URL ?? adminUrl,
    appDatabaseUrl: apiEnv?.DATABASE_URL,
    apiEnvPresent: apiEnv !== null,
    storage: {
      SUPABASE_URL: Boolean(apiEnv?.SUPABASE_URL),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(apiEnv?.SUPABASE_SERVICE_ROLE_KEY),
      SUPABASE_STORAGE_BUCKET: apiEnv?.SUPABASE_STORAGE_BUCKET ?? null,
    },
  };
}
