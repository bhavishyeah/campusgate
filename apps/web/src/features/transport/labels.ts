export const vehicleTypeLabel: Record<string, string> = {
  BUS: "Bus",
  VAN: "Van",
  CAR: "Car",
  OTHER: "Other",
};
export const vehicleStatusLabel: Record<string, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  MAINTENANCE: "Maintenance",
};
export const driverStatusLabel: Record<string, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
};
export const routeStatusLabel: Record<string, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
};
export const enrollmentStatusLabel: Record<string, string> = {
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  ENDED: "Ended",
};
export const assignmentStatusLabel: Record<string, string> = {
  ACTIVE: "Active",
  ENDED: "Ended",
};
export const maintenanceStatusLabel: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  RESOLVED: "Resolved",
  CANCELLED: "Cancelled",
};
export const dayOfWeekLabel: Record<string, string> = {
  MON: "Mon",
  TUE: "Tue",
  WED: "Wed",
  THU: "Thu",
  FRI: "Fri",
  SAT: "Sat",
  SUN: "Sun",
};

export type StatusKind = "vehicle" | "driver" | "route" | "enrollment" | "assignment" | "maintenance";

export const STATUS_LABELS: Record<StatusKind, Record<string, string>> = {
  vehicle: vehicleStatusLabel,
  driver: driverStatusLabel,
  route: routeStatusLabel,
  enrollment: enrollmentStatusLabel,
  assignment: assignmentStatusLabel,
  maintenance: maintenanceStatusLabel,
};

export const GOOD_STATUSES = new Set(["ACTIVE", "RESOLVED"]);
export const BAD_STATUSES = new Set<string>([]);
export const MUTED_STATUSES = new Set(["INACTIVE", "ENDED", "CANCELLED"]);

export function toOptions(labels: Record<string, string>): { value: string; label: string }[] {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}
