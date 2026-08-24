import { prisma } from "@campusgate/db";
import { AllowanceEngine } from "./allowance-engine.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type SeverityLevel = "MINOR" | "MODERATE" | "SIGNIFICANT" | "SEVERE";

export interface SeverityThresholds {
  severityMinorMax: number; // default: 15
  severityModerateMax: number; // default: 60
  severitySignificantMax: number; // default: 180
}

export interface Movement {
  actualReturn: Date;
  expectedReturn: Date;
  hasViolation?: boolean;
}

export interface PassForCompletion {
  status: string;
}

export interface ScoreTrend {
  snapshots: Array<{ score: number; date: Date; movementNumber: number }>;
  improvementIndicator: boolean;
}

export interface ReliabilityScore {
  overall: number; // 0.0–5.0, 1 decimal place
  components: {
    timelyReturnRate: number; // 0.0–1.0
    completionRate: number; // 0.0–1.0
    authorizationComplianceRate: number; // 0.0–1.0
  };
  totalMovements: number;
  hasSufficientData: boolean;
  trend: ScoreTrend | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const SEVERITY_DEDUCTIONS: Record<SeverityLevel, number> = {
  MINOR: 0.25,
  MODERATE: 0.5,
  SIGNIFICANT: 0.75,
  SEVERE: 1.0,
};

const TERMINAL_STATUSES = ["COMPLETED", "EXPIRED", "REVOKED"];

// ─── ReliabilityEngine ──────────────────────────────────────────────────────

export class ReliabilityEngine {
  /**
   * Classifies a late return into a severity level based on how many minutes
   * past the grace period the student returned.
   *
   * Returns null if the student was not late (overdueMinutes <= 0).
   *
   * Requirements: 10.1, 10.2, 10.3, 10.4
   */
  static classifySeverity(
    overdueMinutes: number,
    thresholds: SeverityThresholds
  ): SeverityLevel | null {
    if (overdueMinutes <= 0) return null;
    if (overdueMinutes <= thresholds.severityMinorMax) return "MINOR";
    if (overdueMinutes <= thresholds.severityModerateMax) return "MODERATE";
    if (overdueMinutes <= thresholds.severitySignificantMax)
      return "SIGNIFICANT";
    return "SEVERE";
  }

  /**
   * Computes the timely return rate using severity-weighted deductions.
   *
   * For each movement, calculates overdueMinutes as:
   *   max(0, floor((actualReturn - expectedReturn) / 60000) - gracePeriod)
   *
   * If overdueMinutes > 0, the severity deduction for that level is applied.
   * The rate is: max(0, min(1, 1 - (totalDeductions / movements.length)))
   *
   * Returns 1.0 if no movements exist.
   *
   * Requirements: 8.3, 10.5
   */
  static computeTimelyReturnRate(
    movements: Movement[],
    gracePeriod: number,
    thresholds: SeverityThresholds
  ): number {
    if (movements.length === 0) return 1.0;

    let totalDeductions = 0;

    for (const m of movements) {
      const diffMinutes = Math.floor(
        (m.actualReturn.getTime() - m.expectedReturn.getTime()) / (1000 * 60)
      );
      const overdueMinutes = Math.max(0, diffMinutes - gracePeriod);

      if (overdueMinutes > 0) {
        const severity = ReliabilityEngine.classifySeverity(
          overdueMinutes,
          thresholds
        );
        if (severity !== null) {
          totalDeductions += SEVERITY_DEDUCTIONS[severity];
        }
      }
    }

    return Math.max(0, Math.min(1, 1 - totalDeductions / movements.length));
  }

  /**
   * Computes the completion rate from passes in terminal states.
   *
   * Terminal statuses are: COMPLETED, EXPIRED, REVOKED.
   * Rate = count(COMPLETED) / count(terminal).
   * Returns 1.0 if no terminal passes exist.
   *
   * Requirements: 8.4
   */
  static computeCompletionRate(passes: PassForCompletion[]): number {
    const terminal = passes.filter((p) =>
      TERMINAL_STATUSES.includes(p.status)
    );
    if (terminal.length === 0) return 1.0;

    const completed = terminal.filter((p) => p.status === "COMPLETED").length;
    return completed / terminal.length;
  }

