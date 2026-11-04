import { z } from "zod";
import { optInt, optNumber, optText, optTime, reqDate, reqEnum, reqId, reqInt, reqText, reqTime } from "@/lib/formFields";
import { rupeesToPaise } from "./money";

export const VEHICLE_TYPES = ["BUS", "VAN", "CAR", "OTHER"] as const;
export const VEHICLE_STATUSES = ["ACTIVE", "INACTIVE", "MAINTENANCE"] as const;
export const DRIVER_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export const ROUTE_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export const DAYS_OF_WEEK = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export const MAINTENANCE_TARGETS = ["IN_PROGRESS", "RESOLVED", "CANCELLED"] as const;

export const ASSIGNMENT_DATE_MESSAGE = "effectiveTo must be on or after effectiveFrom";
export const LOOKUP_HINT = "Enter at least 2 characters";
export const SCHEDULE_XOR_MESSAGE = "exactly one of dayOfWeek or date is required";

/** Dirty-field map as produced by react-hook-form (`formState.dirtyFields`). */
export type Dirty<T> = Partial<Record<keyof T, unknown>>;

/**
 * Optional rupee input -> paise digit string. Blank is undefined (no fee / no cost).
 * The messages come from lib/money.ts (the server only sees paise).
 */
export const rupeeAmount = () =>
  z.string().transform((v, ctx): string | undefined => {
    if (v.trim() === "") return undefined;
    try {
      return rupeesToPaise(v);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: err instanceof Error ? err.message : "Invalid amount" });
      return z.NEVER;
    }
  });

const optDate = () =>
  z
    .string()
    .transform((v) => (v.trim() === "" ? undefined : v))
    .pipe(z.coerce.date().optional());

// ── Vehicles ──
export const vehicleSchema = z.object({
  registrationNo: reqText("Registration number is required", 32),
  type: reqEnum(VEHICLE_TYPES),
  seatCapacity: reqInt({ min: 1 }),
  status: reqEnum(VEHICLE_STATUSES),
});
export type VehicleValues = z.output<typeof vehicleSchema>;

export const buildVehicleCreate = (v: VehicleValues) => ({
  registrationNo: v.registrationNo,
  type: v.type,
  seatCapacity: v.seatCapacity,
  status: v.status,
});

export function buildVehiclePatch(dirty: Dirty<VehicleValues>, v: VehicleValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dirty.registrationNo) body.registrationNo = v.registrationNo;
  if (dirty.type) body.type = v.type;
  if (dirty.seatCapacity) body.seatCapacity = v.seatCapacity;
  if (dirty.status) body.status = v.status;
  return body;
}

// ── Drivers ──
export const driverSchema = z.object({
  name: reqText("Name is required", 120),
  licenseNo: reqText("License number is required", 64),
  phone: optText(32),
  status: reqEnum(DRIVER_STATUSES),
});
export type DriverValues = z.output<typeof driverSchema>;

export function buildDriverCreate(v: DriverValues): Record<string, unknown> {
  const body: Record<string, unknown> = { name: v.name, licenseNo: v.licenseNo, status: v.status };
  if (v.phone !== undefined) body.phone = v.phone;
  return body;
}

export function buildDriverPatch(dirty: Dirty<DriverValues>, v: DriverValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dirty.name) body.name = v.name;
  if (dirty.licenseNo) body.licenseNo = v.licenseNo;
  if (dirty.phone) body.phone = v.phone === undefined ? null : v.phone;
  if (dirty.status) body.status = v.status;
  return body;
}

// ── Routes ──
export const routeSchema = z.object({
  name: reqText("Name is required", 120),
  code: reqText("Code is required", 32),
  feeAmount: rupeeAmount(),
  status: reqEnum(ROUTE_STATUSES),
});
export type RouteValues = z.output<typeof routeSchema>;

export function buildRouteCreate(v: RouteValues): Record<string, unknown> {
  const body: Record<string, unknown> = { name: v.name, code: v.code, status: v.status };
  if (v.feeAmount !== undefined) body.feeAmount = v.feeAmount;
  return body;
}

/** Blank + dirty fee sends null (clears it). A stored zero prefills blank, so it is never dirty by itself. */
export function buildRoutePatch(dirty: Dirty<RouteValues>, v: RouteValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dirty.name) body.name = v.name;
  if (dirty.code) body.code = v.code;
  if (dirty.feeAmount) body.feeAmount = v.feeAmount === undefined ? null : v.feeAmount;
  if (dirty.status) body.status = v.status;
  return body;
}

// ── Stops ──
export const stopSchema = z.object({
  name: reqText("Name is required", 120),
  sequence: reqInt({ min: 1 }),
  landmark: optText(200),
  latitude: optNumber(),
  longitude: optNumber(),
  pickupOffsetMinutes: optInt({ min: 0 }),
});
export type StopValues = z.output<typeof stopSchema>;

export function buildStopCreate(v: StopValues): Record<string, unknown> {
  const body: Record<string, unknown> = { name: v.name, sequence: v.sequence };
  if (v.landmark !== undefined) body.landmark = v.landmark;
  if (v.latitude !== undefined) body.latitude = v.latitude;
  if (v.longitude !== undefined) body.longitude = v.longitude;
  if (v.pickupOffsetMinutes !== undefined) body.pickupOffsetMinutes = v.pickupOffsetMinutes;
  return body;
}

