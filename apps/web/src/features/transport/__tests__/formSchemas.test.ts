import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  assignmentSchema,
  buildAssignment,
  buildDriverCreate,
  buildDriverPatch,
  buildEnrollment,
  buildRouteCreate,
  buildRoutePatch,
  buildScheduleCreate,
  buildSchedulePatch,
  buildStopCreate,
  buildStopPatch,
  buildTransportMaintenanceCreate,
  buildTransportMaintenanceTransition,
  buildVehicleCreate,
  buildVehiclePatch,
  driverSchema,
  enrollmentSchema,
  routeSchema,
  scheduleSchema,
  stopSchema,
  transportMaintenanceCreateSchema,
  transportMaintenanceTransitionSchema,
  vehicleSchema,
} from "../formSchemas";
import { paiseToRupeeInput } from "../money";

function messages(schema: z.ZodTypeAny, input: unknown): Record<string, string> {
  const r = schema.safeParse(input);
  const out: Record<string, string> = {};
  if (!r.success) {
    for (const i of r.error.issues) {
      const k = i.path.join(".");
      if (!(k in out)) out[k] = i.message;
    }
  }
  return out;
}

const vehicle = { registrationNo: "KA01", type: "BUS", seatCapacity: "40", status: "ACTIVE" };
const driver = { name: "Ravi", licenseNo: "DL1", phone: "", status: "ACTIVE" };
const route = { name: "North", code: "N1", feeAmount: "", status: "ACTIVE" };
const stop = { name: "Gate", sequence: "1", landmark: "", latitude: "", longitude: "", pickupOffsetMinutes: "" };
const weekly = { mode: "weekly", dayOfWeek: "MON", date: "", stopId: "", departureTime: "08:00", arrivalTime: "" };

describe("literal message pins", () => {
  it("required texts", () => {
    expect(messages(vehicleSchema, { ...vehicle, registrationNo: "" }).registrationNo).toBe("Registration number is required");
    expect(messages(driverSchema, { ...driver, name: "" }).name).toBe("Name is required");
    expect(messages(driverSchema, { ...driver, licenseNo: "" }).licenseNo).toBe("License number is required");
    expect(messages(routeSchema, { ...route, name: "" }).name).toBe("Name is required");
    expect(messages(routeSchema, { ...route, code: "" }).code).toBe("Code is required");
    expect(messages(stopSchema, { ...stop, name: "" }).name).toBe("Name is required");
    expect(messages(transportMaintenanceCreateSchema, { vehicleId: "v", issue: "", cost: "" }).issue).toBe("Issue is required");
    expect(messages(vehicleSchema, { ...vehicle, registrationNo: "  " }).registrationNo).toBe("Registration number is required");
  });
  it("schedule exactly-one rule on create and edit shapes", () => {
    expect(messages(scheduleSchema, { ...weekly, dayOfWeek: "" }).dayOfWeek).toBe("exactly one of dayOfWeek or date is required");
    expect(messages(scheduleSchema, { ...weekly, date: "2026-01-01" }).dayOfWeek).toBe("exactly one of dayOfWeek or date is required");
  });
  it("assignment date order", () => {
    const m = messages(assignmentSchema, { vehicleId: "v", driverId: "d", effectiveFrom: "2026-02-02", effectiveTo: "2026-02-01" });
    expect(m.effectiveTo).toBe("effectiveTo must be on or after effectiveFrom");
    expect(
      assignmentSchema.safeParse({ vehicleId: "v", driverId: "d", effectiveFrom: "2026-02-02", effectiveTo: "" }).success,
    ).toBe(true);
  });
  it("pickers need a value", () => {
    expect(messages(enrollmentSchema, { studentId: "", routeId: "", stopId: "" })).toEqual({
      studentId: "Required",
      routeId: "Required",
      stopId: "Required",
    });
  });
  it("rupee amounts use the money messages", () => {
    expect(messages(routeSchema, { ...route, feeAmount: "1.234" }).feeAmount).toBe("Enter a valid amount (digits with up to two decimals).");
    expect(messages(routeSchema, { ...route, feeAmount: "0" }).feeAmount).toBe("Amount must be greater than zero.");
    expect(messages(transportMaintenanceTransitionSchema, { toStatus: "RESOLVED", cost: "abc", resolutionNote: "" }).cost).toBe(
      "Enter a valid amount (digits with up to two decimals).",
    );
  });
});