  /**
   * Computes the authorization compliance rate.
   *
   * Rate = count(movements without violations) / total movements.
   * Returns 1.0 if no movements exist.
   *
   * Requirements: 8.5
   */
  static computeComplianceRate(movements: Movement[]): number {
    if (movements.length === 0) return 1.0;

    const compliant = movements.filter((m) => !m.hasViolation).length;
    return compliant / movements.length;
  }

  // ─── Exclusion Filtering ──────────────────────────────────────────────────

  /**
   * Filters gate passes for scoring by excluding:
   * - Non-terminal passes (only COMPLETED, EXPIRED, REVOKED included)
   * - Passes with emergency overrides (Req 11.2)
   * - Passes with documented system failures (Req 11.3)
   *
   * HOD rejections are implicitly excluded since rejected passes
   * never reach terminal status (Req 11.1).
   *
   * Requirements: 11.1, 11.2, 11.3, 11.4
   */
  static filterMovementsForScoring(
    passes: Array<{ id: string; status: string }>,
    overrides: Array<{ gatePassId: string }>
  ): Array<{ id: string; status: string }> {
    const overridePassIds = new Set(overrides.map((o) => o.gatePassId));

    return passes.filter((pass) => {
      // Only terminal statuses (Req 11.4)
      if (!TERMINAL_STATUSES.includes(pass.status)) return false;
      // Exclude emergency overrides (Req 11.2)
      if (overridePassIds.has(pass.id)) return false;
      // TODO: Check for system failure flag when schema supports it (Req 11.3)
      // Currently the schema doesn't have a dedicated systemFailureFlag field.
      // This can be enhanced later to check audit log metadata for system failure indicators.
      return true;
    });
  }

  // ─── Score Computation ──────────────────────────────────────────────────

