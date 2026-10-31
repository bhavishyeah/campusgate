import { describe, expect, it } from "vitest";
import {
  planReconcile,
  type LedgerKey,
  type ReconcileAssignment,
} from "../teaching-history.js";

// Fast/mocked unit tests for the pure reconcile planner (design §B.5). Dedup on
// (sourceAssignmentId, changeType); ASSIGNED for every assignment; ENDED only for
// status === "ENDED" with endedAt set; idempotent after a full reconcile.

const ASSIGNED_AT = new Date("2026-01-10T00:00:00.000Z");
const ENDED_AT = new Date("2026-06-20T00:00:00.000Z");

const asg = (over: Partial<ReconcileAssignment> & { id: string }): ReconcileAssignment => ({
  subjectId: "subjA",
  classSectionId: "secA",
  academicTermId: "termA",
  role: "PRIMARY",
  status: "ACTIVE",
  assignedAt: ASSIGNED_AT,
  endedAt: null,
  ...over,
});

describe("planReconcile — pure (design §B.5)", () => {
  it("plans an ASSIGNED row for a fresh ACTIVE assignment", () => {
    const plan = planReconcile([], [asg({ id: "a1" })]);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      sourceAssignmentId: "a1",
      changeType: "ASSIGNED",
      effectiveAt: ASSIGNED_AT,
      role: "PRIMARY",
    });
  });

  it("plans BOTH ASSIGNED and ENDED for an ended assignment", () => {
    const plan = planReconcile(
      [],
      [asg({ id: "a1", status: "ENDED", endedAt: ENDED_AT })],
    );
    const types = plan.map((p) => p.changeType).sort();
    expect(types).toEqual(["ASSIGNED", "ENDED"]);
    const ended = plan.find((p) => p.changeType === "ENDED");
    expect(ended?.effectiveAt).toBe(ENDED_AT);
  });

  it("does NOT plan ENDED for a status-ENDED row with a null endedAt", () => {
    const plan = planReconcile(
      [],
      [asg({ id: "a1", status: "ENDED", endedAt: null })],
    );
    expect(plan.map((p) => p.changeType)).toEqual(["ASSIGNED"]);
  });

  it("dedups against existing ledger rows (idempotent)", () => {
    const existing: LedgerKey[] = [
      { sourceAssignmentId: "a1", changeType: "ASSIGNED" },
    ];
    const plan = planReconcile(existing, [asg({ id: "a1" })]);
    expect(plan).toHaveLength(0);
  });

  it("plans only the missing ENDED when ASSIGNED already exists", () => {
    const existing: LedgerKey[] = [
      { sourceAssignmentId: "a1", changeType: "ASSIGNED" },
    ];
    const plan = planReconcile(
      existing,
      [asg({ id: "a1", status: "ENDED", endedAt: ENDED_AT })],
    );
    expect(plan.map((p) => p.changeType)).toEqual(["ENDED"]);
  });

  it("re-running a full reconcile plans nothing", () => {
    const assignments = [
      asg({ id: "a1" }),
      asg({ id: "a2", status: "ENDED", endedAt: ENDED_AT }),
    ];
    const first = planReconcile([], assignments);
    expect(first.length).toBe(3); // a1 ASSIGNED; a2 ASSIGNED + ENDED
    const existing: LedgerKey[] = first.map((p) => ({
      sourceAssignmentId: p.sourceAssignmentId,
      changeType: p.changeType,
    }));
    const second = planReconcile(existing, assignments);
    expect(second).toHaveLength(0);
  });

  it("preserves subject/section/term/role in the planned row", () => {
    const plan = planReconcile(
      [],
      [asg({ id: "a1", subjectId: "subjX", classSectionId: null, academicTermId: "termZ", role: "SUBSTITUTE" })],
    );
    expect(plan[0]).toMatchObject({
      subjectId: "subjX",
      classSectionId: null,
      academicTermId: "termZ",
      role: "SUBSTITUTE",
    });
  });
});
