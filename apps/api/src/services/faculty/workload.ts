// CAMPASS Phase 9.1 — Faculty Management: pure workload derivation (design §B.4,
// §B.13). Pure + deterministic: NO DB access. The teaching-hours figure is
// DERIVED from the faculty's ACTIVE PRIMARY FacultyAssignment rows and the
// subject contact-hours map; the over-allocation decision is computed against
// the per-institution policy max. The persistence wrapper + in-handler policy
// lookup live in the route (the exams/grading.ts gradeSubject precedent).
//
// Counting rules (design §B.4, F3):
//   * Only ACTIVE assignments count (status === "ACTIVE").
//   * Only role === "PRIMARY" counts toward sanctioned teaching load; SUBSTITUTE
//     and ASSISTANT are EXCLUDED and surfaced as excludedAssignmentIds.
//   * Counting unit = one DISTINCT (subjectId, classSectionId) ACTIVE PRIMARY
//     assignment. Each section counts separately (two sections = two loads); a
//     section-less assignment (classSectionId === null) is its own unit. The
//     DISTINCT guard only collapses exact duplicate (subjectId, classSectionId)
//     rows (a defensive de-dup, not a merge of different sections).
//   * A subject with a null contactHoursPerWeek contributes 0 and its subjectId
//     is surfaced in unestimatedSubjectIds.

/** One faculty assignment input element (the §B.4 counting fields only). */
export interface WorkloadAssignment {
  id: string;
  subjectId: string;
  classSectionId: string | null;
  role: "PRIMARY" | "SUBSTITUTE" | "ASSISTANT";
  status: "ACTIVE" | "ENDED";
}

/** The computed workload for one (faculty, term). */
export interface ComputedWorkload {
  teachingHours: number; // sum of contactHoursPerWeek over counted PRIMARY units
  totalHours: number; // teachingHours + nonTeachingHours
  overAllocated: boolean; // policyMax != null && totalHours > policyMax
  unestimatedSubjectIds: string[]; // counted units whose subject has null contact hours
  excludedAssignmentIds: string[]; // ACTIVE but non-PRIMARY assignment ids
}

/**
 * Derive a faculty member's workload for a term. Pure — all inputs are supplied
 * by the caller (the route reads the assignments + subject contact hours + the
 * policy max inside its `withTenant` tx).
 *
 * @param assignments the faculty's FacultyAssignment rows for the term
 * @param contactHoursBySubject subjectId -> contactHoursPerWeek (null when unset)
 * @param nonTeachingHours staff-entered admin/research hours (>= 0)
 * @param policyMax the institution workload-policy max, or null when uncapped
 */
export function computeWorkload(
  assignments: readonly WorkloadAssignment[],
  contactHoursBySubject: ReadonlyMap<string, number | null>,
  nonTeachingHours: number,
  policyMax: number | null,
): ComputedWorkload {
  const excludedAssignmentIds: string[] = [];
  // de-dup on distinct (subjectId, classSectionId); each distinct unit counted once
  const countedUnits = new Map<string, string>(); // unitKey -> subjectId

  for (const a of assignments) {
    if (a.status !== "ACTIVE") continue;
    if (a.role !== "PRIMARY") {
      excludedAssignmentIds.push(a.id);
      continue;
    }
    const unitKey = `${a.subjectId}::${a.classSectionId ?? "__NULL__"}`;
    if (!countedUnits.has(unitKey)) {
      countedUnits.set(unitKey, a.subjectId);
    }
  }

  let teachingHours = 0;
  const unestimatedSubjectIds: string[] = [];
  const unestimatedSeen = new Set<string>();

  for (const subjectId of countedUnits.values()) {
    const hours = contactHoursBySubject.get(subjectId);
    if (hours == null) {
      teachingHours += 0;
      if (!unestimatedSeen.has(subjectId)) {
        unestimatedSeen.add(subjectId);
        unestimatedSubjectIds.push(subjectId);
      }
    } else {
      teachingHours += hours;
    }
  }

  const totalHours = teachingHours + nonTeachingHours;
  const overAllocated = policyMax != null && totalHours > policyMax;

  return {
    teachingHours,
    totalHours,
    overAllocated,
    unestimatedSubjectIds,
    excludedAssignmentIds,
  };
}
