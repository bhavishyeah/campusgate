/**
 * migrate-neon.ts
 *
 * Creates ALL CAMPUSGATE tables on a fresh PostgreSQL / Neon database.
 * Uses IF NOT EXISTS throughout so it is safe to re-run on an existing DB.
 *
 * Usage:
 *   cd packages/db
 *   npx tsx migrate-neon.ts
 */

import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Client } = pg;

// ─── .env loader ─────────────────────────────────────────────────────────────

function loadEnvFromFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

(function bootstrapEnv() {
  const cwd = process.cwd();
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  for (const base of [cwd, scriptDir]) {
    for (const rel of [".env", "../.env", "../../.env"]) {
      loadEnvFromFile(path.resolve(base, rel));
      if (process.env.DATABASE_URL) return;
    }
  }
})();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required. Set it in your shell or a .env file.");

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(client: InstanceType<typeof Client>, sql: string, label: string) {
  await client.query(sql);
  console.log(`  ✓ ${label}`);
}

async function main() {
  console.log("🔗 Connecting to Neon...");
  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log("✓ Connected\n📦 Creating schema...\n");

  // ── Enums ──────────────────────────────────────────────────────────────────

  await run(client, `
    DO $$ BEGIN CREATE TYPE "Role" AS ENUM ('STUDENT','HOD','GUARD','ADMIN','SUPER_ADMIN');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `, "enum Role");

  await run(client, `
    DO $$ BEGIN CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE','INACTIVE','PENDING_APPROVAL');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `, "enum AccountStatus");

  await run(client, `
    DO $$ BEGIN CREATE TYPE "InstitutionStatus" AS ENUM ('ACTIVE','SUSPENDED');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `, "enum InstitutionStatus");

  await run(client, `
    DO $$ BEGIN CREATE TYPE "PassStatus" AS ENUM ('PENDING','APPROVED','REJECTED','ACTIVE','OUTSIDE','COMPLETED','CANCELLED','EXPIRED','REVOKED');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `, "enum PassStatus");

  await run(client, `
    DO $$ BEGIN CREATE TYPE "GateEventType" AS ENUM ('EXIT','RETURN');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `, "enum GateEventType");

  await run(client, `
    DO $$ BEGIN CREATE TYPE "GuardShiftStatus" AS ENUM ('SCHEDULED','ACTIVE','COMPLETED','CANCELLED');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `, "enum GuardShiftStatus");

  await run(client, `
    DO $$ BEGIN CREATE TYPE "EmergencyAlertStatus" AS ENUM ('ACTIVE','RESOLVED');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `, "enum EmergencyAlertStatus");

  await run(client, `
    DO $$ BEGIN CREATE TYPE "EmergencyType" AS ENUM ('FIRE','EARTHQUAKE','MEDICAL','SECURITY','EVACUATION','OTHER');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `, "enum EmergencyType");

  await run(client, `
    DO $$ BEGIN CREATE TYPE "PolicyPeriod" AS ENUM ('DAILY','WEEKLY','MONTHLY','SEMESTER');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `, "enum PolicyPeriod");

  await run(client, `
    DO $$ BEGIN CREATE TYPE "EnforcementMode" AS ENUM ('BLOCK_NEW_REQUESTS','WARN_ONLY');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `, "enum EnforcementMode");

  await run(client, `
    DO $$ BEGIN CREATE TYPE "AcademicDayType" AS ENUM ('WORKING_DAY','HOLIDAY','WEEKEND','EXAM_DAY','VACATION','SPECIAL_WORKING_DAY','INSTITUTION_EVENT');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `, "enum AcademicDayType");

  await run(client, `
    DO $$ BEGIN CREATE TYPE "AuditAction" AS ENUM (
      'PASS_REQUESTED','PASS_APPROVED','PASS_REJECTED','PASS_CANCELLED','PASS_REVOKED','PASS_EXPIRED',
      'GATE_EXIT','GATE_RETURN',
      'SHIFT_CREATED','SHIFT_STARTED','SHIFT_ENDED',
      'EMERGENCY_DECLARED','EMERGENCY_RESOLVED',
      'USER_CREATED','USER_UPDATED','USER_DEACTIVATED','USER_REACTIVATED',
      'GATE_CREATED','GATE_UPDATED','DEPARTMENT_CREATED','DEPARTMENT_UPDATED',
      'REASON_CREATED','REASON_UPDATED','BULK_IMPORT',
      'EMERGENCY_OVERRIDE','ALLOWANCE_POLICY_UPDATED',
      'INSTITUTION_CONFIG_UPDATED','ACADEMIC_CALENDAR_UPDATED'
    );
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `, "enum AuditAction");

  await run(client, `
    DO $$ BEGIN CREATE TYPE "SecurityEventType" AS ENUM (
      'LOGIN_SUCCESS','LOGIN_FAILED','LOGOUT',
      'SESSION_REVOKED','SESSION_EXPIRED','PASSWORD_CHANGED',
      'SUSPICIOUS_ACTIVITY','ACCOUNT_LOCKED','NEW_DEVICE_LOGIN'
    );
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `, "enum SecurityEventType");

  // ── Core tables ────────────────────────────────────────────────────────────

  await run(client, `
    CREATE TABLE IF NOT EXISTS "institutions" (
      "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "name"      TEXT NOT NULL,
      "code"      TEXT NOT NULL,
      "domain"    TEXT,
      "status"    "InstitutionStatus" NOT NULL DEFAULT 'ACTIVE',
      "settings"  JSONB NOT NULL DEFAULT '{}',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "institutions_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "institutions_code_key" ON "institutions"("code");
  `, "institutions");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "departments" (
      "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "name"          TEXT NOT NULL,
      "code"          TEXT NOT NULL,
      "institutionId" TEXT NOT NULL,
      "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "departments_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "departments_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "departments_institutionId_code_key" ON "departments"("institutionId","code");
  `, "departments");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "users" (
      "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "email"         TEXT NOT NULL,
      "passwordHash"  TEXT,
      "googleId"      TEXT,
      "role"          "Role" NOT NULL,
      "accountStatus" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
      "institutionId" TEXT NOT NULL,
      "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "lastLoginAt"   TIMESTAMP(3),
      CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "users_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");
    CREATE UNIQUE INDEX IF NOT EXISTS "users_googleId_key" ON "users"("googleId");
  `, "users");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "student_profiles" (
      "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "userId"       TEXT NOT NULL,
      "enrollmentNo" TEXT NOT NULL,
      "rollNumber"   TEXT,
      "name"         TEXT NOT NULL,
      "departmentId" TEXT NOT NULL,
      "program"      TEXT NOT NULL,
      "semester"     INTEGER NOT NULL,
      "section"      TEXT,
      "dob"          TEXT,
      "phone"        TEXT,
      "address"      TEXT,
      "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "student_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT,
      CONSTRAINT "student_profiles_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "student_profiles_userId_key" ON "student_profiles"("userId");
    CREATE UNIQUE INDEX IF NOT EXISTS "student_profiles_enrollmentNo_key" ON "student_profiles"("enrollmentNo");
  `, "student_profiles");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "hod_profiles" (
      "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "userId"       TEXT NOT NULL,
      "name"         TEXT NOT NULL,
      "departmentId" TEXT NOT NULL,
      "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "hod_profiles_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "hod_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT,
      CONSTRAINT "hod_profiles_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "hod_profiles_userId_key" ON "hod_profiles"("userId");
  `, "hod_profiles");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "guard_profiles" (
      "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "userId"    TEXT NOT NULL,
      "name"      TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "guard_profiles_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "guard_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "guard_profiles_userId_key" ON "guard_profiles"("userId");
  `, "guard_profiles");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "gates" (
      "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "name"          TEXT NOT NULL,
      "location"      TEXT,
      "isActive"      BOOLEAN NOT NULL DEFAULT true,
      "institutionId" TEXT NOT NULL,
      "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "gates_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "gates_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "gates_institutionId_name_key" ON "gates"("institutionId","name");
  `, "gates");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "guard_gate_assignments" (
      "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "guardId"   TEXT NOT NULL,
      "gateId"    TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "guard_gate_assignments_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "guard_gate_assignments_guardId_fkey" FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE RESTRICT,
      CONSTRAINT "guard_gate_assignments_gateId_fkey" FOREIGN KEY ("gateId") REFERENCES "gates"("id") ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "guard_gate_assignments_guardId_gateId_key" ON "guard_gate_assignments"("guardId","gateId");
  `, "guard_gate_assignments");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "exit_reasons" (
      "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "label"         TEXT NOT NULL,
      "requiresNote"  BOOLEAN NOT NULL DEFAULT false,
      "isActive"      BOOLEAN NOT NULL DEFAULT true,
      "institutionId" TEXT NOT NULL,
      "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "exit_reasons_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "exit_reasons_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT
    );
  `, "exit_reasons");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "gate_passes" (
      "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "passNumber"      TEXT NOT NULL,
      "studentId"       TEXT NOT NULL,
      "reasonId"        TEXT NOT NULL,
      "customReason"    TEXT,
      "requestedExit"   TIMESTAMP(3) NOT NULL,
      "expectedReturn"  TIMESTAMP(3) NOT NULL,
      "status"          "PassStatus" NOT NULL DEFAULT 'PENDING',
      "approvedById"    TEXT,
      "approvedAt"      TIMESTAMP(3),
      "rejectionReason" TEXT,
      "qrToken"         TEXT,
      "qrExpiresAt"     TIMESTAMP(3),
      "actualExit"      TIMESTAMP(3),
      "actualReturn"    TIMESTAMP(3),
      "overdueMinutes"  INTEGER,
      "allowanceWarning" TEXT,
      "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "gate_passes_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "gate_passes_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profiles"("id") ON DELETE RESTRICT,
      CONSTRAINT "gate_passes_reasonId_fkey" FOREIGN KEY ("reasonId") REFERENCES "exit_reasons"("id") ON DELETE RESTRICT,
      CONSTRAINT "gate_passes_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "hod_profiles"("id") ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "gate_passes_passNumber_key" ON "gate_passes"("passNumber");
    CREATE UNIQUE INDEX IF NOT EXISTS "gate_passes_qrToken_key" ON "gate_passes"("qrToken");
    CREATE INDEX IF NOT EXISTS "gate_passes_studentId_status_idx" ON "gate_passes"("studentId","status");
    CREATE INDEX IF NOT EXISTS "gate_passes_status_createdAt_idx" ON "gate_passes"("status","createdAt");
  `, "gate_passes");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "gate_events" (
      "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "passId"    TEXT NOT NULL,
      "gateId"    TEXT NOT NULL,
      "guardId"   TEXT NOT NULL,
      "eventType" "GateEventType" NOT NULL,
      "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "method"    TEXT NOT NULL DEFAULT 'QR_SCAN',
      CONSTRAINT "gate_events_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "gate_events_passId_fkey" FOREIGN KEY ("passId") REFERENCES "gate_passes"("id") ON DELETE RESTRICT,
      CONSTRAINT "gate_events_gateId_fkey" FOREIGN KEY ("gateId") REFERENCES "gates"("id") ON DELETE RESTRICT,
      CONSTRAINT "gate_events_guardId_fkey" FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS "gate_events_passId_eventType_idx" ON "gate_events"("passId","eventType");
  `, "gate_events");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "guard_shifts" (
      "id"                TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "institutionId"     TEXT NOT NULL,
      "guardId"           TEXT NOT NULL,
      "gateId"            TEXT NOT NULL,
      "status"            "GuardShiftStatus" NOT NULL DEFAULT 'SCHEDULED',
      "scheduledStartAt"  TIMESTAMP(3) NOT NULL,
      "scheduledEndAt"    TIMESTAMP(3) NOT NULL,
      "actualStartAt"     TIMESTAMP(3),
      "actualEndAt"       TIMESTAMP(3),
      "note"              TEXT,
      "createdById"       TEXT NOT NULL,
      "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "guard_shifts_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "guard_shifts_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT,
      CONSTRAINT "guard_shifts_guardId_fkey" FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE RESTRICT,
      CONSTRAINT "guard_shifts_gateId_fkey" FOREIGN KEY ("gateId") REFERENCES "gates"("id") ON DELETE RESTRICT,
      CONSTRAINT "guard_shifts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS "guard_shifts_guardId_status_idx" ON "guard_shifts"("guardId","status");
    CREATE INDEX IF NOT EXISTS "guard_shifts_institutionId_scheduledStartAt_idx" ON "guard_shifts"("institutionId","scheduledStartAt");
  `, "guard_shifts");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "emergency_alerts" (
      "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "institutionId"  TEXT NOT NULL,
      "type"           "EmergencyType" NOT NULL,
      "status"         "EmergencyAlertStatus" NOT NULL DEFAULT 'ACTIVE',
      "title"          TEXT NOT NULL,
      "message"        TEXT NOT NULL,
      "affectedArea"   TEXT,
      "declaredById"   TEXT NOT NULL,
      "resolvedById"   TEXT,
      "declaredAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "resolvedAt"     TIMESTAMP(3),
      "resolutionNote" TEXT,
      CONSTRAINT "emergency_alerts_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "emergency_alerts_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT,
      CONSTRAINT "emergency_alerts_declaredById_fkey" FOREIGN KEY ("declaredById") REFERENCES "users"("id") ON DELETE RESTRICT,
      CONSTRAINT "emergency_alerts_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS "emergency_alerts_institutionId_status_idx" ON "emergency_alerts"("institutionId","status");
  `, "emergency_alerts");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "emergency_overrides" (
      "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "gatePassId"     TEXT NOT NULL,
      "overriddenById" TEXT NOT NULL,
      "justification"  TEXT NOT NULL,
      "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "emergency_overrides_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "emergency_overrides_gatePassId_fkey" FOREIGN KEY ("gatePassId") REFERENCES "gate_passes"("id") ON DELETE RESTRICT,
      CONSTRAINT "emergency_overrides_overriddenById_fkey" FOREIGN KEY ("overriddenById") REFERENCES "users"("id") ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "emergency_overrides_gatePassId_key" ON "emergency_overrides"("gatePassId");
  `, "emergency_overrides");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "allowance_policies" (
      "id"                     TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "institutionId"          TEXT NOT NULL,
      "allowanceAmount"        INTEGER NOT NULL DEFAULT 1440,
      "policyPeriod"           "PolicyPeriod" NOT NULL DEFAULT 'WEEKLY',
      "gracePeriod"            INTEGER NOT NULL DEFAULT 10,
      "enforcement"            "EnforcementMode" NOT NULL DEFAULT 'WARN_ONLY',
      "minimumSampleSize"      INTEGER NOT NULL DEFAULT 5,
      "severityMinorMax"       INTEGER NOT NULL DEFAULT 15,
      "severityModerateMax"    INTEGER NOT NULL DEFAULT 60,
      "severitySignificantMax" INTEGER NOT NULL DEFAULT 180,
      "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "allowance_policies_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "allowance_policies_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "allowance_policies_institutionId_key" ON "allowance_policies"("institutionId");
  `, "allowance_policies");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "institution_configs" (
      "id"                           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "institutionId"                TEXT NOT NULL,
      "timezone"                     TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      "weekStartDay"                 INTEGER NOT NULL DEFAULT 1,
      "workingDaysOfWeek"            INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6],
      "lowAllowanceThresholdMinutes" INTEGER NOT NULL DEFAULT 60,
      "createdAt"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "institution_configs_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "institution_configs_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "institution_configs_institutionId_key" ON "institution_configs"("institutionId");
  `, "institution_configs");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "academic_calendar_days" (
      "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "institutionId" TEXT NOT NULL,
      "date"          TEXT NOT NULL,
      "dayType"       "AcademicDayType" NOT NULL,
      "note"          TEXT,
      "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "academic_calendar_days_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "academic_calendar_days_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "academic_calendar_days_institutionId_date_key" ON "academic_calendar_days"("institutionId","date");
  `, "academic_calendar_days");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "reliability_score_snapshots" (
      "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "studentId"      TEXT NOT NULL,
      "score"          DOUBLE PRECISION NOT NULL,
      "movementNumber" INTEGER NOT NULL,
      "computedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "reliability_score_snapshots_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "reliability_score_snapshots_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profiles"("id") ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS "reliability_score_snapshots_studentId_computedAt_idx" ON "reliability_score_snapshots"("studentId","computedAt");
  `, "reliability_score_snapshots");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "audit_logs" (
      "id"         TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "actorId"    TEXT NOT NULL,
      "action"     "AuditAction" NOT NULL,
      "targetId"   TEXT,
      "targetType" TEXT,
      "metadata"   JSONB,
      "timestamp"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS "audit_logs_actorId_timestamp_idx" ON "audit_logs"("actorId","timestamp");
    CREATE INDEX IF NOT EXISTS "audit_logs_action_timestamp_idx" ON "audit_logs"("action","timestamp");
  `, "audit_logs");

  await run(client, `
    CREATE TABLE IF NOT EXISTS "notifications" (
      "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "userId"    TEXT NOT NULL,
      "title"     TEXT NOT NULL,
      "body"      TEXT NOT NULL,
      "type"      TEXT NOT NULL,
      "data"      JSONB,
      "read"      BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
    );
    CREATE INDEX IF NOT EXISTS "notifications_userId_read_createdAt_idx" ON "notifications"("userId","read","createdAt");
  `, "notifications");

  await run(client, `
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
      CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "sessions_jti_key" ON "sessions"("jti");
    CREATE INDEX IF NOT EXISTS "sessions_userId_revoked_idx" ON "sessions"("userId","revoked");
  `, "sessions");

  await run(client, `
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
      CONSTRAINT "security_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS "security_events_userId_createdAt_idx" ON "security_events"("userId","createdAt");
    CREATE INDEX IF NOT EXISTS "security_events_institutionId_eventType_idx" ON "security_events"("institutionId","eventType","createdAt");
  `, "security_events");

  await client.end();
  console.log("\n✅ Migration complete! All tables created.");
  console.log("Next: npx tsx seed-neon.ts");
}

main().catch((e) => {
  console.error("❌ Failed:", e.message);
  process.exit(1);
});
