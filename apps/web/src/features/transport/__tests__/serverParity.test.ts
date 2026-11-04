import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  createAssignmentSchema as serverAssignment,
  createDriverSchema as serverDriver,
  createEnrollmentSchema as serverEnrollment,
  createRouteSchema as serverRoute,
  createScheduleSchema as serverSchedule,
  createStopSchema as serverStop,
  createTransportMaintenanceSchema as serverMaintenance,
  createVehicleSchema as serverVehicle,
  patchDriverSchema,
  patchRouteSchema,
  patchScheduleSchema,
  patchStopSchema,
  patchVehicleSchema,
  transportMaintenanceTransitionSchema as serverTransition,
  transportStudentLookupQuerySchema as serverLookup,
} from "@campusgate/shared";
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

function first(schema: z.ZodTypeAny, input: unknown, field: string): string | undefined {
  const r = schema.safeParse(input);
  if (r.success) return undefined;
  return r.error.issues.find((i) => i.path[0] === field)?.message;
}

interface Case {
  field: string;
  client: Record<string, unknown>;
  server: Record<string, unknown>;
}

function expectParity(clientSchema: z.ZodTypeAny, serverSchema: z.ZodTypeAny, cases: Case[]): void {
  for (const c of cases) {
    const client = first(clientSchema, c.client, c.field);
    const server = first(serverSchema, c.server, c.field);
    expect(server, `server must reject ${JSON.stringify(c.server)}`).toBeDefined();
    expect(client, `client message for ${c.field} ${JSON.stringify(c.client)}`).toBe(server);
  }
}

const vehicle = { registrationNo: "KA01", type: "BUS", seatCapacity: "40", status: "ACTIVE" };
const driver = { name: "Ravi", licenseNo: "DL1", phone: "", status: "ACTIVE" };
const route = { name: "North", code: "N1", feeAmount: "", status: "ACTIVE" };
const stop = { name: "Gate", sequence: "1", landmark: "", latitude: "", longitude: "", pickupOffsetMinutes: "" };
const weekly = { mode: "weekly", dayOfWeek: "MON", date: "", stopId: "", departureTime: "08:00", arrivalTime: "" };

