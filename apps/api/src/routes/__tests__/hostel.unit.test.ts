/**
 * Phase-9.3 Hostel Management FAST unit specs (no DB, no Fastify) — FEAT-003
 * step 3. These cover the PURE pieces of the design the live-DB suites would be
 * wasteful to re-prove:
 *   - the single-source-of-truth occupancy computation ({capacity, occupied,
 *     available}) per room + the per-building aggregation (design §B.6);
 *   - the exported Zod schemas (valid/invalid, incl. the applyLeaveSchema
 *     toDate>=fromDate refine and the capacity bounds) (design §B.10);
 *   - the maintenance source->target transition-legality predicate that the
 *     route checks in-handler before the DB guard backstops it (design §B.5 /
 *     NIT 6 / the guard's transition table).
 *
 * The occupancy + transition logic is inlined in hostel.ts (not exported), so
 * the pure predicates are reproduced here EXACTLY as the route computes them and
 * asserted in isolation — a drift between the two would be caught by the
 * behavioral suite that drives the real handler.
 */
import { describe, expect, it } from "vitest";
import {
  createBuildingSchema,
  patchBuildingSchema,
  createRoomSchema,
  patchRoomSchema,
  allocateSchema,
  transferSchema,
  checkEventSchema,
  applyLeaveSchema,
  leaveDecisionSchema,
  createMaintenanceSchema,
  maintenanceTransitionSchema,
  hostelListQuerySchema,
} from "@campusgate/shared";

// ─── Pure occupancy computation (design §B.6) ────────────────────────────────
// occupied = COUNT(ACTIVE allocations in the room); available = capacity -
// occupied. No stored counter. Mirrors hostel.ts GET /rooms/:id + /occupancy.
interface RoomRow {
  roomId: string;
  buildingId: string;
  roomNumber: string;
  capacity: number;
}
function roomOccupancy(capacity: number, occupied: number) {
  return { capacity, occupied, available: capacity - occupied };
}
function buildingOccupancy(rooms: RoomRow[], activeByRoom: Map<string, number>) {
  const perRoom = rooms.map((r) => {
    const occupied = activeByRoom.get(r.roomId) ?? 0;
    return {
      roomId: r.roomId,
      buildingId: r.buildingId,
      roomNumber: r.roomNumber,
      ...roomOccupancy(r.capacity, occupied),
    };
  });
  const byBuilding = new Map<string, { capacity: number; occupied: number }>();
  for (const row of perRoom) {
    const agg = byBuilding.get(row.buildingId) ?? { capacity: 0, occupied: 0 };
    agg.capacity += row.capacity;
    agg.occupied += row.occupied;
    byBuilding.set(row.buildingId, agg);
  }
  const buildings = [...byBuilding.entries()].map(([buildingId, agg]) => ({
    buildingId,
    capacity: agg.capacity,
    occupied: agg.occupied,
    available: agg.capacity - agg.occupied,
  }));
  return { buildings, rooms: perRoom };
}

// ─── Pure maintenance transition predicate (design §B.5 / NIT 6) ─────────────
// EXACTLY the MAINTENANCE_TRANSITIONS table the route checks in-handler and the
// hostel_maintenance_requests_guard enforces at the DB.
const MAINTENANCE_TRANSITIONS: Record<string, readonly string[]> = {
  OPEN: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["RESOLVED", "CANCELLED"],
  RESOLVED: [],
  CANCELLED: [],
};
function isLegalMaintenanceTransition(from: string, to: string): boolean {
  return (MAINTENANCE_TRANSITIONS[from] ?? []).includes(to);
}

describe("Hostel occupancy computation (pure, design §B.6)", () => {
  it("roomOccupancy derives available = capacity - occupied", () => {
    expect(roomOccupancy(4, 0)).toEqual({ capacity: 4, occupied: 0, available: 4 });
    expect(roomOccupancy(4, 3)).toEqual({ capacity: 4, occupied: 3, available: 1 });
    expect(roomOccupancy(2, 2)).toEqual({ capacity: 2, occupied: 2, available: 0 });
  });

  it("aggregates per building (sum capacity, sum occupied) with rooms that have no active allocations", () => {
    const rooms: RoomRow[] = [
      { roomId: "r1", buildingId: "b1", roomNumber: "101", capacity: 2 },
      { roomId: "r2", buildingId: "b1", roomNumber: "102", capacity: 3 },
      { roomId: "r3", buildingId: "b2", roomNumber: "201", capacity: 4 },
    ];
    const activeByRoom = new Map<string, number>([
      ["r1", 2],
      ["r2", 1],
      // r3 has no ACTIVE allocation rows -> occupied 0
    ]);
    const result = buildingOccupancy(rooms, activeByRoom);

    expect(result.rooms).toEqual([
      { roomId: "r1", buildingId: "b1", roomNumber: "101", capacity: 2, occupied: 2, available: 0 },
      { roomId: "r2", buildingId: "b1", roomNumber: "102", capacity: 3, occupied: 1, available: 2 },
      { roomId: "r3", buildingId: "b2", roomNumber: "201", capacity: 4, occupied: 0, available: 4 },
    ]);

    const b1 = result.buildings.find((b) => b.buildingId === "b1")!;
    const b2 = result.buildings.find((b) => b.buildingId === "b2")!;
    expect(b1).toEqual({ buildingId: "b1", capacity: 5, occupied: 3, available: 2 });
    expect(b2).toEqual({ buildingId: "b2", capacity: 4, occupied: 0, available: 4 });
  });
});

