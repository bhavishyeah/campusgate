import { execSync } from "child_process";
import { Client } from "pg";
import { readFileSync } from "fs";

const DATABASE_URL =
  "postgresql://neondb_owner:npg_3WVXghnMNCD6@ep-misty-pond-azqx1rtc-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb";

async function main() {
  console.log("🔗 Connecting to Neon...");
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("✓ Connected to Neon");

  // Create all tables via raw SQL (generated from Prisma schema)
  console.log("📦 Creating tables...");

  const sql = `
    -- Enums
    DO $$ BEGIN
      CREATE TYPE "Role" AS ENUM ('STUDENT', 'HOD', 'GUARD', 'ADMIN');
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
      CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING_APPROVAL');
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
      CREATE TYPE "PassStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'ACTIVE', 'OUTSIDE', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'REVOKED');
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
      CREATE TYPE "GateEventType" AS ENUM ('EXIT', 'RETURN');
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
      CREATE TYPE "AuditAction" AS ENUM ('PASS_REQUESTED', 'PASS_APPROVED', 'PASS_REJECTED', 'PASS_CANCELLED', 'PASS_REVOKED', 'PASS_EXPIRED', 'GATE_EXIT', 'GATE_RETURN', 'USER_CREATED', 'USER_UPDATED', 'USER_DEACTIVATED', 'USER_REACTIVATED', 'GATE_CREATED', 'GATE_UPDATED', 'DEPARTMENT_CREATED', 'DEPARTMENT_UPDATED', 'REASON_CREATED', 'REASON_UPDATED', 'BULK_IMPORT');
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    -- Tables
    CREATE TABLE IF NOT EXISTS "institutions" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "name" TEXT NOT NULL,
      "code" TEXT NOT NULL,
      "domain" TEXT,
      "settings" JSONB NOT NULL DEFAULT '{}',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "institutions_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "institutions_code_key" ON "institutions"("code");

    CREATE TABLE IF NOT EXISTS "departments" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "name" TEXT NOT NULL,
      "code" TEXT NOT NULL,
      "institutionId" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "departments_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "departments_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "departments_institutionId_code_key" ON "departments"("institutionId", "code");

    CREATE TABLE IF NOT EXISTS "users" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "email" TEXT NOT NULL,
      "passwordHash" TEXT,
      "googleId" TEXT,
      "role" "Role" NOT NULL,
      "accountStatus" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
      "institutionId" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "lastLoginAt" TIMESTAMP(3),
      CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "users_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");
    CREATE UNIQUE INDEX IF NOT EXISTS "users_googleId_key" ON "users"("googleId");

    CREATE TABLE IF NOT EXISTS "student_profiles" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "userId" TEXT NOT NULL,
      "enrollmentNo" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "departmentId" TEXT NOT NULL,
      "program" TEXT NOT NULL,
      "semester" INTEGER NOT NULL,
      "section" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "student_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT,
      CONSTRAINT "student_profiles_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "student_profiles_userId_key" ON "student_profiles"("userId");
    CREATE UNIQUE INDEX IF NOT EXISTS "student_profiles_enrollmentNo_key" ON "student_profiles"("enrollmentNo");

    CREATE TABLE IF NOT EXISTS "hod_profiles" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "userId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "departmentId" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "hod_profiles_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "hod_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT,
      CONSTRAINT "hod_profiles_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "hod_profiles_userId_key" ON "hod_profiles"("userId");

    CREATE TABLE IF NOT EXISTS "guard_profiles" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "userId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "guard_profiles_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "guard_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "guard_profiles_userId_key" ON "guard_profiles"("userId");

    CREATE TABLE IF NOT EXISTS "gates" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "name" TEXT NOT NULL,
      "location" TEXT,
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "institutionId" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "gates_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "gates_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "gates_institutionId_name_key" ON "gates"("institutionId", "name");

    CREATE TABLE IF NOT EXISTS "guard_gate_assignments" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "guardId" TEXT NOT NULL,
      "gateId" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "guard_gate_assignments_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "guard_gate_assignments_guardId_fkey" FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE RESTRICT,
      CONSTRAINT "guard_gate_assignments_gateId_fkey" FOREIGN KEY ("gateId") REFERENCES "gates"("id") ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "guard_gate_assignments_guardId_gateId_key" ON "guard_gate_assignments"("guardId", "gateId");

    CREATE TABLE IF NOT EXISTS "exit_reasons" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "label" TEXT NOT NULL,
      "requiresNote" BOOLEAN NOT NULL DEFAULT false,
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "institutionId" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "exit_reasons_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "exit_reasons_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS "gate_passes" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "passNumber" TEXT NOT NULL,
      "studentId" TEXT NOT NULL,
      "reasonId" TEXT NOT NULL,
      "customReason" TEXT,
      "requestedExit" TIMESTAMP(3) NOT NULL,
      "expectedReturn" TIMESTAMP(3) NOT NULL,
      "status" "PassStatus" NOT NULL DEFAULT 'PENDING',
      "approvedById" TEXT,
      "approvedAt" TIMESTAMP(3),
      "rejectionReason" TEXT,
      "qrToken" TEXT,
      "qrExpiresAt" TIMESTAMP(3),
      "actualExit" TIMESTAMP(3),
      "actualReturn" TIMESTAMP(3),
      "overdueMinutes" INTEGER,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "gate_passes_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "gate_passes_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profiles"("id") ON DELETE RESTRICT,
      CONSTRAINT "gate_passes_reasonId_fkey" FOREIGN KEY ("reasonId") REFERENCES "exit_reasons"("id") ON DELETE RESTRICT,
      CONSTRAINT "gate_passes_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "hod_profiles"("id") ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "gate_passes_passNumber_key" ON "gate_passes"("passNumber");
    CREATE UNIQUE INDEX IF NOT EXISTS "gate_passes_qrToken_key" ON "gate_passes"("qrToken");
    CREATE INDEX IF NOT EXISTS "gate_passes_studentId_status_idx" ON "gate_passes"("studentId", "status");
    CREATE INDEX IF NOT EXISTS "gate_passes_status_createdAt_idx" ON "gate_passes"("status", "createdAt");

    CREATE TABLE IF NOT EXISTS "gate_events" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "passId" TEXT NOT NULL,
      "gateId" TEXT NOT NULL,
      "guardId" TEXT NOT NULL,
      "eventType" "GateEventType" NOT NULL,
      "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "method" TEXT NOT NULL DEFAULT 'QR_SCAN',
      CONSTRAINT "gate_events_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "gate_events_passId_fkey" FOREIGN KEY ("passId") REFERENCES "gate_passes"("id") ON DELETE RESTRICT,
      CONSTRAINT "gate_events_gateId_fkey" FOREIGN KEY ("gateId") REFERENCES "gates"("id") ON DELETE RESTRICT,
      CONSTRAINT "gate_events_guardId_fkey" FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS "gate_events_passId_eventType_idx" ON "gate_events"("passId", "eventType");

    CREATE TABLE IF NOT EXISTS "audit_logs" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "actorId" TEXT NOT NULL,
      "action" "AuditAction" NOT NULL,
      "targetId" TEXT,
      "targetType" TEXT,
      "metadata" JSONB,
      "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS "audit_logs_actorId_timestamp_idx" ON "audit_logs"("actorId", "timestamp");
    CREATE INDEX IF NOT EXISTS "audit_logs_action_timestamp_idx" ON "audit_logs"("action", "timestamp");

    CREATE TABLE IF NOT EXISTS "notifications" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "userId" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "body" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "data" JSONB,
      "read" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
    );
    CREATE INDEX IF NOT EXISTS "notifications_userId_read_createdAt_idx" ON "notifications"("userId", "read", "createdAt");
  `;

  await client.query(sql);
  console.log("✓ All tables created");

  await client.end();
  console.log("\n✅ Migration complete! Now run: npx tsx src/seed-neon.ts");
}

main().catch((e) => {
  console.error("❌ Failed:", e.message);
  process.exit(1);
});