describe("boundaries", () => {
  it("name 120/121, license 64/65, phone 32/33, code 32/33", () => {
    expect(driverSchema.safeParse({ ...driver, name: "a".repeat(120) }).success).toBe(true);
    expect(messages(driverSchema, { ...driver, name: "a".repeat(121) }).name).toBe("String must contain at most 120 character(s)");
    expect(driverSchema.safeParse({ ...driver, licenseNo: "a".repeat(64) }).success).toBe(true);
    expect(messages(driverSchema, { ...driver, licenseNo: "a".repeat(65) }).licenseNo).toBe("String must contain at most 64 character(s)");
    expect(driverSchema.safeParse({ ...driver, phone: "1".repeat(32) }).success).toBe(true);
    expect(messages(driverSchema, { ...driver, phone: "1".repeat(33) }).phone).toBe("String must contain at most 32 character(s)");
    expect(routeSchema.safeParse({ ...route, code: "a".repeat(32) }).success).toBe(true);
    expect(messages(routeSchema, { ...route, code: "a".repeat(33) }).code).toBe("String must contain at most 32 character(s)");
    expect(messages(routeSchema, { ...route, name: "a".repeat(121) }).name).toBe("String must contain at most 120 character(s)");
  });
});

describe("R2: times", () => {
  it("a blank departure time is rejected and never becomes 00:00", () => {
    expect(messages(scheduleSchema, { ...weekly, departureTime: "" }).departureTime).toBe("Expected number, received nan");
    expect(messages(scheduleSchema, { ...weekly, departureTime: "25:00" }).departureTime).toBe("Expected number, received nan");
    const ok = scheduleSchema.parse({ ...weekly, departureTime: "00:00" });
    expect(ok.departureTime).toBe(0);
  });
  it("a blank arrival is omitted on create and null on a dirty patch", () => {
    const v = scheduleSchema.parse(weekly);
    expect(buildScheduleCreate(v)).toEqual({ departureTime: 480, dayOfWeek: "MON" });
    expect("arrivalTime" in buildScheduleCreate(v)).toBe(false);
    expect(buildSchedulePatch({ arrivalTime: true }, v)).toEqual({ arrivalTime: null });
    const withArrival = scheduleSchema.parse({ ...weekly, arrivalTime: "09:15" });
    expect(buildScheduleCreate(withArrival).arrivalTime).toBe(555);
    expect(messages(scheduleSchema, { ...weekly, arrivalTime: "99:99" }).arrivalTime).toBe("Expected number, received nan");
  });
});

