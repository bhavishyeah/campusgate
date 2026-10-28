import { describe, expect, it } from "vitest";
import {
  detectTimetableConflicts,
  weekdayOf,
  DOW_INDEX,
  type ConflictContext,
  type SlotInput,
} from "../timetable-conflict.js";

// ─── Timetable conflict-detection (design §8) ────────────────────────────────
// DB-free unit tests for the pure detectTimetableConflicts function. Each
// conflict type, BLOCK-vs-WARN, the touching boundary, recurring-vs-one-off
// day-axis match, getUTCDay determinism, CANCELLED-ignored, edited-slot
// self-exclusion, and the working-day resolution split by slot kind are pinned.

// A standard Mon-Sat working week (0=SUN..6=SAT), matching the engine default.
const WORKDAYS = [1, 2, 3, 4, 5, 6];

function slot(overrides: Partial<SlotInput>): SlotInput {
  return {
    classSectionId: "sec_1",
    facultyId: "fac_1",
    room: "R101",
    dayOfWeek: "MON",
    date: null,
    startTime: 540, // 09:00
    endTime: 600, // 10:00
    status: "SCHEDULED",
    ...overrides,
  };
}

function ctx(candidate: SlotInput, existing: SlotInput[] = [], extra?: Partial<ConflictContext>): ConflictContext {
  return {
    candidate,
    existing,
    dayType: null,
    workingDaysOfWeek: WORKDAYS,
    ...extra,
  };
}

describe("weekdayOf + DOW_INDEX (design §8.2)", () => {
  it("DOW_INDEX maps SUN=0..SAT=6", () => {
    expect(DOW_INDEX).toEqual({ SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 });
  });

  it("recurring slot resolves weekday from its dayOfWeek", () => {
    expect(weekdayOf(slot({ dayOfWeek: "WED", date: null }))).toBe(3);
  });

  it("one-off slot resolves weekday with getUTCDay (deterministic, timezone-free)", () => {
    // 2026-01-05 is a Monday in UTC. getUTCDay() => 1, regardless of host TZ.
    const s = slot({ dayOfWeek: null, date: "2026-01-05" });
    expect(weekdayOf(s)).toBe(1);
    expect(weekdayOf(s)).toBe(new Date("2026-01-05").getUTCDay());
  });

  it("one-off with no date returns null (invalid upstream)", () => {
    expect(weekdayOf(slot({ dayOfWeek: null, date: null }))).toBeNull();
  });
});

describe("detectTimetableConflicts — INVALID_PERIOD (BLOCK)", () => {
  it("flags startTime >= endTime", () => {
    const r = detectTimetableConflicts(ctx(slot({ startTime: 600, endTime: 600 })));
    expect(r.blocking.map((c) => c.type)).toContain("INVALID_PERIOD");
    expect(r.blocking[0].severity).toBe("BLOCK");
  });

  it("flags negative startTime", () => {
    const r = detectTimetableConflicts(ctx(slot({ startTime: -1, endTime: 60 })));
    expect(r.blocking.map((c) => c.type)).toContain("INVALID_PERIOD");
  });

  it("flags endTime > 1440", () => {
    const r = detectTimetableConflicts(ctx(slot({ startTime: 1400, endTime: 1441 })));
    expect(r.blocking.map((c) => c.type)).toContain("INVALID_PERIOD");
  });

  it("does not flag a valid period", () => {
    const r = detectTimetableConflicts(ctx(slot({ startTime: 0, endTime: 1440 }), []));
    expect(r.blocking.map((c) => c.type)).not.toContain("INVALID_PERIOD");
  });
});

describe("detectTimetableConflicts — FACULTY_DOUBLE_BOOKED (BLOCK)", () => {
  it("flags an overlapping slot with the same faculty on the same weekday", () => {
    const existing = slot({ id: "x1", classSectionId: "sec_OTHER", room: "R999", startTime: 570, endTime: 630 });
    const r = detectTimetableConflicts(ctx(slot({}), [existing]));
    const faculty = r.blocking.find((c) => c.type === "FACULTY_DOUBLE_BOOKED");
    expect(faculty).toBeDefined();
    expect(faculty?.severity).toBe("BLOCK");
    expect(faculty?.conflictingScheduledClassId).toBe("x1");
  });

  it("does not flag different faculty", () => {
    const existing = slot({ id: "x1", facultyId: "fac_OTHER", classSectionId: "sec_OTHER", room: "R999" });
    const r = detectTimetableConflicts(ctx(slot({}), [existing]));
    expect(r.blocking.map((c) => c.type)).not.toContain("FACULTY_DOUBLE_BOOKED");
  });
});

