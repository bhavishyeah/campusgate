import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @campusgate/db before importing the engine (mirrors allowance-integration.test.ts).
vi.mock("@campusgate/db", () => ({
  prisma: {
    allowancePolicy: { findUnique: vi.fn(), create: vi.fn() },
    institutionConfig: { findUnique: vi.fn(), create: vi.fn() },
    academicCalendarDay: { findMany: vi.fn() },
    gatePass: { findMany: vi.fn(), findFirst: vi.fn() },
    gateEvent: { findMany: vi.fn() },
  },
  PolicyPeriod: { DAILY: "DAILY", WEEKLY: "WEEKLY", MONTHLY: "MONTHLY", SEMESTER: "SEMESTER" },
  EnforcementMode: { BLOCK_NEW_REQUESTS: "BLOCK_NEW_REQUESTS", WARN_ONLY: "WARN_ONLY" },
  WeekStartDay: { MONDAY: "MONDAY" },
  AcademicDayType: {
    WORKING_DAY: "WORKING_DAY",
    HOLIDAY: "HOLIDAY",
    WEEKEND: "WEEKEND",
    EXAM_DAY: "EXAM_DAY",
    VACATION: "VACATION",
    SPECIAL_WORKING_DAY: "SPECIAL_WORKING_DAY",
    INSTITUTION_EVENT: "INSTITUTION_EVENT",
  },
}));

import { AllowanceEngine } from "../allowance-engine.js";
import { prisma } from "@campusgate/db";

const mockedPrisma = prisma as unknown as {
  allowancePolicy: { findUnique: ReturnType<typeof vi.fn> };
  institutionConfig: { findUnique: ReturnType<typeof vi.fn> };
  academicCalendarDay: { findMany: ReturnType<typeof vi.fn> };
  gatePass: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
};

// ─── Allowance-engine calendar-read regression (design §4.4/§10.5) ───────────
// Phase 1 adds nullable departmentId/session/term columns to academic_calendar_
// days and the possibility of department-scoped rows. These tests pin TWO things:
//  1. the engine's calendar read is UNCHANGED by the new columns (same findMany
//     + dayType mapping — a HOLIDAY on a return day still excludes that pass);
//  2. the read is now DETERMINISTIC against department-scoped rows because the
//     engine filters departmentId: null — an institution-wide HOLIDAY wins over a
//     same-date department-scoped WORKING_DAY regardless of row ordering (design
//     §4.4 required hardening; backed by the _inst_date_institutionwide partial
//     unique index).

const STUDENT_ID = "student-reg";
const INSTITUTION_ID = "inst-reg";

const WEEKLY_POLICY = {
  id: "policy-reg",
  institutionId: INSTITUTION_ID,
  allowanceAmount: 1440,
  policyPeriod: "WEEKLY",
  gracePeriod: 10,
  enforcement: "WARN_ONLY",
  minimumSampleSize: 5,
  severityMinorMax: 15,
  severityModerateMax: 60,
  severitySignificantMax: 180,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrisma.allowancePolicy.findUnique.mockResolvedValue(WEEKLY_POLICY);
  mockedPrisma.institutionConfig.findUnique.mockResolvedValue({
    id: "cfg-reg",
    institutionId: INSTITUTION_ID,
    timezone: "Asia/Kolkata",
    weekStartDay: "MONDAY",
    // All 7 days working so the pass below counts regardless of weekday the suite runs.
    workingDaysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    lowAllowanceThresholdMinutes: 60,
  });
  mockedPrisma.gatePass.findFirst.mockResolvedValue(null);
});

/** A single 60-minute completed pass returning today (inside any current period). */
function onePass() {
  const now = new Date();
  const exit = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);
  const ret = new Date(exit.getTime() + 60 * 60 * 1000);
  return [
    {
      id: "pass-reg",
      studentId: STUDENT_ID,
      status: "COMPLETED",
      gateEvents: [
        { id: "e1", passId: "pass-reg", eventType: "EXIT", timestamp: exit },
        { id: "e2", passId: "pass-reg", eventType: "RETURN", timestamp: ret },
      ],
    },
  ];
}

function returnDay(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0);
}

describe("allowance-engine calendar regression", () => {
  it("reads academicCalendarDay with departmentId: null (institution-wide only)", async () => {
    mockedPrisma.gatePass.findMany.mockResolvedValue([]);
    mockedPrisma.academicCalendarDay.findMany.mockResolvedValue([]);

    await AllowanceEngine.getRemainingAllowance(STUDENT_ID, INSTITUTION_ID);

    expect(mockedPrisma.academicCalendarDay.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          institutionId: INSTITUTION_ID,
          departmentId: null,
          date: expect.objectContaining({ gte: expect.any(Date), lte: expect.any(Date) }),
        }),
      }),
    );
  });

  it("computes consumption identically with the new nullable columns present on returned rows", async () => {
    mockedPrisma.gatePass.findMany.mockResolvedValue(onePass());
    // The engine only reads date + dayType; the new nullable columns ride along harmlessly.
    mockedPrisma.academicCalendarDay.findMany.mockResolvedValue([
      {
        id: "acd-1",
        institutionId: INSTITUTION_ID,
        date: returnDay(),
        dayType: "WORKING_DAY",
        note: null,
        departmentId: null,
        academicSessionId: "sess-1",
        academicTermId: "term-1",
      },
    ]);

    const summary = await AllowanceEngine.getRemainingAllowance(STUDENT_ID, INSTITUTION_ID);
    // Working day => the 60-minute pass is counted.
    expect(summary.consumed).toBe(60);
    expect(summary.remaining).toBe(1380);
  });

  it("is deterministic: an institution-wide HOLIDAY wins over a same-date dept WORKING_DAY", async () => {
    mockedPrisma.gatePass.findMany.mockResolvedValue(onePass());

    // The engine's query filters departmentId: null, so even if the DB held a
    // department-scoped WORKING_DAY for the same date, findMany returns ONLY the
    // institution-wide HOLIDAY. We assert the engine behaves as if the dept row
    // does not exist (it excludes the non-working-day pass) — the result does not
    // depend on row ordering.
    mockedPrisma.academicCalendarDay.findMany.mockImplementation(({ where }: any) => {
      // Honour the departmentId: null filter the way the DB would.
      expect(where.departmentId).toBeNull();
      return Promise.resolve([
        {
          id: "acd-holiday",
          institutionId: INSTITUTION_ID,
          date: returnDay(),
          dayType: "HOLIDAY",
          note: null,
          departmentId: null,
          academicSessionId: null,
          academicTermId: null,
        },
      ]);
    });

    const summary = await AllowanceEngine.getRemainingAllowance(STUDENT_ID, INSTITUTION_ID);
    // HOLIDAY => the pass's return day is non-working => excluded => 0 consumed.
    expect(summary.consumed).toBe(0);
    expect(summary.remaining).toBe(1440);
  });
});
