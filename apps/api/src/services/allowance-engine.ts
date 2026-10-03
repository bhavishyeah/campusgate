import { prisma, PolicyPeriod, EnforcementMode, WeekStartDay, AcademicDayType } from "@campusgate/db";

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

export interface InstitutionConfig {
  timezone: string;
  weekStartDay: WeekStartDay;
  workingDaysOfWeek: number[];
  lowAllowanceThresholdMinutes: number;
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

const WORKING_DAY_TYPES = new Set<AcademicDayType>([
  "WORKING_DAY",
  "SPECIAL_WORKING_DAY",
  "EXAM_DAY",
  "INSTITUTION_EVENT",
]);

const NON_WORKING_DAY_TYPES = new Set<AcademicDayType>([
  "HOLIDAY",
  "WEEKEND",
  "VACATION",
]);

// ─── AllowanceEngine ────────────────────────────────────────────────────────

export class AllowanceEngine {
  /**
   * Computes actual duration in minutes for a completed gate pass
   * by deriving from EXIT and RETURN GateEvent timestamps.
   */
  static async computeActualDuration(passId: string): Promise<number | null> {
    const gateEvents = await prisma.gateEvent.findMany({
      where: { passId },
      orderBy: { timestamp: "asc" },
    });

    const exitEvent = gateEvents.find((e) => e.eventType === "EXIT");
    const returnEvent = gateEvents.find((e) => e.eventType === "RETURN");

    if (!exitEvent || !returnEvent) {
      console.warn(
        `[AllowanceEngine] Pass ${passId} missing EXIT or RETURN GateEvent — excluded from duration calculation`
      );
      return null;
    }

    return Math.floor(
      (returnEvent.timestamp.getTime() - exitEvent.timestamp.getTime()) / (1000 * 60)
    );
  }

  static getPeriodBounds(
    periodType: PolicyPeriod,
    referenceDate: Date
  ): { start: Date; end: Date } {
    const ref = new Date(referenceDate);

    switch (periodType) {
      case "DAILY": {
        const dayStart = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 0, 0, 0, 0);
        const dayEnd = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 23, 59, 59, 999);
        return { start: dayStart, end: dayEnd };
      }

      case "WEEKLY": {
        const dayOfWeek = ref.getDay();
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
        const monthStart = new Date(ref.getFullYear(), ref.getMonth(), 1, 0, 0, 0, 0);
        const monthEnd = new Date(ref.getFullYear(), ref.getMonth() + 1, 0, 23, 59, 59, 999);
        return { start: monthStart, end: monthEnd };
      }