  /**
   * Computes the full reliability score for a student.
   *
   * Algorithm:
   * 1. Get all gate passes for student that reached terminal status
   * 2. Get emergency override records for those passes
   * 3. Filter passes using filterMovementsForScoring
   * 4. Get AllowancePolicy for institution (for gracePeriod and thresholds)
   * 5. Build Movement objects from GateEvent pairs (EXIT/RETURN)
   * 6. Compute three rates
   * 7. Apply weighted formula: overall = round((0.6*TR + 0.2*CR + 0.2*ACR) * 5.0, 1)
   * 8. Get trend data
   * 9. Return ReliabilityScore
   *
   * Requirements: 8.1, 8.2, 11.1, 11.2, 11.3, 11.4
   */
  static async computeScore(
    studentId: string,
    institutionId: string
  ): Promise<ReliabilityScore> {
    // 1. Get all terminal gate passes for student with their events
    const allPasses = await prisma.gatePass.findMany({
      where: {
        studentId,
        status: { in: ["COMPLETED", "EXPIRED", "REVOKED"] },
      },
      include: { gateEvents: true },
    });

    // 2. Get emergency override records for this student's passes
    const overrides = await prisma.emergencyOverride.findMany({
      where: {
        gatePass: { studentId },
      },
    });

    // 3. Filter passes using exclusion rules
    const scoringPasses = ReliabilityEngine.filterMovementsForScoring(
      allPasses,
      overrides
    );
    const scoringPassIds = new Set(scoringPasses.map((p) => p.id));

    // 4. Get policy config for grace period and severity thresholds
    const policy = await AllowanceEngine.getOrCreatePolicy(institutionId);

    // 5. Build Movement objects from GateEvent pairs
    const movements: Movement[] = [];
    for (const pass of allPasses) {
      if (!scoringPassIds.has(pass.id)) continue;

      const exitEvent = pass.gateEvents.find((e) => e.eventType === "EXIT");
      const returnEvent = pass.gateEvents.find((e) => e.eventType === "RETURN");

      if (exitEvent && returnEvent) {
        movements.push({
          actualReturn: returnEvent.timestamp,
          expectedReturn: pass.expectedReturn,
          // Since there's no dedicated violation field on GatePass,
          // treat all movements as compliant for now. Can be enhanced later.
          hasViolation: false,
        });
      }
    }

    // Check minimum sample size
    const hasSufficientData = movements.length >= policy.minimumSampleSize;

    if (!hasSufficientData) {
      return {
        overall: 0,
        components: {
          timelyReturnRate: 0,
          completionRate: 0,
          authorizationComplianceRate: 0,
        },
        totalMovements: movements.length,
        hasSufficientData: false,
        trend: null,
      };
    }

    // 6. Compute three rates
    const thresholds: SeverityThresholds = {
      severityMinorMax: policy.severityThresholds.minorMax,
      severityModerateMax: policy.severityThresholds.moderateMax,
      severitySignificantMax: policy.severityThresholds.significantMax,
    };

    const timelyReturnRate = ReliabilityEngine.computeTimelyReturnRate(
      movements,
      policy.gracePeriod,
      thresholds
    );
    const completionRate = ReliabilityEngine.computeCompletionRate(
      scoringPasses as PassForCompletion[]
    );
    const authorizationComplianceRate =
      ReliabilityEngine.computeComplianceRate(movements);

    // 7. Apply weighted formula: overall = round((0.6*TR + 0.2*CR + 0.2*ACR) * 5.0, 1)
    const raw =
      0.6 * timelyReturnRate +
      0.2 * completionRate +
      0.2 * authorizationComplianceRate;
    const scaled = raw * 5.0;
    const overall = Math.min(
      5.0,
      Math.max(0.0, Math.round(scaled * 10) / 10)
    );

    // 8. Get trend data
    const trend = await ReliabilityEngine.getScoreTrend(studentId);

    // 9. Return ReliabilityScore
    return {
      overall,
      components: {
        timelyReturnRate,
        completionRate,
        authorizationComplianceRate,
      },
      totalMovements: movements.length,
      hasSufficientData: true,
      trend,
    };
  }

  // ─── Snapshot Recording ─────────────────────────────────────────────────

  /**
   * Records a reliability score snapshot after a movement is completed.
   * Creates a ReliabilityScoreSnapshot record in the database.
   *
   * Requirements: 13.1
   */
  static async recordSnapshot(
    studentId: string,
    score: number,
    movementNumber: number
  ): Promise<void> {
    await prisma.reliabilityScoreSnapshot.create({
      data: {
        studentId,
        score,
        movementNumber,
      },
    });
  }

  // ─── Score Trend ────────────────────────────────────────────────────────

  /**
   * Returns the score trend (last N snapshots) for a student.
   *
   * Queries last N snapshots (default 30) ordered by computedAt desc.
   * Checks improvement: if snapshots.length >= 11, compare current score
   * to the score from 10 snapshots ago — indicator is true if difference >= 0.5.
   *
   * Requirements: 13.1, 13.2, 13.3
   */
  static async getScoreTrend(
    studentId: string,
    limit: number = 30
  ): Promise<ScoreTrend> {
    const snapshots = await prisma.reliabilityScoreSnapshot.findMany({
      where: { studentId },
      orderBy: { computedAt: "desc" },
      take: limit,
    });

    // Reverse to get chronological order for trend display
    const chronological = snapshots.reverse();

    // Check improvement indicator: compare current to 10th ago
    let improvementIndicator = false;
    if (chronological.length >= 11) {
      const currentScore = chronological[chronological.length - 1].score;
      const tenthAgoScore =
        chronological[chronological.length - 11].score;
      improvementIndicator = currentScore - tenthAgoScore >= 0.5;
    }

    return {
      snapshots: chronological.map((s) => ({
        score: s.score,
        date: s.computedAt,
        movementNumber: s.movementNumber,
      })),
      improvementIndicator,
    };
  }
}
