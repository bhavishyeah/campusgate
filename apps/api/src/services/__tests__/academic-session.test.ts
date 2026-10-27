import { describe, expect, it } from "vitest";
import {
  suggestedTermCount,
  termCountWarning,
  termOutsideSessionWarning,
  termOverlapWarning,
} from "../academic-session.js";

// ─── Pure state-machine predicate tests (design §3.3/§5.1/§13) ───────────────
// These predicates own the SOFT (warn-never-block) validation that keeps the
// academic structure configurable. They are DB-free by design so they are
// unit-testable without the pooler, mirroring module-system.ts's pure helpers.

describe("suggestedTermCount", () => {
  it("maps each structure type to its conventional term count", () => {
    expect(suggestedTermCount("SEMESTER")).toBe(2);
    expect(suggestedTermCount("TRIMESTER")).toBe(3);
    expect(suggestedTermCount("ANNUAL")).toBe(1);
    expect(suggestedTermCount("CUSTOM")).toBeNull(); // any N >= 1
  });
});

describe("termCountWarning (configurable structure — never blocks)", () => {
  it("SEMESTER + 2 terms produces NO warning (matches the suggestion)", () => {
    expect(termCountWarning("SEMESTER", 2)).toBeNull();
  });

  it("ANNUAL + 1 term produces NO warning (matches the suggestion)", () => {
    expect(termCountWarning("ANNUAL", 1)).toBeNull();
  });

  it("TRIMESTER + 2 terms produces a soft TERM_COUNT_SUGGESTION warning", () => {
    const w = termCountWarning("TRIMESTER", 2);
    expect(w).not.toBeNull();
    expect(w!.code).toBe("TERM_COUNT_SUGGESTION");
    expect(w!.message).toContain("3"); // suggests 3 for a TRIMESTER
  });

  it("CUSTOM never warns regardless of term count", () => {
    expect(termCountWarning("CUSTOM", 1)).toBeNull();
    expect(termCountWarning("CUSTOM", 7)).toBeNull();
  });
});

describe("termOutsideSessionWarning (soft)", () => {
  const session = {
    startDate: new Date("2026-07-01"),
    endDate: new Date("2027-06-30"),
  };

  it("returns null when the term is fully contained in the session", () => {
    const term = { startDate: new Date("2026-08-01"), endDate: new Date("2026-12-31") };
    expect(termOutsideSessionWarning(term, session)).toBeNull();
  });

  it("warns when the term starts before the session start", () => {
    const term = { startDate: new Date("2026-06-01"), endDate: new Date("2026-12-31") };
    const w = termOutsideSessionWarning(term, session);
    expect(w!.code).toBe("TERM_OUTSIDE_SESSION");
  });

  it("warns when the term ends after the session end", () => {
    const term = { startDate: new Date("2026-08-01"), endDate: new Date("2027-07-15") };
    expect(termOutsideSessionWarning(term, session)!.code).toBe("TERM_OUTSIDE_SESSION");
  });
});

describe("termOverlapWarning (soft)", () => {
  const existing = [
    { startDate: new Date("2026-07-01"), endDate: new Date("2026-12-31") },
  ];

  it("returns null for a non-overlapping term", () => {
    const next = { startDate: new Date("2027-01-01"), endDate: new Date("2027-06-30") };
    expect(termOverlapWarning(next, existing)).toBeNull();
  });

  it("warns when the new term overlaps an existing term in time", () => {
    const next = { startDate: new Date("2026-12-01"), endDate: new Date("2027-03-31") };
    const w = termOverlapWarning(next, existing);
    expect(w!.code).toBe("TERM_OVERLAP");
  });

  it("returns null when there are no existing terms", () => {
    const next = { startDate: new Date("2026-07-01"), endDate: new Date("2026-12-31") };
    expect(termOverlapWarning(next, [])).toBeNull();
  });
});
