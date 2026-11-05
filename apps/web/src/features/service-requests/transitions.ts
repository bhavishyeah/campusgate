import type { RequestStatus } from "./types";

// EXACT mirror of the server's STATUS_TRANSITIONS.
export const STATUS_TRANSITIONS = {
  OPEN: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["IN_PROGRESS", "ASSIGNED", "CANCELLED"], // ASSIGNED->ASSIGNED = reassign
  IN_PROGRESS: ["PENDING_APPROVAL", "RESOLVED", "CANCELLED"],
  PENDING_APPROVAL: ["RESOLVED", "REJECTED"],
  RESOLVED: ["CLOSED"],
  CLOSED: [],
  REJECTED: [],
  CANCELLED: [],
} as const;

export type StaffAction =
  | "ASSIGN"
  | "REASSIGN"
  | "IN_PROGRESS"
  | "SEND_FOR_APPROVAL"
  | "RESOLVE"
  | "APPROVE"
  | "REJECT"
  | "CLOSE"
  | "CANCEL";

/**
 * Staff actions offered for a request's status + the type's requiresApproval flag.
 * The UI never offers an illegal or endpoint-mismatched move. RESOLVED is reached
 * only via RESOLVE (non-approval) or APPROVE (approval), never a direct status PATCH.
 */
export function staffActions(status: RequestStatus, requiresApproval: boolean): StaffAction[] {
  switch (status) {
    case "OPEN":
      return ["ASSIGN", "CANCEL"];
    case "ASSIGNED":
      return ["REASSIGN", "IN_PROGRESS", "CANCEL"];
    case "IN_PROGRESS":
      return [requiresApproval ? "SEND_FOR_APPROVAL" : "RESOLVE", "CANCEL"];
    case "PENDING_APPROVAL":
      return ["APPROVE", "REJECT"];
    case "RESOLVED":
      return ["CLOSE"];
    default:
      return [];
  }
}

export type SelfAction = "COMMENT" | "CANCEL" | "CLOSE" | "FEEDBACK";

/** Requester actions offered for a request's status. Comment allowed on any non-closed own request. */
export function selfActions(status: RequestStatus): SelfAction[] {
  const actions: SelfAction[] = [];
  if (status !== "CLOSED") actions.push("COMMENT");
  if (status === "OPEN") actions.push("CANCEL");
  if (status === "RESOLVED") actions.push("CLOSE");
  if (status === "RESOLVED" || status === "CLOSED") actions.push("FEEDBACK");
  return actions;
}
