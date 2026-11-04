import type { ContractStatus, EmployeeStatus, LeaveStatus } from "./types";

/** Mirror of the server's legal transitions. The UI only decides which buttons to show. */
export const LEAVE_TRANSITIONS = {
  REQUESTED: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
} as const;

export const CONTRACT_TRANSITIONS = {
  ACTIVE: ["SUPERSEDED", "ENDED"],
  SUPERSEDED: [],
  ENDED: [],
} as const;

/** Staff can approve or reject; cancelling is the employee's own action. */
export function staffLeaveActions(status: LeaveStatus): ("APPROVED" | "REJECTED")[] {
  const next: readonly string[] = LEAVE_TRANSITIONS[status];
  return next.filter((s): s is "APPROVED" | "REJECTED" => s === "APPROVED" || s === "REJECTED");
}

export function selfLeaveActions(status: LeaveStatus): "CANCELLED"[] {
  return LEAVE_TRANSITIONS[status].some((s) => s === "CANCELLED") ? ["CANCELLED"] : [];
}

export function contractActions(status: ContractStatus): ("SUPERSEDED" | "ENDED")[] {
  return [...CONTRACT_TRANSITIONS[status]];
}

/** The server has no employee status transition table: any of the three may be set. */
export function employeeStatusOptions(): EmployeeStatus[] {
  return ["ACTIVE", "INACTIVE", "TERMINATED"];
}
