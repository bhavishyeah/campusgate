import { describe, it, expect } from "vitest";
import {
  attendanceCorrectSchema,
  attendanceRecordSchema,
  buildEmployeeCreate,
  buildEmployeePatch,
  contractFormSchema,
  employeeCreateSchema,
  employeePatchSchema,
  leaveApplySchema,
  leavePolicySchema,
  parseTerms,
  reportRangeSchema,
  shiftPatchSchema,
  shiftSchema,
  toContractBody,
  toCorrectBody,
  toPolicyBody,
  toRecordBody,
  toReviewBody,
  toShiftBody,
  toShiftPatch,
} from "../formSchemas";

function messages(r: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) {
  return r.success ? [] : (r.error?.issues ?? []).map((i) => ({ message: i.message, path: i.path }));
}

const emp = {
  userId: "u1",
  employeeNo: "E-1",
  designation: "",
  employmentType: "PERMANENT" as const,
  departmentId: "",
  joiningDate: "2026-04-01",
  status: "ACTIVE" as const,
};
const contract = { contractType: "PERMANENT" as const, startDate: "2026-04-01", endDate: "", salary: "", terms: "" };
const leave = { leaveType: "CASUAL" as const, startDate: "2026-04-01", endDate: "2026-04-03", reason: "Trip" };

describe("server message parity", () => {
  it("contract end before start", () => {
    const r = contractFormSchema.safeParse({ ...contract, endDate: "2026-03-01" });
    expect(messages(r)).toContainEqual({ message: "endDate must be on or after startDate", path: ["endDate"] });
  });
  it("leave end before start", () => {
    const r = leaveApplySchema.safeParse({ ...leave, endDate: "2026-03-30" });
    expect(messages(r)).toContainEqual({ message: "endDate must be on or after startDate", path: ["endDate"] });
  });
  it("leave multi-year", () => {
    const r = leaveApplySchema.safeParse({ ...leave, startDate: "2026-12-30", endDate: "2027-01-02" });
    expect(messages(r)).toContainEqual({
      message: "leave startDate and endDate must share one calendar year",
      path: ["endDate"],
    });
  });
  it("report range order and length", () => {
    expect(messages(reportRangeSchema.safeParse({ from: "2026-05-02", to: "2026-05-01" }))).toContainEqual({
      message: "to must be on or after from",
      path: ["to"],
    });
    expect(reportRangeSchema.safeParse({ from: "2026-01-01", to: "2027-01-02" }).success).toBe(true); // 366 days
    expect(messages(reportRangeSchema.safeParse({ from: "2026-01-01", to: "2027-01-03" }))).toContainEqual({
      message: "range must not exceed 366 days",
      path: ["to"],
    });
  });
  it("employee and shift patch with no fields", () => {
    expect(messages(employeePatchSchema.safeParse({}))[0].message).toBe("no updatable fields provided");
    expect(messages(shiftPatchSchema.safeParse({}))[0].message).toBe("no updatable fields provided");
    expect(employeePatchSchema.safeParse({ departmentId: null }).success).toBe(true);
  });
});

describe("employee schemas", () => {
  it("employeeNo 64 vs 65 and trim", () => {
    expect(employeeCreateSchema.safeParse({ ...emp, employeeNo: "a".repeat(64) }).success).toBe(true);
    expect(employeeCreateSchema.safeParse({ ...emp, employeeNo: "a".repeat(65) }).success).toBe(false);
    expect(employeeCreateSchema.safeParse({ ...emp, employeeNo: "   " }).success).toBe(false);
  });
  it("user and joining date are required", () => {
    expect(messages(employeeCreateSchema.safeParse({ ...emp, userId: "" }))[0].message).toBe("User is required");
    expect(employeeCreateSchema.safeParse({ ...emp, joiningDate: "" }).success).toBe(false);
  });
  it("designation limit 200", () => {
    expect(employeeCreateSchema.safeParse({ ...emp, designation: "a".repeat(201) }).success).toBe(false);
  });
  it("create body omits blanks", () => {
    expect(buildEmployeeCreate({ ...emp, employeeNo: " E-1 " })).toEqual({
      userId: "u1",
      employeeNo: "E-1",
      employmentType: "PERMANENT",
      joiningDate: "2026-04-01",
      status: "ACTIVE",
    });
  });
  it("patch sends dirty fields, department clear is null, blank designation omitted", () => {
    expect(buildEmployeePatch(emp, { departmentId: true })).toEqual({ departmentId: null });
    expect(buildEmployeePatch(emp, { designation: true })).toEqual({});
    expect(buildEmployeePatch({ ...emp, status: "TERMINATED" }, { status: true })).toEqual({ status: "TERMINATED" });
  });
});