describe("detectTimetableConflicts — ROOM_DOUBLE_BOOKED (BLOCK)", () => {
  it("flags the same non-null room on an overlapping same-axis slot", () => {
    const existing = slot({ id: "x1", facultyId: "fac_OTHER", classSectionId: "sec_OTHER" });
    const r = detectTimetableConflicts(ctx(slot({}), [existing]));
    const room = r.blocking.find((c) => c.type === "ROOM_DOUBLE_BOOKED");
    expect(room).toBeDefined();
    expect(room?.conflictingScheduledClassId).toBe("x1");
  });

  it("does not flag when the candidate has a null room", () => {
    const existing = slot({ id: "x1", facultyId: "fac_OTHER", classSectionId: "sec_OTHER" });
    const r = detectTimetableConflicts(ctx(slot({ room: null }), [existing]));
    expect(r.blocking.map((c) => c.type)).not.toContain("ROOM_DOUBLE_BOOKED");
  });

  it("does not flag when the existing slot has a null room", () => {
    const existing = slot({ id: "x1", facultyId: "fac_OTHER", classSectionId: "sec_OTHER", room: null });
    const r = detectTimetableConflicts(ctx(slot({}), [existing]));
    expect(r.blocking.map((c) => c.type)).not.toContain("ROOM_DOUBLE_BOOKED");
  });
});

describe("detectTimetableConflicts — SECTION_SELF_CONFLICT (BLOCK)", () => {
  it("flags the same section overlapping on the same axis", () => {
    const existing = slot({ id: "x1", facultyId: "fac_OTHER", room: "R999" });
    const r = detectTimetableConflicts(ctx(slot({}), [existing]));
    const sec = r.blocking.find((c) => c.type === "SECTION_SELF_CONFLICT");
    expect(sec).toBeDefined();
    expect(sec?.conflictingScheduledClassId).toBe("x1");
  });
});

describe("detectTimetableConflicts — boundary (touching != overlap)", () => {
  it("a.end === b.start produces NO conflict", () => {
    // candidate 09:00-10:00, existing 10:00-11:00 — same faculty/room/section.
    const existing = slot({ id: "x1", startTime: 600, endTime: 660 });
    const r = detectTimetableConflicts(ctx(slot({ startTime: 540, endTime: 600 }), [existing]));
    expect(r.blocking).toHaveLength(0);
  });

  it("a one-minute overlap DOES conflict", () => {
    const existing = slot({ id: "x1", startTime: 599, endTime: 660 });
    const r = detectTimetableConflicts(ctx(slot({ startTime: 540, endTime: 600 }), [existing]));
    expect(r.blocking.length).toBeGreaterThan(0);
  });
});

describe("detectTimetableConflicts — recurring vs one-off day-axis", () => {
  it("a one-off date whose UTC weekday equals a recurring slot's dayOfWeek collides", () => {
    // 2026-01-05 is Monday (UTC); the recurring existing slot is MON.
    // Share faculty (default fac_1) so the dated occurrence collides with the
    // weekly pattern on the same day axis.
    const existing = slot({ id: "x1", dayOfWeek: "MON", date: null, classSectionId: "sec_OTHER", room: "R999" });
    const candidate = slot({ dayOfWeek: null, date: "2026-01-05", classSectionId: "sec_OTHER", room: "R999" });
    const r = detectTimetableConflicts(ctx(candidate, [existing]));
    expect(r.blocking.some((c) => c.type === "FACULTY_DOUBLE_BOOKED")).toBe(true);
  });

  it("a one-off date on a different weekday than the recurring slot does NOT collide", () => {
    // 2026-01-06 is Tuesday (UTC); recurring existing is MON => different axis.
    const existing = slot({ id: "x1", dayOfWeek: "MON", date: null });
    const candidate = slot({ dayOfWeek: null, date: "2026-01-06" });
    const r = detectTimetableConflicts(ctx(candidate, [existing]));
    expect(r.blocking).toHaveLength(0);
  });

  it("two one-off slots on the same date collide; different dates do not", () => {
    const sameDate = slot({ id: "x1", dayOfWeek: null, date: "2026-01-05", facultyId: "fac_OTHER", room: "R999", classSectionId: "sec_OTHER" });
    const candidate = slot({ dayOfWeek: null, date: "2026-01-05", classSectionId: "sec_1", facultyId: "fac_OTHER", room: "R999" });
    const same = detectTimetableConflicts(ctx(candidate, [sameDate]));
    expect(same.blocking.length).toBeGreaterThan(0);

    const otherDate = slot({ id: "x2", dayOfWeek: null, date: "2026-01-12", facultyId: "fac_1", room: "R101", classSectionId: "sec_1" });
    const r2 = detectTimetableConflicts(ctx(slot({ dayOfWeek: null, date: "2026-01-05" }), [otherDate]));
    expect(r2.blocking).toHaveLength(0);
  });
});

