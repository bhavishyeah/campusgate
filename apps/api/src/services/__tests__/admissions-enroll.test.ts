/**
 * Pure admissions enroll match/plan unit tests (design §4 + §2). No I/O, no DB —
 * these pin the create-or-link decision from snapshots: CREATE (no profile),
 * LINK_FLIP_APPLICANT (existing APPLICANT profile), LINK_LEAVE (existing
 * active/graduated profile — never demoted), and REJECT_CROSS_PERSON (an
 * enrollmentNo owned by a different person).
 */
import { describe, expect, it } from "vitest";
import {
  planEnrollment,
  CROSS_PERSON_MESSAGE,
  type ApplicantSnapshot,
  type StudentProfileSnapshot,
} from "../admissions-enroll.js";

const applicant: ApplicantSnapshot = {
  userId: "user_applicant",
  normalizedEmail: "applicant@demo.edu",
  enrollmentNo: "ADM2026001",
};

function profile(overrides: Partial<StudentProfileSnapshot>): StudentProfileSnapshot {
  return {
    id: "sp_1",
    userId: "user_applicant",
    status: "APPLICANT",
    ownerNormalizedEmail: "applicant@demo.edu",
    ...overrides,
  };
}

describe("admissions-enroll: planEnrollment", () => {
  it("CREATE when no profile matches by userId or enrollmentNo", () => {
    expect(planEnrollment(applicant, null, null)).toEqual({ kind: "CREATE" });
  });

  it("LINK_FLIP_APPLICANT when the userId match is in APPLICANT status", () => {
    const sp = profile({ id: "sp_app", status: "APPLICANT" });
    expect(planEnrollment(applicant, sp, null)).toEqual({
      kind: "LINK_FLIP_APPLICANT",
      studentProfileId: "sp_app",
    });
  });

  it("LINK_LEAVE when the userId match is already ACTIVE (never demote)", () => {
    const sp = profile({ id: "sp_active", status: "ACTIVE" });
    expect(planEnrollment(applicant, sp, null)).toEqual({
      kind: "LINK_LEAVE",
      studentProfileId: "sp_active",
    });
  });

  it("LINK_LEAVE when the userId match is GRADUATED (never demote)", () => {
    const sp = profile({ id: "sp_grad", status: "GRADUATED" });
    expect(planEnrollment(applicant, sp, null)).toEqual({
      kind: "LINK_LEAVE",
      studentProfileId: "sp_grad",
    });
  });

  it("prefers the userId match over the enrollmentNo match", () => {
    const byUser = profile({ id: "sp_user", status: "APPLICANT" });
    const byEnroll = profile({ id: "sp_enroll", status: "ACTIVE" });
    expect(planEnrollment(applicant, byUser, byEnroll)).toEqual({
      kind: "LINK_FLIP_APPLICANT",
      studentProfileId: "sp_user",
    });
  });

  it("LINK via enrollmentNo when the found profile is the same person by userId", () => {
    const byEnroll = profile({ id: "sp_e", userId: "user_applicant", status: "APPLICANT" });
    expect(planEnrollment(applicant, null, byEnroll)).toEqual({
      kind: "LINK_FLIP_APPLICANT",
      studentProfileId: "sp_e",
    });
  });

  it("LINK via enrollmentNo when the found profile is the same person by email", () => {
    const byEnroll = profile({
      id: "sp_e2",
      userId: "user_other_same_email",
      ownerNormalizedEmail: "applicant@demo.edu",
      status: "ACTIVE",
    });
    expect(planEnrollment(applicant, null, byEnroll)).toEqual({
      kind: "LINK_LEAVE",
      studentProfileId: "sp_e2",
    });
  });

  it("REJECT_CROSS_PERSON when the enrollmentNo belongs to a different person", () => {
    const byEnroll = profile({
      id: "sp_other",
      userId: "user_other",
      ownerNormalizedEmail: "someone.else@demo.edu",
      status: "ACTIVE",
    });
    expect(planEnrollment(applicant, null, byEnroll)).toEqual({ kind: "REJECT_CROSS_PERSON" });
  });

  it("exposes the stable cross-person 409 message", () => {
    expect(CROSS_PERSON_MESSAGE).toBe("Enrollment number already assigned to another student");
  });
});
