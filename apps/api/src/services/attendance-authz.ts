import type { DayOfWeek, Prisma } from "@campusgate/db";

/**
 * Faculty-scoped marking authz (design §7.2). The record-level "faculty may mark
 * ONLY an assigned class" guarantee is enforced here as an explicit in-handler
 * ownership assertion (NOT a generic engine `canOnResource`), matching the live
 * GatePass / classes record-level precedent. These helpers run INSIDE the
 * request's `withTenant` transaction (RLS-scoped) so the DB reads are tenant-safe.
 */

/**
 * Resolve the caller's ACTIVE FacultyProfile in this tenant. Returns the faculty
 * id or null when the caller holds `attendance.mark` but has no ACTIVE faculty
 * profile (→ 403 "not a faculty member" at the handler, design §7.3 step 1).
 */
export async function resolveMarkingFaculty(
  tx: Prisma.TransactionClient,
  institutionId: string,
  userId: string,
): Promise<{ facultyId: string } | null> {
  const faculty = await tx.facultyProfile.findFirst({
    where: { userId, institutionId, status: "ACTIVE" },
    select: { id: true },
  });
  return faculty ? { facultyId: faculty.id } : null;
}

/**
 * Whether `facultyId` may mark the given scheduled class (design §7.2).
 *  - Fast path: the ScheduledClass directly names this faculty (the assigned
 *    teacher for that slot) → true without a DB round-trip.
 *  - General path: an ACTIVE FacultyAssignment for this faculty on the same
 *    subject + term, and the same section (or a section-less subject assignment).
 */
export async function assertFacultyAssigned(
  tx: Prisma.TransactionClient,
  institutionId: string,
  facultyId: string,
  scheduled: {
    classSectionId: string;
    subjectId: string;
    academicTermId: string;
    facultyId: string;
  },
): Promise<boolean> {
  if (scheduled.facultyId === facultyId) return true;
  const assignment = await tx.facultyAssignment.findFirst({
    where: {
      institutionId,
      facultyId,
      subjectId: scheduled.subjectId,
      academicTermId: scheduled.academicTermId,
      status: "ACTIVE",
      OR: [{ classSectionId: scheduled.classSectionId }, { classSectionId: null }],
    },
    select: { id: true },
  });
  return assignment !== null;
}

/**
 * Map a Prisma `DayOfWeek` to the JS `Date.getUTCDay()` index (SUN=0..SAT=6),
 * for the recurrence check in the open-session handler (design §8.3).
 */
export function dayOfWeekToIndex(day: DayOfWeek): number {
  const map: Record<DayOfWeek, number> = {
    SUN: 0,
    MON: 1,
    TUE: 2,
    WED: 3,
    THU: 4,
    FRI: 5,
    SAT: 6,
  };
  return map[day];
}
