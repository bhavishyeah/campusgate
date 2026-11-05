export const requestStatusLabel: Record<string, string> = {
  OPEN: "Open",
  ASSIGNED: "Assigned",
  IN_PROGRESS: "In progress",
  PENDING_APPROVAL: "Pending approval",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};
export const priorityLabel: Record<string, string> = {
  LOW: "Low",
  NORMAL: "Normal",
  HIGH: "High",
  URGENT: "Urgent",
};
export const fieldTypeLabel: Record<string, string> = {
  TEXT: "Text",
  NUMBER: "Number",
  DATE: "Date",
  SELECT: "Select",
};

export type StatusKind = "request";

export const STATUS_LABELS: Record<StatusKind, Record<string, string>> = {
  request: requestStatusLabel,
};

/** Badge tone per status: good, bad, muted, otherwise warning. */
export const GOOD_STATUSES = new Set(["RESOLVED", "CLOSED"]);
export const BAD_STATUSES = new Set(["REJECTED"]);
export const MUTED_STATUSES = new Set(["CANCELLED"]);

export function toOptions(labels: Record<string, string>): { value: string; label: string }[] {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}
