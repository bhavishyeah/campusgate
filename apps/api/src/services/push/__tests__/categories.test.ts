import { describe, expect, it } from "vitest";
import { categoryForType, priorityFor, ttlSecondsFor, urgencyFor } from "../categories.js";

describe("categoryForType", () => {
  const table: Array<[string, string]> = [
    ["EMERGENCY_DECLARED", "EMERGENCY"],
    ["EMERGENCY_RESOLVED", "EMERGENCY"],
    ["PASS_APPROVED", "GATEPASS"],
    ["PASS_REJECTED", "GATEPASS"],
    ["PASS_REVOKED", "GATEPASS"],
    ["PASS_EXPIRED", "GATEPASS"],
    ["GATE_EXIT", "GATEPASS"],
    ["GATE_RETURN", "GATEPASS"],
    ["NEW_REQUEST", "GATEPASS"],
    ["gatepass.anything", "GATEPASS"],
    ["guardian.child_left", "GATEPASS"],
    ["fees.payment.captured", "FEES"],
    ["fee.due", "FEES"],
    ["payment.failed", "FEES"],
    ["exams.published", "EXAMS"],
    ["results.out", "EXAMS"],
    ["attendance.low", "ATTENDANCE"],
    ["library.overdue", "LIBRARY"],
    ["admissions.application.status", "ADMISSIONS"],
    ["admissions.application.interview", "ADMISSIONS"],
    ["admissions.offer.issued", "ADMISSIONS"],
    ["admissions.application.enrolled", "ADMISSIONS"],
    ["notice.posted", "ANNOUNCEMENTS"],
    ["Circular.new", "ANNOUNCEMENTS"],
    ["announcement.x", "ANNOUNCEMENTS"],
    ["REGISTRATION_PENDING", "SYSTEM"],
    ["something.unknown", "SYSTEM"],
    ["", "SYSTEM"],
  ];
  it.each(table)("%s -> %s", (type, expected) => {
    expect(categoryForType(type)).toBe(expected);
  });
});

describe("priority, urgency and ttl", () => {
  it("derives priority", () => {
    expect(priorityFor("EMERGENCY_DECLARED", "EMERGENCY")).toBe("EMERGENCY");
    expect(priorityFor("EMERGENCY_RESOLVED", "EMERGENCY")).toBe("HIGH");
    expect(priorityFor("PASS_APPROVED", "GATEPASS")).toBe("HIGH");
    expect(priorityFor("fees.payment.captured", "FEES")).toBe("NORMAL");
  });
  it("maps to wire urgency and ttl", () => {
    expect(urgencyFor("EMERGENCY")).toBe("high");
    expect(urgencyFor("HIGH")).toBe("high");
    expect(urgencyFor("NORMAL")).toBe("normal");
    expect(ttlSecondsFor("EMERGENCY")).toBe(86_400);
    expect(ttlSecondsFor("HIGH")).toBe(21_600);
    expect(ttlSecondsFor("NORMAL")).toBe(10_800);
  });
});
