// Academic-session / term state machine (design §5.1/§5.2/§6). The SINGLE owner
// of the session/term lifecycle invariants, mirroring module-system.ts
// ownership: legal status transitions only, exactly-one-ACTIVE session per
// institution, >=1 term (each with startDate<endDate) before a session may be
// activated. Soft warnings (term-count vs structureType, term-outside-session,
// term-overlap) WARN but never block — this is what keeps the structure
// configurable (design §3.3/§5.1).
//
// Lifecycle is STATUS-ONLY (preserve-history §6): a transition only ever flips a
// status enum; it never rewrites dates/name/structureType of a non-UPCOMING
// session and never deletes terms. The partial unique index
// `academic_sessions_one_active_per_institution` is the DB backstop for the
// one-active invariant; this service gives the friendly 409.
//
// PROMOTION SEAM (modelled, NOT executed — design §6.3): a future SIS promote
// operation will create NEW session/term-scoped enrollment rows in the TARGET
// session, leaving the source session's rows untouched and CLOSED-linked. Phase
// 1 only guarantees the target structures exist and are immutable-by-status.
// This service touches NO StudentProfile and creates NO enrollment rows.
//
// All functions run on a passed tenant tx (withTenant), so the read + the write
// are atomic within the caller's transaction. Transition predicates are kept
// pure where possible so they are unit-testable without a DB (design §13).

import type { Prisma } from "@campusgate/db";
import type { AcademicStructureType } from "@campusgate/db";

export interface Warning {
  code: string;
  message: string;
}

// ─── Pure predicates (DB-free, unit-testable) ───────────────────────────────

/** Suggested term count for a structure type (soft guidance, never enforced). */
export function suggestedTermCount(structureType: AcademicStructureType): number | null {
  switch (structureType) {
    case "SEMESTER":
      return 2;
    case "TRIMESTER":
      return 3;
    case "ANNUAL":
      return 1;
    case "CUSTOM":
      return null; // any N >= 1
  }
}

/**
 * Soft warning when the defined term count differs from the structure's
 * suggestion. CUSTOM never warns. Never blocks — returns a warning or null.
 */
export function termCountWarning(
  structureType: AcademicStructureType,
  termCount: number,
): Warning | null {
  const suggested = suggestedTermCount(structureType);
  if (suggested === null) return null;
  if (termCount === suggested) return null;
  return {
    code: "TERM_COUNT_SUGGESTION",
    message: `A ${structureType} session usually has ${suggested} term(s); this session has ${termCount}.`,
  };
}

interface DateRange {
  startDate: Date;
  endDate: Date;
}

/** Soft warning when a term's range falls outside the session's range. */
export function termOutsideSessionWarning(
  term: DateRange,
  session: DateRange,
): Warning | null {
  if (term.startDate < session.startDate || term.endDate > session.endDate) {
    return {
      code: "TERM_OUTSIDE_SESSION",
      message: "Term dates fall outside the session's date range.",
    };
  }
  return null;
}

/** Soft warning when a new term overlaps in time with an existing term. */
export function termOverlapWarning(
  newTerm: DateRange,
  existingTerms: DateRange[],
): Warning | null {
  const overlaps = existingTerms.some(
    (t) => newTerm.startDate < t.endDate && t.startDate < newTerm.endDate,
  );
  if (overlaps) {
    return {
      code: "TERM_OVERLAP",
      message: "Term overlaps in time with another term in this session.",
    };
  }
  return null;
}

// ─── Service results ─────────────────────────────────────────────────────────

type SessionRow = {
  id: string;
  institutionId: string;
  name: string;
  structureType: AcademicStructureType;
  status: "UPCOMING" | "ACTIVE" | "CLOSED";
  startDate: Date;
  endDate: Date;
};

type TermRow = {
  id: string;
  academicSessionId: string;
  status: "UPCOMING" | "ACTIVE" | "CLOSED";
  startDate: Date;
  endDate: Date;
};

export type ActivateSessionResult =
  | { ok: true; session: SessionRow; closedSessionId: string | null; warnings: Warning[] }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "INVALID_STATE" }
  | { ok: false; code: "NO_TERMS" }
  | { ok: false; code: "TERM_INVALID_DATES"; termId: string }
  | { ok: false; code: "ACTIVE_EXISTS" };

export type CloseSessionResult =
  | { ok: true; session: SessionRow }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "INVALID_STATE" };

export type TermTransitionResult =
  | { ok: true; term: TermRow }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "INVALID_STATE" }
  | { ok: false; code: "SESSION_NOT_ACTIVE" };

// ─── DB-touching transitions ─────────────────────────────────────────────────

