import { describe, expect, it } from "vitest";
import { updateStudentSchema } from "@campusgate/shared";
import {
  createdPayload,
  updatedPayload,
  programAssignedPayload,
  enrolledPayload,
  promotedPayload,
  transferredPayload,
  deactivatedPayload,
  resolveImportRow,
  type StudentSnapshot,
} from "../student-sis.js";

// ─── student-sis transition service (design §5.3/§6) ─────────────────────────
// DB-free unit tests: every transition builds a StudentProfileHistory payload
// from a plain snapshot + input. These pin the changeType + the previous*/new*
// snapshot each transition records, the updateStudentSchema.strict() rejection
// of a forbidden key, and the resolve-first bulk-import decision.

const base: StudentSnapshot = {
  status: "ACTIVE",
  programId: "prog_old",
  program: "Old Program",
  semester: 2,
  departmentId: "dept_old",
  academicSessionId: "sess_old",
  currentTermId: "term_old",
};

describe("student-sis: transition payloads", () => {
  it("createdPayload records CREATED with only new* axes", () => {
    const next: StudentSnapshot = {
      status: "ACTIVE",
      programId: "prog_1",
      program: "B.Tech CSE",
      semester: 1,
      departmentId: "dept_1",
      academicSessionId: null,
      currentTermId: null,
    };
    const p = createdPayload(next);
    expect(p.changeType).toBe("CREATED");
    expect(p.newStatus).toBe("ACTIVE");
    expect(p.newProgramId).toBe("prog_1");
    expect(p.newProgramText).toBe("B.Tech CSE");
    expect(p.newSemester).toBe(1);
    expect(p.newDepartmentId).toBe("dept_1");
    // no prior state
    expect(p.previousStatus).toBeNull();
    expect(p.previousProgramId).toBeNull();
  });

  it("updatedPayload records UPDATED with status unchanged (no lifecycle axis moves)", () => {
    const p = updatedPayload(base);
    expect(p.changeType).toBe("UPDATED");
    expect(p.previousStatus).toBe("ACTIVE");
    expect(p.newStatus).toBe("ACTIVE");
    expect(p.previousProgramId).toBeNull();
    expect(p.newProgramId).toBeNull();
  });

  it("programAssignedPayload records PROGRAM_CHANGED on the program axis", () => {
    const p = programAssignedPayload(base, "prog_new", "New Program");
    expect(p.changeType).toBe("PROGRAM_CHANGED");
    expect(p.previousProgramId).toBe("prog_old");
    expect(p.newProgramId).toBe("prog_new");
    expect(p.previousProgramText).toBe("Old Program");
    expect(p.newProgramText).toBe("New Program");
  });

  it("enrolledPayload records ENROLLED with session/term/semester and status transition", () => {
    const p = enrolledPayload(base, {
      status: "ENROLLED",
      academicSessionId: "sess_new",
      currentTermId: "term_new",
      semester: 3,
    });
    expect(p.changeType).toBe("ENROLLED");
    expect(p.previousStatus).toBe("ACTIVE");
    expect(p.newStatus).toBe("ENROLLED");
    expect(p.previousSessionId).toBe("sess_old");
    expect(p.newSessionId).toBe("sess_new");
    expect(p.previousTermId).toBe("term_old");
    expect(p.newTermId).toBe("term_new");
    expect(p.previousSemester).toBe(2);
    expect(p.newSemester).toBe(3);
  });

  it("promotedPayload records PROMOTED capturing previous term/semester, status ACTIVE", () => {
    const p = promotedPayload(base, { currentTermId: "term_next", semester: 3 });
    expect(p.changeType).toBe("PROMOTED");
    expect(p.newStatus).toBe("ACTIVE");
    expect(p.previousTermId).toBe("term_old");
    expect(p.newTermId).toBe("term_next");
    expect(p.previousSemester).toBe(2);
    expect(p.newSemester).toBe(3);
  });

  it("transferredPayload records TRANSFERRED on department + program axes", () => {
    const p = transferredPayload(base, {
      departmentId: "dept_new",
      programId: "prog_new",
      programText: "New Program",
    });
    expect(p.changeType).toBe("TRANSFERRED");
    expect(p.previousDepartmentId).toBe("dept_old");
    expect(p.newDepartmentId).toBe("dept_new");
    expect(p.previousProgramId).toBe("prog_old");
    expect(p.newProgramId).toBe("prog_new");
    expect(p.previousProgramText).toBe("Old Program");
    expect(p.newProgramText).toBe("New Program");
  });

  it("deactivatedPayload records DEACTIVATED with the status flip", () => {
    const p = deactivatedPayload(base, "WITHDRAWN");
    expect(p.changeType).toBe("DEACTIVATED");
    expect(p.previousStatus).toBe("ACTIVE");
    expect(p.newStatus).toBe("WITHDRAWN");
  });
});

describe("student-sis: updateStudentSchema.strict()", () => {
  it("accepts permitted mutable fields", () => {
    const parsed = updateStudentSchema.safeParse({ name: "New Name", phone: "123" });
    expect(parsed.success).toBe(true);
  });

  it("rejects a forbidden/unknown key (field not editable)", () => {
    const parsed = updateStudentSchema.safeParse({ enrollmentNo: "E999" });
    expect(parsed.success).toBe(false);
  });

  it("rejects status (a lifecycle field, not editable here)", () => {
    const parsed = updateStudentSchema.safeParse({ status: "WITHDRAWN" });
    expect(parsed.success).toBe(false);
  });
});

describe("student-sis: resolveImportRow (resolve-first re-import rule)", () => {
  const row = { enrollmentNo: "E123", email: "a@demo.edu" };

  it("existing enrollmentNo -> update (never a duplicate)", () => {
    const r = resolveImportRow({ id: "sp_1" }, null, row);
    expect(r).toEqual({ action: "update", studentProfileId: "sp_1" });
  });

  it("existing enrollmentNo even when email also exists -> update (identity key wins)", () => {
    const r = resolveImportRow({ id: "sp_1" }, { id: "u_other" }, row);
    expect(r).toEqual({ action: "update", studentProfileId: "sp_1" });
  });

  it("no enrollmentNo but email belongs to a different user -> skip with error", () => {
    const r = resolveImportRow(null, { id: "u_other" }, row);
    expect(r.action).toBe("skip");
    if (r.action === "skip") expect(r.reason).toContain("E123");
  });

  it("neither exists -> create", () => {
    const r = resolveImportRow(null, null, row);
    expect(r).toEqual({ action: "create" });
  });
});
