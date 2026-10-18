-- CreateEnum
CREATE TYPE "InstitutionStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "WeekStartDay" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateEnum
CREATE TYPE "AcademicDayType" AS ENUM ('WORKING_DAY', 'HOLIDAY', 'WEEKEND', 'EXAM_DAY', 'VACATION', 'SPECIAL_WORKING_DAY', 'INSTITUTION_EVENT');

-- CreateEnum
CREATE TYPE "GuardShiftStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EmergencyType" AS ENUM ('FIRE', 'EARTHQUAKE', 'MEDICAL', 'SECURITY', 'EVACUATION', 'OTHER');

-- CreateEnum
CREATE TYPE "EmergencyStatus" AS ENUM ('ACTIVE', 'RESOLVED');

-- CreateEnum
CREATE TYPE "SecurityEventType" AS ENUM ('LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGOUT', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'PASSWORD_CHANGED', 'SUSPICIOUS_ACTIVITY', 'ACCOUNT_LOCKED', 'NEW_DEVICE_LOGIN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'SHIFT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'SHIFT_STARTED';
ALTER TYPE "AuditAction" ADD VALUE 'SHIFT_ENDED';
ALTER TYPE "AuditAction" ADD VALUE 'EMERGENCY_DECLARED';
ALTER TYPE "AuditAction" ADD VALUE 'EMERGENCY_RESOLVED';
ALTER TYPE "AuditAction" ADD VALUE 'INSTITUTION_CONFIG_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'ACADEMIC_CALENDAR_UPDATED';

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'SUPER_ADMIN';

-- AlterTable
ALTER TABLE "institutions" ADD COLUMN     "status" "InstitutionStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "student_profiles" ADD COLUMN     "address" TEXT,
ADD COLUMN     "dob" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "rollNumber" TEXT;

-- CreateTable
CREATE TABLE "guard_shifts" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "guardId" TEXT NOT NULL,
    "gateId" TEXT NOT NULL,
    "status" "GuardShiftStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledStartAt" TIMESTAMP(3) NOT NULL,
    "scheduledEndAt" TIMESTAMP(3) NOT NULL,
    "actualStartAt" TIMESTAMP(3),
    "actualEndAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guard_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institution_configs" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "weekStartDay" "WeekStartDay" NOT NULL DEFAULT 'MONDAY',
    "workingDaysOfWeek" JSONB NOT NULL DEFAULT '[1,2,3,4,5,6]',
    "lowAllowanceThresholdMinutes" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "institution_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academic_calendar_days" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "dayType" "AcademicDayType" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "academic_calendar_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_alerts" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "type" "EmergencyType" NOT NULL,
    "status" "EmergencyStatus" NOT NULL DEFAULT 'ACTIVE',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "affectedArea" TEXT,
    "declaredById" TEXT NOT NULL,
    "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "emergency_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "deviceName" TEXT,
    "deviceType" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "ipAddress" TEXT,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "institutionId" TEXT,
    "eventType" "SecurityEventType" NOT NULL,
    "ipAddress" TEXT,
    "deviceInfo" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guard_shifts_institutionId_scheduledStartAt_idx" ON "guard_shifts"("institutionId", "scheduledStartAt");

-- CreateIndex
CREATE INDEX "guard_shifts_guardId_status_idx" ON "guard_shifts"("guardId", "status");

-- CreateIndex
CREATE INDEX "guard_shifts_gateId_status_idx" ON "guard_shifts"("gateId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "institution_configs_institutionId_key" ON "institution_configs"("institutionId");

-- CreateIndex
CREATE INDEX "academic_calendar_days_institutionId_date_idx" ON "academic_calendar_days"("institutionId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "academic_calendar_days_institutionId_date_key" ON "academic_calendar_days"("institutionId", "date");

-- CreateIndex
CREATE INDEX "emergency_alerts_institutionId_status_declaredAt_idx" ON "emergency_alerts"("institutionId", "status", "declaredAt");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_jti_key" ON "sessions"("jti");

-- CreateIndex
CREATE INDEX "sessions_userId_revoked_idx" ON "sessions"("userId", "revoked");

-- CreateIndex
CREATE INDEX "sessions_jti_idx" ON "sessions"("jti");

-- CreateIndex
CREATE INDEX "security_events_userId_createdAt_idx" ON "security_events"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "security_events_institutionId_eventType_createdAt_idx" ON "security_events"("institutionId", "eventType", "createdAt");

-- AddForeignKey
ALTER TABLE "guard_shifts" ADD CONSTRAINT "guard_shifts_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_shifts" ADD CONSTRAINT "guard_shifts_guardId_fkey" FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_shifts" ADD CONSTRAINT "guard_shifts_gateId_fkey" FOREIGN KEY ("gateId") REFERENCES "gates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_shifts" ADD CONSTRAINT "guard_shifts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institution_configs" ADD CONSTRAINT "institution_configs_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academic_calendar_days" ADD CONSTRAINT "academic_calendar_days_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_alerts" ADD CONSTRAINT "emergency_alerts_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_alerts" ADD CONSTRAINT "emergency_alerts_declaredById_fkey" FOREIGN KEY ("declaredById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_alerts" ADD CONSTRAINT "emergency_alerts_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
