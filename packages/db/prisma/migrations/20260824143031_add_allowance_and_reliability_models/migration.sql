-- CreateEnum
CREATE TYPE "Role" AS ENUM ('STUDENT', 'HOD', 'GUARD', 'ADMIN');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING_APPROVAL');

-- CreateEnum
CREATE TYPE "PassStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'ACTIVE', 'OUTSIDE', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "GateEventType" AS ENUM ('EXIT', 'RETURN');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('PASS_REQUESTED', 'PASS_APPROVED', 'PASS_REJECTED', 'PASS_CANCELLED', 'PASS_REVOKED', 'PASS_EXPIRED', 'GATE_EXIT', 'GATE_RETURN', 'USER_CREATED', 'USER_UPDATED', 'USER_DEACTIVATED', 'USER_REACTIVATED', 'GATE_CREATED', 'GATE_UPDATED', 'DEPARTMENT_CREATED', 'DEPARTMENT_UPDATED', 'REASON_CREATED', 'REASON_UPDATED', 'BULK_IMPORT', 'EMERGENCY_OVERRIDE', 'ALLOWANCE_POLICY_UPDATED');

-- CreateEnum
CREATE TYPE "PolicyPeriod" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'SEMESTER');

-- CreateEnum
CREATE TYPE "EnforcementMode" AS ENUM ('BLOCK_NEW_REQUESTS', 'WARN_ONLY');

-- CreateEnum
CREATE TYPE "SeverityLevel" AS ENUM ('MINOR', 'MODERATE', 'SIGNIFICANT', 'SEVERE');

-- CreateTable
CREATE TABLE "institutions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "domain" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "institutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "googleId" TEXT,
    "role" "Role" NOT NULL,
    "accountStatus" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "institutionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enrollmentNo" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "program" TEXT NOT NULL,
    "semester" INTEGER NOT NULL,
    "section" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hod_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hod_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guard_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guard_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "institutionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guard_gate_assignments" (
    "id" TEXT NOT NULL,
    "guardId" TEXT NOT NULL,
    "gateId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guard_gate_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exit_reasons" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "requiresNote" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "institutionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exit_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gate_passes" (
    "id" TEXT NOT NULL,
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
    "allowanceWarning" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gate_passes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gate_events" (
    "id" TEXT NOT NULL,
    "passId" TEXT NOT NULL,
    "gateId" TEXT NOT NULL,
    "guardId" TEXT NOT NULL,
    "eventType" "GateEventType" NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL DEFAULT 'QR_SCAN',

    CONSTRAINT "gate_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "targetId" TEXT,
    "targetType" TEXT,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allowance_policies" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "allowanceAmount" INTEGER NOT NULL DEFAULT 1440,
    "policyPeriod" "PolicyPeriod" NOT NULL DEFAULT 'WEEKLY',
    "gracePeriod" INTEGER NOT NULL DEFAULT 10,
    "enforcement" "EnforcementMode" NOT NULL DEFAULT 'WARN_ONLY',
    "minimumSampleSize" INTEGER NOT NULL DEFAULT 5,
    "severityMinorMax" INTEGER NOT NULL DEFAULT 15,
    "severityModerateMax" INTEGER NOT NULL DEFAULT 60,
    "severitySignificantMax" INTEGER NOT NULL DEFAULT 180,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "allowance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_overrides" (
    "id" TEXT NOT NULL,
    "gatePassId" TEXT NOT NULL,
    "overriddenById" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emergency_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reliability_score_snapshots" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "movementNumber" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reliability_score_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "institutions_code_key" ON "institutions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "departments_institutionId_code_key" ON "departments"("institutionId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_googleId_key" ON "users"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_userId_key" ON "student_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_enrollmentNo_key" ON "student_profiles"("enrollmentNo");

-- CreateIndex
CREATE UNIQUE INDEX "hod_profiles_userId_key" ON "hod_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "guard_profiles_userId_key" ON "guard_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "gates_institutionId_name_key" ON "gates"("institutionId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "guard_gate_assignments_guardId_gateId_key" ON "guard_gate_assignments"("guardId", "gateId");

-- CreateIndex
CREATE UNIQUE INDEX "gate_passes_passNumber_key" ON "gate_passes"("passNumber");

-- CreateIndex
CREATE UNIQUE INDEX "gate_passes_qrToken_key" ON "gate_passes"("qrToken");

-- CreateIndex
CREATE INDEX "gate_passes_studentId_status_idx" ON "gate_passes"("studentId", "status");

-- CreateIndex
CREATE INDEX "gate_passes_status_createdAt_idx" ON "gate_passes"("status", "createdAt");

-- CreateIndex
CREATE INDEX "gate_events_passId_eventType_idx" ON "gate_events"("passId", "eventType");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_timestamp_idx" ON "audit_logs"("actorId", "timestamp");

-- CreateIndex
CREATE INDEX "audit_logs_action_timestamp_idx" ON "audit_logs"("action", "timestamp");

-- CreateIndex
CREATE INDEX "notifications_userId_read_createdAt_idx" ON "notifications"("userId", "read", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "allowance_policies_institutionId_key" ON "allowance_policies"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "emergency_overrides_gatePassId_key" ON "emergency_overrides"("gatePassId");

-- CreateIndex
CREATE INDEX "reliability_score_snapshots_studentId_computedAt_idx" ON "reliability_score_snapshots"("studentId", "computedAt");

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hod_profiles" ADD CONSTRAINT "hod_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hod_profiles" ADD CONSTRAINT "hod_profiles_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_profiles" ADD CONSTRAINT "guard_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gates" ADD CONSTRAINT "gates_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_gate_assignments" ADD CONSTRAINT "guard_gate_assignments_guardId_fkey" FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_gate_assignments" ADD CONSTRAINT "guard_gate_assignments_gateId_fkey" FOREIGN KEY ("gateId") REFERENCES "gates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exit_reasons" ADD CONSTRAINT "exit_reasons_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gate_passes" ADD CONSTRAINT "gate_passes_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gate_passes" ADD CONSTRAINT "gate_passes_reasonId_fkey" FOREIGN KEY ("reasonId") REFERENCES "exit_reasons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gate_passes" ADD CONSTRAINT "gate_passes_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "hod_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gate_events" ADD CONSTRAINT "gate_events_passId_fkey" FOREIGN KEY ("passId") REFERENCES "gate_passes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gate_events" ADD CONSTRAINT "gate_events_gateId_fkey" FOREIGN KEY ("gateId") REFERENCES "gates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gate_events" ADD CONSTRAINT "gate_events_guardId_fkey" FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allowance_policies" ADD CONSTRAINT "allowance_policies_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_overrides" ADD CONSTRAINT "emergency_overrides_gatePassId_fkey" FOREIGN KEY ("gatePassId") REFERENCES "gate_passes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_overrides" ADD CONSTRAINT "emergency_overrides_overriddenById_fkey" FOREIGN KEY ("overriddenById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reliability_score_snapshots" ADD CONSTRAINT "reliability_score_snapshots_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
