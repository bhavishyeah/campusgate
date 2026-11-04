import { describe, expect, it } from "vitest";
import {
  filterRooms,
  joinOccupancy,
  mergeRoomPages,
  occupancyPercent,
  roomLabel,
  studentLabel,
  sumOccupancy,
} from "../format";
import type { RoomRow } from "../types";

function room(id: string, roomNumber: string): RoomRow {
  return {
    id,
    buildingId: "b1",
    roomNumber,
    capacity: 4,
    floor: null,
    status: "AVAILABLE",
    building: { id: "b1", name: "Block A", type: "BOYS" },
    occupancy: { capacity: 4, occupied: 1, available: 3 },
  };
}

describe("labels", () => {
  it("roomLabel", () => {
    expect(roomLabel({ id: "r", roomNumber: "101", floor: 1, building: { id: "b", name: "Block A" } })).toBe("Block A / 101");
    expect(roomLabel(null)).toBe("-");
  });
  it("studentLabel", () => {
    expect(studentLabel({ name: "Asha", enrollmentNo: "EN1" })).toBe("Asha (EN1)");
    expect(studentLabel({ name: "Asha", enrollmentNo: null })).toBe("Asha");
    expect(studentLabel(null)).toBe("-");
  });
});

describe("occupancy math", () => {
  it("occupancyPercent", () => {
    expect(occupancyPercent(0, 0)).toBeNull();
    expect(occupancyPercent(3, 4)).toBe(75);
    expect(occupancyPercent(1, 3)).toBe(33);
    expect(occupancyPercent(5, 4)).toBe(100);
  });
  it("sumOccupancy", () => {
    expect(
      sumOccupancy([
        { capacity: 4, occupied: 1, available: 3 },
        { capacity: 2, occupied: 2, available: 0 },
      ]),
    ).toEqual({ capacity: 6, occupied: 3, available: 3 });
    expect(sumOccupancy([])).toEqual({ capacity: 0, occupied: 0, available: 0 });
  });
});

describe("joinOccupancy", () => {
  it("defaults a building without rooms to zeros", () => {
    const rows = joinOccupancy([{ id: "b1", name: "A" }], []);
    expect(rows).toEqual([{ key: "b1", buildingId: "b1", name: "A", capacity: 0, occupied: 0, available: 0 }]);
  });
  it("keeps an inactive building that has rooms", () => {
    const rows = joinOccupancy([{ id: "b1", name: "A" }], [{ buildingId: "b1", capacity: 4, occupied: 1, available: 3 }]);
    expect(rows[0]).toMatchObject({ name: "A", capacity: 4, occupied: 1, available: 3 });
  });
  it("shows an orphan occupancy id as Another building", () => {
    const rows = joinOccupancy([], [{ buildingId: "zz", capacity: 2, occupied: 1, available: 1 }]);
    expect(rows).toEqual([
      { key: "zz", buildingId: null, name: "Another building", capacity: 2, occupied: 1, available: 1 },
    ]);
  });
});

describe("room picker helpers", () => {
  it("mergeRoomPages concatenates and de-duplicates", () => {
    const merged = mergeRoomPages([room("1", "101"), room("2", "102")], [room("2", "102"), room("3", "103")]);
    expect(merged.map((r) => r.id)).toEqual(["1", "2", "3"]);
  });
  it("mergeRoomPages from empty is the next page", () => {
    expect(mergeRoomPages([], [room("1", "101")]).map((r) => r.id)).toEqual(["1"]);
  });
  it("filterRooms is a case-insensitive substring match", () => {
    const rooms = [room("1", "A-101"), room("2", "B-202")];
    expect(filterRooms(rooms, "a-1").map((r) => r.id)).toEqual(["1"]);
    expect(filterRooms(rooms, "").length).toBe(2);
    expect(filterRooms(rooms, "zzz")).toEqual([]);
  });
});