describe("transport client messages equal the real shared schemas", () => {
  it("vehicle", () => {
    expectParity(vehicleSchema, serverVehicle, [
      { field: "registrationNo", client: { ...vehicle, registrationNo: "" }, server: { registrationNo: "", type: "BUS", seatCapacity: "4" } },
      { field: "registrationNo", client: { ...vehicle, registrationNo: "a".repeat(33) }, server: { registrationNo: "a".repeat(33), type: "BUS", seatCapacity: "4" } },
      { field: "type", client: { ...vehicle, type: "" }, server: { registrationNo: "a", seatCapacity: "4" } },
      { field: "seatCapacity", client: { ...vehicle, seatCapacity: "" }, server: { registrationNo: "a", type: "BUS", seatCapacity: "" } },
      { field: "seatCapacity", client: { ...vehicle, seatCapacity: "0" }, server: { registrationNo: "a", type: "BUS", seatCapacity: "0" } },
      { field: "seatCapacity", client: { ...vehicle, seatCapacity: "abc" }, server: { registrationNo: "a", type: "BUS", seatCapacity: "abc" } },
      { field: "seatCapacity", client: { ...vehicle, seatCapacity: "1.5" }, server: { registrationNo: "a", type: "BUS", seatCapacity: "1.5" } },
    ]);
  });
  it("driver", () => {
    const sb = { name: "a", licenseNo: "b" };
    expectParity(driverSchema, serverDriver, [
      { field: "name", client: { ...driver, name: "" }, server: { ...sb, name: "" } },
      { field: "name", client: { ...driver, name: "a".repeat(121) }, server: { ...sb, name: "a".repeat(121) } },
      { field: "licenseNo", client: { ...driver, licenseNo: "" }, server: { ...sb, licenseNo: "" } },
      { field: "licenseNo", client: { ...driver, licenseNo: "a".repeat(65) }, server: { ...sb, licenseNo: "a".repeat(65) } },
      { field: "phone", client: { ...driver, phone: "1".repeat(33) }, server: { ...sb, phone: "1".repeat(33) } },
    ]);
  });
  it("route", () => {
    const sb = { name: "a", code: "b" };
    expectParity(routeSchema, serverRoute, [
      { field: "name", client: { ...route, name: "" }, server: { ...sb, name: "" } },
      { field: "code", client: { ...route, code: "" }, server: { ...sb, code: "" } },
      { field: "code", client: { ...route, code: "a".repeat(33) }, server: { ...sb, code: "a".repeat(33) } },
    ]);
  });
  it("stop", () => {
    const sb = { name: "a", sequence: "1" };
    expectParity(stopSchema, serverStop, [
      { field: "name", client: { ...stop, name: "" }, server: { ...sb, name: "" } },
      { field: "sequence", client: { ...stop, sequence: "0" }, server: { ...sb, sequence: "0" } },
      { field: "sequence", client: { ...stop, sequence: "x" }, server: { ...sb, sequence: "x" } },
      { field: "landmark", client: { ...stop, landmark: "a".repeat(201) }, server: { ...sb, landmark: "a".repeat(201) } },
      { field: "latitude", client: { ...stop, latitude: "x" }, server: { ...sb, latitude: "x" } },
      { field: "pickupOffsetMinutes", client: { ...stop, pickupOffsetMinutes: "-1" }, server: { ...sb, pickupOffsetMinutes: "-1" } },
      { field: "pickupOffsetMinutes", client: { ...stop, pickupOffsetMinutes: "1.5" }, server: { ...sb, pickupOffsetMinutes: "1.5" } },
    ]);
  });
  it("schedule", () => {
    expectParity(scheduleSchema, serverSchedule, [
      { field: "dayOfWeek", client: { ...weekly, dayOfWeek: "" }, server: { departureTime: "480" } },
      { field: "dayOfWeek", client: { ...weekly, date: "2026-01-01" }, server: { dayOfWeek: "MON", date: "2026-01-01", departureTime: "480" } },
      { field: "dayOfWeek", client: { ...weekly, dayOfWeek: "XXX" }, server: { dayOfWeek: "XXX", departureTime: "480" } },
      { field: "departureTime", client: { ...weekly, departureTime: "" }, server: { dayOfWeek: "MON", departureTime: "nope" } },
      { field: "date", client: { ...weekly, mode: "date", dayOfWeek: "", date: "nope" }, server: { date: "nope", departureTime: "480" } },
      { field: "arrivalTime", client: { ...weekly, arrivalTime: "99:99" }, server: { dayOfWeek: "MON", departureTime: "480", arrivalTime: "nope" } },
    ]);
  });
  it("assignment, enrollment, maintenance", () => {
    expectParity(assignmentSchema, serverAssignment, [
      { field: "effectiveFrom", client: { vehicleId: "v", driverId: "d", effectiveFrom: "", effectiveTo: "" }, server: { vehicleId: "v", driverId: "d", effectiveFrom: "" } },
      { field: "vehicleId", client: { vehicleId: "", driverId: "d", effectiveFrom: "2026-01-01", effectiveTo: "" }, server: { driverId: "d", effectiveFrom: "2026-01-01" } },
    ]);
    expectParity(enrollmentSchema, serverEnrollment, [
      { field: "studentId", client: { studentId: "", routeId: "r", stopId: "t" }, server: { routeId: "r", stopId: "t" } },
    ]);
    expectParity(transportMaintenanceCreateSchema, serverMaintenance, [
      { field: "issue", client: { vehicleId: "v", issue: "", cost: "" }, server: { vehicleId: "v", issue: "" } },
      { field: "issue", client: { vehicleId: "v", issue: "a".repeat(501), cost: "" }, server: { vehicleId: "v", issue: "a".repeat(501) } },
    ]);
    expectParity(transportMaintenanceTransitionSchema, serverTransition, [
      { field: "toStatus", client: { toStatus: "", cost: "", resolutionNote: "" }, server: {} },
      { field: "toStatus", client: { toStatus: "OPEN", cost: "", resolutionNote: "" }, server: { toStatus: "OPEN" } },
      { field: "resolutionNote", client: { toStatus: "RESOLVED", cost: "", resolutionNote: "a".repeat(501) }, server: { toStatus: "RESOLVED", resolutionNote: "a".repeat(501) } },
    ]);
  });
  it("lookup hint equals the server message", () => {
    const r = serverLookup.safeParse({ q: "a" });
    expect(r.success ? "" : r.error.issues[0].message).toBe("Enter at least 2 characters");
  });
});

