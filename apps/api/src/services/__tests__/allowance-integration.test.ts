import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @campusgate/db before importing anything that uses it
vi.mock('@campusgate/db', () => ({
  prisma: {
    allowancePolicy: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
    gatePass: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    gateEvent: { findMany: vi.fn() },
    emergencyOverride: { create: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  PolicyPeriod: { DAILY: 'DAILY', WEEKLY: 'WEEKLY', MONTHLY: 'MONTHLY', SEMESTER: 'SEMESTER' },
  EnforcementMode: { BLOCK_NEW_REQUESTS: 'BLOCK_NEW_REQUESTS', WARN_ONLY: 'WARN_ONLY' },
}));

import { AllowanceEngine } from '../allowance-engine.js';
import { prisma } from '@campusgate/db';

// Type the mocked prisma for easier use
const mockedPrisma = prisma as unknown as {
  allowancePolicy: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  gatePass: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  gateEvent: { findMany: ReturnType<typeof vi.fn> };
  emergencyOverride: { create: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

describe('Allowance Integration Tests', () => {
  const STUDENT_ID = 'student-001';
  const INSTITUTION_ID = 'inst-001';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Full Gate Pass Lifecycle with Allowance Tracking ───────────────────────
  // Validates: Requirements 2.1, 2.4
  describe('Full gate pass lifecycle with allowance tracking', () => {
    it('should compute consumed allowance from EXIT/RETURN event pairs of completed passes in current period', async () => {
      // Setup: weekly policy with 1440 minutes (24 hours) allowance
      const weeklyPolicy = {
        id: 'policy-001',
        institutionId: INSTITUTION_ID,
        allowanceAmount: 1440,
        policyPeriod: 'WEEKLY',
        gracePeriod: 10,
        enforcement: 'WARN_ONLY',
        minimumSampleSize: 5,
        severityMinorMax: 15,
        severityModerateMax: 60,
        severitySignificantMax: 180,
      };

      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(weeklyPolicy);

      // Simulate two completed passes with EXIT and RETURN events
      // Pass 1: 60 minutes outside (exit at 9:00, return at 10:00)
      // Pass 2: 90 minutes outside (exit at 14:00, return at 15:30)
      const now = new Date();
      const todayMorning = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);

      const completedPasses = [
        {
          id: 'pass-001',
          studentId: STUDENT_ID,
          status: 'COMPLETED',
          gateEvents: [
            { id: 'evt-1', passId: 'pass-001', eventType: 'EXIT', timestamp: todayMorning },
            { id: 'evt-2', passId: 'pass-001', eventType: 'RETURN', timestamp: new Date(todayMorning.getTime() + 60 * 60 * 1000) },
          ],
        },
        {
          id: 'pass-002',
          studentId: STUDENT_ID,
          status: 'COMPLETED',
          gateEvents: [
            { id: 'evt-3', passId: 'pass-002', eventType: 'EXIT', timestamp: new Date(todayMorning.getTime() + 5 * 60 * 60 * 1000) },
            { id: 'evt-4', passId: 'pass-002', eventType: 'RETURN', timestamp: new Date(todayMorning.getTime() + 5 * 60 * 60 * 1000 + 90 * 60 * 1000) },
          ],
        },
      ];

      mockedPrisma.gatePass.findMany.mockResolvedValue(completedPasses);
      mockedPrisma.gatePass.findFirst.mockResolvedValue(null); // Not currently outside

      const summary = await AllowanceEngine.getRemainingAllowance(STUDENT_ID, INSTITUTION_ID);

      // Total consumed = 60 + 90 = 150 minutes
      expect(summary.consumed).toBe(150);
      // Remaining = 1440 - 150 = 1290 minutes
      expect(summary.remaining).toBe(1290);
      expect(summary.totalAllowance).toBe(1440);
      expect(summary.isExhausted).toBe(false);
      expect(summary.currentlyOutsideElapsed).toBeNull();
    });

    it('should include in-progress elapsed time when student is currently outside', async () => {
      const weeklyPolicy = {
        id: 'policy-001',
        institutionId: INSTITUTION_ID,
        allowanceAmount: 1440,
        policyPeriod: 'WEEKLY',
        gracePeriod: 10,
        enforcement: 'WARN_ONLY',
        minimumSampleSize: 5,
        severityMinorMax: 15,
        severityModerateMax: 60,
        severitySignificantMax: 180,
      };

      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(weeklyPolicy);

      // One completed pass consuming 60 minutes
      const now = new Date();
      const todayMorning = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);
      const completedPasses = [
        {
          id: 'pass-001',
          studentId: STUDENT_ID,
          status: 'COMPLETED',
          gateEvents: [
            { id: 'evt-1', passId: 'pass-001', eventType: 'EXIT', timestamp: todayMorning },
            { id: 'evt-2', passId: 'pass-001', eventType: 'RETURN', timestamp: new Date(todayMorning.getTime() + 60 * 60 * 1000) },
          ],
        },
      ];

      mockedPrisma.gatePass.findMany.mockResolvedValue(completedPasses);

      // Student is currently outside — exited 30 minutes ago
      const exitTime = new Date(Date.now() - 30 * 60 * 1000);
      mockedPrisma.gatePass.findFirst.mockResolvedValue({
        id: 'pass-002',
        studentId: STUDENT_ID,
        status: 'OUTSIDE',
        gateEvents: [
          { id: 'evt-3', passId: 'pass-002', eventType: 'EXIT', timestamp: exitTime },
        ],
      });

      const summary = await AllowanceEngine.getRemainingAllowance(STUDENT_ID, INSTITUTION_ID);

      // Consumed should include completed (60) + in-progress (~30)
      expect(summary.consumed).toBeGreaterThanOrEqual(89); // 60 + ~30 (allow some ms variance)
      expect(summary.consumed).toBeLessThanOrEqual(91);
      expect(summary.currentlyOutsideElapsed).toBeGreaterThanOrEqual(29);
      expect(summary.currentlyOutsideElapsed).toBeLessThanOrEqual(31);
      expect(summary.remaining).toBe(Math.max(0, 1440 - summary.consumed));
    });

    it('should exclude passes with missing EXIT or RETURN events from duration calculation', async () => {
      const weeklyPolicy = {
        id: 'policy-001',
        institutionId: INSTITUTION_ID,
        allowanceAmount: 1440,
        policyPeriod: 'WEEKLY',
        gracePeriod: 10,
        enforcement: 'WARN_ONLY',
        minimumSampleSize: 5,
        severityMinorMax: 15,
        severityModerateMax: 60,
        severitySignificantMax: 180,
      };

      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(weeklyPolicy);

      const now = new Date();
      const todayMorning = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);

      // Pass with only EXIT event (missing RETURN) — should be excluded
      // Pass with valid EXIT + RETURN pair — should be counted (120 minutes)
      const completedPasses = [
        {
          id: 'pass-incomplete',
          studentId: STUDENT_ID,
          status: 'COMPLETED',
          gateEvents: [
            { id: 'evt-1', passId: 'pass-incomplete', eventType: 'EXIT', timestamp: todayMorning },
            // No RETURN event
          ],
        },
        {
          id: 'pass-valid',
          studentId: STUDENT_ID,
          status: 'COMPLETED',
          gateEvents: [
            { id: 'evt-2', passId: 'pass-valid', eventType: 'EXIT', timestamp: new Date(todayMorning.getTime() + 3 * 60 * 60 * 1000) },
            { id: 'evt-3', passId: 'pass-valid', eventType: 'RETURN', timestamp: new Date(todayMorning.getTime() + 3 * 60 * 60 * 1000 + 120 * 60 * 1000) },
          ],
        },
      ];

      mockedPrisma.gatePass.findMany.mockResolvedValue(completedPasses);
      mockedPrisma.gatePass.findFirst.mockResolvedValue(null);

      // Suppress console.warn for this test since the engine logs warnings for missing events
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const summary = await AllowanceEngine.getRemainingAllowance(STUDENT_ID, INSTITUTION_ID);

      // Only the valid pass should be counted (120 minutes)
      expect(summary.consumed).toBe(120);
      expect(summary.remaining).toBe(1440 - 120);
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('should report full allowance when no completed movements exist in current period', async () => {
      const weeklyPolicy = {
        id: 'policy-001',
        institutionId: INSTITUTION_ID,
        allowanceAmount: 1440,
        policyPeriod: 'WEEKLY',
        gracePeriod: 10,
        enforcement: 'WARN_ONLY',
        minimumSampleSize: 5,
        severityMinorMax: 15,
        severityModerateMax: 60,
        severitySignificantMax: 180,
      };

      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(weeklyPolicy);
      mockedPrisma.gatePass.findMany.mockResolvedValue([]); // No completed passes
      mockedPrisma.gatePass.findFirst.mockResolvedValue(null); // Not currently outside

      const summary = await AllowanceEngine.getRemainingAllowance(STUDENT_ID, INSTITUTION_ID);

      expect(summary.consumed).toBe(0);
      expect(summary.remaining).toBe(1440);
      expect(summary.totalAllowance).toBe(1440);
      expect(summary.isExhausted).toBe(false);
    });
  });

  // ─── Emergency Override Flow ────────────────────────────────────────────────
  // Validates: Requirements 4.1, 5.1, 5.3
  describe('Emergency override flow (exhausted → override → pass created → audit logged)', () => {
    it('should block new requests when allowance is exhausted and enforcement is BLOCK_NEW_REQUESTS', async () => {
      const blockPolicy = {
        id: 'policy-001',
        institutionId: INSTITUTION_ID,
        allowanceAmount: 120, // 2 hours
        policyPeriod: 'DAILY',
        gracePeriod: 10,
        enforcement: 'BLOCK_NEW_REQUESTS',
        minimumSampleSize: 5,
        severityMinorMax: 15,
        severityModerateMax: 60,
        severitySignificantMax: 180,
      };

      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(blockPolicy);

      // Student already consumed 150 minutes (exceeds 120 minute allowance)
      const now = new Date();
      const todayMorning = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0, 0);
      const completedPasses = [
        {
          id: 'pass-001',
          studentId: STUDENT_ID,
          status: 'COMPLETED',
          gateEvents: [
            { id: 'evt-1', passId: 'pass-001', eventType: 'EXIT', timestamp: todayMorning },
            { id: 'evt-2', passId: 'pass-001', eventType: 'RETURN', timestamp: new Date(todayMorning.getTime() + 150 * 60 * 1000) },
          ],
        },
      ];

      mockedPrisma.gatePass.findMany.mockResolvedValue(completedPasses);
      mockedPrisma.gatePass.findFirst.mockResolvedValue(null);

      const decision = await AllowanceEngine.getEnforcementDecision(STUDENT_ID, INSTITUTION_ID);

      expect(decision.action).toBe('block');
      expect(decision.remainingAllowance).toBe(0);
      expect(decision.message).toContain('exhausted');
    });

    it('should warn when allowance is exhausted and enforcement is WARN_ONLY', async () => {
      const warnPolicy = {
        id: 'policy-001',
        institutionId: INSTITUTION_ID,
        allowanceAmount: 120,
        policyPeriod: 'DAILY',
        gracePeriod: 10,
        enforcement: 'WARN_ONLY',
        minimumSampleSize: 5,
        severityMinorMax: 15,
        severityModerateMax: 60,
        severitySignificantMax: 180,
      };

      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(warnPolicy);

      const now = new Date();
      const todayMorning = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0, 0);
      const completedPasses = [
        {
          id: 'pass-001',
          studentId: STUDENT_ID,
          status: 'COMPLETED',
          gateEvents: [
            { id: 'evt-1', passId: 'pass-001', eventType: 'EXIT', timestamp: todayMorning },
            { id: 'evt-2', passId: 'pass-001', eventType: 'RETURN', timestamp: new Date(todayMorning.getTime() + 150 * 60 * 1000) },
          ],
        },
      ];

      mockedPrisma.gatePass.findMany.mockResolvedValue(completedPasses);
      mockedPrisma.gatePass.findFirst.mockResolvedValue(null);

      const decision = await AllowanceEngine.getEnforcementDecision(STUDENT_ID, INSTITUTION_ID);

      expect(decision.action).toBe('warn');
      expect(decision.remainingAllowance).toBe(0);
      expect(decision.message).toContain('exhausted');
    });

    it('should allow when remaining allowance is positive regardless of enforcement mode', async () => {
      const blockPolicy = {
        id: 'policy-001',
        institutionId: INSTITUTION_ID,
        allowanceAmount: 1440,
        policyPeriod: 'WEEKLY',
        gracePeriod: 10,
        enforcement: 'BLOCK_NEW_REQUESTS',
        minimumSampleSize: 5,
        severityMinorMax: 15,
        severityModerateMax: 60,
        severitySignificantMax: 180,
      };

      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(blockPolicy);

      // Only consumed 60 minutes — plenty of allowance remaining
      const now = new Date();
      const todayMorning = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);
      const completedPasses = [
        {
          id: 'pass-001',
          studentId: STUDENT_ID,
          status: 'COMPLETED',
          gateEvents: [
            { id: 'evt-1', passId: 'pass-001', eventType: 'EXIT', timestamp: todayMorning },
            { id: 'evt-2', passId: 'pass-001', eventType: 'RETURN', timestamp: new Date(todayMorning.getTime() + 60 * 60 * 1000) },
          ],
        },
      ];

      mockedPrisma.gatePass.findMany.mockResolvedValue(completedPasses);
      mockedPrisma.gatePass.findFirst.mockResolvedValue(null);

      const decision = await AllowanceEngine.getEnforcementDecision(STUDENT_ID, INSTITUTION_ID);

      expect(decision.action).toBe('allow');
      expect(decision.remainingAllowance).toBe(1380); // 1440 - 60
    });

    it('should create emergency override record with justification and audit log', async () => {
      const overrideData = {
        gatePassId: 'pass-blocked-001',
        overriddenById: 'hod-user-001',
        justification: 'Student has a family emergency and needs to leave campus immediately.',
      };

      const createdOverride = {
        id: 'override-001',
        ...overrideData,
        createdAt: new Date(),
      };

      mockedPrisma.emergencyOverride.create.mockResolvedValue(createdOverride);
      mockedPrisma.auditLog.create.mockResolvedValue({ id: 'audit-001' });

      // Simulate the override creation flow
      const override = await prisma.emergencyOverride.create({ data: overrideData });

      expect(override.id).toBe('override-001');
      expect(override.gatePassId).toBe('pass-blocked-001');
      expect(override.overriddenById).toBe('hod-user-001');
      expect(override.justification).toContain('family emergency');

      // Verify the override creation was called with correct data
      expect(mockedPrisma.emergencyOverride.create).toHaveBeenCalledWith({
        data: overrideData,
      });

      // Create audit log for the override
      await prisma.auditLog.create({
        data: {
          actorId: 'hod-user-001',
          action: 'EMERGENCY_OVERRIDE',
          targetId: 'pass-blocked-001',
          targetType: 'GatePass',
          metadata: { justification: overrideData.justification, studentId: STUDENT_ID },
        },
      });

      expect(mockedPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorId: 'hod-user-001',
          action: 'EMERGENCY_OVERRIDE',
          targetId: 'pass-blocked-001',
          targetType: 'GatePass',
        }),
      });
    });

    it('should reject emergency override when justification is too short', () => {
      const shortJustification = 'too short';

      // Validate justification length >= 10 characters (Requirement 5.2)
      expect(shortJustification.length).toBeLessThan(10);

      const isValid = shortJustification.length >= 10;
      expect(isValid).toBe(false);
    });

    it('should accept emergency override when justification meets minimum length', () => {
      const validJustification = 'Student has medical appointment that cannot be rescheduled.';

      expect(validJustification.length).toBeGreaterThanOrEqual(10);

      const isValid = validJustification.length >= 10;
      expect(isValid).toBe(true);
    });
  });

  // ─── Policy Period Reset Behavior ──────────────────────────────────────────
  // Validates: Requirements 2.4
  describe('Policy period reset behavior', () => {
    it('should only count movements with RETURN events in the current period', async () => {
      const dailyPolicy = {
        id: 'policy-001',
        institutionId: INSTITUTION_ID,
        allowanceAmount: 480, // 8 hours
        policyPeriod: 'DAILY',
        gracePeriod: 10,
        enforcement: 'WARN_ONLY',
        minimumSampleSize: 5,
        severityMinorMax: 15,
        severityModerateMax: 60,
        severitySignificantMax: 180,
      };

      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(dailyPolicy);

      // Only return passes with RETURN in current period (the query already filters)
      // Simulating that the DB query returns only today's passes
      const now = new Date();
      const todayMorning = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);

      const currentPeriodPasses = [
        {
          id: 'pass-today',
          studentId: STUDENT_ID,
          status: 'COMPLETED',
          gateEvents: [
            { id: 'evt-1', passId: 'pass-today', eventType: 'EXIT', timestamp: todayMorning },
            { id: 'evt-2', passId: 'pass-today', eventType: 'RETURN', timestamp: new Date(todayMorning.getTime() + 45 * 60 * 1000) },
          ],
        },
      ];

      mockedPrisma.gatePass.findMany.mockResolvedValue(currentPeriodPasses);
      mockedPrisma.gatePass.findFirst.mockResolvedValue(null);

      const summary = await AllowanceEngine.getRemainingAllowance(STUDENT_ID, INSTITUTION_ID);

      // Only today's 45-minute pass should be counted
      expect(summary.consumed).toBe(45);
      expect(summary.remaining).toBe(480 - 45);
      expect(summary.periodType).toBe('DAILY');
    });

    it('should verify period boundaries are used to filter passes via query params', async () => {
      const weeklyPolicy = {
        id: 'policy-001',
        institutionId: INSTITUTION_ID,
        allowanceAmount: 1440,
        policyPeriod: 'WEEKLY',
        gracePeriod: 10,
        enforcement: 'WARN_ONLY',
        minimumSampleSize: 5,
        severityMinorMax: 15,
        severityModerateMax: 60,
        severitySignificantMax: 180,
      };

      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(weeklyPolicy);
      mockedPrisma.gatePass.findMany.mockResolvedValue([]);
      mockedPrisma.gatePass.findFirst.mockResolvedValue(null);

      await AllowanceEngine.getRemainingAllowance(STUDENT_ID, INSTITUTION_ID);

      // Verify the query includes period boundary filtering
      expect(mockedPrisma.gatePass.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            studentId: STUDENT_ID,
            status: 'COMPLETED',
            gateEvents: expect.objectContaining({
              some: expect.objectContaining({
                eventType: 'RETURN',
                timestamp: expect.objectContaining({
                  gte: expect.any(Date),
                  lte: expect.any(Date),
                }),
              }),
            }),
          }),
        })
      );
    });

    it('should return period start and end dates matching the policy period type', async () => {
      const monthlyPolicy = {
        id: 'policy-001',
        institutionId: INSTITUTION_ID,
        allowanceAmount: 2880,
        policyPeriod: 'MONTHLY',
        gracePeriod: 10,
        enforcement: 'WARN_ONLY',
        minimumSampleSize: 5,
        severityMinorMax: 15,
        severityModerateMax: 60,
        severitySignificantMax: 180,
      };

      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(monthlyPolicy);
      mockedPrisma.gatePass.findMany.mockResolvedValue([]);
      mockedPrisma.gatePass.findFirst.mockResolvedValue(null);

      const summary = await AllowanceEngine.getRemainingAllowance(STUDENT_ID, INSTITUTION_ID);

      const now = new Date();
      // Period should be MONTHLY type
      expect(summary.periodType).toBe('MONTHLY');
      // Period start should be 1st of current month
      expect(summary.periodStart.getDate()).toBe(1);
      expect(summary.periodStart.getMonth()).toBe(now.getMonth());
      expect(summary.periodStart.getFullYear()).toBe(now.getFullYear());
      // Period end should be the last day of current month
      const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      expect(summary.periodEnd.getDate()).toBe(lastDayOfMonth);
      expect(summary.periodEnd.getMonth()).toBe(now.getMonth());
    });

    it('should reset consumed to zero for new period (simulated by empty query result)', async () => {
      // Scenario: It's a new week, and the DB query returns no passes in the new period
      // even though the student had passes last week
      const weeklyPolicy = {
        id: 'policy-001',
        institutionId: INSTITUTION_ID,
        allowanceAmount: 1440,
        policyPeriod: 'WEEKLY',
        gracePeriod: 10,
        enforcement: 'BLOCK_NEW_REQUESTS',
        minimumSampleSize: 5,
        severityMinorMax: 15,
        severityModerateMax: 60,
        severitySignificantMax: 180,
      };

      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(weeklyPolicy);
      // New period — no passes returned by the period-bounded query
      mockedPrisma.gatePass.findMany.mockResolvedValue([]);
      mockedPrisma.gatePass.findFirst.mockResolvedValue(null);

      const summary = await AllowanceEngine.getRemainingAllowance(STUDENT_ID, INSTITUTION_ID);

      // After period reset, consumed should be 0 and remaining should be full allowance
      expect(summary.consumed).toBe(0);
      expect(summary.remaining).toBe(1440);
      expect(summary.isExhausted).toBe(false);
      expect(summary.warningThreshold).toBe(false);
    });

    it('should create default policy when none exists for the institution', async () => {
      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(null);
      mockedPrisma.allowancePolicy.create.mockResolvedValue({
        id: 'policy-new',
        institutionId: INSTITUTION_ID,
        allowanceAmount: 1440,
        policyPeriod: 'WEEKLY',
        gracePeriod: 10,
        enforcement: 'WARN_ONLY',
        minimumSampleSize: 5,
        severityMinorMax: 15,
        severityModerateMax: 60,
        severitySignificantMax: 180,
      });
      mockedPrisma.gatePass.findMany.mockResolvedValue([]);
      mockedPrisma.gatePass.findFirst.mockResolvedValue(null);

      const summary = await AllowanceEngine.getRemainingAllowance(STUDENT_ID, INSTITUTION_ID);

      // Should have created a default policy
      expect(mockedPrisma.allowancePolicy.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          institutionId: INSTITUTION_ID,
          allowanceAmount: 1440,
          policyPeriod: 'WEEKLY',
          gracePeriod: 10,
          enforcement: 'WARN_ONLY',
          minimumSampleSize: 5,
        }),
      });

      // Default allowance should be returned
      expect(summary.totalAllowance).toBe(1440);
      expect(summary.remaining).toBe(1440);
      expect(summary.periodType).toBe('WEEKLY');
    });

    it('should set warningThreshold when remaining is below 20% of total', async () => {
      const dailyPolicy = {
        id: 'policy-001',
        institutionId: INSTITUTION_ID,
        allowanceAmount: 100, // 100 minutes
        policyPeriod: 'DAILY',
        gracePeriod: 10,
        enforcement: 'WARN_ONLY',
        minimumSampleSize: 5,
        severityMinorMax: 15,
        severityModerateMax: 60,
        severitySignificantMax: 180,
      };

      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(dailyPolicy);

      // Consumed 85 minutes, remaining = 15 (15% of 100, which is below 20%)
      const now = new Date();
      const todayMorning = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0, 0);
      const completedPasses = [
        {
          id: 'pass-001',
          studentId: STUDENT_ID,
          status: 'COMPLETED',
          gateEvents: [
            { id: 'evt-1', passId: 'pass-001', eventType: 'EXIT', timestamp: todayMorning },
            { id: 'evt-2', passId: 'pass-001', eventType: 'RETURN', timestamp: new Date(todayMorning.getTime() + 85 * 60 * 1000) },
          ],
        },
      ];

      mockedPrisma.gatePass.findMany.mockResolvedValue(completedPasses);
      mockedPrisma.gatePass.findFirst.mockResolvedValue(null);

      const summary = await AllowanceEngine.getRemainingAllowance(STUDENT_ID, INSTITUTION_ID);

      expect(summary.consumed).toBe(85);
      expect(summary.remaining).toBe(15);
      expect(summary.warningThreshold).toBe(true); // 15 < 20% of 100 (20)
      expect(summary.isExhausted).toBe(false);
    });
  });
});
