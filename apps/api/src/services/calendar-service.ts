// Calendar read service (design §4.4). The single read API other modules call
// for academic-calendar entries. It DESCRIBES dates (returns a raw dayType); it
// does NOT invent rules — the allowance-engine keeps deciding what a dayType
// MEANS. Runs on a passed tenant tx (RLS-scoped); never reads cross-tenant.

import { AcademicDayType, type Prisma } from "@campusgate/db";

export interface CalendarEntry {
  date: Date;
  dayType: AcademicDayType;
  note: string | null;
  departmentId: string | null; // null = institution-wide
  academicSessionId: string | null;
  academicTermId: string | null;
}

// Minimal row shape the pure precedence resolver needs (so it is testable
// without a DB — design §13).
export interface CalendarRow {
  date: Date;
  dayType: AcademicDayType;
  departmentId: string | null;
}

/**
 * Pure precedence resolver: given the rows fetched for a (institution, date,
 * optional department) query, pick the effective dayType. A department-scoped
 * row (matching `departmentId`) wins over the institution-wide (null) row on a
 * date collision. Returns null when no row applies. No I/O — unit-testable.
 */
export function resolveEffectiveDayType(
  rows: CalendarRow[],
  departmentId?: string,
): AcademicDayType | null {
  let institutionWide: AcademicDayType | null = null;
  let departmentScoped: AcademicDayType | null = null;

  for (const row of rows) {
    if (row.departmentId === null) {
      institutionWide = row.dayType;
    } else if (departmentId && row.departmentId === departmentId) {
      departmentScoped = row.dayType;
    }
  }

  // Department-scoped wins over institution-wide for that department's query.
  return departmentScoped ?? institutionWide;
}

export class CalendarService {
  /**
   * Entries overlapping [from, to] for an institution, optionally narrowed to a
   * department. A department-scoped query returns BOTH institution-wide
   * (departmentId null) AND the department's own rows; the department row takes
   * precedence on a date collision (resolved in `effectiveDayType`). With no
   * department the full institution set (institution-wide + any dept rows) is
   * returned, matching the pre-Phase-1 admin read.
   */
  static async getEntries(
    institutionId: string,
    from: Date,
    to: Date,
    db: Prisma.TransactionClient,
    opts?: { departmentId?: string },
  ): Promise<CalendarEntry[]> {
    const where: Prisma.AcademicCalendarDayWhereInput = {
      institutionId,
      date: { gte: from, lte: to },
    };

    if (opts?.departmentId) {
      // Institution-wide rows plus the caller's own department rows only.
      where.OR = [{ departmentId: null }, { departmentId: opts.departmentId }];
    }

    const rows = await db.academicCalendarDay.findMany({
      where,
      orderBy: { date: "asc" },
    });

    return rows.map((r) => ({
      date: r.date,
      dayType: r.dayType,
      note: r.note,
      departmentId: r.departmentId,
      academicSessionId: r.academicSessionId,
      academicTermId: r.academicTermId,
    }));
  }

  /**
   * The effective dayType for a single date + optional department, applying the
   * precedence rule (department-scoped wins over institution-wide). Returns null
   * when no explicit entry exists (the caller falls back to its own weekday
   * rule). The service does NOT decide "working vs not" — only the dayType.
   */
  static async effectiveDayType(
    institutionId: string,
    date: Date,
    db: Prisma.TransactionClient,
    opts?: { departmentId?: string },
  ): Promise<AcademicDayType | null> {
    const where: Prisma.AcademicCalendarDayWhereInput = {
      institutionId,
      date,
    };

    if (opts?.departmentId) {
      where.OR = [{ departmentId: null }, { departmentId: opts.departmentId }];
    } else {
      where.departmentId = null;
    }

    const rows = await db.academicCalendarDay.findMany({
      where,
      select: { date: true, dayType: true, departmentId: true },
    });

    return resolveEffectiveDayType(rows, opts?.departmentId);
  }
}
