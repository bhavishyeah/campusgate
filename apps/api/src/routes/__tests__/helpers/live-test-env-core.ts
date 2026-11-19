/**
 * Pure logic behind the live-DB test environment loader (no side effects, no DB).
 * Unit-tested by ../live-test-env.test.ts. The side-effecting entry point that the
 * live suites import is ./live-test-env.ts.
 *
 * Live suites must ONLY ever run against a dedicated TEST Supabase project. They
 * read apps/api/.env.test and packages/db/.env.test (never the production .env
 * files) and refuse to run if any loaded URL references a protected project ref.
 * See docs/test-database.md.
 */
import { existsSync, readFileSync } from "node:fs";

/** The PRODUCTION Supabase project. Deliberately has no bypass flag. */
export const PRODUCTION_PROJECT_REF = "vybsvmvcdmoomuoxvmbc";

/** Refs the live suites refuse to touch (extend at runtime via CG_PROTECTED_PROJECT_REFS). */
export const PROTECTED_PROJECT_REFS: readonly string[] = [PRODUCTION_PROJECT_REF];

export const DOCS_HINT = "docs/test-database.md";

/** Minimal .env parser (KEY="value" / KEY=value), ignores comments/blank lines. */
export function parseEnvText(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
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

export function parseEnv(filePath: string): Record<string, string> {
  return parseEnvText(readFileSync(filePath, "utf8"));
}

/** Protected refs = the constant list + comma-separated CG_PROTECTED_PROJECT_REFS. */
export function protectedRefs(env: Record<string, string | undefined> = process.env): string[] {
  const extra = (env.CG_PROTECTED_PROJECT_REFS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...PROTECTED_PROJECT_REFS, ...extra])];
}

/**
 * Supabase project ref from a connection string / project URL, or null.
 *   pooler user   postgres.<ref> / campass_app.<ref>   (…pooler.supabase.com)
 *   direct host   db.<ref>.supabase.co
 *   project URL   https://<ref>.supabase.co            (SUPABASE_URL)
 */
export function extractProjectRef(url: string | undefined): string | null {
  if (!url) return null;
  const at = url.lastIndexOf("@");
  const userInfo = at === -1 ? "" : url.slice(url.indexOf("//") + 2, at);
  const hostPart = at === -1 ? url.slice(url.indexOf("//") + 2) : url.slice(at + 1);
  const hostMatch = /^(?:db\.)?([a-z0-9]+)\.supabase\.(?:co|com)(?=[:/?]|$)/i.exec(hostPart);
  if (hostMatch && hostMatch[1] && (/^db\./i.test(hostPart) || at === -1)) return hostMatch[1].toLowerCase();
  const userName = userInfo.split(":")[0] ?? "";
  const userMatch = /^[^.]+\.([a-z0-9]+)$/i.exec(userName);
  return userMatch && userMatch[1] ? userMatch[1].toLowerCase() : null;
}

/** Host[:port] only — safe to print (no user, no password). */
export function safeHost(url: string | undefined): string {
  if (!url) return "(unset)";
  const at = url.lastIndexOf("@");
  const rest = at === -1 ? url.slice(url.indexOf("//") + 2) : url.slice(at + 1);
  return rest.split(/[/?]/)[0] || "(unparseable)";
}

export class LiveTestEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveTestEnvError";
  }
}

export interface LiveTestEnv {
  appDatabaseUrl: string;
  adminDatabaseUrl: string;
  /** Project ref shared by every loaded URL, or null for a non-Supabase (e.g. local) host. */
  ref: string | null;
  host: string;
  storage: { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string; SUPABASE_STORAGE_BUCKET?: string };
}

/**
 * Throws if ANY url references a protected ref (by extracted ref OR by plain
 * substring, so an odd URL shape cannot slip past the extractor), or if the urls
 * reference different projects.
 */
