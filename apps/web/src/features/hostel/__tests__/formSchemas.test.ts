import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  allocateSchema,
  buildAllocate,
  buildBuildingCreate,
  buildBuildingPatch,
  buildCheckEvent,
  buildDecision,
  buildLeaveApply,
  buildMaintenanceCreate,
  buildMaintenanceTransition,
  buildRoomCreate,
  buildRoomPatch,
  buildTransfer,
  buildingSchema,
  checkEventSchema,
  decisionSchema,
  hasDuplicateBuildingName,
  leaveApplySchema,
  maintenanceCreateSchema,
  maintenanceTransitionSchema,
  roomCreateSchema,
  roomPatchSchema,
  transferSchema,
} from "../formSchemas";

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

const goodBuilding = { name: "Block A", type: "BOYS", wardenUserId: "", isActive: true };
const goodRoom = { buildingId: "b1", roomNumber: "101", capacity: "4", floor: "" };

describe("literal message pins", () => {
  it("building name", () => {
    expect(messages(buildingSchema, { ...goodBuilding, name: "" }).name).toBe("Name is required");
    expect(messages(buildingSchema, { ...goodBuilding, name: "   " }).name).toBe("Name is required");
  });
  it("room number", () => {
    expect(messages(roomCreateSchema, { ...goodRoom, roomNumber: "" }).roomNumber).toBe("Room number is required");
  });
  it("leave reason", () => {
    const base = { fromDate: "2026-01-01", toDate: "2026-01-02", reason: "" };
    expect(messages(leaveApplySchema, base).reason).toBe("Reason is required");
  });
  it("maintenance issue", () => {
    expect(messages(maintenanceCreateSchema, { roomId: "r", issue: "" }).issue).toBe("Issue is required");
  });
  it("leave date order", () => {
    const m = messages(leaveApplySchema, { fromDate: "2026-02-02", toDate: "2026-02-01", reason: "x" });
    expect(m.toDate).toBe("toDate must be on or after fromDate");
    expect(Object.keys(m)).toEqual(["toDate"]);
  });
  it("date order is not checked when a date is invalid", () => {
    const m = messages(leaveApplySchema, { fromDate: "", toDate: "2026-02-01", reason: "x" });
    expect(m.fromDate).toBe("Invalid date");
    expect(m.toDate).toBeUndefined();
  });
  it("pickers", () => {
    expect(messages(allocateSchema, { roomId: "", studentId: "" })).toEqual({ roomId: "Required", studentId: "Required" });
    expect(messages(transferSchema, { toRoomId: "" })).toEqual({ toRoomId: "Required" });
  });
});

describe("boundaries", () => {
  it("room number 32 ok, 33 fails", () => {
    expect(roomCreateSchema.safeParse({ ...goodRoom, roomNumber: "a".repeat(32) }).success).toBe(true);
    expect(messages(roomCreateSchema, { ...goodRoom, roomNumber: "a".repeat(33) }).roomNumber).toBe(
      "String must contain at most 32 character(s)",
    );
  });
  it("capacity 64 ok, 65 and 0 fail", () => {
    expect(roomCreateSchema.safeParse({ ...goodRoom, capacity: "64" }).success).toBe(true);
    expect(messages(roomCreateSchema, { ...goodRoom, capacity: "65" }).capacity).toBe("Number must be less than or equal to 64");
    expect(messages(roomCreateSchema, { ...goodRoom, capacity: "0" }).capacity).toBe("Number must be greater than or equal to 1");
  });
  it("edit capacity has no upper bound", () => {
    expect(roomPatchSchema.safeParse({ roomNumber: "1", capacity: "500", floor: "", status: "AVAILABLE" }).success).toBe(true);
  });
  it("floor 200 ok, 201 fails", () => {
    expect(roomCreateSchema.safeParse({ ...goodRoom, floor: "200" }).success).toBe(true);
    expect(messages(roomCreateSchema, { ...goodRoom, floor: "201" }).floor).toBe("Number must be less than or equal to 200");
  });
  it("building name 120 ok, 121 fails", () => {
    expect(buildingSchema.safeParse({ ...goodBuilding, name: "a".repeat(120) }).success).toBe(true);
    expect(messages(buildingSchema, { ...goodBuilding, name: "a".repeat(121) }).name).toBe(
      "String must contain at most 120 character(s)",
    );
  });
  it("notes 500 ok, 501 fails", () => {
    expect(decisionSchema.safeParse({ decisionNote: "a".repeat(500) }).success).toBe(true);
    expect(messages(decisionSchema, { decisionNote: "a".repeat(501) }).decisionNote).toBe(
      "String must contain at most 500 character(s)",
    );
    expect(messages(maintenanceTransitionSchema, { toStatus: "RESOLVED", resolutionNote: "a".repeat(501) }).resolutionNote).toBe(
      "String must contain at most 500 character(s)",
    );
  });
});

describe("PATCH-blank text differs from the server on purpose", () => {
  it("the edit form shows the create required text (server says String must contain at least 1 character(s))", () => {
    expect(messages(roomPatchSchema, { roomNumber: "", capacity: "4", floor: "", status: "AVAILABLE" }).roomNumber).toBe(
      "Room number is required",
    );
    expect(messages(buildingSchema, { ...goodBuilding, name: "" }).name).not.toBe("String must contain at least 1 character(s)");
  });
});

