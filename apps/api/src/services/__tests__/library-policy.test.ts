/**
 * Pure library-policy parser + computation unit tests (design §6). No I/O, no
 * DB — these pin the ONE definition of the circulation policy (defaults,
 * negative-clamping, malformed-settings safety) and the pure due-date /
 * overdue-days / fine-amount helpers that issue, return, lost and the reports
 * all share so they can never disagree.
 */
import { describe, expect, it } from "vitest";
import {
  libraryPolicy,
  computeDueDate,
  computeOverdueDays,
  computeOverdueFine,
} from "../library-policy.js";

const DEFAULTS = {
  loanPeriodDays: 14,
  maxActiveLoansPerStudent: 3,
  maxRenewals: 2,
  finesEnabled: false,
  overdueFinePerDay: 0,
  lostFineAmount: 0,
  reservationExpiryDays: 7,
};

describe("libraryPolicy() — defaults + safety", () => {
  it("returns the documented Phase-5 defaults for null/undefined settings", () => {
    expect(libraryPolicy(null)).toEqual(DEFAULTS);
    expect(libraryPolicy(undefined)).toEqual(DEFAULTS);
  });

  it("returns defaults for a malformed (non-object / array / primitive) settings blob", () => {
    expect(libraryPolicy("not-an-object")).toEqual(DEFAULTS);
    expect(libraryPolicy(42)).toEqual(DEFAULTS);
    expect(libraryPolicy([1, 2, 3])).toEqual(DEFAULTS);
    expect(libraryPolicy(true)).toEqual(DEFAULTS);
  });

  it("falls back per-key when individual keys are absent or wrong-typed", () => {
    const p = libraryPolicy({ loanPeriodDays: 21, maxRenewals: "nope", finesEnabled: "yes" });
    expect(p.loanPeriodDays).toBe(21); // honoured
    expect(p.maxRenewals).toBe(DEFAULTS.maxRenewals); // wrong type -> default
    expect(p.finesEnabled).toBe(DEFAULTS.finesEnabled); // non-boolean -> default
    expect(p.maxActiveLoansPerStudent).toBe(DEFAULTS.maxActiveLoansPerStudent); // absent -> default
  });

  it("clamps negative numbers to 0 (never a negative loan period / limit / fine)", () => {
    const p = libraryPolicy({
      loanPeriodDays: -5,
      maxActiveLoansPerStudent: -1,
      maxRenewals: -3,
      overdueFinePerDay: -10,
      lostFineAmount: -100,
      reservationExpiryDays: -2,
    });
    expect(p.loanPeriodDays).toBe(0);
    expect(p.maxActiveLoansPerStudent).toBe(0);
    expect(p.maxRenewals).toBe(0);
    expect(p.overdueFinePerDay).toBe(0);
    expect(p.lostFineAmount).toBe(0);
    expect(p.reservationExpiryDays).toBe(0);
  });

  it("honours a fully-specified valid settings object incl. finesEnabled=true", () => {
    const p = libraryPolicy({
      loanPeriodDays: 30,
      maxActiveLoansPerStudent: 5,
      maxRenewals: 4,
      finesEnabled: true,
      overdueFinePerDay: 2,
      lostFineAmount: 500,
      reservationExpiryDays: 3,
    });
    expect(p).toEqual({
      loanPeriodDays: 30,
      maxActiveLoansPerStudent: 5,
      maxRenewals: 4,
      finesEnabled: true,
      overdueFinePerDay: 2,
      lostFineAmount: 500,
      reservationExpiryDays: 3,
    });
  });

  it("never throws on NaN / Infinity (falls back to the default)", () => {
    const p = libraryPolicy({ loanPeriodDays: NaN, overdueFinePerDay: Infinity });
    expect(p.loanPeriodDays).toBe(DEFAULTS.loanPeriodDays);
    expect(p.overdueFinePerDay).toBe(DEFAULTS.overdueFinePerDay);
  });
});

describe("computeDueDate()", () => {
  it("dueDate = issueDate + loanPeriodDays", () => {
    const issue = new Date("2026-01-01T00:00:00.000Z");
    expect(computeDueDate(issue, 14).toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });

  it("a zero-day loan period is due the same instant", () => {
    const issue = new Date("2026-01-01T12:00:00.000Z");
    expect(computeDueDate(issue, 0).getTime()).toBe(issue.getTime());
  });
});

describe("computeOverdueDays()", () => {
  const due = new Date("2026-01-15T00:00:00.000Z");

  it("returns 0 when returned on or before the due date", () => {
    expect(computeOverdueDays(due, new Date("2026-01-15T00:00:00.000Z"))).toBe(0);
    expect(computeOverdueDays(due, new Date("2026-01-10T00:00:00.000Z"))).toBe(0);
  });

  it("ceils a partial overdue day up to a whole day", () => {
    expect(computeOverdueDays(due, new Date("2026-01-15T00:00:01.000Z"))).toBe(1);
    expect(computeOverdueDays(due, new Date("2026-01-16T12:00:00.000Z"))).toBe(2);
  });

  it("counts whole overdue days", () => {
    expect(computeOverdueDays(due, new Date("2026-01-20T00:00:00.000Z"))).toBe(5);
  });
});

describe("computeOverdueFine()", () => {
  it("multiplies overdue days by the per-day rate", () => {
    expect(computeOverdueFine(5, 2)).toBe(10);
  });

  it("is 0 when finesEnabled is off (rate 0 — the default policy)", () => {
    expect(computeOverdueFine(5, 0)).toBe(0);
  });

  it("never returns a negative amount", () => {
    expect(computeOverdueFine(0, 5)).toBe(0);
    expect(computeOverdueFine(5, -2)).toBe(0);
  });
});
