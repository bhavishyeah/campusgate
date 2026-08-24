import { prisma, PolicyPeriod, EnforcementMode } from "@campusgate/db";

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface SeverityThresholds {
  minorMax: number;
  moderateMax: number;
  significantMax: number;
}

export interface PolicyConfig {
  allowanceAmount: number;
  policyPeriod: PolicyPeriod;
  gracePeriod: number;
  enforcement: EnforcementMode;
  minimumSampleSize: number;
  severityThresholds: SeverityThresholds;
}

export interface AllowanceSummary {
  totalAllowance: number;
  consumed: number;
  remaining: number;
  periodType: PolicyPeriod;
  periodStart: Date;
  periodEnd: Date;
  isExhausted: boolean;
  warningThreshold: boolean;
  currentlyOutsideElapsed: number | null;
}

export interface EnforcementDecision {
  action: "allow" | "block" | "warn";
  message?: string;
  remainingAllowance: number;
}

// ─── AllowanceEngine ────────────────────────────────────────────────────────

export class AllowanceEngine {
  /**
   * Computes actual duration in minutes for a completed gate pass
   * by deriving from EXIT and RETURN GateEvent timestamps.
   *
   * Returns null if the pass has no matching EXIT or RETURN event.
   *
   * Requirements: 1.1, 1.2, 1.3
   */
  static async computeActualDuration(passId: string): Promise<number | null> {
    const gateEvents = await prisma.gateEvent.findMany({
      where: { passId },
      orderBy: { timestamp: "asc" },
    });

    const exitEvent = gateEvents.find((e) => e.eventType === "EXIT");
    const returnEvent = gateEvents.find((e) => e.eventType === "RETURN");

    if (!exitEvent || !returnEvent) {
      // Req 1.3: exclude passes with missing events, log warning
      console.warn(
        `[AllowanceEngine] Pass ${passId} missing EXIT or RETURN GateEvent — excluded from duration calculation`
      );
      return null;
    }

    return Math.floor(
      (returnEvent.timestamp.getTime() - exitEvent.timestamp.getTime()) /
        (1000 * 60)
    );
  }

  /**
   * Computes period start and end dates for a given PolicyPeriod type
   * relative to a reference date.
   *
   * - DAILY: midnight to end of day (23:59:59.999)
   * - WEEKLY: Monday 00:00:00.000 to Sunday 23:59:59.999
   * - MONTHLY: 1st of month to last day of month (23:59:59.999)
   * - SEMESTER: Jan 1–Jun 30 or Jul 1–Dec 31
   *
   * Requirements: 2.4, 6.4
   */
  static getPeriodBounds(
    periodType: PolicyPeriod,
    referenceDate: Date
  ): { start: Date; end: Date } {
    const ref = new Date(referenceDate);

    switch (periodType) {
      case "DAILY": {
        const dayStart = new Date(
          ref.getFullYear(),
          ref.getMonth(),
          ref.getDate(),
          0,
          0,
          0,
          0
        );
        const dayEnd = new Date(
          ref.getFullYear(),
          ref.getMonth(),
          ref.getDate(),
          23,
          59,
          59,
          999
        );
        return { start: dayStart, end: dayEnd };
      }

      case "WEEKLY": {
        const dayOfWeek = ref.getDay(); // 0 = Sunday, 1 = Monday, ...
        // Compute offset to Monday (week start)
        const offsetToMonday = (dayOfWeek + 6) % 7;
        const monday = new Date(
          ref.getFullYear(),
          ref.getMonth(),
          ref.getDate() - offsetToMonday,
          0,
          0,
          0,
          0
        );
        const sundayEnd = new Date(
          monday.getFullYear(),
          monday.getMonth(),
          monday.getDate() + 6,
          23,
          59,
          59,
          999
        );
        return { start: monday, end: sundayEnd };
      }

      case "MONTHLY": {
        const monthStart = new Date(
          ref.getFullYear(),
          ref.getMonth(),
          1,
          0,
          0,
          0,
          0
        );
        // Day 0 of next month = last day of current month
        const monthEnd = new Date(
          ref.getFullYear(),
          ref.getMonth() + 1,
          0,
          23,
          59,
          59,
          999
        );
        return { start: monthStart, end: monthEnd };
      }

      case "SEMESTER": {
        // Semesters: Jan–Jun (months 0–5) and Jul–Dec (months 6–11)
        if (ref.getMonth() < 6) {
          const semStart = new Date(ref.getFullYear(), 0, 1, 0, 0, 0, 0);
          const semEnd = new Date(ref.getFullYear(), 5, 30, 23, 59, 59, 999);
          return { start: semStart, end: semEnd };
        } else {
          const semStart = new Date(ref.getFullYear(), 6, 1, 0, 0, 0, 0);
          const semEnd = new Date(ref.getFullYear(), 11, 31, 23, 59, 59, 999);
          return { start: semStart, end: semEnd };
        }
      }
    }
  }

