#!/usr/bin/env node
// Bootstrap tooling for the dedicated TEST Supabase project (docs/test-database.md).
//
//   node packages/db/test-project/migrate-test.mjs             prisma migrate deploy against the TEST project
//   node packages/db/test-project/migrate-test.mjs --dry-run   print the ref/host that WOULD be used; no connection
//   node packages/db/test-project/migrate-test.mjs --check     read-only status of the TEST project
//
// Reads ONLY packages/db/.env.test (+ apps/api/.env.test for --check). Refuses any
// protected project ref (production). The prisma child gets DATABASE_URL/DIRECT_URL
// set explicitly in its environment; Prisma never overrides existing env vars with
// values from packages/db/.env, so the production .env cannot leak in. Secrets are
// never printed.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { loadTestEnv, repoRoot } from "./guard.mjs";

const require = createRequire(import.meta.url);
const args = new Set(process.argv.slice(2));
const migrationsDir = path.join(repoRoot, "packages", "db", "prisma", "migrations");
const schemaPath = path.join(repoRoot, "packages", "db", "prisma", "schema.prisma");

function localMigrations() {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(migrationsDir, d.name, "migration.sql")))
    .map((d) => d.name)
    .sort();
}

function describeTarget(env) {
  return `test database -> project ${env.ref ?? "(non-supabase host)"} host ${env.host}`;
}

function sslFor(url) {
  return /supabase\.(co|com)/i.test(url) ? { rejectUnauthorized: false } : undefined;
}

async function check(env) {
  const pg = require("pg");
  const local = localMigrations();
  console.log(describeTarget(env));
  const client = new pg.Client({ connectionString: env.directUrl, ssl: sslFor(env.directUrl) });
  await client.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    const role = await client.query(
      "SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'campass_app'",
    );
    if (role.rowCount === 0) {
      console.log("role campass_app: MISSING (run packages/db/test-project/001-create-app-role.sql)");
    } else {
      const r = role.rows[0];
      const ok = r.rolsuper === false && r.rolbypassrls === false && r.rolcanlogin === true;
      console.log(
        `role campass_app: exists, rolsuper=${r.rolsuper}, rolbypassrls=${r.rolbypassrls}, rolcanlogin=${r.rolcanlogin} ${ok ? "OK" : "WRONG (must be login, no superuser, no bypassrls)"}`,
      );
    }
    let applied = 0;
    const tbl = await client.query("SELECT to_regclass('public._prisma_migrations') AS t");
    if (tbl.rows[0].t) {
      const m = await client.query(
        "SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
      );
      applied = m.rows[0].n;
    }
    console.log(
      `migrations applied: ${applied} of ${local.length} ${applied === local.length ? "OK" : "(run npm run db:migrate:test)"}`,
    );
  } finally {
    await client.end();
  }
  console.log(
    `storage env (apps/api/.env.test): ${env.apiEnvPresent ? "" : "file missing; "}SUPABASE_URL=${env.storage.SUPABASE_URL ? "set" : "unset"}, ` +
      `SUPABASE_SERVICE_ROLE_KEY=${env.storage.SUPABASE_SERVICE_ROLE_KEY ? "set" : "unset"}, ` +
      `SUPABASE_STORAGE_BUCKET=${env.storage.SUPABASE_STORAGE_BUCKET ?? "unset (defaults to documents)"} ` +
      `(storage.smoke needs URL + key; bucket existence is not checked here)`,
  );
  console.log(`app role url (apps/api/.env.test DATABASE_URL): ${env.appDatabaseUrl ? "set" : "MISSING"}`);
}

function migrate(env) {
  const prismaCli = require.resolve("prisma/build/index.js");
  console.log(describeTarget(env));
  const res = spawnSync(process.execPath, [prismaCli, "migrate", "deploy", `--schema=${schemaPath}`], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: env.databaseUrl, DIRECT_URL: env.directUrl },
  });
  process.exit(res.status ?? 1);
}

try {
  const env = loadTestEnv();
  if (args.has("--dry-run")) {
    console.log(describeTarget(env));
    console.log(`would run: prisma migrate deploy (${localMigrations().length} local migrations); no connection made`);
  } else if (args.has("--check")) {
    await check(env);
  } else {
    migrate(env);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
