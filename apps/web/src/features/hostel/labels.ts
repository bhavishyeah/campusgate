export const buildingTypeLabel: Record<string, string> = {
  BOYS: "Boys",
  GIRLS: "Girls",
  MIXED: "Mixed",
  STAFF: "Staff",
};
export const roomStatusLabel: Record<string, string> = {
  AVAILABLE: "Available",
  FULL: "Full",
  MAINTENANCE: "Maintenance",
  CLOSED: "Closed",
};
export const allocationStatusLabel: Record<string, string> = {
  ACTIVE: "Active",
  VACATED: "Vacated",
  TRANSFERRED: "Transferred",
};
export const leaveStatusLabel: Record<string, string> = {
  REQUESTED: "Requested",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};
export const maintenanceStatusLabel: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  RESOLVED: "Resolved",
  CANCELLED: "Cancelled",
};
export const checkEventLabel: Record<string, string> = {
  CHECK_IN: "Check-in",
  CHECK_OUT: "Check-out",
};

/** Room status helper text (the flag is manual, never derived from occupancy). */
export const ROOM_STATUS_HELP =
  "Set manually; it is not calculated from occupancy. Only Available rooms accept allocations.";

export type StatusKind = "allocation" | "leave" | "maintenance" | "room" | "checkEvent";

export const STATUS_LABELS: Record<StatusKind, Record<string, string>> = {
  allocation: allocationStatusLabel,
  leave: leaveStatusLabel,
  maintenance: maintenanceStatusLabel,
  room: roomStatusLabel,
  checkEvent: checkEventLabel,
};

/** Badge tone per status: good, bad, muted, otherwise warning. */
export const GOOD_STATUSES = new Set(["ACTIVE", "APPROVED", "RESOLVED", "AVAILABLE", "CHECK_IN"]);
export const BAD_STATUSES = new Set(["REJECTED", "FULL", "CLOSED"]);
export const MUTED_STATUSES = new Set(["VACATED", "TRANSFERRED", "CANCELLED", "CHECK_OUT"]);

export function toOptions(labels: Record<string, string>): { value: string; label: string }[] {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}
