// Timetable conflict-detection service (design §8). A pure, DB-free function
// the route layer calls after it has fetched the candidate slot, the
// term-scoped existing SCHEDULED slots, the slot's effective calendar day-type
// (one-off only), and the institution's workingDaysOfWeek. It mirrors the
// student-sis.ts / calendar-service.ts pure-logic pattern: no Prisma client, no
// I/O — unit-testable without a DB. The timetable module decides what a date
// MEANS; CalendarService only describes the day (design §8 boundary).
//
// Determinism rules pinned by the design:
//   - The DayOfWeek enum ordinal lives ONLY in DOW_INDEX (SUN=0..SAT=6). No SQL
//     ever compares the enum numerically (§8.2, NIT-2).
//   - One-off dated slots resolve their weekday with getUTCDay() (NOT getDay())
//     so date-only midnight-UTC values never drift a weekday across the local
//     timezone boundary (§8.2).

import type { AcademicDayType, DayOfWeek } from "@campusgate/db";

// ─── Inputs (design §8.1) ────────────────────────────────────────────────────

export interface SlotInput {
  /** Present when editing an existing slot; excluded from its own self-compare. */
  id?: string;
  classSectionId: string;
  facultyId: string;
  room: string | null;
  /** Recurring weekly slot (mutually exclusive with `date`). */
  dayOfWeek: DayOfWeek | null;
  /** One-off dated slot as an ISO date string (mutually exclusive with `dayOfWeek`). */
  date: string | null;
  /** Minutes from midnight. */
  startTime: number;
  /** Minutes from midnight. */
  endTime: number;
  status: "SCHEDULED" | "CANCELLED";
}

export interface ConflictContext {
  /** The slot being added / edited. */
  candidate: SlotInput;
  /** SCHEDULED slots in the same academic term (fetched in-tenant by the route). */
  existing: SlotInput[];
  /**
   * The effective calendar day-type for the candidate's date (one-off only),
   * from CalendarService.effectiveDayType, or null when none / recurring.
   */
  dayType: AcademicDayType | null;
  /** InstitutionConfig.workingDaysOfWeek (0..6, aligned to DOW_INDEX / getUTCDay). */
  workingDaysOfWeek: number[];
}

// ─── Output (design §8.3) ────────────────────────────────────────────────────

export type ConflictType =
  | "INVALID_PERIOD"
  | "FACULTY_DOUBLE_BOOKED"
  | "ROOM_DOUBLE_BOOKED"
  | "SECTION_SELF_CONFLICT"
  | "OUT_OF_HOURS";

export interface Conflict {
  type: ConflictType;
  severity: "BLOCK" | "WARN";
  message: string;
  /** The existing slot it collides with (types 2–4). */
  conflictingScheduledClassId?: string;
  detail?: Record<string, string | number>;
}

export interface ConflictReport {
  blocking: Conflict[];
  warnings: Conflict[];
}

// ─── Day-axis conversion (design §8.2 — pinned) ──────────────────────────────

/**
 * The DayOfWeek label→ordinal map. SUN=0..SAT=6, aligned to JS getUTCDay() and
 * to workingDaysOfWeek. This is the ONLY place the enum becomes an integer — no
 * ad-hoc indexOf, no numeric SQL compare (§8.2, NIT-2).
 */
export const DOW_INDEX: Record<DayOfWeek, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

/**
 * The weekday integer of a slot, or null if it is a one-off with no date
 * (structurally invalid upstream). A recurring slot resolves from its
 * `dayOfWeek`; a one-off slot resolves from `date.getUTCDay()` (§8.2 — UTC is
 * mandatory for date-only midnight-UTC values).
 */
export function weekdayOf(slot: SlotInput): number | null {
  if (slot.dayOfWeek) return DOW_INDEX[slot.dayOfWeek];
  if (slot.date) return new Date(slot.date).getUTCDay();
  return null;
}

// ─── Working-day classification (design §8.2.1) ──────────────────────────────

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

/**
 * True when two time windows overlap. Touching (a.end === b.start) is NOT an
 * overlap (half-open intervals) — design §8.2.1 boundary rule.
 */
function windowsOverlap(a: SlotInput, b: SlotInput): boolean {
  return a.startTime < b.endTime && b.startTime < a.endTime;
}

/**
 * True when two slots share the same day axis (design §8.2.1):
 *   - two recurring slots with the same dayOfWeek;
 *   - a recurring + a one-off slot whose UTC weekday equals the recurring day;
 *   - two one-off slots with the same date.
 */
function sameDayAxis(a: SlotInput, b: SlotInput): boolean {
  // Two one-off dated slots: same calendar date.
  if (a.dayOfWeek === null && b.dayOfWeek === null) {
    if (a.date === null || b.date === null) return false;
    return new Date(a.date).getTime() === new Date(b.date).getTime();
  }
  // Otherwise at least one is recurring: compare on weekday integer.
  const wa = weekdayOf(a);
  const wb = weekdayOf(b);
  if (wa === null || wb === null) return false;
  return wa === wb;
}