describe("builders", () => {
  it("building create omits a blank warden", () => {
    const v = buildingSchema.parse(goodBuilding);
    expect(buildBuildingCreate(v)).toEqual({ name: "Block A", type: "BOYS", isActive: true });
    const w = buildingSchema.parse({ ...goodBuilding, wardenUserId: "u1" });
    expect(buildBuildingCreate(w)).toEqual({ name: "Block A", type: "BOYS", isActive: true, wardenUserId: "u1" });
  });
  it("building patch carries dirty fields only and null for a cleared warden", () => {
    const v = buildingSchema.parse({ ...goodBuilding, name: "New" });
    expect(buildBuildingPatch({ name: true }, v)).toEqual({ name: "New" });
    expect(buildBuildingPatch({ wardenUserId: true }, v)).toEqual({ wardenUserId: null });
    expect(buildBuildingPatch({ isActive: true }, { ...v, isActive: false })).toEqual({ isActive: false });
    expect(buildBuildingPatch({}, v)).toEqual({});
  });
  it("room create omits a blank floor", () => {
    expect(buildRoomCreate(roomCreateSchema.parse(goodRoom))).toEqual({ roomNumber: "101", capacity: 4 });
    expect(buildRoomCreate(roomCreateSchema.parse({ ...goodRoom, floor: "0" }))).toEqual({ roomNumber: "101", capacity: 4, floor: 0 });
  });
  it("room patch is dirty-only and a cleared floor is null", () => {
    const v = roomPatchSchema.parse({ roomNumber: "102", capacity: "6", floor: "", status: "CLOSED" });
    expect(buildRoomPatch({ floor: true }, v)).toEqual({ floor: null });
    expect(buildRoomPatch({ roomNumber: true, status: true }, v)).toEqual({ roomNumber: "102", status: "CLOSED" });
    expect(buildRoomPatch({ capacity: true }, v)).toEqual({ capacity: 6 });
  });
  it("allocate, transfer", () => {
    expect(buildAllocate(allocateSchema.parse({ roomId: "r", studentId: "s" }))).toEqual({ roomId: "r", studentId: "s" });
    expect(buildTransfer(transferSchema.parse({ toRoomId: "r2" }))).toEqual({ toRoomId: "r2" });
  });
  it("check event: blank time omitted, set time becomes ISO", () => {
    expect(buildCheckEvent(checkEventSchema.parse({ eventType: "CHECK_IN", occurredAt: "" }))).toEqual({ eventType: "CHECK_IN" });
    const body = buildCheckEvent(checkEventSchema.parse({ eventType: "CHECK_OUT", occurredAt: "2026-03-01T10:30" }));
    expect(body.occurredAt).toBe(new Date("2026-03-01T10:30").toISOString());
    expect(messages(checkEventSchema, { eventType: "CHECK_IN", occurredAt: "nope" }).occurredAt).toBe("Invalid date");
  });
  it("leave apply sends ISO dates", () => {
    const v = leaveApplySchema.parse({ fromDate: "2026-01-01", toDate: "2026-01-03", reason: "Home" });
    expect(buildLeaveApply(v)).toEqual({
      fromDate: "2026-01-01T00:00:00.000Z",
      toDate: "2026-01-03T00:00:00.000Z",
      reason: "Home",
    });
  });
  it("decision: blank note sends {}", () => {
    expect(buildDecision(decisionSchema.parse({ decisionNote: "" }))).toEqual({});
    expect(buildDecision(decisionSchema.parse({ decisionNote: " ok " }))).toEqual({ decisionNote: "ok" });
  });
  it("maintenance create and transition", () => {
    expect(buildMaintenanceCreate(maintenanceCreateSchema.parse({ roomId: "r", issue: " Leak " }))).toEqual({ roomId: "r", issue: "Leak" });
    expect(buildMaintenanceTransition(maintenanceTransitionSchema.parse({ toStatus: "RESOLVED", resolutionNote: "" }))).toEqual({
      toStatus: "RESOLVED",
    });
    expect(buildMaintenanceTransition(maintenanceTransitionSchema.parse({ toStatus: "CANCELLED", resolutionNote: "dup" }))).toEqual({
      toStatus: "CANCELLED",
      resolutionNote: "dup",
    });
  });
});

describe("hasDuplicateBuildingName", () => {
  const list = [
    { id: "1", name: "Block A" },
    { id: "2", name: "Block B" },
  ];
  it("matches the exact name of another building", () => {
    expect(hasDuplicateBuildingName("Block A", list, 2)).toBe(true);
    expect(hasDuplicateBuildingName("  Block A ", list, 2)).toBe(true);
    expect(hasDuplicateBuildingName("block a", list, 2)).toBe(false);
  });
  it("ignores the building being edited", () => {
    expect(hasDuplicateBuildingName("Block A", list, 2, "1")).toBe(false);
  });
  it("is unreliable beyond 100 buildings so it never blocks", () => {
    expect(hasDuplicateBuildingName("Block A", list, 101)).toBe(false);
  });
  it("blank is not a duplicate", () => {
    expect(hasDuplicateBuildingName("", list, 2)).toBe(false);
  });
});
