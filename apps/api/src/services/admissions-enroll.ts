// Admissions enroll match/plan (design §4 + §2). The pure, DB-free decision
// function at the heart of the create-or-link enrollment: given snapshots of the
// applicant and any StudentProfile matched by userId / enrollmentNo, it decides
// whether the enroll handler must CREATE a new profile, LINK to an existing one
// (optionally flipping an APPLICANT-status profile to ENROLLED), or REJECT a
// cross-person enrollmentNo collision. It holds no Prisma client and is
// unit-tested without a database; the thin tx handler in routes/admissions.ts
// performs the I/O the plan prescribes.

import type { StudentStatusValue } from "@campusgate/shared";

/** The applicant side of the match (resolved from the applicant User). */
export interface ApplicantSnapshot {
  /** The applicant User.id (StudentProfile.userId is @unique — strongest signal). */
  userId: string;
  /** The applicant User.email, already normalized (lowercased/trimmed). */
  normalizedEmail: string;
  /** The enrollment number supplied for this admission (the match key). */
  enrollmentNo: string;
}

/** A matched StudentProfile snapshot (the tenant-scoped candidate), or null. */
export interface StudentProfileSnapshot {
  id: string;
  userId: string;
  status: StudentStatusValue;
  /** The owning User.email, normalized — used for the same-person check. */
  ownerNormalizedEmail: string;
}

/**
 * The plan the enroll handler executes:
 *  - CREATE               → no existing profile; create one (status ENROLLED).
 *  - LINK_FLIP_APPLICANT  → existing profile in APPLICANT status; flip it to
 *                           ENROLLED (with a history row) and link.
 *  - LINK_LEAVE           → existing profile in any other status; link only,
 *                           leave the authoritative status untouched.
 *  - REJECT_CROSS_PERSON  → an enrollmentNo matched a profile owned by a
 *                           different person (409, no link, no write).
 */
export type EnrollPlanKind =
  | "CREATE"
  | "LINK_FLIP_APPLICANT"
  | "LINK_LEAVE"
  | "REJECT_CROSS_PERSON";

export type EnrollPlan =
  | { kind: "CREATE" }
  | { kind: "LINK_FLIP_APPLICANT"; studentProfileId: string }
  | { kind: "LINK_LEAVE"; studentProfileId: string }
  | { kind: "REJECT_CROSS_PERSON" };

/** The stable 409 message when an enrollmentNo belongs to a different person. */
export const CROSS_PERSON_MESSAGE = "Enrollment number already assigned to another student";

/**
 * Decide the enroll plan (design §4 match order + §2 reconciliation), purely
 * from snapshots:
 *
 *  1. `byUserId` — a StudentProfile found by the applicant's User.id. The
 *     strongest identity signal (same User). → LINK.
 *  2. `byEnrollmentNo` — a StudentProfile found by the enrollmentNo. It MUST
 *     belong to the same person: its userId equals the applicant's, OR its
 *     owner's normalized email equals the applicant's. A DIFFERENT person →
 *     REJECT_CROSS_PERSON. Same person → LINK.
 *  3. Neither → CREATE.
 *
 * On a LINK, the §2 reconciliation decides FLIP (APPLICANT status) vs LEAVE
 * (any other status — never demote an active/graduated student).
 */
export function planEnrollment(
  applicant: ApplicantSnapshot,
  byUserId: StudentProfileSnapshot | null,
  byEnrollmentNo: StudentProfileSnapshot | null,
): EnrollPlan {
  // 1. Match by applicant User.id (StudentProfile.userId @unique).
  if (byUserId) return linkPlan(byUserId);

  // 2. Match by enrollmentNo — same-person check.
  if (byEnrollmentNo) {
    const samePerson =
      byEnrollmentNo.userId === applicant.userId ||
      byEnrollmentNo.ownerNormalizedEmail === applicant.normalizedEmail;
    if (!samePerson) return { kind: "REJECT_CROSS_PERSON" };
    return linkPlan(byEnrollmentNo);
  }

  // 3. No existing profile — create one.
  return { kind: "CREATE" };
}

/** §2 reconciliation for a same-person LINK: FLIP an APPLICANT profile, else LEAVE. */
function linkPlan(profile: StudentProfileSnapshot): EnrollPlan {
  if (profile.status === "APPLICANT") {
    return { kind: "LINK_FLIP_APPLICANT", studentProfileId: profile.id };
  }
  return { kind: "LINK_LEAVE", studentProfileId: profile.id };
}
