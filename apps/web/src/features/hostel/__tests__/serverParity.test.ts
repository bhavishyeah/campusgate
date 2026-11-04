import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  applyLeaveSchema as serverApplyLeave,
  createBuildingSchema as serverCreateBuilding,
  createMaintenanceSchema as serverCreateMaintenance,
  createRoomSchema as serverCreateRoom,
  hostelStudentLookupQuerySchema as serverLookup,
  leaveDecisionSchema as serverDecision,
  maintenanceTransitionSchema as serverTransition,
  patchRoomSchema as serverPatchRoom,
} from "@campusgate/shared";
import {
  buildBuildingCreate,
  buildBuildingPatch,
  buildCheckEvent,
  buildDecision,
  buildLeaveApply,
  buildMaintenanceCreate,
  buildMaintenanceTransition,
  buildRoomCreate,
  buildRoomPatch,
  buildingSchema,
  checkEventSchema,
  decisionSchema,
  leaveApplySchema,
  maintenanceCreateSchema,
  maintenanceTransitionSchema,
  roomCreateSchema,
  roomPatchSchema,
  LOOKUP_HINT,
} from "../formSchemas";
import { checkEventSchema as sharedCheckEvent, createBuildingSchema, patchBuildingSchema } from "@campusgate/shared";

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

describe("hostel client messages equal the real shared schemas", () => {
  it("building create", () => {
    const base = { name: "A", type: "BOYS", wardenUserId: "", isActive: true };
    expectParity(buildingSchema, serverCreateBuilding, [
      { field: "name", client: { ...base, name: "" }, server: { name: "", type: "BOYS" } },
      { field: "name", client: { ...base, name: "a".repeat(121) }, server: { name: "a".repeat(121), type: "BOYS" } },
      { field: "type", client: { ...base, type: "" }, server: { name: "A" } },
      { field: "type", client: { ...base, type: "x" }, server: { name: "A", type: "x" } },
    ]);
  });
  it("room create", () => {
    const base = { buildingId: "b", roomNumber: "1", capacity: "4", floor: "" };
    const sbase = { roomNumber: "1", capacity: "4" };
    expectParity(roomCreateSchema, serverCreateRoom, [
      { field: "roomNumber", client: { ...base, roomNumber: "" }, server: { ...sbase, roomNumber: "" } },
      { field: "roomNumber", client: { ...base, roomNumber: "a".repeat(33) }, server: { ...sbase, roomNumber: "a".repeat(33) } },
      { field: "capacity", client: { ...base, capacity: "" }, server: { ...sbase, capacity: "" } },
      { field: "capacity", client: { ...base, capacity: "0" }, server: { ...sbase, capacity: "0" } },
      { field: "capacity", client: { ...base, capacity: "abc" }, server: { ...sbase, capacity: "abc" } },
      { field: "capacity", client: { ...base, capacity: "1.5" }, server: { ...sbase, capacity: "1.5" } },
      { field: "capacity", client: { ...base, capacity: "65" }, server: { ...sbase, capacity: "65" } },
      { field: "floor", client: { ...base, floor: "201" }, server: { ...sbase, floor: "201" } },
      { field: "floor", client: { ...base, floor: "-1" }, server: { ...sbase, floor: "-1" } },
      { field: "floor", client: { ...base, floor: "x" }, server: { ...sbase, floor: "x" } },
    ]);
  });
  it("room patch (non-blank rules only)", () => {
    const base = { roomNumber: "1", capacity: "4", floor: "", status: "AVAILABLE" };
    expectParity(roomPatchSchema, serverPatchRoom, [
      { field: "roomNumber", client: { ...base, roomNumber: "a".repeat(33) }, server: { roomNumber: "a".repeat(33) } },
      { field: "capacity", client: { ...base, capacity: "0" }, server: { capacity: "0" } },
      { field: "capacity", client: { ...base, capacity: "abc" }, server: { capacity: "abc" } },
      { field: "capacity", client: { ...base, capacity: "1.5" }, server: { capacity: "1.5" } },
      { field: "floor", client: { ...base, floor: "201" }, server: { floor: "201" } },
      { field: "status", client: { ...base, status: "x" }, server: { status: "x" } },
    ]);
  });
  it("leave apply", () => {
    expectParity(leaveApplySchema, serverApplyLeave, [
      { field: "fromDate", client: { fromDate: "", toDate: "2026-01-02", reason: "x" }, server: { fromDate: "", toDate: "2026-01-02", reason: "x" } },
      { field: "toDate", client: { fromDate: "2026-01-02", toDate: "nope", reason: "x" }, server: { fromDate: "2026-01-02", toDate: "nope", reason: "x" } },
      { field: "reason", client: { fromDate: "2026-01-01", toDate: "2026-01-02", reason: "" }, server: { fromDate: "2026-01-01", toDate: "2026-01-02", reason: "" } },
      { field: "reason", client: { fromDate: "2026-01-01", toDate: "2026-01-02", reason: "a".repeat(501) }, server: { fromDate: "2026-01-01", toDate: "2026-01-02", reason: "a".repeat(501) } },
      { field: "toDate", client: { fromDate: "2026-01-03", toDate: "2026-01-02", reason: "x" }, server: { fromDate: "2026-01-03", toDate: "2026-01-02", reason: "x" } },
    ]);
  });
  it("maintenance create and transition", () => {
    expectParity(maintenanceCreateSchema, serverCreateMaintenance, [
      { field: "issue", client: { roomId: "r", issue: "" }, server: { roomId: "r", issue: "" } },
      { field: "issue", client: { roomId: "r", issue: "a".repeat(501) }, server: { roomId: "r", issue: "a".repeat(501) } },
      { field: "roomId", client: { roomId: "", issue: "x" }, server: { issue: "x" } },
    ]);
    expectParity(maintenanceTransitionSchema, serverTransition, [
      { field: "toStatus", client: { toStatus: "", resolutionNote: "" }, server: {} },
      { field: "toStatus", client: { toStatus: "OPEN", resolutionNote: "" }, server: { toStatus: "OPEN" } },
      { field: "resolutionNote", client: { toStatus: "RESOLVED", resolutionNote: "a".repeat(501) }, server: { toStatus: "RESOLVED", resolutionNote: "a".repeat(501) } },
    ]);
  });
  it("decision note", () => {
    expectParity(decisionSchema, serverDecision, [
      { field: "decisionNote", client: { decisionNote: "a".repeat(501) }, server: { decisionNote: "a".repeat(501) } },
    ]);
  });
  it("lookup hint equals the server message", () => {
    const r = serverLookup.safeParse({ q: "a" });
    expect(r.success ? "" : r.error.issues[0].message).toBe(LOOKUP_HINT);
  });
});