export function assertSafeTestUrls(
  urls: Array<{ label: string; url: string | undefined }>,
  protectedList: string[],
): string | null {
  const present = urls.filter((u): u is { label: string; url: string } => Boolean(u.url));
  for (const { label, url } of present) {
    const ref = extractProjectRef(url);
    const lower = url.toLowerCase();
    const hit = protectedList.find((p) => ref === p || lower.includes(p));
    if (hit) {
      throw new LiveTestEnvError(
        `REFUSING TO RUN: ${label} points at protected project "${hit}" (production). ` +
          `Live suites create and delete rows and must only run against the dedicated TEST ` +
          `Supabase project. Fix the .env.test files. See ${DOCS_HINT}.`,
      );
    }
  }
  const refs = present.map((u) => ({ label: u.label, ref: extractProjectRef(u.url) }));
  const first = refs[0];
  if (first) {
    const odd = refs.find((r) => r.ref !== first.ref);
    if (odd) {
      throw new LiveTestEnvError(
        `REFUSING TO RUN: ${first.label} (project ${first.ref ?? "non-supabase host"}) and ` +
          `${odd.label} (project ${odd.ref ?? "non-supabase host"}) reference different ` +
          `projects. All .env.test URLs must point at the same TEST project. See ${DOCS_HINT}.`,
      );
    }
    return first.ref;
  }
  return null;
}

function missingFileError(file: string, keys: string, example: string): LiveTestEnvError {
  return new LiveTestEnvError(
    `Live-DB test settings not found: ${file}\n` +
      `Live suites never fall back to the production .env files. Create ${file} ` +
      `(copy ${example}) with: ${keys}.\n` +
      `Setup guide: ${DOCS_HINT}`,
  );
}

export interface LiveTestEnvFiles {
  apiEnvPath: string; // apps/api/.env.test
  dbEnvPath: string; // packages/db/.env.test
}

/** Load + validate both .env.test files. Throws (before any connection) on any problem. */
export function resolveLiveTestEnv(
  files: LiveTestEnvFiles,
  processEnv: Record<string, string | undefined> = process.env,
): LiveTestEnv {
  if (!existsSync(files.apiEnvPath)) {
    throw missingFileError(
      "apps/api/.env.test",
      "DATABASE_URL (campass_app over the transaction pooler 6543, ?pgbouncer=true) and optionally " +
        "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_STORAGE_BUCKET",
      "apps/api/.env.test.example",
    );
  }
  if (!existsSync(files.dbEnvPath)) {
    throw missingFileError(
      "packages/db/.env.test",
      "DIRECT_URL (postgres owner over the session pooler 5432), DATABASE_URL, optional PRIVILEGED_DATABASE_URL",
      "packages/db/.env.test.example",
    );
  }
  const apiEnv = parseEnv(files.apiEnvPath);
  const dbEnv = parseEnv(files.dbEnvPath);
  const appDatabaseUrl = apiEnv.DATABASE_URL; // campass_app (RLS-subject)
  const adminDatabaseUrl = dbEnv.DIRECT_URL ?? dbEnv.DATABASE_URL; // postgres (owner)
  if (!appDatabaseUrl) throw new LiveTestEnvError(`apps/api/.env.test DATABASE_URL not found. See ${DOCS_HINT}`);
  if (!adminDatabaseUrl) throw new LiveTestEnvError(`packages/db/.env.test DIRECT_URL not found. See ${DOCS_HINT}`);

  const ref = assertSafeTestUrls(
    [
      { label: "apps/api/.env.test DATABASE_URL", url: appDatabaseUrl },
      { label: "packages/db/.env.test DIRECT_URL/DATABASE_URL", url: adminDatabaseUrl },
      { label: "packages/db/.env.test DATABASE_URL", url: dbEnv.DATABASE_URL },
      { label: "packages/db/.env.test PRIVILEGED_DATABASE_URL", url: dbEnv.PRIVILEGED_DATABASE_URL },
      { label: "apps/api/.env.test SUPABASE_URL", url: apiEnv.SUPABASE_URL },
    ],
    protectedRefs(processEnv),
  );

  const storage: LiveTestEnv["storage"] = {};
  if (apiEnv.SUPABASE_URL) storage.SUPABASE_URL = apiEnv.SUPABASE_URL;
  if (apiEnv.SUPABASE_SERVICE_ROLE_KEY) storage.SUPABASE_SERVICE_ROLE_KEY = apiEnv.SUPABASE_SERVICE_ROLE_KEY;
  if (apiEnv.SUPABASE_STORAGE_BUCKET) storage.SUPABASE_STORAGE_BUCKET = apiEnv.SUPABASE_STORAGE_BUCKET;

  return { appDatabaseUrl, adminDatabaseUrl, ref, host: safeHost(adminDatabaseUrl), storage };
}
