import { describe, it, expect } from "vitest";
import {
  copyConditionLabel,
  copyStatusLabel,
  fineReasonLabel,
  fineStatusLabel,
  libraryErrorOverrides,
  loanStatusLabel,
  reservationStatusLabel,
  titleStatusLabel,
} from "../labels";

describe("libraryErrorOverrides", () => {
  it("has exactly the three documented keys with literal texts", () => {
    expect(Object.keys(libraryErrorOverrides)).toEqual([
      "copy not available",
      "borrowing limit reached",
      "student not found",
    ]);
    expect(libraryErrorOverrides["copy not available"]).toBe(
      "This copy was just issued or is no longer available. The list has been refreshed.",
    );
    expect(libraryErrorOverrides["borrowing limit reached"]).toBe(
      "This student has reached the borrowing limit.",
    );
    expect(libraryErrorOverrides["student not found"]).toBe("Student not found.");
  });
});

describe("label maps", () => {
  it("cover every enum value", () => {
    expect(Object.keys(copyStatusLabel).sort()).toEqual(
      ["AVAILABLE", "DAMAGED", "ISSUED", "LOST", "RESERVED", "WITHDRAWN"],
    );
    expect(Object.keys(copyConditionLabel).sort()).toEqual(["DAMAGED", "FAIR", "GOOD", "NEW", "POOR"]);
    expect(Object.keys(loanStatusLabel).sort()).toEqual(["ACTIVE", "LOST", "OVERDUE", "RETURNED"]);
    expect(Object.keys(reservationStatusLabel).sort()).toEqual(["CANCELLED", "EXPIRED", "FULFILLED", "PENDING"]);
    expect(Object.keys(fineReasonLabel).sort()).toEqual(["DAMAGED", "LOST", "OVERDUE"]);
    expect(Object.keys(fineStatusLabel).sort()).toEqual(["PAID", "PENDING", "WAIVED"]);
    expect(Object.keys(titleStatusLabel).sort()).toEqual(["ACTIVE", "WITHDRAWN"]);
  });
});
