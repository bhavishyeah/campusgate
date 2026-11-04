// Hand-written from the API contract. Dates are ISO strings.

export type BuildingType = "BOYS" | "GIRLS" | "MIXED" | "STAFF";
export type RoomStatus = "AVAILABLE" | "FULL" | "MAINTENANCE" | "CLOSED";
export type AllocationStatus = "ACTIVE" | "VACATED" | "TRANSFERRED";
export type LeaveStatus = "REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED";
export type MaintenanceStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CANCELLED";
export type CheckEventType = "CHECK_IN" | "CHECK_OUT";

export interface Paged {
  total: number;
  page: number;
  pageSize: number;
}

export interface StudentBrief {
  id: string;
  name: string;
  enrollmentNo: string | null;
  program: string | null;
}

export interface RoomBrief {
  id: string;
  roomNumber: string;
  floor: number | null;
  building: { id: string; name: string };
}

export interface Building {
  id: string;
  name: string;
  type: BuildingType;
  wardenUserId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BuildingRow extends Building {
  roomCount: number;
  warden: { id: string; email: string; name: string | null } | null;
}

export interface Room {
  id: string;
  buildingId: string;
  roomNumber: string;
  capacity: number;
  floor: number | null;
  status: RoomStatus;
}

export interface RoomOccupancy {
  capacity: number;
  occupied: number;
  available: number;
}

export interface RoomRow extends Room {
  building: { id: string; name: string; type: BuildingType };
  occupancy: RoomOccupancy;
}

export interface Allocation {
  id: string;
  roomId: string;
  studentId: string;
  status: AllocationStatus;
  allocatedAt: string;
  vacatedAt: string | null;
  transferFromAllocationId: string | null;
}

export interface AllocationRow extends Allocation {
  student: StudentBrief;
  room: RoomBrief;
}

export interface CheckEventRow {
  id: string;
  allocationId: string;
  studentId: string;
  eventType: CheckEventType;
  occurredAt: string;
  student: StudentBrief;
  allocation: { id: string; room: RoomBrief };
}

export interface Leave {
  id: string;
  studentId: string;
  fromDate: string;
  toDate: string;
  reason: string;
  status: LeaveStatus;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface LeaveRow extends Leave {
  student: StudentBrief;
}

export type MyLeave = Leave;

export interface MaintenanceRow {
  id: string;
  roomId: string;
  issue: string;
  status: MaintenanceStatus;
  assigneeUserId: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
  room: RoomBrief;
}

export interface OccupancyBuilding {
  buildingId: string;
  capacity: number;
  occupied: number;
  available: number;
}

export interface OccupancyResponse {
  buildings: OccupancyBuilding[];
  rooms: { roomId: string; buildingId: string; roomNumber: string; capacity: number; occupied: number; available: number }[];
}

export interface MyAllocation extends Allocation {
  room: {
    id: string;
    roomNumber: string;
    floor: number | null;
    building: { id: string; name: string; type: BuildingType };
  };
}

export interface MyOccupancy {
  roomId: string;
  capacity: number;
  occupied: number;
  available: number;
}

export interface StudentLookupItem extends StudentBrief {
  hasActiveAllocation: boolean;
}

export interface UserLookupItem {
  id: string;
  email: string;
  name: string | null;
}
