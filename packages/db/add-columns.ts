import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Client } = pg;

// ─── Load .env file (same logic as seed-neon.ts) ────────────────────────────

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return null;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

function loadEnvFromFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function bootstrapEnv() {
  const cwd = process.cwd();
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(cwd, ".env"),
    path.join(cwd, "..", ".env"),
    path.join(cwd, "..", "..", ".env"),
    path.join(scriptDir, ".env"),
    path.join(scriptDir, "..", ".env"),
    path.join(scriptDir, "..", "..", ".env"),
  ];
  for (const f of candidates) {
    loadEnvFromFile(path.resolve(f));
    if (process.env.DATABASE_URL) return;
  }
}

bootstrapEnv();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required. Set it in your shell or add it to a .env file (project root or packages/db)."
  );
}

// ─── Run migrations ──────────────────────────────────────────────────────────

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("Connected to database");

  // Student profile extra columns (added in CSV import update)
  await client.query(`
    ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "rollNumber" TEXT;
    ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "dob" TEXT;
    ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "phone" TEXT;
    ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "address" TEXT;
  `);
  console.log("✓ student_profiles columns added (rollNumber, dob, phone, address)");

  // GatePass allowanceWarning field
  await client.query(`
    ALTER TABLE "gate_passes" ADD COLUMN IF NOT EXISTS "allowanceWarning" TEXT;
  `);
  console.log("✓ gate_passes.allowanceWarning column added");

  await client.end();
  console.log("\n✅ All column migrations complete");
}

main().catch((e) => {
  console.error("❌ Failed:", e.message);
  process.exit(1);
});
