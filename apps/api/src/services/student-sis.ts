// Student-SIS transition service (design §5.3/§6). The SINGLE owner of the pure
// decision logic behind every lifecycle operation on a student record: given a
// snapshot of the current profile + a transition input, it returns the
// StudentProfileHistory changeType + the previous*/new* snapshot payload that
// the route handler writes (atomically, inside withTenant) alongside the live-row
// update. It mirrors module-system.ts / academic-session.ts: the decision logic
// is DB-free so it is unit-testable without a database (design §13).
//
// These functions NEVER hold a real Prisma client and NEVER perform I/O. The
// route handler owns the in-tenant lookups (program/session/term validation,
// the live update, the history insert, the audit event); this module owns only
// the "what changed" computation so PRESERVE-HISTORY (§6) is enforced uniformly.

import type { StudentHistoryChangeType, StudentStatus } from "@campusgate/db";

// ─── Profile snapshot the transitions reason over ──────────────────────────
// The subset of a StudentProfile row the transitions read. Kept to plain scalar
// fields so callers can pass either a full Prisma row or a hand-built object
// (the unit tests do the latter).
export interface StudentSnapshot {
  status: StudentStatus;
  programId: string | null;
  program: string; // free-text program (retained column — §3.4)
  semester: number;
  departmentId: string;
  academicSessionId: string | null;
  currentTermId: string | null;
}

// The previous*/new* columns of a StudentProfileHistory row (design §4.1). Every
// field is optional/nullable — a transition populates only the axes it touches.
export interface HistorySnapshotPayload {
  changeType: StudentHistoryChangeType;
  previousStatus: StudentStatus | null;
  newStatus: StudentStatus | null;
  previousProgramId: string | null;
  newProgramId: string | null;
  previousProgramText: string | null;
  newProgramText: string | null;
  previousSemester: number | null;
  newSemester: number | null;
  previousDepartmentId: string | null;
  newDepartmentId: string | null;
  previousSessionId: string | null;
  newSessionId: string | null;
  previousTermId: string | null;
  newTermId: string | null;
}

/** Base payload with every snapshot column null; transitions override the axes
 * they touch. Keeps every builder exhaustive without repeating 14 nulls. */
function emptyPayload(changeType: StudentHistoryChangeType): HistorySnapshotPayload {
  return {
    changeType,
    previousStatus: null,
    newStatus: null,
    previousProgramId: null,
    newProgramId: null,
    previousProgramText: null,
    newProgramText: null,
    previousSemester: null,
    newSemester: null,
    previousDepartmentId: null,
    newDepartmentId: null,
    previousSessionId: null,
    newSessionId: null,
    previousTermId: null,
    newTermId: null,
  };
}

// ─── CREATED ────────────────────────────────────────────────────────────────
/**
 * Snapshot for a freshly-created student. There is no prior state, so only the
 * new* axes are filled (status/program/semester/department/session/term).
 */
export function createdPayload(next: StudentSnapshot): HistorySnapshotPayload {
  return {
    ...emptyPayload("CREATED"),
    newStatus: next.status,
    newProgramId: next.programId,
    newProgramText: next.program,
    newSemester: next.semester,
    newDepartmentId: next.departmentId,
    newSessionId: next.academicSessionId,
    newTermId: next.currentTermId,
  };
}

// ─── UPDATED (permitted-field profile edit, non-lifecycle) ───────────────────
/**
 * Snapshot for a permitted-mutable-field edit (§5.2). The edit never touches a
 * lifecycle axis, so the payload records the status as both previous+new (an
 * unchanged marker) — the UPDATED changeType is what distinguishes it; no
 * lifecycle axis moved.
 */
export function updatedPayload(current: StudentSnapshot): HistorySnapshotPayload {
  return {
    ...emptyPayload("UPDATED"),
    previousStatus: current.status,
    newStatus: current.status,
  };
}

// ─── PROGRAM_CHANGED (assign-program) ────────────────────────────────────────
/**
 * Snapshot for assign-program (§5.3). Captures the program axis (structured id +
 * free-text) moving from current to the assigned value. `newProgramText` is the
 * refreshed free-text when the caller opted to refresh it, else the unchanged
 * current free-text.
 */
export function programAssignedPayload(
  current: StudentSnapshot,
  newProgramId: string,
  newProgramText: string,
): HistorySnapshotPayload {
  return {
    ...emptyPayload("PROGRAM_CHANGED"),
    previousProgramId: current.programId,
    newProgramId,
    previousProgramText: current.program,
    newProgramText,
  };
}

