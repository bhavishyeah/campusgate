import { describe, expect, it } from "vitest";
import type { DayOfWeek } from "@campusgate/db";
import { assertFacultyAssigned, dayOfWeekToIndex } from "../attendance-authz.js";

describe("assertFacultyAssigned (pure fast path)", () => {
  // A tx stub that throws if the DB branch is taken — proves the fast path
  // short-circuits without any query when the scheduled class names the faculty.
  const throwingTx = {
    facultyAssignment: {
      findFirst: () => {
        throw new Error("DB branch should not be reached on the fast path");
      },
    },
  } as never;

  it("returns true without a DB read when the scheduled class names the faculty", async () => {
    const result = await assertFacultyAssigned(throwingTx, "inst_1", "fac_1", {
      classSectionId: "sec_1",
      subjectId: "subj_1",
      academicTermId: "term_1",
      facultyId: "fac_1",
    });
    expect(result).toBe(true);
  });
});

describe("dayOfWeekToIndex (SUN=0..SAT=6, matching Date.getUTCDay())", () => {
  it("maps each weekday to the JS getUTCDay index", () => {
    const expected: Record<DayOfWeek, number> = {
      SUN: 0,
      MON: 1,
      TUE: 2,
      WED: 3,
      THU: 4,
      FRI: 5,
      SAT: 6,
    };
    for (const [day, index] of Object.entries(expected)) {
      expect(dayOfWeekToIndex(day as DayOfWeek)).toBe(index);
    }
  });
});
