import type { OccupancyBuilding, RoomBrief, RoomRow, StudentBrief } from "./types";

/** "Block A / 101", or "-" when there is no room. */
export function roomLabel(room: RoomBrief | null | undefined): string {
  if (!room) return "-";
  return `${room.building.name} / ${room.roomNumber}`;
}

/** "Name (EN123)"; "-" when there is no student. */
export function studentLabel(s: Pick<StudentBrief, "name" | "enrollmentNo"> | null | undefined): string {
  if (!s) return "-";
  return s.enrollmentNo ? `${s.name} (${s.enrollmentNo})` : s.name;
}

/** Integer 0..100, or null when capacity is 0. */
export function occupancyPercent(occupied: number, capacity: number): number | null {
  if (capacity <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((occupied / capacity) * 100)));
}

export function sumOccupancy(rows: readonly { capacity: number; occupied: number; available: number }[]): {
  capacity: number;
  occupied: number;
  available: number;
} {
  return rows.reduce(
    (acc, r) => ({
      capacity: acc.capacity + r.capacity,
      occupied: acc.occupied + r.occupied,
      available: acc.available + r.available,
    }),
    { capacity: 0, occupied: 0, available: 0 },
  );
}

export interface OccupancyJoinRow {
  key: string;
  buildingId: string | null;
  name: string;
  capacity: number;
  occupied: number;
  available: number;
}

/**
 * Left-joins all buildings with the occupancy aggregate (which omits buildings with no rooms).
 * Occupancy entries for a building that is not loaded show as "Another building".
 */
export function joinOccupancy(
  buildings: readonly { id: string; name: string }[],
  occupancyBuildings: readonly OccupancyBuilding[],
): OccupancyJoinRow[] {
  const byId = new Map(occupancyBuildings.map((o) => [o.buildingId, o]));
  const rows: OccupancyJoinRow[] = buildings.map((b) => {
    const o = byId.get(b.id);
    return {
      key: b.id,
      buildingId: b.id,
      name: b.name,
      capacity: o?.capacity ?? 0,
      occupied: o?.occupied ?? 0,
      available: o?.available ?? 0,
    };
  });
  const known = new Set(buildings.map((b) => b.id));
  for (const o of occupancyBuildings) {
    if (known.has(o.buildingId)) continue;
    rows.push({
      key: o.buildingId,
      buildingId: null,
      name: "Another building",
      capacity: o.capacity,
      occupied: o.occupied,
      available: o.available,
    });
  }
  return rows;
}

/** Concatenates room pages, de-duplicating by id (a refetch may overlap). */
export function mergeRoomPages(existing: readonly RoomRow[], next: readonly RoomRow[]): RoomRow[] {
  const seen = new Set(existing.map((r) => r.id));
  const out = [...existing];
  for (const r of next) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/** Case-insensitive substring filter on the room number. */
export function filterRooms(rooms: readonly RoomRow[], text: string): RoomRow[] {
  const t = text.trim().toLowerCase();
  if (t === "") return [...rooms];
  return rooms.filter((r) => r.roomNumber.toLowerCase().includes(t));
}