export function buildStopPatch(dirty: Dirty<StopValues>, v: StopValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dirty.name) body.name = v.name;
  if (dirty.sequence) body.sequence = v.sequence;
  if (dirty.landmark) body.landmark = v.landmark === undefined ? null : v.landmark;
  if (dirty.latitude) body.latitude = v.latitude === undefined ? null : v.latitude;
  if (dirty.longitude) body.longitude = v.longitude === undefined ? null : v.longitude;
  if (dirty.pickupOffsetMinutes) {
    body.pickupOffsetMinutes = v.pickupOffsetMinutes === undefined ? null : v.pickupOffsetMinutes;
  }
  return body;
}

// ── Schedules ──
export const scheduleSchema = z
  .object({
    mode: z.enum(["weekly", "date"]),
    dayOfWeek: z
      .string()
      .transform((v) => (v === "" ? undefined : v))
      .pipe(z.enum(DAYS_OF_WEEK).optional()),
    date: optDate(),
    stopId: z.string(),
    departureTime: reqTime(),
    arrivalTime: optTime(),
  })
  .refine((v) => (v.dayOfWeek !== undefined) !== (v.date !== undefined), {
    message: SCHEDULE_XOR_MESSAGE,
    path: ["dayOfWeek"],
  });
export type ScheduleValues = z.output<typeof scheduleSchema>;

export function buildScheduleCreate(v: ScheduleValues): Record<string, unknown> {
  const body: Record<string, unknown> = { departureTime: v.departureTime };
  if (v.stopId !== "") body.stopId = v.stopId;
  if (v.dayOfWeek !== undefined) body.dayOfWeek = v.dayOfWeek;
  if (v.date !== undefined) body.date = v.date.toISOString();
  if (v.arrivalTime !== undefined) body.arrivalTime = v.arrivalTime;
  return body;
}

/**
 * PATCH carries BOTH dayOfWeek and date whenever the mode or either value is dirty, one of them
 * null: the server has no exactly-one check on PATCH and the DB CHECK would answer 500 otherwise.
 */
export function buildSchedulePatch(dirty: Dirty<ScheduleValues>, v: ScheduleValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dirty.mode || dirty.dayOfWeek || dirty.date) {
    body.dayOfWeek = v.dayOfWeek === undefined ? null : v.dayOfWeek;
    body.date = v.date === undefined ? null : v.date.toISOString();
  }
  if (dirty.stopId) body.stopId = v.stopId === "" ? null : v.stopId;
  if (dirty.departureTime) body.departureTime = v.departureTime;
  if (dirty.arrivalTime) body.arrivalTime = v.arrivalTime === undefined ? null : v.arrivalTime;
  return body;
}

// ── Assignment ──
export const assignmentSchema = z
  .object({
    vehicleId: reqId(),
    driverId: reqId(),
    effectiveFrom: reqDate(),
    effectiveTo: optDate(),
  })
  .refine((v) => v.effectiveTo === undefined || v.effectiveTo >= v.effectiveFrom, {
    message: ASSIGNMENT_DATE_MESSAGE,
    path: ["effectiveTo"],
  });
export type AssignmentValues = z.output<typeof assignmentSchema>;

export function buildAssignment(v: AssignmentValues): Record<string, unknown> {
  const body: Record<string, unknown> = {
    vehicleId: v.vehicleId,
    driverId: v.driverId,
    effectiveFrom: v.effectiveFrom.toISOString(),
  };
  if (v.effectiveTo !== undefined) body.effectiveTo = v.effectiveTo.toISOString();
  return body;
}

// ── Enrollment ──
export const enrollmentSchema = z.object({ studentId: reqId(), routeId: reqId(), stopId: reqId() });
export type EnrollmentValues = z.output<typeof enrollmentSchema>;
export const buildEnrollment = (v: EnrollmentValues) => ({
  studentId: v.studentId,
  routeId: v.routeId,
  stopId: v.stopId,
});

// ── Maintenance ──
export const transportMaintenanceCreateSchema = z.object({
  vehicleId: reqId(),
  issue: reqText("Issue is required", 500),
  cost: rupeeAmount(),
});
export type TransportMaintenanceCreateValues = z.output<typeof transportMaintenanceCreateSchema>;

export function buildTransportMaintenanceCreate(v: TransportMaintenanceCreateValues): Record<string, unknown> {
  const body: Record<string, unknown> = { vehicleId: v.vehicleId, issue: v.issue };
  if (v.cost !== undefined) body.cost = v.cost;
  return body;
}

export const transportMaintenanceTransitionSchema = z.object({
  toStatus: reqEnum(MAINTENANCE_TARGETS),
  cost: rupeeAmount(),
  resolutionNote: optText(500),
});
export type TransportMaintenanceTransitionValues = z.output<typeof transportMaintenanceTransitionSchema>;

export function buildTransportMaintenanceTransition(v: TransportMaintenanceTransitionValues): Record<string, unknown> {
  const body: Record<string, unknown> = { toStatus: v.toStatus };
  if (v.cost !== undefined) body.cost = v.cost;
  if (v.resolutionNote !== undefined) body.resolutionNote = v.resolutionNote;
  return body;
}