describe("builders", () => {
  it("vehicle", () => {
    const v = vehicleSchema.parse(vehicle);
    expect(buildVehicleCreate(v)).toEqual({ registrationNo: "KA01", type: "BUS", seatCapacity: 40, status: "ACTIVE" });
    expect(buildVehiclePatch({ seatCapacity: true }, v)).toEqual({ seatCapacity: 40 });
    expect(buildVehiclePatch({}, v)).toEqual({});
  });
  it("driver: blank phone omitted on create, null when dirty on patch", () => {
    const v = driverSchema.parse(driver);
    expect(buildDriverCreate(v)).toEqual({ name: "Ravi", licenseNo: "DL1", status: "ACTIVE" });
    expect(buildDriverPatch({ phone: true }, v)).toEqual({ phone: null });
    expect(buildDriverCreate(driverSchema.parse({ ...driver, phone: "99" })).phone).toBe("99");
  });
  it("route fee converts rupees to paise", () => {
    expect(buildRouteCreate(routeSchema.parse({ ...route, feeAmount: "1,500.5" })).feeAmount).toBe("150050");
    expect("feeAmount" in buildRouteCreate(routeSchema.parse(route))).toBe(false);
  });
  it("route patch: blank + dirty fee is null; stored zero edit with a name change yields {name}", () => {
    const blank = routeSchema.parse(route);
    expect(buildRoutePatch({ feeAmount: true }, blank)).toEqual({ feeAmount: null });
    const prefill = paiseToRupeeInput("0");
    const zeroFee = routeSchema.parse({ ...route, name: "Renamed", feeAmount: prefill });
    expect(buildRoutePatch({ name: true }, zeroFee)).toEqual({ name: "Renamed" });
  });
  it("stop", () => {
    const v = stopSchema.parse({ ...stop, landmark: "Temple", latitude: "12.5", pickupOffsetMinutes: "0" });
    expect(buildStopCreate(v)).toEqual({ name: "Gate", sequence: 1, landmark: "Temple", latitude: 12.5, pickupOffsetMinutes: 0 });
    const cleared = stopSchema.parse(stop);
    expect(buildStopPatch({ landmark: true, latitude: true, longitude: true, pickupOffsetMinutes: true }, cleared)).toEqual({
      landmark: null,
      latitude: null,
      longitude: null,
      pickupOffsetMinutes: null,
    });
  });
  it("schedule PATCH weekly -> date carries both keys", () => {
    const v = scheduleSchema.parse({ ...weekly, mode: "date", dayOfWeek: "", date: "2026-03-05" });
    expect(buildSchedulePatch({ mode: true, dayOfWeek: true, date: true }, v)).toEqual({
      dayOfWeek: null,
      date: "2026-03-05T00:00:00.000Z",
    });
  });
  it("schedule PATCH date -> weekly carries both keys", () => {
    const v = scheduleSchema.parse({ ...weekly, mode: "weekly", dayOfWeek: "TUE", date: "" });
    expect(buildSchedulePatch({ mode: true, dayOfWeek: true, date: true }, v)).toEqual({ dayOfWeek: "TUE", date: null });
    expect(buildSchedulePatch({ date: true }, v)).toEqual({ dayOfWeek: "TUE", date: null });
  });
  it("schedule PATCH without day/date changes leaves them out", () => {
    const v = scheduleSchema.parse({ ...weekly, stopId: "s1", departureTime: "07:30" });
    expect(buildSchedulePatch({ stopId: true, departureTime: true }, v)).toEqual({ stopId: "s1", departureTime: 450 });
    const noStop = scheduleSchema.parse(weekly);
    expect(buildSchedulePatch({ stopId: true }, noStop)).toEqual({ stopId: null });
  });
  it("assignment dates become ISO", () => {
    const v = assignmentSchema.parse({ vehicleId: "v", driverId: "d", effectiveFrom: "2026-02-01", effectiveTo: "2026-03-01" });
    expect(buildAssignment(v)).toEqual({
      vehicleId: "v",
      driverId: "d",
      effectiveFrom: "2026-02-01T00:00:00.000Z",
      effectiveTo: "2026-03-01T00:00:00.000Z",
    });
    const open = assignmentSchema.parse({ vehicleId: "v", driverId: "d", effectiveFrom: "2026-02-01", effectiveTo: "" });
    expect("effectiveTo" in buildAssignment(open)).toBe(false);
  });
  it("enrollment", () => {
    expect(buildEnrollment(enrollmentSchema.parse({ studentId: "s", routeId: "r", stopId: "t" }))).toEqual({
      studentId: "s",
      routeId: "r",
      stopId: "t",
    });
  });
  it("maintenance cost becomes a digit string; zero-cost name-only edit is not an issue", () => {
    const create = transportMaintenanceCreateSchema.parse({ vehicleId: "v", issue: "Brakes", cost: "250.50" });
    expect(buildTransportMaintenanceCreate(create)).toEqual({ vehicleId: "v", issue: "Brakes", cost: "25050" });
    const none = transportMaintenanceCreateSchema.parse({ vehicleId: "v", issue: "Brakes", cost: paiseToRupeeInput("0") });
    expect("cost" in buildTransportMaintenanceCreate(none)).toBe(false);
    const t = transportMaintenanceTransitionSchema.parse({ toStatus: "RESOLVED", cost: "10", resolutionNote: "done" });
    expect(buildTransportMaintenanceTransition(t)).toEqual({ toStatus: "RESOLVED", cost: "1000", resolutionNote: "done" });
    expect(
      buildTransportMaintenanceTransition(transportMaintenanceTransitionSchema.parse({ toStatus: "CANCELLED", cost: "", resolutionNote: "" })),
    ).toEqual({ toStatus: "CANCELLED" });
  });
});