describe("builder output passes the real shared schemas", () => {
  it("buildings", () => {
    const v = buildingSchema.parse({ name: "Block A", type: "GIRLS", wardenUserId: "u1", isActive: false });
    expect(createBuildingSchema.safeParse(buildBuildingCreate(v)).success).toBe(true);
    expect(patchBuildingSchema.safeParse(buildBuildingPatch({ name: true, wardenUserId: true, isActive: true }, v)).success).toBe(true);
    const cleared = buildingSchema.parse({ name: "Block A", type: "GIRLS", wardenUserId: "", isActive: true });
    expect(patchBuildingSchema.safeParse(buildBuildingPatch({ wardenUserId: true }, cleared)).success).toBe(true);
  });
  it("rooms", () => {
    expect(serverCreateRoom.safeParse(buildRoomCreate(roomCreateSchema.parse({ buildingId: "b", roomNumber: "101", capacity: "4", floor: "2" }))).success).toBe(true);
    const v = roomPatchSchema.parse({ roomNumber: "102", capacity: "6", floor: "", status: "CLOSED" });
    expect(serverPatchRoom.safeParse(buildRoomPatch({ roomNumber: true, capacity: true, floor: true, status: true }, v)).success).toBe(true);
  });
  it("check event, leave, decision, maintenance", () => {
    expect(sharedCheckEvent.safeParse(buildCheckEvent(checkEventSchema.parse({ eventType: "CHECK_IN", occurredAt: "2026-03-01T10:30" }))).success).toBe(true);
    expect(sharedCheckEvent.safeParse(buildCheckEvent(checkEventSchema.parse({ eventType: "CHECK_OUT", occurredAt: "" }))).success).toBe(true);
    expect(serverApplyLeave.safeParse(buildLeaveApply(leaveApplySchema.parse({ fromDate: "2026-01-01", toDate: "2026-01-01", reason: "x" }))).success).toBe(true);
    expect(serverDecision.safeParse(buildDecision(decisionSchema.parse({ decisionNote: "" }))).success).toBe(true);
    expect(serverDecision.safeParse(buildDecision(decisionSchema.parse({ decisionNote: "ok" }))).success).toBe(true);
    expect(serverCreateMaintenance.safeParse(buildMaintenanceCreate(maintenanceCreateSchema.parse({ roomId: "r", issue: "Leak" }))).success).toBe(true);
    expect(serverTransition.safeParse(buildMaintenanceTransition(maintenanceTransitionSchema.parse({ toStatus: "RESOLVED", resolutionNote: "fixed" }))).success).toBe(true);
  });
});
