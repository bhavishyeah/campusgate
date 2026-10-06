import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

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

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;

    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  console.log(`Loaded environment from: ${filePath}`);
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

  for (const filePath of candidates) {
    loadEnvFromFile(path.resolve(filePath));
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

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("Connected to Neon");

  await client.query(`
    ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "rollNumber" TEXT;
    ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "dob" TEXT;
    ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "phone" TEXT;
    ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "address" TEXT;
  `);

  console.log("Done — added rollNumber, dob, phone, address columns");
  await client.end();
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});
