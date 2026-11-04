/** Every request parameter of a query is part of its key. */
export const hostelKeys = {
  all: ["hostel"] as const,
  buildings: (page: number) => ["hostel", "buildings", "list", { page }] as const,
  buildingsAll: () => ["hostel", "buildings"] as const,
  buildingOptions: () => ["hostel", "building-options"] as const,
  rooms: (f: { buildingId?: string; status?: string; page: number }) => ["hostel", "rooms", "list", f] as const,
  roomOptions: (f: { buildingId: string; status?: string; page: number }) =>
    ["hostel", "rooms", "options", f] as const,
  roomsAll: () => ["hostel", "rooms"] as const,
  allocations: (f: { status?: string; buildingId?: string; page: number }) => ["hostel", "allocations", f] as const,
  allocationsAll: () => ["hostel", "allocations"] as const,
  occupancy: () => ["hostel", "occupancy"] as const,
  checkEvents: (f: { allocationId?: string; studentId?: string; page: number }) =>
    ["hostel", "check-events", f] as const,
  checkEventsAll: () => ["hostel", "check-events"] as const,
  leave: (f: { status?: string; page: number }) => ["hostel", "leave", f] as const,
  leaveAll: () => ["hostel", "leave"] as const,
  maintenance: (f: { status?: string; page: number }) => ["hostel", "maintenance", f] as const,
  maintenanceAll: () => ["hostel", "maintenance"] as const,
  studentLookup: (q: string) => ["hostel", "student-lookup", q] as const,
  userLookup: (q: string) => ["hostel", "user-lookup", q] as const,
  meAllocation: () => ["hostel", "me", "allocation"] as const,
  meOccupancy: () => ["hostel", "me", "occupancy"] as const,
  meLeave: (f: { status?: string; page: number }) => ["hostel", "me", "leave", f] as const,
  meAll: () => ["hostel", "me"] as const,
} as const;
