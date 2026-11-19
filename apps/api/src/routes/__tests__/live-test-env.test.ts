/**
 * FAST suite (no DB, no network): the pure parts of the live-test env loader and
 * its production guard. Imports ONLY live-test-env-core (never live-test-env.ts,
 * which loads the .env.test files at import time).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  PRODUCTION_PROJECT_REF,
  PROTECTED_PROJECT_REFS,
  extractProjectRef,
  parseEnvText,
  protectedRefs,
  resolveLiveTestEnv,
  safeHost,
} from "./helpers/live-test-env-core.js";

const TEST_REF = "abcdefghijklmnopqrst";
const OTHER_REF = "zzzzzzzzzzzzzzzzzzzz";
const pooler = (user: string, port: number, q = "") =>
  `postgresql://${user}:fakepw@aws-0-ap-south-1.pooler.supabase.com:${port}/postgres${q}`;
const appUrl = (ref: string) => pooler(`campass_app.${ref}`, 6543, "?pgbouncer=true");
const adminUrl = (ref: string) => pooler(`postgres.${ref}`, 5432);

const dir = mkdtempSync(path.join(os.tmpdir(), "cg-live-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function files(api: string | null, db: string | null) {
  const apiEnvPath = path.join(dir, `api-${Math.random()}.env.test`);
  const dbEnvPath = path.join(dir, `db-${Math.random()}.env.test`);
  if (api !== null) writeFileSync(apiEnvPath, api);
  if (db !== null) writeFileSync(dbEnvPath, db);
  return { apiEnvPath, dbEnvPath };
}

describe("live-test-env: constants", () => {
  it("protects the production project ref", () => {
    expect(PRODUCTION_PROJECT_REF).toBe("vybsvmvcdmoomuoxvmbc");
    expect(PROTECTED_PROJECT_REFS).toContain("vybsvmvcdmoomuoxvmbc");
    expect(protectedRefs({})).toContain("vybsvmvcdmoomuoxvmbc");
  });

  it("extends the list from CG_PROTECTED_PROJECT_REFS (comma separated, trimmed, lowercased)", () => {
    const list = protectedRefs({ CG_PROTECTED_PROJECT_REFS: " AAA111 , bbb222,,  " });
    expect(list).toEqual(expect.arrayContaining(["vybsvmvcdmoomuoxvmbc", "aaa111", "bbb222"]));
    expect(list).toHaveLength(3);
  });
});

describe("live-test-env: parseEnvText (same behavior as the old parseEnv)", () => {
  it("handles comments, blanks, quotes and values containing =", () => {
    const out = parseEnvText('# c\n\nA="x y"\nB=\'q\'\r\nC=plain\nD=a=b?c=d\nnoequals\n');
    expect(out).toEqual({ A: "x y", B: "q", C: "plain", D: "a=b?c=d" });
  });
});

describe("live-test-env: extractProjectRef", () => {
  it("reads the ref from pooler usernames (postgres.<ref>, campass_app.<ref>)", () => {
    expect(extractProjectRef(adminUrl(TEST_REF))).toBe(TEST_REF);
    expect(extractProjectRef(appUrl(TEST_REF))).toBe(TEST_REF);
  });
  it("reads the ref from the direct host db.<ref>.supabase.co", () => {
    expect(extractProjectRef(`postgresql://postgres:fakepw@db.${TEST_REF}.supabase.co:5432/postgres`)).toBe(TEST_REF);
  });
  it("reads the ref from a project URL", () => {
    expect(extractProjectRef(`https://${TEST_REF}.supabase.co`)).toBe(TEST_REF);
  });
  it("does not mistake a refless pooler host for a ref, and handles an unencoded @ in the password", () => {
    expect(extractProjectRef("postgresql://postgres:pw@aws-0-x.pooler.supabase.com:5432/postgres")).toBeNull();
    expect(extractProjectRef("postgresql://postgres:pw@pooler.supabase.com:5432/postgres")).toBeNull();
    expect(extractProjectRef(`postgresql://postgres.${TEST_REF}:p@ss@aws-0-x.pooler.supabase.com:5432/postgres`)).toBe(TEST_REF);
  });
  it("returns null for local / empty values", () => {
    expect(extractProjectRef("postgresql://postgres:pw@localhost:5432/postgres")).toBeNull();
    expect(extractProjectRef(undefined)).toBeNull();
  });
  it("safeHost never includes credentials", () => {
    expect(safeHost(appUrl(TEST_REF))).toBe("aws-0-ap-south-1.pooler.supabase.com:6543");
    expect(safeHost(appUrl(TEST_REF))).not.toContain("fakepw");
  });
});

describe("live-test-env: resolveLiveTestEnv", () => {
  it("accepts a consistent TEST project and returns app/admin urls + ref", () => {
    const env = resolveLiveTestEnv(
      files(`DATABASE_URL="${appUrl(TEST_REF)}"\n`, `DIRECT_URL="${adminUrl(TEST_REF)}"\nDATABASE_URL=${appUrl(TEST_REF)}\n`),
      {},
    );
    expect(env.ref).toBe(TEST_REF);
    expect(env.appDatabaseUrl).toBe(appUrl(TEST_REF));
    expect(env.adminDatabaseUrl).toBe(adminUrl(TEST_REF)); // DIRECT_URL wins over DATABASE_URL
  });

  it("falls back to packages/db DATABASE_URL when DIRECT_URL is absent", () => {
    const env = resolveLiveTestEnv(files(`DATABASE_URL=${appUrl(TEST_REF)}\n`, `DATABASE_URL=${adminUrl(TEST_REF)}\n`), {});
    expect(env.adminDatabaseUrl).toBe(adminUrl(TEST_REF));
  });

  it("passes storage vars through only when present", () => {
    const env = resolveLiveTestEnv(
      files(
        `DATABASE_URL=${appUrl(TEST_REF)}\nSUPABASE_URL=https://${TEST_REF}.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=k\n`,
        `DIRECT_URL=${adminUrl(TEST_REF)}\n`,
      ),
      {},
    );
    expect(env.storage).toEqual({ SUPABASE_URL: `https://${TEST_REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: "k" });
  });

  it("refuses the production ref in the app URL", () => {
    expect(() =>
      resolveLiveTestEnv(
        files(`DATABASE_URL=${appUrl(PRODUCTION_PROJECT_REF)}\n`, `DIRECT_URL=${adminUrl(TEST_REF)}\n`),
        {},
      ),
    ).toThrow(/REFUSING TO RUN.*apps\/api\/\.env\.test DATABASE_URL.*vybsvmvcdmoomuoxvmbc/s);
  });

  it("refuses the production ref in the admin URL (pooler and direct-host forms)", () => {
    expect(() =>
      resolveLiveTestEnv(
        files(`DATABASE_URL=${appUrl(TEST_REF)}\n`, `DIRECT_URL=${adminUrl(PRODUCTION_PROJECT_REF)}\n`),
        {},
      ),
    ).toThrow(/REFUSING TO RUN.*packages\/db\/\.env\.test/s);
    expect(() =>
      resolveLiveTestEnv(
        files(
          `DATABASE_URL=${appUrl(TEST_REF)}\n`,
          `DIRECT_URL=postgresql://postgres:pw@db.${PRODUCTION_PROJECT_REF}.supabase.co:5432/postgres\n`,
        ),
        {},
      ),
    ).toThrow(/REFUSING TO RUN/);
  });

  it("refuses the production ref in an optional PRIVILEGED_DATABASE_URL or SUPABASE_URL", () => {
    expect(() =>
      resolveLiveTestEnv(
        files(`DATABASE_URL=${appUrl(TEST_REF)}\n`, `DIRECT_URL=${adminUrl(TEST_REF)}\nPRIVILEGED_DATABASE_URL=${adminUrl(PRODUCTION_PROJECT_REF)}\n`),
        {},
      ),
    ).toThrow(/PRIVILEGED_DATABASE_URL/);
    expect(() =>
      resolveLiveTestEnv(
        files(
          `DATABASE_URL=${appUrl(TEST_REF)}\nSUPABASE_URL=https://${PRODUCTION_PROJECT_REF}.supabase.co\n`,
          `DIRECT_URL=${adminUrl(TEST_REF)}\n`,
        ),
        {},
      ),
    ).toThrow(/SUPABASE_URL/);
  });

  it("refuses when app and admin URLs reference different projects", () => {
    expect(() =>
      resolveLiveTestEnv(files(`DATABASE_URL=${appUrl(TEST_REF)}\n`, `DIRECT_URL=${adminUrl(OTHER_REF)}\n`), {}),
    ).toThrow(/different projects/);
  });

  it("refuses refs listed in CG_PROTECTED_PROJECT_REFS", () => {
    expect(() =>
      resolveLiveTestEnv(files(`DATABASE_URL=${appUrl(TEST_REF)}\n`, `DIRECT_URL=${adminUrl(TEST_REF)}\n`), {
        CG_PROTECTED_PROJECT_REFS: `x1,${TEST_REF}`,
      }),
    ).toThrow(new RegExp(`protected project "${TEST_REF}"`));
  });

  it("has no env-var bypass for the production ref", () => {
    expect(() =>
      resolveLiveTestEnv(files(`DATABASE_URL=${appUrl(PRODUCTION_PROJECT_REF)}\n`, `DIRECT_URL=${adminUrl(PRODUCTION_PROJECT_REF)}\n`), {
        CG_PROTECTED_PROJECT_REFS: "",
        CG_ALLOW_PRODUCTION: "1",
        ALLOW_PRODUCTION: "true",
      }),
    ).toThrow(/REFUSING TO RUN/);
  });

  it("never echoes passwords in guard errors", () => {
    try {
      resolveLiveTestEnv(files(`DATABASE_URL=${appUrl(PRODUCTION_PROJECT_REF)}\n`, `DIRECT_URL=${adminUrl(TEST_REF)}\n`), {});
      throw new Error("expected throw");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("fakepw");
      expect(String((e as Error).message)).not.toContain("postgresql://");
    }
  });

  it("fails closed with an actionable error when apps/api/.env.test is missing", () => {
    expect(() => resolveLiveTestEnv(files(null, `DIRECT_URL=${adminUrl(TEST_REF)}\n`), {})).toThrow(
      /apps\/api\/\.env\.test[\s\S]*never fall back[\s\S]*DATABASE_URL[\s\S]*docs\/test-database\.md/,
    );
  });

  it("fails closed with an actionable error when packages/db/.env.test is missing", () => {
    expect(() => resolveLiveTestEnv(files(`DATABASE_URL=${appUrl(TEST_REF)}\n`, null), {})).toThrow(
      /packages\/db\/\.env\.test[\s\S]*DIRECT_URL[\s\S]*docs\/test-database\.md/,
    );
  });

  it("errors when a required key is missing", () => {
    expect(() => resolveLiveTestEnv(files(`FOO=1\n`, `DIRECT_URL=${adminUrl(TEST_REF)}\n`), {})).toThrow(/DATABASE_URL not found/);
    expect(() => resolveLiveTestEnv(files(`DATABASE_URL=${appUrl(TEST_REF)}\n`, `FOO=1\n`), {})).toThrow(/DIRECT_URL not found/);
  });
});
