import { z } from "zod";
import { optText, reqDate, reqEnum, reqId, reqInt, optInt, reqText } from "@/lib/formFields";

export const BUILDING_TYPES = ["BOYS", "GIRLS", "MIXED", "STAFF"] as const;
export const ROOM_STATUSES = ["AVAILABLE", "FULL", "MAINTENANCE", "CLOSED"] as const;
export const CHECK_EVENT_TYPES = ["CHECK_IN", "CHECK_OUT"] as const;
export const MAINTENANCE_TARGETS = ["IN_PROGRESS", "RESOLVED", "CANCELLED"] as const;

/** Messages that are not server strings (documented client-only exceptions). */
export const DUPLICATE_BUILDING_MESSAGE = "A building with this name already exists";
export const LOOKUP_HINT = "Enter at least 2 characters";

/** Dirty-field map as produced by react-hook-form (`formState.dirtyFields`). */
export type Dirty<T> = Partial<Record<keyof T, unknown>>;

// ── Buildings ──
export const buildingSchema = z.object({
  name: reqText("Name is required", 120),
  type: reqEnum(BUILDING_TYPES),
  wardenUserId: z.string(),
  isActive: z.boolean(),
});
export type BuildingValues = z.output<typeof buildingSchema>;

export function buildBuildingCreate(v: BuildingValues): Record<string, unknown> {
  const body: Record<string, unknown> = { name: v.name, type: v.type, isActive: v.isActive };
  if (v.wardenUserId !== "") body.wardenUserId = v.wardenUserId;
  return body;
}

/** PATCH: dirty fields only; a cleared warden sends null. */
export function buildBuildingPatch(dirty: Dirty<BuildingValues>, v: BuildingValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dirty.name) body.name = v.name;
  if (dirty.type) body.type = v.type;
  if (dirty.wardenUserId) body.wardenUserId = v.wardenUserId === "" ? null : v.wardenUserId;
  if (dirty.isActive) body.isActive = v.isActive;
  return body;
}

/**
 * Client pre-check for the unique building name (the server answers 500 on a clash).
 * Only reliable when every building was loaded (total <= 100).
 */
export function hasDuplicateBuildingName(
  name: string,
  buildings: readonly { id: string; name: string }[],
  total: number,
  ignoreId?: string,
): boolean {
  if (total > 100) return false;
  const n = name.trim();
  if (n === "") return false;
  return buildings.some((b) => b.id !== ignoreId && b.name === n);
}

// ── Rooms ──
export const roomCreateSchema = z.object({
  buildingId: reqId(),
  roomNumber: reqText("Room number is required", 32),
  capacity: reqInt({ min: 1, max: 64 }),
  floor: optInt({ min: 0, max: 200 }),
});
export type RoomCreateValues = z.output<typeof roomCreateSchema>;

/** Edit form: capacity has no upper bound (patchRoomSchema); a blank room number shows the create text. */
export const roomPatchSchema = z.object({
  roomNumber: reqText("Room number is required", 32),
  capacity: reqInt({ min: 1 }),
  floor: optInt({ min: 0, max: 200 }),
  status: reqEnum(ROOM_STATUSES),
});
export type RoomPatchValues = z.output<typeof roomPatchSchema>;

export function buildRoomCreate(v: RoomCreateValues): Record<string, unknown> {
  const body: Record<string, unknown> = { roomNumber: v.roomNumber, capacity: v.capacity };
  if (v.floor !== undefined) body.floor = v.floor;
  return body;
}

export function buildRoomPatch(dirty: Dirty<RoomPatchValues>, v: RoomPatchValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dirty.roomNumber) body.roomNumber = v.roomNumber;
  if (dirty.capacity) body.capacity = v.capacity;
  if (dirty.floor) body.floor = v.floor === undefined ? null : v.floor;
  if (dirty.status) body.status = v.status;
  return body;
}

// ── Allocation ──
export const allocateSchema = z.object({ roomId: reqId(), studentId: reqId() });
export type AllocateValues = z.output<typeof allocateSchema>;
export const buildAllocate = (v: AllocateValues) => ({ roomId: v.roomId, studentId: v.studentId });

export const transferSchema = z.object({ toRoomId: reqId() });
export type TransferValues = z.output<typeof transferSchema>;
export const buildTransfer = (v: TransferValues) => ({ toRoomId: v.toRoomId });

export const checkEventSchema = z.object({
  eventType: reqEnum(CHECK_EVENT_TYPES),
  occurredAt: z.string().refine((v) => v === "" || !Number.isNaN(new Date(v).getTime()), { message: "Invalid date" }),
});
export type CheckEventValues = z.output<typeof checkEventSchema>;

/** A blank time is omitted so the server uses now. */
export function buildCheckEvent(v: CheckEventValues): Record<string, unknown> {
  const body: Record<string, unknown> = { eventType: v.eventType };
  if (v.occurredAt !== "") body.occurredAt = new Date(v.occurredAt).toISOString();
  return body;
}

// ── Leave ──
export const leaveApplySchema = z
  .object({
    fromDate: reqDate(),
    toDate: reqDate(),
    reason: reqText("Reason is required", 500),
  })
  .refine((v) => v.toDate >= v.fromDate, { message: "toDate must be on or after fromDate", path: ["toDate"] });
export type LeaveApplyValues = z.output<typeof leaveApplySchema>;

export function buildLeaveApply(v: LeaveApplyValues): Record<string, unknown> {
  return { fromDate: v.fromDate.toISOString(), toDate: v.toDate.toISOString(), reason: v.reason };
}

export const decisionSchema = z.object({ decisionNote: optText(500) });
export type DecisionValues = z.output<typeof decisionSchema>;

/** Blank note sends {} (the body is strict and the note optional). */
export function buildDecision(v: DecisionValues): Record<string, unknown> {
  return v.decisionNote === undefined ? {} : { decisionNote: v.decisionNote };
}

// ── Maintenance ──
export const maintenanceCreateSchema = z.object({
  roomId: reqId(),
  issue: reqText("Issue is required", 500),
});
export type MaintenanceCreateValues = z.output<typeof maintenanceCreateSchema>;
export const buildMaintenanceCreate = (v: MaintenanceCreateValues) => ({ roomId: v.roomId, issue: v.issue });

export const maintenanceTransitionSchema = z.object({
  toStatus: reqEnum(MAINTENANCE_TARGETS),
  resolutionNote: optText(500),
});
export type MaintenanceTransitionValues = z.output<typeof maintenanceTransitionSchema>;

export function buildMaintenanceTransition(v: MaintenanceTransitionValues): Record<string, unknown> {
  const body: Record<string, unknown> = { toStatus: v.toStatus };
  if (v.resolutionNote !== undefined) body.resolutionNote = v.resolutionNote;
  return body;
}
