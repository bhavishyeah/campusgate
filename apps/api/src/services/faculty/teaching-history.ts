// CAMPASS Phase 9.1 — Faculty Management: teaching-history reconcile planner +
// the append-only ledger writer (design §B.5). The ledger (faculty_teaching_history)
// is STRICTLY append-only (DB trigger + append-only RLS pair). This slice adds no
// assignment-mutation endpoint, so history is captured via the staff reconcile
// action: snapshot current + ended assignments into the ledger.
//
// `planReconcile` is PURE (no DB): given the existing ledger rows + the faculty's
// current assignment rows, it emits the ASSIGNED/ENDED rows that are not yet
// represented. Dedup is a service-layer pre-check on (sourceAssignmentId,
// changeType) — the ledger has NO unique on that tuple by design (append-only;
// the reeval idempotent-backfill style). `appendTeachingHistory` inserts the
// planned rows inside the caller's `withTenant` tx.

import type { Prisma } from "@campusgate/db";

export type TeachingHistoryChangeType = "ASSIGNED" | "ENDED";

/** A faculty assignment row to reconcile into the ledger (the §B.5 fields). */
export interface ReconcileAssignment {
  id: string; // FacultyAssignment id → recorded as sourceAssignmentId (no FK)
  subjectId: string;
  classSectionId: string | null;
  academicTermId: string;
  role: "PRIMARY" | "SUBSTITUTE" | "ASSISTANT";
  status: "ACTIVE" | "ENDED";
  assignedAt: Date;
  endedAt: Date | null;
}

/** An existing ledger row, reduced to the dedup key fields. */
export interface LedgerKey {
  sourceAssignmentId: string | null;
  changeType: TeachingHistoryChangeType;
}

/** A planned ledger row to append (identity/tenant fields added by the writer). */
export interface PlannedHistoryRow {
  subjectId: string;
  classSectionId: string | null;
  academicTermId: string;
  sourceAssignmentId: string;
  role: "PRIMARY" | "SUBSTITUTE" | "ASSISTANT";
  changeType: TeachingHistoryChangeType;
  effectiveAt: Date;
}

/**
 * Plan which ledger rows to append. For each assignment:
 *   - an ASSIGNED row (effectiveAt = assignedAt) unless already represented;
 *   - for an ENDED assignment (status === "ENDED" with endedAt set) an ENDED row
 *     (effectiveAt = endedAt) unless already represented.
 * Dedup is on (sourceAssignmentId, changeType). Idempotent: re-running after a
 * full reconcile plans nothing.
 */
export function planReconcile(
  existing: readonly LedgerKey[],
  assignments: readonly ReconcileAssignment[],
): PlannedHistoryRow[] {
  const seen = new Set<string>();
  for (const e of existing) {
    if (e.sourceAssignmentId != null) {
      seen.add(`${e.sourceAssignmentId}::${e.changeType}`);
    }
  }

  const planned: PlannedHistoryRow[] = [];
  const addIfNew = (row: PlannedHistoryRow) => {
    const key = `${row.sourceAssignmentId}::${row.changeType}`;
    if (seen.has(key)) return;
    seen.add(key); // also dedup within this plan (two ENDED of the same assignment)
    planned.push(row);
  };

  for (const a of assignments) {
    addIfNew({
      subjectId: a.subjectId,
      classSectionId: a.classSectionId,
      academicTermId: a.academicTermId,
      sourceAssignmentId: a.id,
      role: a.role,
      changeType: "ASSIGNED",
      effectiveAt: a.assignedAt,
    });
    if (a.status === "ENDED" && a.endedAt != null) {
      addIfNew({
        subjectId: a.subjectId,
        classSectionId: a.classSectionId,
        academicTermId: a.academicTermId,
        sourceAssignmentId: a.id,
        role: a.role,
        changeType: "ENDED",
        effectiveAt: a.endedAt,
      });
    }
  }

  return planned;
}

/**
 * Append the planned rows to faculty_teaching_history inside the caller's
 * `withTenant` tx. institutionId / facultyId / recordedByUserId are supplied by
 * the handler (never from input). A no-op when `rows` is empty.
 */
export async function appendTeachingHistory(
  tx: Prisma.TransactionClient,
  params: {
    institutionId: string;
    facultyId: string;
    recordedByUserId: string;
    rows: readonly PlannedHistoryRow[];
  },
): Promise<number> {
  const { institutionId, facultyId, recordedByUserId, rows } = params;
  if (rows.length === 0) return 0;

  await tx.facultyTeachingHistory.createMany({
    data: rows.map((r) => ({
      institutionId,
      facultyId,
      subjectId: r.subjectId,
      classSectionId: r.classSectionId,
      academicTermId: r.academicTermId,
      sourceAssignmentId: r.sourceAssignmentId,
      role: r.role,
      changeType: r.changeType,
      effectiveAt: r.effectiveAt,
      recordedByUserId,
    })),
  });

  return rows.length;
}