describe("contract form", () => {
  it("terms boundary", () => {
    const fits = JSON.stringify({ k: "a".repeat(16384 - 8) }); // {"k":"..."} is exactly 16384 chars
    expect(JSON.stringify(JSON.parse(fits)).length).toBe(16384);
    expect(parseTerms(fits).ok).toBe(true);
    const over = JSON.stringify({ k: "a".repeat(16384 - 7) });
    expect(JSON.stringify(JSON.parse(over)).length).toBe(16385);
    const r = parseTerms(over);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Terms must be 16 KB or smaller");
  });
  it("whitespace padding does not count (re-serialized length)", () => {
    const padded = `{ "k" : "${"a".repeat(16384 - 8)}" ${" ".repeat(50)} }`;
    expect(padded.length).toBeGreaterThan(16384);
    expect(parseTerms(padded).ok).toBe(true);
  });
  it("terms must be an object", () => {
    for (const bad of ["[]", "null", "1", '"x"', "{oops"]) {
      const r = parseTerms(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("Terms must be a JSON object");
    }
    expect(parseTerms("  ")).toEqual({ ok: true, value: undefined });
  });
  it("salary validation and body", () => {
    expect(contractFormSchema.safeParse({ ...contract, salary: "12.345" }).success).toBe(false);
    expect(contractFormSchema.safeParse({ ...contract, salary: "0" }).success).toBe(true);
    expect(toContractBody({ ...contract, salary: "1,234.5", terms: '{"a":1}', endDate: "2026-12-31" })).toEqual({
      contractType: "PERMANENT",
      startDate: "2026-04-01",
      endDate: "2026-12-31",
      salaryAmount: 123450,
      termsMetadata: { a: 1 },
      currency: "INR",
    });
    expect(toContractBody(contract)).toEqual({ contractType: "PERMANENT", startDate: "2026-04-01", currency: "INR" });
  });
});

describe("leave schemas", () => {
  it("accepts a valid application and limits reason", () => {
    expect(leaveApplySchema.safeParse(leave).success).toBe(true);
    expect(leaveApplySchema.safeParse({ ...leave, reason: "a".repeat(2001) }).success).toBe(false);
    expect(leaveApplySchema.safeParse({ ...leave, reason: " " }).success).toBe(false);
  });
  it("review note is omitted when blank", () => {
    expect(toReviewBody({ reviewNote: " " })).toEqual({});
    expect(toReviewBody({ reviewNote: " ok " })).toEqual({ reviewNote: "ok" });
  });
  it("policy quota is an integer >= 0 with no maximum", () => {
    const base = { annualQuotaDays: "0", accrualRule: "ANNUAL_LUMP_SUM" as const, active: true };
    expect(leavePolicySchema.safeParse(base).success).toBe(true);
    expect(leavePolicySchema.safeParse({ ...base, annualQuotaDays: "9999" }).success).toBe(true);
    expect(leavePolicySchema.safeParse({ ...base, annualQuotaDays: "-1" }).success).toBe(false);
    expect(leavePolicySchema.safeParse({ ...base, annualQuotaDays: "1.5" }).success).toBe(false);
    expect(toPolicyBody({ ...base, annualQuotaDays: "12" })).toEqual({
      annualQuotaDays: 12,
      accrualRule: "ANNUAL_LUMP_SUM",
      active: true,
    });
  });
});

describe("shift schemas", () => {
  const shift = { name: "Morning", startTime: "09:00", endTime: "17:30", active: true };
  it("converts times to minutes", () => {
    expect(toShiftBody(shift)).toEqual({ name: "Morning", startMinute: 540, endMinute: 1050, active: true });
    expect(toShiftBody({ ...shift, endTime: "23:59" }).endMinute).toBe(1439);
  });
  it("rejects bad names and times", () => {
    expect(shiftSchema.safeParse({ ...shift, name: " " }).success).toBe(false);
    expect(shiftSchema.safeParse({ ...shift, name: "a".repeat(201) }).success).toBe(false);
    expect(shiftSchema.safeParse({ ...shift, startTime: "24:00" }).success).toBe(false);
    expect(shiftSchema.safeParse({ ...shift, endTime: "" }).success).toBe(false);
  });
  it("allows an overnight shift (end before start)", () => {
    expect(shiftSchema.safeParse({ ...shift, startTime: "22:00", endTime: "06:00" }).success).toBe(true);
  });
  it("patch sends dirty fields only", () => {
    expect(toShiftPatch(shift, { startTime: true, active: true })).toEqual({ startMinute: 540, active: true });
  });
});

describe("attendance schemas", () => {
  const rec = { status: "PRESENT" as const, source: "MANUAL" as const, shiftId: "" };
  it("record body", () => {
    expect(attendanceRecordSchema.safeParse(rec).success).toBe(true);
    expect(toRecordBody("2026-04-01", rec)).toEqual({ attendanceDate: "2026-04-01", status: "PRESENT", source: "MANUAL" });
    expect(toRecordBody("2026-04-01", { ...rec, shiftId: "s1" }).shiftId).toBe("s1");
  });
  it("correct body clears the shift with null and limits reason", () => {
    const c = { ...rec, reason: "" };
    expect(attendanceCorrectSchema.safeParse(c).success).toBe(true);
    expect(attendanceCorrectSchema.safeParse({ ...c, reason: "a".repeat(2001) }).success).toBe(false);
    expect(toCorrectBody(c)).toEqual({ status: "PRESENT", source: "MANUAL", shiftId: null });
    expect(toCorrectBody({ ...c, reason: " late " }).reason).toBe("late");
  });
});
