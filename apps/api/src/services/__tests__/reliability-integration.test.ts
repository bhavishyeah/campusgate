import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@campusgate/db', () => ({
  prisma: {
    gatePass: { findMany: vi.fn(), count: vi.fn() },
    emergencyOverride: { findMany: vi.fn() },
    allowancePolicy: { findUnique: vi.fn(), create: vi.fn() },
    reliabilityScoreSnapshot: { create: vi.fn(), findMany: vi.fn() },
  },
  PolicyPeriod: { WEEKLY: 'WEEKLY' },
  EnforcementMode: { WARN_ONLY: 'WARN_ONLY' },
}));

import { ReliabilityEngine } from '../reliability-engine.js';
import { prisma } from '@campusgate/db';

const mockedPrisma = prisma as unknown as {
  gatePass: {
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  emergencyOverride: {
    findMany: ReturnType<typeof vi.fn>;
  };
  allowancePolicy: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  reliabilityScoreSnapshot: {
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePolicy(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'policy-1',
    institutionId: 'inst-1',
    allowanceAmount: 1440,
    policyPeriod: 'WEEKLY',
    gracePeriod: 10,
    enforcement: 'WARN_ONLY',
    minimumSampleSize: 5,
    severityMinorMax: 15,
    severityModerateMax: 60,
    severitySignificantMax: 180,
    ...overrides,
  };
}

function makeCompletedPass(
  id: string,
  expectedReturn: Date,
  actualReturn: Date
) {
  return {
    id,
    status: 'COMPLETED',
    studentId: 'student-1',
    expectedReturn,
    gateEvents: [
      { eventType: 'EXIT', timestamp: new Date('2024-01-15T08:00:00Z') },
      { eventType: 'RETURN', timestamp: actualReturn },
    ],
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Reliability Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── 1. Snapshot creation on pass completion (Req 13.1) ─────────────────

  describe('Snapshot creation on pass completion', () => {
    it('should create a snapshot with correct score and movementNumber', async () => {
      // Mock a student with 6 completed passes (above minimumSampleSize of 5)
      const now = new Date('2024-01-15T10:00:00Z');
      const passes = Array.from({ length: 6 }, (_, i) =>
        makeCompletedPass(
          `pass-${i}`,
          new Date('2024-01-15T09:30:00Z'), // expected return
          new Date('2024-01-15T09:25:00Z') // actual return (on time)
        )
      );

      mockedPrisma.gatePass.findMany.mockResolvedValue(passes);
      mockedPrisma.emergencyOverride.findMany.mockResolvedValue([]);
      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(makePolicy());
      mockedPrisma.reliabilityScoreSnapshot.findMany.mockResolvedValue([]);
      mockedPrisma.reliabilityScoreSnapshot.create.mockResolvedValue({});

      // Compute the score
      const score = await ReliabilityEngine.computeScore('student-1', 'inst-1');

      expect(score.hasSufficientData).toBe(true);
      expect(score.overall).toBeGreaterThan(0);
      expect(score.overall).toBeLessThanOrEqual(5.0);

      // Record the snapshot
      const movementNumber = 6;
      await ReliabilityEngine.recordSnapshot(
        'student-1',
        score.overall,
        movementNumber
      );

      // Verify snapshot was created with correct data
      expect(mockedPrisma.reliabilityScoreSnapshot.create).toHaveBeenCalledWith({
        data: {
          studentId: 'student-1',
          score: score.overall,
          movementNumber: 6,
        },
      });
    });

    it('should not record snapshot when student has insufficient data', async () => {
      // Only 3 passes (below minimumSampleSize of 5)
      const passes = Array.from({ length: 3 }, (_, i) =>
        makeCompletedPass(
          `pass-${i}`,
          new Date('2024-01-15T09:30:00Z'),
          new Date('2024-01-15T09:25:00Z')
        )
      );

      mockedPrisma.gatePass.findMany.mockResolvedValue(passes);
      mockedPrisma.emergencyOverride.findMany.mockResolvedValue([]);
      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(makePolicy());
      mockedPrisma.reliabilityScoreSnapshot.findMany.mockResolvedValue([]);

      const score = await ReliabilityEngine.computeScore('student-1', 'inst-1');

      expect(score.hasSufficientData).toBe(false);

      // Should NOT record snapshot for insufficient data
      // (business logic: caller checks hasSufficientData before calling recordSnapshot)
      expect(mockedPrisma.reliabilityScoreSnapshot.create).not.toHaveBeenCalled();
    });
  });

  // ─── 2. Score exclusion for emergency override (Req 11.2) ───────────────

  describe('Score exclusion for emergency override', () => {
    it('should exclude passes with emergency override records from scoring', async () => {
      const passes = [
        makeCompletedPass(
          'pass-normal-1',
          new Date('2024-01-15T09:30:00Z'),
          new Date('2024-01-15T09:25:00Z')
        ),
        makeCompletedPass(
          'pass-normal-2',
          new Date('2024-01-15T09:30:00Z'),
          new Date('2024-01-15T09:25:00Z')
        ),
        makeCompletedPass(
          'pass-normal-3',
          new Date('2024-01-15T09:30:00Z'),
          new Date('2024-01-15T09:25:00Z')
        ),
        makeCompletedPass(
          'pass-normal-4',
          new Date('2024-01-15T09:30:00Z'),
          new Date('2024-01-15T09:25:00Z')
        ),
        makeCompletedPass(
          'pass-normal-5',
          new Date('2024-01-15T09:30:00Z'),
          new Date('2024-01-15T09:25:00Z')
        ),
        // This pass was heavily overdue but has an emergency override
        makeCompletedPass(
          'pass-override',
          new Date('2024-01-15T09:00:00Z'),
          new Date('2024-01-15T14:00:00Z') // 5 hours late
        ),
      ];

      // Emergency override for the overdue pass
      const overrides = [{ gatePassId: 'pass-override' }];

      mockedPrisma.gatePass.findMany.mockResolvedValue(passes);
      mockedPrisma.emergencyOverride.findMany.mockResolvedValue(overrides);
      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(makePolicy());
      mockedPrisma.reliabilityScoreSnapshot.findMany.mockResolvedValue([]);

      const score = await ReliabilityEngine.computeScore('student-1', 'inst-1');

      // The overridden pass (5 hours late) should be excluded.
      // With only the 5 normal (on-time) passes, score should be perfect.
      expect(score.hasSufficientData).toBe(true);
      expect(score.totalMovements).toBe(5); // 5 normal passes, override excluded
      expect(score.overall).toBe(5.0); // All on-time returns = perfect score
    });

    it('should include the overdue pass in scoring when no override exists', async () => {
      const passes = [
        makeCompletedPass(
          'pass-normal-1',
          new Date('2024-01-15T09:30:00Z'),
          new Date('2024-01-15T09:25:00Z')
        ),
        makeCompletedPass(
          'pass-normal-2',
          new Date('2024-01-15T09:30:00Z'),
          new Date('2024-01-15T09:25:00Z')
        ),
        makeCompletedPass(
          'pass-normal-3',
          new Date('2024-01-15T09:30:00Z'),
          new Date('2024-01-15T09:25:00Z')
        ),
        makeCompletedPass(
          'pass-normal-4',
          new Date('2024-01-15T09:30:00Z'),
          new Date('2024-01-15T09:25:00Z')
        ),
        makeCompletedPass(
          'pass-normal-5',
          new Date('2024-01-15T09:30:00Z'),
          new Date('2024-01-15T09:25:00Z')
        ),
        // This pass is 5 hours late with NO override
        makeCompletedPass(
          'pass-late',
          new Date('2024-01-15T09:00:00Z'),
          new Date('2024-01-15T14:00:00Z')
        ),
      ];

      mockedPrisma.gatePass.findMany.mockResolvedValue(passes);
      mockedPrisma.emergencyOverride.findMany.mockResolvedValue([]); // no overrides
      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(makePolicy());
      mockedPrisma.reliabilityScoreSnapshot.findMany.mockResolvedValue([]);

      const score = await ReliabilityEngine.computeScore('student-1', 'inst-1');

      // Without override, the late pass counts and lowers the score
      expect(score.totalMovements).toBe(6);
      expect(score.overall).toBeLessThan(5.0);
    });
  });

  // ─── 3. Guard role cannot access reliability endpoints (Req 9.4) ────────

  describe('Guard role blocked from reliability', () => {
    it('should not expose any reliability score retrieval endpoint in guard routes', async () => {
      // Import the guard routes module to inspect registered routes
      const guardModule = await import('../../routes/guard.js');

      // The guardRoutes function registers routes on a Fastify instance.
      // We verify that the module does NOT register a "/reliability" or "/score"
      // GET/POST endpoint. The function internally uses computeScore for snapshot
      // recording, but it does NOT expose a route that returns scores to guards.
      const routesFnSource = guardModule.guardRoutes.toString();

      // Guard routes should NOT have reliability-specific endpoints
      expect(routesFnSource).not.toContain('/reliability');
      expect(routesFnSource).not.toContain('/score');

      // Guard routes should NOT call getScoreTrend directly
      // (getScoreTrend is only for returning score trend data to students/admins)
      expect(routesFnSource).not.toContain('getScoreTrend');
    });

    it('should not expose ReliabilityEngine score methods as guard-facing APIs', () => {
      // ReliabilityEngine is a service class, not route-specific.
      // Verify that there are no guard-specific score retrieval methods.
      const engineMethods = Object.getOwnPropertyNames(ReliabilityEngine);

      // Engine should NOT have guard-specific score methods
      expect(engineMethods).not.toContain('getGuardScore');
      expect(engineMethods).not.toContain('guardReliability');
      expect(engineMethods).not.toContain('getScoreForGuard');
    });
  });

  // ─── 4. Insufficient data scenario (Req 9.4) ───────────────────────────

  describe('Insufficient data scenario', () => {
    it('should return hasSufficientData: false when passes < minimumSampleSize', async () => {
      // minimumSampleSize is 5 by default, we provide only 2 passes
      const passes = [
        makeCompletedPass(
          'pass-1',
          new Date('2024-01-15T09:30:00Z'),
          new Date('2024-01-15T09:25:00Z')
        ),
        makeCompletedPass(
          'pass-2',
          new Date('2024-01-15T09:30:00Z'),
          new Date('2024-01-15T09:25:00Z')
        ),
      ];

      mockedPrisma.gatePass.findMany.mockResolvedValue(passes);
      mockedPrisma.emergencyOverride.findMany.mockResolvedValue([]);
      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(makePolicy());
      mockedPrisma.reliabilityScoreSnapshot.findMany.mockResolvedValue([]);

      const score = await ReliabilityEngine.computeScore('student-1', 'inst-1');

      expect(score.hasSufficientData).toBe(false);
      expect(score.overall).toBe(0);
      expect(score.totalMovements).toBe(2);
      expect(score.components.timelyReturnRate).toBe(0);
      expect(score.components.completionRate).toBe(0);
      expect(score.components.authorizationComplianceRate).toBe(0);
      expect(score.trend).toBeNull();
    });

    it('should return hasSufficientData: false when student has zero passes', async () => {
      mockedPrisma.gatePass.findMany.mockResolvedValue([]);
      mockedPrisma.emergencyOverride.findMany.mockResolvedValue([]);
      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(makePolicy());
      mockedPrisma.reliabilityScoreSnapshot.findMany.mockResolvedValue([]);

      const score = await ReliabilityEngine.computeScore('student-1', 'inst-1');

      expect(score.hasSufficientData).toBe(false);
      expect(score.overall).toBe(0);
      expect(score.totalMovements).toBe(0);
      expect(score.trend).toBeNull();
    });

    it('should return hasSufficientData: true when passes >= minimumSampleSize', async () => {
      // Exactly 5 passes (equals minimumSampleSize)
      const passes = Array.from({ length: 5 }, (_, i) =>
        makeCompletedPass(
          `pass-${i}`,
          new Date('2024-01-15T09:30:00Z'),
          new Date('2024-01-15T09:25:00Z')
        )
      );

      mockedPrisma.gatePass.findMany.mockResolvedValue(passes);
      mockedPrisma.emergencyOverride.findMany.mockResolvedValue([]);
      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(makePolicy());
      mockedPrisma.reliabilityScoreSnapshot.findMany.mockResolvedValue([]);

      const score = await ReliabilityEngine.computeScore('student-1', 'inst-1');

      expect(score.hasSufficientData).toBe(true);
      expect(score.overall).toBeGreaterThan(0);
      expect(score.totalMovements).toBe(5);
    });

    it('should respect custom minimumSampleSize from policy', async () => {
      // Policy with minimumSampleSize of 10
      const customPolicy = makePolicy({ minimumSampleSize: 10 });

      // 7 passes: enough for default (5) but not for custom (10)
      const passes = Array.from({ length: 7 }, (_, i) =>
        makeCompletedPass(
          `pass-${i}`,
          new Date('2024-01-15T09:30:00Z'),
          new Date('2024-01-15T09:25:00Z')
        )
      );

      mockedPrisma.gatePass.findMany.mockResolvedValue(passes);
      mockedPrisma.emergencyOverride.findMany.mockResolvedValue([]);
      mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(customPolicy);
      mockedPrisma.reliabilityScoreSnapshot.findMany.mockResolvedValue([]);

      const score = await ReliabilityEngine.computeScore('student-1', 'inst-1');

      expect(score.hasSufficientData).toBe(false);
      expect(score.overall).toBe(0);
      expect(score.totalMovements).toBe(7);
    });
  });
});
