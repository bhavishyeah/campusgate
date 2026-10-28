// Faculty-assignment decision service (design §6.7). A pure, DB-free decision
// helper the route layer calls to assign / reassign / substitute a faculty
// member on a subject. It mirrors the student-sis.ts pure-logic pattern: no
// Prisma client, no I/O — unit-testable without a DB. The route owns the
// in-tenant lookups + writes (resolve the replaced assignment, apply the soft
// transition, insert the new row, write the ScheduleRevision + AuditEvent, all
// in one withTenant transaction); this module owns only the "what changes"
// computation so the PRESERVE-HISTORY invariant (§6.7) is enforced uniformly.
//
// Invariant (design §6.7): on a FacultyAssignment row, facultyId / subjectId /
// classSectionId / academicTermId / role are IMMUTABLE after insert. The ONLY
// permitted in-place mutation is the soft transition status ACTIVE -> ENDED
// (plus endedAt). Reassignment / substitution is NEVER an UPDATE of facultyId —
// it ALWAYS ends the current row and INSERTs a new row for the new faculty/role,
// plus a FACULTY_REASSIGNED revision. Prior rows are retained as the historical
// record (preserve-history).

import type { FacultyAssignmentRole } from "@campusgate/db";

/** The subset of a FacultyAssignment row the decision reads (plain scalars). */
export interface AssignmentSnapshot {
  id: string;
  facultyId: string;
  subjectId: string;
  classSectionId: string | null;
  academicTermId: string;
  role: FacultyAssignmentRole;
  status: "ACTIVE" | "ENDED";
}

/** A fresh-assignment request (no prior assignment being replaced). */
export interface AssignInput {
  facultyId: string;
  subjectId: string;
  classSectionId: string | null;
  academicTermId: string;
  role: FacultyAssignmentRole;
}

/** The soft transition applied in place to the ended (replaced) row. */
export interface EndTransition {
  assignmentId: string;
  /** Always ACTIVE -> ENDED; the only permitted in-place status change. */
  status: "ENDED";
  /** The moment the ended row stopped being active. */
  endedAt: Date;
}

/** The new FacultyAssignment row to INSERT (immutable identity after insert). */
export interface NewAssignment {
  facultyId: string;
  subjectId: string;
  classSectionId: string | null;
  academicTermId: string;
  role: FacultyAssignmentRole;
  status: "ACTIVE";
}

/**
 * The FACULTY_REASSIGNED ScheduleRevision payload (design §6.9 per-type column
 * contract). The previous/new faculty pair captures the move; metadata captures
 * the identifying scalars so the revision reconstructs without joining a
 * possibly-later-mutated assignment row.
 */
export interface ReassignmentRevision {
  changeType: "FACULTY_REASSIGNED";
  previousFacultyId: string;
  newFacultyId: string;
  metadata: {
    subjectId: string;
    classSectionId: string | null;
    role: FacultyAssignmentRole;
    endedAssignmentId: string;
  };
}

export type FacultyAssignmentDecision =
  // A brand-new assignment: just insert the new ACTIVE row (no revision — a
  // first assignment is not a reassignment; the route still writes the
  // classes.faculty.assigned audit event).
  | { action: "assign"; newAssignment: NewAssignment }
  // A reassignment / substitution swap: soft-end the current ACTIVE row, insert
  // the new one, and emit a FACULTY_REASSIGNED revision (preserve-history).
  | {
      action: "reassign";
      end: EndTransition;
      newAssignment: NewAssignment;
      revision: ReassignmentRevision;
    };

/**
 * Decide a fresh assignment (no prior row being replaced). The route inserts the
 * returned ACTIVE row and writes the classes.faculty.assigned audit event.
 */
export function decideAssign(input: AssignInput): FacultyAssignmentDecision {
  return {
    action: "assign",
    newAssignment: {
      facultyId: input.facultyId,
      subjectId: input.subjectId,
      classSectionId: input.classSectionId,
      academicTermId: input.academicTermId,
      role: input.role,
      status: "ACTIVE",
    },
  };
}

/**
 * Decide a reassignment / substitution swap (design §6.7). The `current` row is
 * the ACTIVE assignment being replaced (resolved by the route from
 * replacesAssignmentId). The swap:
 *   - soft-ends `current` (status ACTIVE -> ENDED, endedAt = `now`) — the only
 *     permitted in-place mutation; `current`'s identity columns are untouched,
 *     so the prior row is RETAINED as history, never overwritten;
 *   - inserts a NEW ACTIVE row for the new faculty / role (immutable identity);
 *   - emits a FACULTY_REASSIGNED revision capturing previous/new faculty.
 *
 * The new assignment keeps the subject / section / term of the ended row (those
 * identify the teaching slot being handed over); only facultyId and role move.
 */
export function decideReassignment(
  current: AssignmentSnapshot,
  next: { facultyId: string; role: FacultyAssignmentRole },
  now: Date,
): FacultyAssignmentDecision {
  const newAssignment: NewAssignment = {
    facultyId: next.facultyId,
    subjectId: current.subjectId,
    classSectionId: current.classSectionId,
    academicTermId: current.academicTermId,
    role: next.role,
    status: "ACTIVE",
  };

  return {
    action: "reassign",
    end: {
      assignmentId: current.id,
      status: "ENDED",
      endedAt: now,
    },
    newAssignment,
    revision: {
      changeType: "FACULTY_REASSIGNED",
      previousFacultyId: current.facultyId,
      newFacultyId: next.facultyId,
      metadata: {
        subjectId: current.subjectId,
        classSectionId: current.classSectionId,
        role: next.role,
        endedAssignmentId: current.id,
      },
    },
  };
}
