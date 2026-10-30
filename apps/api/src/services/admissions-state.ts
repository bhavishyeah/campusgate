// Admissions application lifecycle state machine (design §3). The SINGLE owner
// of the legal-transition invariant for `Application.status`. DB-free and pure
// (mirrors module-system.ts / student-sis.ts): no Prisma client, unit-testable
// without a database. Route handlers call `assertTransition`/`canTransition`
// and, on an illegal move, RETURN a 409 (after a DENIED audit) from the
// `withTenant` callback — they never throw past the handler.

import type { ApplicationStatusValue } from "@campusgate/shared";

export type ApplicationStatus = ApplicationStatusValue;

/**
 * The legal-transition table (design §3) — the single source of truth, also
 * asserted exhaustively by the unit test. Each key lists the states reachable
 * in one hop. Terminal states (ENROLLED, REJECTED, WITHDRAWN) map to an empty
 * set, so they have no outgoing edges.
 *
 * Encoded rules:
 *  - DRAFT → SUBMITTED | WITHDRAWN
 *  - the review edges (SUBMITTED/UNDER_REVIEW/DOCUMENTS_REQUIRED/ELIGIBLE/
 *    SHORTLISTED) — each may move to REJECTED and WITHDRAWN as well
 *  - OFFERED → ACCEPTED | ELIGIBLE | SHORTLISTED | REJECTED | WITHDRAWN
 *    (ELIGIBLE/SHORTLISTED are the decline/expire return edges, §3)
 *  - ACCEPTED → ENROLLED | REJECTED | WITHDRAWN
 *  - ENROLLED / REJECTED / WITHDRAWN terminal (no outgoing edges)
 */
export const LEGAL_TRANSITIONS: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
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
} as const;

/** The three terminal states (no outgoing transitions). */
export const TERMINAL_STATUSES: readonly ApplicationStatus[] = ["ENROLLED", "REJECTED", "WITHDRAWN"];

/** True iff `status` is terminal (has no legal outgoing transition). */
export function isTerminal(status: ApplicationStatus): boolean {
  return LEGAL_TRANSITIONS[status].length === 0;
}

/**
 * Pure predicate: is `from → to` a legal one-hop transition? A no-op (from ===
 * to) is NOT legal — a transition must change the status.
 */
export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** The stable error message a route returns (409) on an illegal transition. */
export function illegalTransitionMessage(from: ApplicationStatus, to: ApplicationStatus): string {
  return `Illegal application transition: ${from} -> ${to}`;
}

export type TransitionResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Assert a transition is legal. Returns `{ ok: true }` or, for an illegal move,
 * `{ ok: false, message }` with the stable 409 message. Mirrors the result-shape
 * style of module-system.ts so the handler can branch without a throw.
 */
export function assertTransition(from: ApplicationStatus, to: ApplicationStatus): TransitionResult {
  if (canTransition(from, to)) return { ok: true };
  return { ok: false, message: illegalTransitionMessage(from, to) };
}
