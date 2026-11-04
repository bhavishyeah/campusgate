import type { AssignmentStatus, EnrollmentStatus, MaintenanceStatus } from "./types";

/** Mirror of the server's legal transitions. The UI only decides which buttons to show. */
export const ENROLLMENT_TRANSITIONS = {
  ACTIVE: ["SUSPENDED", "ENDED"],
  SUSPENDED: ["ENDED"],
  ENDED: [],
} as const;

export const ASSIGNMENT_TRANSITIONS = {
  ACTIVE: ["ENDED"],
  ENDED: [],
} as const;

export const MAINTENANCE_TRANSITIONS = {
  OPEN: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["RESOLVED", "CANCELLED"],
  RESOLVED: [],
  CANCELLED: [],
} as const;

export type EnrollmentAction = "suspend" | "end";

/** There is no resume: SUSPENDED -> ACTIVE is illegal on the server. */
export function enrollmentActions(status: EnrollmentStatus): EnrollmentAction[] {
  return ENROLLMENT_TRANSITIONS[status].map((t) => (t === "SUSPENDED" ? "suspend" : "end"));
}

export function assignmentActions(status: AssignmentStatus): "end"[] {
  return ASSIGNMENT_TRANSITIONS[status].length > 0 ? ["end"] : [];
}

export function maintenanceActions(status: MaintenanceStatus): ("IN_PROGRESS" | "RESOLVED" | "CANCELLED")[] {
  return [...MAINTENANCE_TRANSITIONS[status]];
}
