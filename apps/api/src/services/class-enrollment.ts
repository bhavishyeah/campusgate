// Class-enrollment decision service (design §6.5 / §10). A pure, DB-free
// decision helper the route layer calls to decide whether a student may be
// enrolled into a section. It mirrors the student-sis.ts pure-logic pattern:
// no Prisma client, no I/O — unit-testable without a DB. The route owns the
// in-tenant lookups (resolve the existing enrollment by (classSectionId,
// studentId), the ENROLLED count, the INSERT); this module owns only the
// "may we enroll / what's the reason" computation.
//
// Single-identity guarantee (design §6.5): a student is the shared Phase-2
// StudentProfile, resolved by (classSectionId, studentId). Enrollment never
// creates a second copy of the student — it points at the authoritative row.
// No-duplicate is DB-enforced by the (classSectionId, studentId) unique; this
// helper decides the pre-insert outcome so the route can map it to a 409/422.

/** The subset of an existing ClassEnrollment the decision reads (plain scalars). */
export interface ExistingEnrollment {
  id: string;
  status: "ENROLLED" | "DROPPED" | "COMPLETED";
}

export interface EnrollmentDecisionInput {
  classSectionId: string;
  studentId: string;
  /**
   * The existing enrollment row for THIS (classSectionId, studentId), resolved
   * in-tenant by the route, or null when the student has never been enrolled in
   * this section. There is at most one (the (classSectionId, studentId) unique).
   */
  existing: ExistingEnrollment | null;
  /** Section capacity, or null when uncapped. */
  capacity: number | null;
  /** Current count of ENROLLED enrollments in the section. */
  enrolledCount: number;
}

export type EnrollmentDecision =
  // Fresh enrollment: insert a new ENROLLED row.
  | { action: "enroll" }
  // The student already has a live ENROLLED row for this section.
  | { action: "reject"; reason: "duplicate" }
  // The section is at/over capacity.
  | { action: "reject"; reason: "capacity_full" }
  // A prior DROPPED/COMPLETED row exists; re-enroll by reactivating it (never a
  // second row — preserves the single (section,student) identity).
  | { action: "reenroll"; enrollmentId: string };

/**
 * Decide the enrollment outcome for one (classSectionId, studentId).
 *
 * Resolution order:
 *   1. An ENROLLED row already exists  -> reject(duplicate). The no-duplicate
 *      rule (design §6.5) — one live enrollment per (section, student).
 *   2. Capacity is set and the section is full -> reject(capacity_full).
 *      (Checked inside the route transaction; a soft one-row overshoot under
 *      concurrency is accepted per design A9 — this helper uses the count it is
 *      given.)
 *   3. A prior DROPPED/COMPLETED row exists -> reenroll (reactivate it), so the
 *      single (section, student) identity is kept — never a duplicate row.
 *   4. No prior row -> enroll (fresh insert).
 */
export function decideEnrollment(input: EnrollmentDecisionInput): EnrollmentDecision {
  const { existing, capacity, enrolledCount } = input;

  // 1. Live duplicate — one ENROLLED row per (section, student).
  if (existing && existing.status === "ENROLLED") {
    return { action: "reject", reason: "duplicate" };
  }

  // 2. Capacity gate (only when capped). Applies to both fresh enroll and
  //    re-enroll of a previously-dropped student.
  if (capacity !== null && enrolledCount >= capacity) {
    return { action: "reject", reason: "capacity_full" };
  }

  // 3. Re-enroll a previously DROPPED/COMPLETED student by reactivating the row.
  if (existing) {
    return { action: "reenroll", enrollmentId: existing.id };
  }

  // 4. Fresh enrollment.
  return { action: "enroll" };
}