describe("Hostel maintenance transition predicate (pure, design §B.5 / NIT 6)", () => {
  it("accepts every legal forward transition", () => {
    expect(isLegalMaintenanceTransition("OPEN", "IN_PROGRESS")).toBe(true);
    expect(isLegalMaintenanceTransition("OPEN", "CANCELLED")).toBe(true);
    expect(isLegalMaintenanceTransition("IN_PROGRESS", "RESOLVED")).toBe(true);
    expect(isLegalMaintenanceTransition("IN_PROGRESS", "CANCELLED")).toBe(true);
  });

  it("rejects illegal / backward / terminal transitions", () => {
    expect(isLegalMaintenanceTransition("OPEN", "RESOLVED")).toBe(false); // skip IN_PROGRESS
    expect(isLegalMaintenanceTransition("IN_PROGRESS", "OPEN")).toBe(false); // backward
    expect(isLegalMaintenanceTransition("RESOLVED", "IN_PROGRESS")).toBe(false); // terminal
    expect(isLegalMaintenanceTransition("CANCELLED", "RESOLVED")).toBe(false); // terminal
    expect(isLegalMaintenanceTransition("OPEN", "OPEN")).toBe(false); // self (not a forward step)
  });
});

describe("Hostel Zod schemas (design §B.10)", () => {
  it("createBuildingSchema: requires name + type; accepts optional warden/isActive", () => {
    expect(createBuildingSchema.safeParse({ name: "Block A", type: "BOYS" }).success).toBe(true);
    expect(
      createBuildingSchema.safeParse({ name: "Block A", type: "MIXED", wardenUserId: "u1", isActive: false }).success,
    ).toBe(true);
    // missing name
    expect(createBuildingSchema.safeParse({ type: "BOYS" }).success).toBe(false);
    // empty name
    expect(createBuildingSchema.safeParse({ name: "", type: "BOYS" }).success).toBe(false);
    // invalid type enum
    expect(createBuildingSchema.safeParse({ name: "Block A", type: "COED" }).success).toBe(false);
    // name over 120 chars
    expect(createBuildingSchema.safeParse({ name: "x".repeat(121), type: "BOYS" }).success).toBe(false);
  });

  it("patchBuildingSchema: all optional, strict (rejects unknown keys)", () => {
    expect(patchBuildingSchema.safeParse({}).success).toBe(true);
    expect(patchBuildingSchema.safeParse({ isActive: true }).success).toBe(true);
    expect(patchBuildingSchema.safeParse({ wardenUserId: null }).success).toBe(true); // nullish clear
    expect(patchBuildingSchema.safeParse({ bogus: 1 }).success).toBe(false); // strict
  });

  it("createRoomSchema: roomNumber 1..32, capacity int 1..64, optional floor 0..200", () => {
    expect(createRoomSchema.safeParse({ roomNumber: "101", capacity: 4 }).success).toBe(true);
    expect(createRoomSchema.safeParse({ roomNumber: "101", capacity: 4, floor: 2 }).success).toBe(true);
    // capacity below 1
    expect(createRoomSchema.safeParse({ roomNumber: "101", capacity: 0 }).success).toBe(false);
    // capacity above 64
    expect(createRoomSchema.safeParse({ roomNumber: "101", capacity: 65 }).success).toBe(false);
    // empty roomNumber
    expect(createRoomSchema.safeParse({ roomNumber: "", capacity: 4 }).success).toBe(false);
    // floor above 200
    expect(createRoomSchema.safeParse({ roomNumber: "101", capacity: 4, floor: 201 }).success).toBe(false);
  });

  it("patchRoomSchema: capacity >= 1, status enum, strict", () => {
    expect(patchRoomSchema.safeParse({ capacity: 6 }).success).toBe(true);
    expect(patchRoomSchema.safeParse({ status: "MAINTENANCE" }).success).toBe(true);
    expect(patchRoomSchema.safeParse({ floor: null }).success).toBe(true);
    expect(patchRoomSchema.safeParse({ capacity: 0 }).success).toBe(false);
    expect(patchRoomSchema.safeParse({ status: "FULLISH" }).success).toBe(false);
    expect(patchRoomSchema.safeParse({ unknown: 1 }).success).toBe(false); // strict
  });

  it("allocateSchema / transferSchema: required ids", () => {
    expect(allocateSchema.safeParse({ roomId: "r1", studentId: "s1" }).success).toBe(true);
    expect(allocateSchema.safeParse({ roomId: "r1" }).success).toBe(false);
    expect(transferSchema.safeParse({ toRoomId: "r2" }).success).toBe(true);
    expect(transferSchema.safeParse({}).success).toBe(false);
  });

  it("checkEventSchema: eventType enum; occurredAt optional (coerced)", () => {
    expect(checkEventSchema.safeParse({ eventType: "CHECK_IN" }).success).toBe(true);
    expect(
      checkEventSchema.safeParse({ eventType: "CHECK_OUT", occurredAt: "2027-01-05T10:00:00.000Z" }).success,
    ).toBe(true);
    expect(checkEventSchema.safeParse({ eventType: "ARRIVED" }).success).toBe(false);
  });

  it("applyLeaveSchema: enforces toDate >= fromDate and reason 1..500", () => {
    const ok = applyLeaveSchema.safeParse({
      fromDate: "2027-01-10T00:00:00.000Z",
      toDate: "2027-01-12T00:00:00.000Z",
      reason: "home visit",
    });
    expect(ok.success).toBe(true);

    // equal dates allowed (>=)
    expect(
      applyLeaveSchema.safeParse({
        fromDate: "2027-01-10T00:00:00.000Z",
        toDate: "2027-01-10T00:00:00.000Z",
        reason: "day pass",
      }).success,
    ).toBe(true);

    // toDate before fromDate -> refine fails
    const bad = applyLeaveSchema.safeParse({
      fromDate: "2027-01-12T00:00:00.000Z",
      toDate: "2027-01-10T00:00:00.000Z",
      reason: "backwards",
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.path.includes("toDate"))).toBe(true);
    }

    // empty reason
    expect(
      applyLeaveSchema.safeParse({
        fromDate: "2027-01-10T00:00:00.000Z",
        toDate: "2027-01-12T00:00:00.000Z",
        reason: "",
      }).success,
    ).toBe(false);
  });

  it("leaveDecisionSchema: optional note, strict", () => {
    expect(leaveDecisionSchema.safeParse({}).success).toBe(true);
    expect(leaveDecisionSchema.safeParse({ decisionNote: "approved" }).success).toBe(true);
    expect(leaveDecisionSchema.safeParse({ decisionNote: "x".repeat(501) }).success).toBe(false);
    expect(leaveDecisionSchema.safeParse({ bogus: 1 }).success).toBe(false); // strict
  });

  it("createMaintenanceSchema: roomId + issue 1..500; optional assignee", () => {
    expect(createMaintenanceSchema.safeParse({ roomId: "r1", issue: "leak" }).success).toBe(true);
    expect(
      createMaintenanceSchema.safeParse({ roomId: "r1", issue: "leak", assigneeUserId: "u2" }).success,
    ).toBe(true);
    expect(createMaintenanceSchema.safeParse({ roomId: "r1", issue: "" }).success).toBe(false);
    expect(createMaintenanceSchema.safeParse({ issue: "leak" }).success).toBe(false);
  });

  it("maintenanceTransitionSchema: target enum never includes OPEN", () => {
    expect(maintenanceTransitionSchema.safeParse({ toStatus: "IN_PROGRESS" }).success).toBe(true);
    expect(maintenanceTransitionSchema.safeParse({ toStatus: "RESOLVED" }).success).toBe(true);
    expect(maintenanceTransitionSchema.safeParse({ toStatus: "CANCELLED" }).success).toBe(true);
    // OPEN is not a reachable target (forward-only)
    expect(maintenanceTransitionSchema.safeParse({ toStatus: "OPEN" }).success).toBe(false);
  });

  it("hostelListQuerySchema: page/pageSize defaults + bounds (coerced)", () => {
    const parsed = hostelListQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.page).toBe(1);
      expect(parsed.data.pageSize).toBe(20);
    }
    expect(hostelListQuerySchema.safeParse({ page: "2", pageSize: "50" }).success).toBe(true);
    expect(hostelListQuerySchema.safeParse({ pageSize: "0" }).success).toBe(false);
    expect(hostelListQuerySchema.safeParse({ pageSize: "101" }).success).toBe(false);
    expect(hostelListQuerySchema.safeParse({ page: "0" }).success).toBe(false);
  });
});
