// CAMPASS Phase 8 — slice 8.2 re-evaluation service helpers (design §8.2/§8.4/§13).
//
// Three small helpers used by the exams routes:
//   * reevalTransitionLegal(from, to) — the SINGLE source of truth for the
//     forward-only re-eval lifecycle, mirroring the reeval_requests_guard trigger.
//     Pure + DB-free so it is unit-tested; the route consults it BEFORE any write
//     and the trigger is the hard DB backstop.
//   * assertSupplementaryLinkage(tx, institutionId, { type, parentExaminationId })
//     — enforces the SUPPLEMENTARY ⇔ parentExaminationId pairing rule and the
//     same-tenant existence of the parent. Returns a deny message or null.
//   * computeSupplementaryEligible(snapshots) — pure: given parent latest-PUBLISHED
//     snapshots filtered to the requested subjects with passed=false, return the
//     DISTINCT eligible studentId set.

import type { Prisma } from "@campusgate/db";

/** The re-eval request lifecycle status values (mirrors ReevalRequestStatus). */
export type ReevalStatus = "REQUESTED" | "UNDER_REVIEW" | "REMARKED" | "CLOSED" | "REJECTED";

/**
 * The single source of truth for the forward-only re-eval lifecycle, mirroring
 * the reeval_requests_guard trigger. Legal edges:
 *   REQUESTED    -> UNDER_REVIEW
 *   UNDER_REVIEW -> REMARKED
 *   REMARKED     -> CLOSED
 *   REQUESTED    -> REJECTED
 *   UNDER_REVIEW -> REJECTED
 * Every other (from, to) — including backward edges, the no-op self transition
 * (the route never asks for it), and any edge out of a terminal CLOSED/REJECTED —
 * is illegal.
 */
export function reevalTransitionLegal(from: string, to: string): boolean {
  switch (from) {
    case "REQUESTED":
      return to === "UNDER_REVIEW" || to === "REJECTED";
    case "UNDER_REVIEW":
      return to === "REMARKED" || to === "REJECTED";
    case "REMARKED":
      return to === "CLOSED";
    default:
      return false; // CLOSED / REJECTED are terminal
  }
}

/**
 * Enforce the supplementary-exam linkage rule at create time:
 *   - type === "SUPPLEMENTARY" ⇒ parentExaminationId is REQUIRED and must resolve
 *     to an existing same-tenant examination.
 *   - type !== "SUPPLEMENTARY" ⇒ parentExaminationId must be ABSENT.
 * Returns a deny message (for a 400 + DENIED audit) or null when the linkage is
 * valid. The composite same-tenant FK is the hard backstop; this gives a clean
 * message and rejects a cross-tenant / non-existent parent before the INSERT.
 */
export async function assertSupplementaryLinkage(
  tx: Prisma.TransactionClient,
  institutionId: string,
  input: { type: string; parentExaminationId?: string | null },
): Promise<{ message: string } | null> {
  const { type, parentExaminationId } = input;
  if (type === "SUPPLEMENTARY") {
    if (!parentExaminationId) {
      return { message: "a supplementary examination requires a parentExaminationId" };
    }
    const parent = await tx.examination.findFirst({
      where: { id: parentExaminationId, institutionId },
      select: { id: true },
    });
    if (!parent) {
      return { message: "parent examination not found" };
    }
    return null;
  }
  if (parentExaminationId) {
    return { message: "parentExaminationId is only valid for a SUPPLEMENTARY examination" };
  }
  return null;
}

/** A parent snapshot row shape relevant to eligibility. */
export interface EligibilitySnapshot {
  studentId: string;
  passed: boolean;
}

/**
 * Pure: given parent latest-PUBLISHED snapshots already filtered to the requested
 * subjects, return the DISTINCT set of studentIds that have at least one
 * non-passing (passed=false) snapshot — the supplementary-eligible set.
 */
export function computeSupplementaryEligible(
  snapshots: readonly EligibilitySnapshot[],
): Set<string> {
  const eligible = new Set<string>();
  for (const s of snapshots) {
    if (!s.passed) eligible.add(s.studentId);
  }
  return eligible;
}
