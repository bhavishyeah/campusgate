import { describe, expect, it } from "vitest";
import {
  decideAssign,
  decideReassignment,
  type AssignmentSnapshot,
} from "../faculty-assignment.js";

// ─── Faculty-assignment decision (design §6.7) ───────────────────────────────
// DB-free unit tests: a fresh assign inserts an ACTIVE row with no revision; a
// reassignment / substitution swap soft-ends the current row (ACTIVE -> ENDED +
// endedAt), inserts a new ACTIVE row with immutable identity, and emits a
// FACULTY_REASSIGNED revision. The PRESERVE-HISTORY assertion: the prior row is
// retained (ended), never overwritten.

const current: AssignmentSnapshot = {
  id: "asg_1",
  facultyId: "fac_OLD",
  subjectId: "subj_1",
  classSectionId: "sec_1",
  academicTermId: "term_1",
  role: "PRIMARY",
  status: "ACTIVE",
};

describe("decideAssign — fresh assignment", () => {
  it("inserts an ACTIVE row with no reassignment/revision", () => {
    const d = decideAssign({
      facultyId: "fac_NEW",
      subjectId: "subj_1",
      classSectionId: "sec_1",
      academicTermId: "term_1",
      role: "PRIMARY",
    });
    expect(d.action).toBe("assign");
    if (d.action !== "assign") throw new Error("unreachable");
    expect(d.newAssignment).toEqual({
      facultyId: "fac_NEW",
      subjectId: "subj_1",
      classSectionId: "sec_1",
      academicTermId: "term_1",
      role: "PRIMARY",
      status: "ACTIVE",
    });
  });
});

describe("decideReassignment — soft-transition swap (preserve history)", () => {
  const now = new Date("2026-03-01T00:00:00.000Z");

  it("soft-ends the current row: status ACTIVE -> ENDED + endedAt, identity untouched", () => {
    const d = decideReassignment(current, { facultyId: "fac_NEW", role: "SUBSTITUTE" }, now);
    expect(d.action).toBe("reassign");
    if (d.action !== "reassign") throw new Error("unreachable");

    // PRESERVE-HISTORY: the prior row is ENDED in place, never deleted or
    // rewritten — only status + endedAt change; its id is retained.
    expect(d.end.assignmentId).toBe("asg_1");
    expect(d.end.status).toBe("ENDED");
    expect(d.end.endedAt).toBe(now);
    // The transition carries no facultyId/subjectId/role change for the old row —
    // those columns stay immutable; the end transition only flips status/endedAt.
    expect(Object.keys(d.end).sort()).toEqual(["assignmentId", "endedAt", "status"]);
  });

  it("inserts a NEW ACTIVE row carrying the ended row's slot identity + the new faculty/role", () => {
    const d = decideReassignment(current, { facultyId: "fac_NEW", role: "SUBSTITUTE" }, now);
    if (d.action !== "reassign") throw new Error("unreachable");
    expect(d.newAssignment).toEqual({
      facultyId: "fac_NEW",
      subjectId: "subj_1", // inherited from the ended row (immutable slot identity)
      classSectionId: "sec_1",
      academicTermId: "term_1",
      role: "SUBSTITUTE",
      status: "ACTIVE",
    });
  });

  it("emits a FACULTY_REASSIGNED revision capturing previous/new faculty + identifying metadata", () => {
    const d = decideReassignment(current, { facultyId: "fac_NEW", role: "SUBSTITUTE" }, now);
    if (d.action !== "reassign") throw new Error("unreachable");
    expect(d.revision).toEqual({
      changeType: "FACULTY_REASSIGNED",
      previousFacultyId: "fac_OLD",
      newFacultyId: "fac_NEW",
      metadata: {
        subjectId: "subj_1",
        classSectionId: "sec_1",
        role: "SUBSTITUTE",
        endedAssignmentId: "asg_1",
      },
    });
  });

  it("the new row is a distinct insert, not a mutation of the prior row's id", () => {
    const d = decideReassignment(current, { facultyId: "fac_NEW", role: "PRIMARY" }, now);
    if (d.action !== "reassign") throw new Error("unreachable");
    // The decision never exposes a way to rewrite the ended row's facultyId;
    // the new faculty lives only on the freshly-inserted ACTIVE row.
    expect(d.newAssignment.facultyId).toBe("fac_NEW");
    expect(d.end.assignmentId).toBe(current.id);
    expect(d.revision.previousFacultyId).toBe(current.facultyId);
  });

  it("supports a null classSection in the ended row (carried through)", () => {
    const termWide: AssignmentSnapshot = { ...current, classSectionId: null };
    const d = decideReassignment(termWide, { facultyId: "fac_NEW", role: "ASSISTANT" }, now);
    if (d.action !== "reassign") throw new Error("unreachable");
    expect(d.newAssignment.classSectionId).toBeNull();
    expect(d.revision.metadata.classSectionId).toBeNull();
  });
});
