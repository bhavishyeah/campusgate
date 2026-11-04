import type { ApplicationStatus } from "./types";

/** UI mirror of the server LEGAL_TRANSITIONS. The server remains authoritative. */
export const LEGAL_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  DRAFT: ["SUBMITTED", "WITHDRAWN"],
  SUBMITTED: ["UNDER_REVIEW", "DOCUMENTS_REQUIRED", "REJECTED", "WITHDRAWN"],
  UNDER_REVIEW: ["DOCUMENTS_REQUIRED", "ELIGIBLE", "REJECTED", "WITHDRAWN"],
  DOCUMENTS_REQUIRED: ["UNDER_REVIEW", "REJECTED", "WITHDRAWN"],
  ELIGIBLE: ["UNDER_REVIEW", "SHORTLISTED", "OFFERED", "REJECTED", "WITHDRAWN"],
  SHORTLISTED: ["OFFERED", "REJECTED", "WITHDRAWN"],
  OFFERED: ["ACCEPTED", "ELIGIBLE", "SHORTLISTED", "REJECTED", "WITHDRAWN"],
  ACCEPTED: ["ENROLLED", "REJECTED", "WITHDRAWN"],
  ENROLLED: [],
  REJECTED: [],
  WITHDRAWN: [],
};

/** Allow-list of targets a staff member may request through PATCH /status. */
export const STAFF_STATUS_ACTIONS: ApplicationStatus[] = [
  "UNDER_REVIEW",
  "DOCUMENTS_REQUIRED",
  "ELIGIBLE",
  "SHORTLISTED",
  "REJECTED",
];

const TERMINAL: ApplicationStatus[] = ["ENROLLED", "REJECTED", "WITHDRAWN"];

/**
 * Targets a staff member may request from the current status, through
 * PATCH /applications/:id/status. OFFERED/ACCEPTED special-case to REJECTED
 * only: leaving those states is otherwise done via offer expire/decline, and
 * ACCEPTED/ENROLLED are refused by the server outside those flows.
 */
export function staffActionsFor(status: ApplicationStatus): ApplicationStatus[] {
  if (TERMINAL.includes(status)) return [];
  if (status === "OFFERED" || status === "ACCEPTED") return ["REJECTED"];
  return LEGAL_TRANSITIONS[status].filter((s) => STAFF_STATUS_ACTIONS.includes(s));
}

export function isTerminal(status: ApplicationStatus): boolean {
  return TERMINAL.includes(status);
}
