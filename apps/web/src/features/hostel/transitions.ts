import type { AllocationStatus, LeaveStatus, MaintenanceStatus } from "./types";

/** Mirror of the server's legal transitions. The UI only decides which buttons to show. */
export const ALLOCATION_TRANSITIONS = {
  ACTIVE: ["VACATED", "TRANSFERRED"],
  VACATED: [],
  TRANSFERRED: [],
} as const;

export const HOSTEL_LEAVE_TRANSITIONS = {
  REQUESTED: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
} as const;

export const MAINTENANCE_TRANSITIONS = {
  OPEN: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["RESOLVED", "CANCELLED"],
  RESOLVED: [],
  CANCELLED: [],
} as const;

export type AllocationAction = "TRANSFER" | "VACATE" | "CHECK";

/**
 * TRANSFERRED is never a user-chosen target: Transfer creates a new allocation and the
 * server marks the source TRANSFERRED. Check-in/out is offered on ACTIVE allocations only.
 */
export function allocationActions(status: AllocationStatus): AllocationAction[] {
  return ALLOCATION_TRANSITIONS[status].length > 0 ? ["TRANSFER", "VACATE", "CHECK"] : [];
}

/** Staff can approve or reject; cancelling is the student's own action. */
export function staffLeaveActions(status: LeaveStatus): ("APPROVED" | "REJECTED")[] {
  const next: readonly string[] = HOSTEL_LEAVE_TRANSITIONS[status];
  return next.filter((s): s is "APPROVED" | "REJECTED" => s === "APPROVED" || s === "REJECTED");
}

export function selfLeaveActions(status: LeaveStatus): "CANCELLED"[] {
  return HOSTEL_LEAVE_TRANSITIONS[status].some((s) => s === "CANCELLED") ? ["CANCELLED"] : [];
}

export function maintenanceActions(status: MaintenanceStatus): ("IN_PROGRESS" | "RESOLVED" | "CANCELLED")[] {
  return [...MAINTENANCE_TRANSITIONS[status]];
}