describe("builder output passes the real shared schemas", () => {
  it("vehicle, driver, route, stop", () => {
    const v = vehicleSchema.parse(vehicle);
    expect(serverVehicle.safeParse(buildVehicleCreate(v)).success).toBe(true);
    expect(patchVehicleSchema.safeParse(buildVehiclePatch({ registrationNo: true, type: true, seatCapacity: true, status: true }, v)).success).toBe(true);
    const d = driverSchema.parse({ ...driver, phone: "99" });
    expect(serverDriver.safeParse(buildDriverCreate(d)).success).toBe(true);
    expect(patchDriverSchema.safeParse(buildDriverPatch({ name: true, phone: true }, driverSchema.parse(driver))).success).toBe(true);
    const r = routeSchema.parse({ ...route, feeAmount: "1,500.50" });
    expect(serverRoute.safeParse(buildRouteCreate(r)).success).toBe(true);
    expect(patchRouteSchema.safeParse(buildRoutePatch({ feeAmount: true, name: true }, r)).success).toBe(true);
    expect(patchRouteSchema.safeParse(buildRoutePatch({ feeAmount: true }, routeSchema.parse(route))).success).toBe(true);
    const s = stopSchema.parse({ ...stop, landmark: "L", latitude: "1.5", longitude: "2.5", pickupOffsetMinutes: "5" });
    expect(serverStop.safeParse(buildStopCreate(s)).success).toBe(true);
    expect(patchStopSchema.safeParse(buildStopPatch({ landmark: true, latitude: true }, stopSchema.parse(stop))).success).toBe(true);
  });
  it("schedule create and both PATCH directions", () => {
    const w = scheduleSchema.parse({ ...weekly, stopId: "s1", arrivalTime: "09:00" });
    expect(serverSchedule.safeParse(buildScheduleCreate(w)).success).toBe(true);
    const dt = scheduleSchema.parse({ ...weekly, mode: "date", dayOfWeek: "", date: "2026-03-05" });
    expect(serverSchedule.safeParse(buildScheduleCreate(dt)).success).toBe(true);
    expect(patchScheduleSchema.safeParse(buildSchedulePatch({ mode: true, dayOfWeek: true, date: true }, dt)).success).toBe(true);
    expect(patchScheduleSchema.safeParse(buildSchedulePatch({ mode: true, dayOfWeek: true, date: true, arrivalTime: true, stopId: true }, scheduleSchema.parse(weekly))).success).toBe(true);
  });
  it("assignment, enrollment, maintenance", () => {
    const a = assignmentSchema.parse({ vehicleId: "v", driverId: "d", effectiveFrom: "2026-01-01", effectiveTo: "2026-02-01" });
    expect(serverAssignment.safeParse(buildAssignment(a)).success).toBe(true);
    expect(serverEnrollment.safeParse(buildEnrollment(enrollmentSchema.parse({ studentId: "s", routeId: "r", stopId: "t" }))).success).toBe(true);
    const m = transportMaintenanceCreateSchema.parse({ vehicleId: "v", issue: "x", cost: "12.5" });
    expect(serverMaintenance.safeParse(buildTransportMaintenanceCreate(m)).success).toBe(true);
    const t = transportMaintenanceTransitionSchema.parse({ toStatus: "RESOLVED", cost: "12.5", resolutionNote: "ok" });
    expect(serverTransition.safeParse(buildTransportMaintenanceTransition(t)).success).toBe(true);
  });
});