/**
 * activateSession: UPCOMING -> ACTIVE. Preconditions (all inside the tx):
 *  - session is UPCOMING (else INVALID_STATE / 409);
 *  - session has >= 1 term (else NO_TERMS / 409);
 *  - each term has startDate < endDate (else TERM_INVALID_DATES / 409);
 *  - no other ACTIVE session unless handover=true, in which case the current
 *    ACTIVE session is CLOSED first (status-only flip — preserve-history).
 * Term containment / overlap are NOT re-checked here (allowed-but-warned at
 * term-add time per §5.1). Soft warnings (term-count suggestion) are returned
 * but never block.
 */
export async function activateSession(
  db: Prisma.TransactionClient,
  institutionId: string,
  sessionId: string,
  handover: boolean,
): Promise<ActivateSessionResult> {
  const session = (await db.academicSession.findFirst({
    where: { id: sessionId, institutionId },
  })) as SessionRow | null;

  if (!session) return { ok: false, code: "NOT_FOUND" };
  if (session.status !== "UPCOMING") return { ok: false, code: "INVALID_STATE" };

  const terms = (await db.academicTerm.findMany({
    where: { academicSessionId: sessionId, institutionId },
    orderBy: { ordinal: "asc" },
  })) as TermRow[];

  if (terms.length === 0) return { ok: false, code: "NO_TERMS" };

  const invalid = terms.find((t) => !(t.startDate < t.endDate));
  if (invalid) return { ok: false, code: "TERM_INVALID_DATES", termId: invalid.id };

  const currentActive = (await db.academicSession.findFirst({
    where: { institutionId, status: "ACTIVE" },
  })) as SessionRow | null;

  let closedSessionId: string | null = null;
  if (currentActive) {
    if (!handover) return { ok: false, code: "ACTIVE_EXISTS" };
    await db.academicSession.update({
      where: { id: currentActive.id },
      data: { status: "CLOSED" },
    });
    closedSessionId = currentActive.id;
  }

  const updated = (await db.academicSession.update({
    where: { id: sessionId },
    data: { status: "ACTIVE" },
  })) as SessionRow;

  const warnings: Warning[] = [];
  const countWarn = termCountWarning(session.structureType, terms.length);
  if (countWarn) warnings.push(countWarn);

  return { ok: true, session: updated, closedSessionId, warnings };
}

/**
 * closeSession: ACTIVE -> CLOSED, or UPCOMING -> CLOSED (cancel an upcoming
 * session). Pure status flip; never touches terms, calendar, or any enrollment
 * row (preserve-history §5.2/§6). A CLOSED session cannot be re-closed.
 */
export async function closeSession(
  db: Prisma.TransactionClient,
  institutionId: string,
  sessionId: string,
): Promise<CloseSessionResult> {
  const session = (await db.academicSession.findFirst({
    where: { id: sessionId, institutionId },
  })) as SessionRow | null;

  if (!session) return { ok: false, code: "NOT_FOUND" };
  if (session.status === "CLOSED") return { ok: false, code: "INVALID_STATE" };

  const updated = (await db.academicSession.update({
    where: { id: sessionId },
    data: { status: "CLOSED" },
  })) as SessionRow;

  return { ok: true, session: updated };
}

/**
 * activateTerm: UPCOMING -> ACTIVE. A term can be ACTIVE only within an ACTIVE
 * session.
 */
export async function activateTerm(
  db: Prisma.TransactionClient,
  institutionId: string,
  termId: string,
): Promise<TermTransitionResult> {
  const term = (await db.academicTerm.findFirst({
    where: { id: termId, institutionId },
  })) as TermRow | null;

  if (!term) return { ok: false, code: "NOT_FOUND" };
  if (term.status !== "UPCOMING") return { ok: false, code: "INVALID_STATE" };

  const session = (await db.academicSession.findFirst({
    where: { id: term.academicSessionId, institutionId },
    select: { status: true },
  })) as { status: string } | null;

  if (!session || session.status !== "ACTIVE") {
    return { ok: false, code: "SESSION_NOT_ACTIVE" };
  }

  const updated = (await db.academicTerm.update({
    where: { id: termId },
    data: { status: "ACTIVE" },
  })) as TermRow;

  return { ok: true, term: updated };
}

/**
 * closeTerm: ACTIVE/UPCOMING -> CLOSED. Pure status flip.
 */
export async function closeTerm(
  db: Prisma.TransactionClient,
  institutionId: string,
  termId: string,
): Promise<TermTransitionResult> {
  const term = (await db.academicTerm.findFirst({
    where: { id: termId, institutionId },
  })) as TermRow | null;

  if (!term) return { ok: false, code: "NOT_FOUND" };
  if (term.status === "CLOSED") return { ok: false, code: "INVALID_STATE" };

  const updated = (await db.academicTerm.update({
    where: { id: termId },
    data: { status: "CLOSED" },
  })) as TermRow;

  return { ok: true, term: updated };
}