// ─── ENROLLED ────────────────────────────────────────────────────────────────
/**
 * Snapshot for enroll (§5.3): session/term assigned, status -> ENROLLED (or
 * ACTIVE when activate), optional semester from the term ordinal.
 */
export function enrolledPayload(
  current: StudentSnapshot,
  next: { status: StudentStatus; academicSessionId: string; currentTermId: string; semester: number },
): HistorySnapshotPayload {
  return {
    ...emptyPayload("ENROLLED"),
    previousStatus: current.status,
    newStatus: next.status,
    previousSessionId: current.academicSessionId,
    newSessionId: next.academicSessionId,
    previousTermId: current.currentTermId,
    newTermId: next.currentTermId,
    previousSemester: current.semester,
    newSemester: next.semester,
  };
}

// ─── PROMOTED ────────────────────────────────────────────────────────────────
/**
 * Snapshot for promote (§5.3): advance current term and/or semester, status ->
 * ACTIVE. Captures the previous term/semester so the advance is recoverable; it
 * NEVER rewrites prior history (owner: the route writes a NEW row).
 */
export function promotedPayload(
  current: StudentSnapshot,
  next: { currentTermId: string | null; semester: number },
): HistorySnapshotPayload {
  return {
    ...emptyPayload("PROMOTED"),
    previousStatus: current.status,
    newStatus: "ACTIVE",
    previousTermId: current.currentTermId,
    newTermId: next.currentTermId,
    previousSemester: current.semester,
    newSemester: next.semester,
  };
}

// ─── TRANSFERRED ──────────────────────────────────────────────────────────────
/**
 * Snapshot for transfer (§5.3): change department and/or program. Captures the
 * previous+new department and program axes.
 */
export function transferredPayload(
  current: StudentSnapshot,
  next: { departmentId: string; programId: string | null; programText: string },
): HistorySnapshotPayload {
  return {
    ...emptyPayload("TRANSFERRED"),
    previousDepartmentId: current.departmentId,
    newDepartmentId: next.departmentId,
    previousProgramId: current.programId,
    newProgramId: next.programId,
    previousProgramText: current.program,
    newProgramText: next.programText,
  };
}

// ─── DEACTIVATED ──────────────────────────────────────────────────────────────
/**
 * Snapshot for deactivate/archive (§5.4): status flip to a terminal/hold value.
 * NEVER a hard delete — the route only flips status + appends this row.
 */
export function deactivatedPayload(
  current: StudentSnapshot,
  newStatus: StudentStatus,
): HistorySnapshotPayload {
  return {
    ...emptyPayload("DEACTIVATED"),
    previousStatus: current.status,
    newStatus,
  };
}

// ─── Bulk-import resolve-first rule (§7.3) ────────────────────────────────────
/**
 * The pure decision for one bulk-import row (design §7.3, "no duplicate identity
 * on re-import"). Resolve by enrollmentNo FIRST, before the email check:
 *   - existingByEnrollmentNo present  -> UPDATE the existing profile (never a
 *     second row);
 *   - else the email already belongs to a DIFFERENT user -> SKIP with an error
 *     (a data conflict the admin must resolve);
 *   - else -> CREATE a fresh User + StudentProfile.
 *
 * Takes already-resolved lookup results (plain inputs) so the decision is DB-free
 * and unit-testable; the caller performs the actual lookups + writes in-tenant.
 */
export interface ImportRowIdentity {
  enrollmentNo: string;
  email: string;
}

export type ImportRowResolution =
  | { action: "update"; studentProfileId: string }
  | { action: "create" }
  | { action: "skip"; reason: string };

export function resolveImportRow(
  existingByEnrollmentNo: { id: string } | null,
  existingEmailUser: { id: string } | null,
  row: ImportRowIdentity,
): ImportRowResolution {
  // Identity key first: an existing enrollmentNo is an UPDATE, never a duplicate.
  if (existingByEnrollmentNo) {
    return { action: "update", studentProfileId: existingByEnrollmentNo.id };
  }
  // No such enrollmentNo, but the email is already a user -> conflict, skip.
  if (existingEmailUser) {
    return { action: "skip", reason: `${row.enrollmentNo}: Email already exists` };
  }
  // Neither exists -> fresh create.
  return { action: "create" };
}
