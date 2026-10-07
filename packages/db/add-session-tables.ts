import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Client } = pg;

function loadEnv() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(scriptDir, ".env"),
    path.join(scriptDir, "..", ".env"),
    path.join(scriptDir, "..", "..", ".env"),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq <= 0 || line.trim().startsWith("#")) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
    if (process.env.DATABASE_URL) return;
  }
}

loadEnv();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("Connected");

  await client.query(`
    DO $$ BEGIN
      CREATE TYPE "SecurityEventType" AS ENUM (
        'LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGOUT',
        'SESSION_REVOKED', 'SESSION_EXPIRED', 'PASSWORD_CHANGED',
        'SUSPICIOUS_ACTIVITY', 'ACCOUNT_LOCKED', 'NEW_DEVICE_LOGIN'
      );
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    CREATE TABLE IF NOT EXISTS "sessions" (
      "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "userId"        TEXT NOT NULL,
      "jti"           TEXT NOT NULL,
      "deviceName"    TEXT,
      "deviceType"    TEXT,
      "browser"       TEXT,
      "os"            TEXT,
      "ipAddress"     TEXT,
      "revoked"       BOOLEAN NOT NULL DEFAULT false,
      "revokedAt"     TIMESTAMP(3),
      "revokedReason" TEXT,
      "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "lastActiveAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "expiresAt"     TIMESTAMP(3) NOT NULL,
      CONSTRAINT "sessions_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "sessions_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "sessions_jti_key" ON "sessions"("jti");
    CREATE INDEX IF NOT EXISTS "sessions_userId_revoked_idx" ON "sessions"("userId", "revoked");

    CREATE TABLE IF NOT EXISTS "security_events" (
      "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "userId"        TEXT,
      "institutionId" TEXT,
      "eventType"     "SecurityEventType" NOT NULL,
      "ipAddress"     TEXT,
      "deviceInfo"    TEXT,
      "metadata"      JSONB,
      "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "security_events_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "security_events_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS "security_events_userId_createdAt_idx"
      ON "security_events"("userId", "createdAt");
    CREATE INDEX IF NOT EXISTS "security_events_institutionId_eventType_createdAt_idx"
      ON "security_events"("institutionId", "eventType", "createdAt");
  `);

  console.log("✓ sessions and security_events tables created");
  await client.end();
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