describe("detectTimetableConflicts — CANCELLED ignored", () => {
  it("ignores a CANCELLED existing slot", () => {
    const existing = slot({ id: "x1", status: "CANCELLED" });
    const r = detectTimetableConflicts(ctx(slot({}), [existing]));
    expect(r.blocking).toHaveLength(0);
  });

  it("a CANCELLED candidate reports nothing", () => {
    const existing = slot({ id: "x1" });
    const r = detectTimetableConflicts(ctx(slot({ status: "CANCELLED", startTime: -5, endTime: -1 }), [existing]));
    expect(r.blocking).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });
});

describe("detectTimetableConflicts — edited-slot self-exclusion", () => {
  it("excludes the candidate's own id from the self-compare", () => {
    // Same id => the candidate IS the existing row being edited; no self-conflict.
    const existing = slot({ id: "edit_me" });
    const r = detectTimetableConflicts(ctx(slot({ id: "edit_me" }), [existing]));
    expect(r.blocking).toHaveLength(0);
  });

  it("still conflicts with a DIFFERENT existing row", () => {
    // `self` is the row being edited (same id => excluded). `other` is a
    // distinct row for the SAME section/faculty/room => a real conflict.
    const self = slot({ id: "edit_me" });
    const other = slot({ id: "other", startTime: 570, endTime: 630 });
    const r = detectTimetableConflicts(ctx(slot({ id: "edit_me" }), [self, other]));
    expect(r.blocking.map((c) => c.type)).toContain("SECTION_SELF_CONFLICT");
  });
});

describe("detectTimetableConflicts — OUT_OF_HOURS (WARN) by slot kind", () => {
  it("recurring slot on a non-working weekday warns (weekday-only, calendar NOT consulted)", () => {
    // SUN (0) is not in WORKDAYS. dayType provided but must be IGNORED for recurring.
    const r = detectTimetableConflicts(ctx(slot({ dayOfWeek: "SUN" }), [], { dayType: "WORKING_DAY" }));
    expect(r.warnings.map((c) => c.type)).toContain("OUT_OF_HOURS");
    expect(r.warnings[0].severity).toBe("WARN");
    expect(r.blocking).toHaveLength(0);
  });

  it("recurring slot on a working weekday does not warn", () => {
    const r = detectTimetableConflicts(ctx(slot({ dayOfWeek: "MON" })));
    expect(r.warnings.map((c) => c.type)).not.toContain("OUT_OF_HOURS");
  });

  it("one-off slot: explicit calendar HOLIDAY wins over a working weekday", () => {
    // 2026-01-05 is Monday (working weekday) but the calendar marks it HOLIDAY.
    const r = detectTimetableConflicts(ctx(slot({ dayOfWeek: null, date: "2026-01-05" }), [], { dayType: "HOLIDAY" }));
    expect(r.warnings.map((c) => c.type)).toContain("OUT_OF_HOURS");
  });

  it("one-off slot: explicit SPECIAL_WORKING_DAY makes a weekend working (no warn)", () => {
    // 2026-01-04 is Sunday (non-working weekday) but calendar marks it working.
    const r = detectTimetableConflicts(ctx(slot({ dayOfWeek: null, date: "2026-01-04" }), [], { dayType: "SPECIAL_WORKING_DAY" }));
    expect(r.warnings.map((c) => c.type)).not.toContain("OUT_OF_HOURS");
  });

  it("one-off slot: no calendar entry falls back to workingDaysOfWeek membership", () => {
    // 2026-01-04 is Sunday => not a working day, no calendar entry => warn.
    const r = detectTimetableConflicts(ctx(slot({ dayOfWeek: null, date: "2026-01-04" }), [], { dayType: null }));
    expect(r.warnings.map((c) => c.type)).toContain("OUT_OF_HOURS");
  });
});

describe("detectTimetableConflicts — BLOCK vs WARN separation", () => {
  it("a blocking faculty conflict and an out-of-hours warning are reported separately", () => {
    // Recurring SUN candidate (out-of-hours warn) overlapping a same-faculty SUN slot (block).
    const existing = slot({ id: "x1", dayOfWeek: "SUN", classSectionId: "sec_OTHER", room: "R999", startTime: 570, endTime: 630 });
    const r = detectTimetableConflicts(ctx(slot({ dayOfWeek: "SUN" }), [existing]));
    expect(r.blocking.map((c) => c.type)).toContain("FACULTY_DOUBLE_BOOKED");
    expect(r.warnings.map((c) => c.type)).toContain("OUT_OF_HOURS");
  });
});