  /**
   * Returns the existing AllowancePolicy for an institution,
   * or creates one with default values if none exists.
   *
   * Defaults (Req 3.5):
   * - allowanceAmount: 1440 (24 hours)
   * - policyPeriod: WEEKLY
   * - gracePeriod: 10 minutes
   * - enforcement: WARN_ONLY
   * - minimumSampleSize: 5
   * - severityMinorMax: 15, severityModerateMax: 60, severitySignificantMax: 180
   *
   * Requirements: 3.5
   */
  static async getOrCreatePolicy(institutionId: string): Promise<PolicyConfig> {
    let policy = await prisma.allowancePolicy.findUnique({
      where: { institutionId },
    });

    if (!policy) {
      policy = await prisma.allowancePolicy.create({
        data: {
          institutionId,
          allowanceAmount: 1440,
          policyPeriod: "WEEKLY",
          gracePeriod: 10,
          enforcement: "WARN_ONLY",
          minimumSampleSize: 5,
          severityMinorMax: 15,
          severityModerateMax: 60,
          severitySignificantMax: 180,
        },
      });
    }

    return {
      allowanceAmount: policy.allowanceAmount,
      policyPeriod: policy.policyPeriod,
      gracePeriod: policy.gracePeriod,
      enforcement: policy.enforcement,
      minimumSampleSize: policy.minimumSampleSize,
      severityThresholds: {
        minorMax: policy.severityMinorMax,
        moderateMax: policy.severityModerateMax,
        significantMax: policy.severitySignificantMax,
      },
    };
  }

  /**
   * Computes the remaining allowance for a student in the current policy period.
   *
   * Algorithm:
   * 1. Get policy for institution
   * 2. Compute period boundaries from policy period type
   * 3. Query all COMPLETED gate passes where a RETURN GateEvent falls within period
   * 4. For each pass, find EXIT/RETURN events and sum durations (skip if either missing)
   * 5. Check if student is currently OUTSIDE — if so, add elapsed time since EXIT
   * 6. remaining = max(0, allowanceAmount - consumed)
   * 7. Return AllowanceSummary
   *
   * Requirements: 2.1, 2.2, 2.3, 2.4
   */
  static async getRemainingAllowance(
    studentId: string,
    institutionId: string
  ): Promise<AllowanceSummary> {
    // 1. Get policy for institution
    const policy = await AllowanceEngine.getOrCreatePolicy(institutionId);

    // 2. Compute period boundaries
    const { start, end } = AllowanceEngine.getPeriodBounds(
      policy.policyPeriod,
      new Date()
    );

    // 3. Query all COMPLETED passes for student where a RETURN event falls within period
    const completedPasses = await prisma.gatePass.findMany({
      where: {
        studentId,
        status: "COMPLETED",
        gateEvents: {
          some: {
            eventType: "RETURN",
            timestamp: { gte: start, lte: end },
          },
        },
      },
      include: { gateEvents: true },
    });

    // 4. Sum actual durations from GateEvent pairs
    let consumed = 0;
    for (const pass of completedPasses) {
      const exitEvent = pass.gateEvents.find((e) => e.eventType === "EXIT");
      const returnEvent = pass.gateEvents.find((e) => e.eventType === "RETURN");

      if (exitEvent && returnEvent) {
        const duration = Math.floor(
          (returnEvent.timestamp.getTime() - exitEvent.timestamp.getTime()) /
            (1000 * 60)
        );
        consumed += duration;
      } else {
        // Req 1.3: exclude passes with missing events, log warning
        console.warn(
          `[AllowanceEngine] Pass ${pass.id} missing EXIT or RETURN GateEvent — excluded from allowance calculation`
        );
      }
    }

    // 5. Include in-progress elapsed time if student is currently OUTSIDE
    let currentlyOutsideElapsed: number | null = null;
    const outsidePass = await prisma.gatePass.findFirst({
      where: { studentId, status: "OUTSIDE" },
      include: { gateEvents: true },
    });

    if (outsidePass) {
      const exitEvent = outsidePass.gateEvents.find(
        (e) => e.eventType === "EXIT"
      );
      if (exitEvent) {
        currentlyOutsideElapsed = Math.floor(
          (Date.now() - exitEvent.timestamp.getTime()) / (1000 * 60)
        );
        consumed += currentlyOutsideElapsed;
      }
    }

    // 6. remaining = max(0, allowanceAmount - consumed)
    const remaining = Math.max(0, policy.allowanceAmount - consumed);

    // 7. Return AllowanceSummary
    return {
      totalAllowance: policy.allowanceAmount,
      consumed,
      remaining,
      periodType: policy.policyPeriod,
      periodStart: start,
      periodEnd: end,
      isExhausted: remaining <= 0,
      warningThreshold: remaining < policy.allowanceAmount * 0.2,
      currentlyOutsideElapsed,
    };
  }

  /**
   * Determines enforcement action based on remaining allowance and policy mode.
   *
   * Decision logic:
   * - If remaining > 0: allow (no restrictions)
   * - If remaining <= 0 and enforcement is BLOCK_NEW_REQUESTS: block
   * - If remaining <= 0 and enforcement is WARN_ONLY: warn
   *
   * Requirements: 4.1, 4.2, 4.3
   */
  static async getEnforcementDecision(
    studentId: string,
    institutionId: string
  ): Promise<EnforcementDecision> {
    // 1. Get the allowance summary
    const summary = await AllowanceEngine.getRemainingAllowance(
      studentId,
      institutionId
    );

    // 2. If remaining > 0: allow
    if (summary.remaining > 0) {
      return { action: "allow", remainingAllowance: summary.remaining };
    }

    // 3. Get the policy to check enforcement mode
    const policy = await AllowanceEngine.getOrCreatePolicy(institutionId);

    // 4. If remaining <= 0 and enforcement is BLOCK_NEW_REQUESTS: block
    if (policy.enforcement === "BLOCK_NEW_REQUESTS") {
      return {
        action: "block",
        message:
          "Your outside-time allowance for this period is exhausted. Contact your HOD for an emergency override.",
        remainingAllowance: summary.remaining,
      };
    }

    // 5. If remaining <= 0 and enforcement is WARN_ONLY: warn
    return {
      action: "warn",
      message:
        "Student has exhausted their outside-time allowance for this period.",
      remainingAllowance: summary.remaining,
    };
  }
}
