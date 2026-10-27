import { describe, expect, it } from "vitest";
import { resolveEffectiveDayType, type CalendarRow } from "../calendar-service.js";

// ─── Pure precedence-resolver tests (design §4.4/§13) ────────────────────────
// resolveEffectiveDayType is the one piece of resolution logic CalendarService
// owns: a department-scoped entry wins over the institution-wide entry for that
// department's query. It is a pure function over fetched rows (no I/O) so it is
// unit-testable without a DB — this test pins the precedence rule directly.

const HOLIDAY: CalendarRow = { date: new Date("2026-09-01"), dayType: "HOLIDAY", departmentId: null };
const deptExam = (dept: string): CalendarRow => ({
  date: new Date("2026-09-01"),
  dayType: "EXAM_DAY",
  departmentId: dept,
});

describe("resolveEffectiveDayType — department-wins precedence", () => {
  it("returns null when no rows apply", () => {
    expect(resolveEffectiveDayType([], "dept-1")).toBeNull();
    expect(resolveEffectiveDayType([])).toBeNull();
  });

  it("returns the institution-wide dayType when no department is requested", () => {
    expect(resolveEffectiveDayType([HOLIDAY])).toBe("HOLIDAY");
  });

  it("returns the institution-wide dayType when the requested department has no own row", () => {
    expect(resolveEffectiveDayType([HOLIDAY], "dept-1")).toBe("HOLIDAY");
  });

  it("department-scoped entry WINS over the institution-wide entry on a date collision", () => {
    const rows = [HOLIDAY, deptExam("dept-1")];
    expect(resolveEffectiveDayType(rows, "dept-1")).toBe("EXAM_DAY");
  });

  it("another department's row does NOT win for this department's query", () => {
    const rows = [HOLIDAY, deptExam("dept-OTHER")];
    // dept-1 has no own row; the other department's row is ignored => institution-wide.
    expect(resolveEffectiveDayType(rows, "dept-1")).toBe("HOLIDAY");
  });

  it("ignores department rows entirely when no department is requested", () => {
    const rows = [HOLIDAY, deptExam("dept-1")];
    expect(resolveEffectiveDayType(rows)).toBe("HOLIDAY");
  });

  it("returns a department row even without an institution-wide fallback", () => {
    expect(resolveEffectiveDayType([deptExam("dept-1")], "dept-1")).toBe("EXAM_DAY");
  });
});