/**
 * Resolve whether the candidate slot falls on a working day (design §8.2.1
 * working-day resolution rule):
 *   - Recurring slot: weekday membership of workingDaysOfWeek ONLY — the
 *     calendar day-type is NOT consulted.
 *   - One-off slot: explicit calendar dayType wins (working vs non-working),
 *     else fall back to workingDaysOfWeek membership.
 */
function isWorkingDay(candidate: SlotInput, ctx: ConflictContext): boolean {
  const workingDays = new Set(ctx.workingDaysOfWeek);

  // Recurring: weekday-only (§8.2.1 — effectiveDayType NOT consulted).
  if (candidate.dayOfWeek !== null) {
    const wd = weekdayOf(candidate);
    return wd !== null && workingDays.has(wd);
  }

  // One-off: explicit calendar dayType wins.
  if (ctx.dayType) {
    if (WORKING_DAY_TYPES.has(ctx.dayType)) return true;
    if (NON_WORKING_DAY_TYPES.has(ctx.dayType)) return false;
  }
  // Fallback: weekday membership.
  const wd = weekdayOf(candidate);
  return wd !== null && workingDays.has(wd);
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Detect every timetable conflict for a candidate slot against the term-scoped
 * existing SCHEDULED slots + the institution's working-day context. Returns a
 * ConflictReport split into BLOCK (blocking) and WARN (warnings). Pure + DB-free
 * (design §8). CANCELLED slots are ignored on both sides; the candidate's own id
 * is excluded from the self-compare.
 */
export function detectTimetableConflicts(ctx: ConflictContext): ConflictReport {
  const { candidate } = ctx;
  const blocking: Conflict[] = [];
  const warnings: Conflict[] = [];

  // A CANCELLED candidate schedules nothing — no conflicts to report.
  if (candidate.status === "CANCELLED") {
    return { blocking, warnings };
  }

  // 1. INVALID_PERIOD (BLOCK) — structurally invalid duration/bounds.
  const invalidPeriod =
    candidate.startTime >= candidate.endTime ||
    candidate.startTime < 0 ||
    candidate.endTime > 1440;
  if (invalidPeriod) {
    blocking.push({
      type: "INVALID_PERIOD",
      severity: "BLOCK",
      message: "Slot has an invalid period (startTime must be >= 0, endTime <= 1440, and startTime < endTime).",
      detail: { startTime: candidate.startTime, endTime: candidate.endTime },
    });
    // No point scanning overlaps against a structurally invalid period.
    // Out-of-hours is still meaningful, so continue to that check below.
  }

  // Overlap scans (2–4) only when the period is valid.
  if (!invalidPeriod) {
    for (const other of ctx.existing) {
      // Ignore CANCELLED slots on both sides.
      if (other.status === "CANCELLED") continue;
      // Exclude the edited slot's own row from the self-compare.
      if (candidate.id !== undefined && other.id === candidate.id) continue;
      // Only slots on the same day axis can collide.
      if (!sameDayAxis(candidate, other)) continue;
      if (!windowsOverlap(candidate, other)) continue;

      // 2. FACULTY_DOUBLE_BOOKED (BLOCK)
      if (other.facultyId === candidate.facultyId) {
        blocking.push({
          type: "FACULTY_DOUBLE_BOOKED",
          severity: "BLOCK",
          message: "Faculty is already scheduled for an overlapping slot.",
          conflictingScheduledClassId: other.id,
          detail: {
            facultyId: candidate.facultyId,
            startTime: candidate.startTime,
            endTime: candidate.endTime,
          },
        });
      }

      // 3. ROOM_DOUBLE_BOOKED (BLOCK) — only when room is non-null on both.
      if (
        candidate.room !== null &&
        other.room !== null &&
        other.room === candidate.room
      ) {
        blocking.push({
          type: "ROOM_DOUBLE_BOOKED",
          severity: "BLOCK",
          message: "Room is already booked for an overlapping slot.",
          conflictingScheduledClassId: other.id,
          detail: {
            room: candidate.room,
            startTime: candidate.startTime,
            endTime: candidate.endTime,
          },
        });
      }

      // 4. SECTION_SELF_CONFLICT (BLOCK)
      if (other.classSectionId === candidate.classSectionId) {
        blocking.push({
          type: "SECTION_SELF_CONFLICT",
          severity: "BLOCK",
          message: "The section already has an overlapping class.",
          conflictingScheduledClassId: other.id,
          detail: {
            classSectionId: candidate.classSectionId,
            startTime: candidate.startTime,
            endTime: candidate.endTime,
          },
        });
      }
    }
  }

  // 5. OUT_OF_HOURS (WARN) — non-working day.
  if (!isWorkingDay(candidate, ctx)) {
    const wd = weekdayOf(candidate);
    warnings.push({
      type: "OUT_OF_HOURS",
      severity: "WARN",
      message: "Slot falls on a day the institution does not normally operate.",
      detail: wd !== null ? { weekday: wd } : {},
    });
  }

  return { blocking, warnings };
}