      case "SEMESTER": {
        if (ref.getMonth() < 6) {
          const semStart = new Date(ref.getFullYear(), 0, 1, 0, 0, 0, 0);
          const semEnd = new Date(ref.getFullYear(), 5, 30, 23, 59, 59, 999);
          return { start: semStart, end: semEnd };
        }

        const semStart = new Date(ref.getFullYear(), 6, 1, 0, 0, 0, 0);
        const semEnd = new Date(ref.getFullYear(), 11, 31, 23, 59, 59, 999);
        return { start: semStart, end: semEnd };
      }
    }
  }

  private static getWeekStartOffset(day: WeekStartDay): number {
    switch (day) {
      case "SUNDAY":
        return 0;
      case "MONDAY":
        return 1;
      case "TUESDAY":
        return 2;
      case "WEDNESDAY":
        return 3;
      case "THURSDAY":
        return 4;
      case "FRIDAY":
        return 5;
      case "SATURDAY":
        return 6;
    }
  }

  private static getWeeklyPeriodBounds(
    weekStartDay: WeekStartDay,
    referenceDate: Date
  ): { start: Date; end: Date } {
    const ref = new Date(referenceDate);
    const startDow = AllowanceEngine.getWeekStartOffset(weekStartDay);
    const dow = ref.getDay();
    const delta = (dow - startDow + 7) % 7;

    const start = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - delta, 0, 0, 0, 0);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 23, 59, 59, 999);

    return { start, end };
  }

  private static normalizeDateKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  private static isWorkingDay(
    date: Date,
    calendarMap: Map<string, AcademicDayType>,
    workingDaysOfWeek: Set<number>
  ): boolean {
    const key = AllowanceEngine.normalizeDateKey(date);
    const explicit = calendarMap.get(key);

    if (explicit) {
      if (WORKING_DAY_TYPES.has(explicit)) return true;
      if (NON_WORKING_DAY_TYPES.has(explicit)) return false;
    }

    return workingDaysOfWeek.has(date.getDay());
  }

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

  static async getOrCreateInstitutionConfig(institutionId: string): Promise<InstitutionConfig> {
    let config = await prisma.institutionConfig.findUnique({
      where: { institutionId },
    });

    if (!config) {
      config = await prisma.institutionConfig.create({
        data: {
          institutionId,
          timezone: "Asia/Kolkata",
          weekStartDay: "MONDAY",
          workingDaysOfWeek: [1, 2, 3, 4, 5, 6],
          lowAllowanceThresholdMinutes: 60,
        },
      });
    }

    const weekdays = Array.isArray(config.workingDaysOfWeek)
      ? config.workingDaysOfWeek
          .map((d) => Number(d))
          .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : [1, 2, 3, 4, 5, 6];

    return {
      timezone: config.timezone,
      weekStartDay: config.weekStartDay,
      workingDaysOfWeek: weekdays.length > 0 ? weekdays : [1, 2, 3, 4, 5, 6],
      lowAllowanceThresholdMinutes: config.lowAllowanceThresholdMinutes,
    };
  }

  static async getRemainingAllowance(
    studentId: string,
    institutionId: string
  ): Promise<AllowanceSummary> {
    const [policy, institutionConfig] = await Promise.all([
      AllowanceEngine.getOrCreatePolicy(institutionId),
      AllowanceEngine.getOrCreateInstitutionConfig(institutionId),
    ]);

    const now = new Date();
    const { start, end } =
      policy.policyPeriod === "WEEKLY"
        ? AllowanceEngine.getWeeklyPeriodBounds(institutionConfig.weekStartDay, now)
        : AllowanceEngine.getPeriodBounds(policy.policyPeriod, now);

    const [completedPasses, calendarDays] = await Promise.all([
      prisma.gatePass.findMany({
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
      }),
      prisma.academicCalendarDay.findMany({
        where: {
          institutionId,
          date: { gte: start, lte: end },
        },
      }),
    ]);

    const calendarMap = new Map<string, AcademicDayType>(
      calendarDays.map((d) => [AllowanceEngine.normalizeDateKey(d.date), d.dayType])
    );
    const workingWeekdays = new Set<number>(institutionConfig.workingDaysOfWeek);

    let consumed = 0;
    for (const pass of completedPasses) {
      const exitEvent = pass.gateEvents.find((e) => e.eventType === "EXIT");
      const returnEvent = pass.gateEvents.find((e) => e.eventType === "RETURN");

      if (!exitEvent || !returnEvent) {
        console.warn(
          `[AllowanceEngine] Pass ${pass.id} missing EXIT or RETURN GateEvent — excluded from allowance calculation`
        );
        continue;
      }

      if (!AllowanceEngine.isWorkingDay(returnEvent.timestamp, calendarMap, workingWeekdays)) {
        continue;
      }

      const duration = Math.floor(
        (returnEvent.timestamp.getTime() - exitEvent.timestamp.getTime()) / (1000 * 60)
      );
      consumed += duration;
    }

    let currentlyOutsideElapsed: number | null = null;
    const outsidePass = await prisma.gatePass.findFirst({
      where: { studentId, status: "OUTSIDE" },
      include: { gateEvents: true },
    });

    if (outsidePass) {
      const exitEvent = outsidePass.gateEvents.find((e) => e.eventType === "EXIT");
      if (exitEvent) {
        currentlyOutsideElapsed = Math.floor(
          (Date.now() - exitEvent.timestamp.getTime()) / (1000 * 60)
        );
        consumed += currentlyOutsideElapsed;
      }
    }

    const remaining = Math.max(0, policy.allowanceAmount - consumed);

    return {
      totalAllowance: policy.allowanceAmount,
      consumed,
      remaining,
      periodType: policy.policyPeriod,
      periodStart: start,
      periodEnd: end,
      isExhausted: remaining <= 0,
      warningThreshold: remaining <= institutionConfig.lowAllowanceThresholdMinutes,
      currentlyOutsideElapsed,
    };
  }

  static async getEnforcementDecision(
    studentId: string,
    institutionId: string
  ): Promise<EnforcementDecision> {
    const summary = await AllowanceEngine.getRemainingAllowance(studentId, institutionId);

    if (summary.remaining > 0) {
      return { action: "allow", remainingAllowance: summary.remaining };
    }

    const policy = await AllowanceEngine.getOrCreatePolicy(institutionId);

    if (policy.enforcement === "BLOCK_NEW_REQUESTS") {
      return {
        action: "block",
        message:
          "Your outside-time allowance for this period is exhausted. Contact your HOD for an emergency override.",
        remainingAllowance: summary.remaining,
      };
    }

    return {
      action: "warn",
      message: "Student has exhausted their outside-time allowance for this period.",
      remainingAllowance: summary.remaining,
    };
  }
}
