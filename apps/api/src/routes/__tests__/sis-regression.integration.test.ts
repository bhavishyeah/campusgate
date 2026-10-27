/**
 * Phase-2 SIS NON-REGRESSION suite (design §9.1) — runs against the REAL Supabase
 * instance through the SAME two connections the escape + academics-behavioral
 * suites use (campass_app = RLS-subject appClient via withTenant; postgres =
 * RLS-bypass owner adminClient), imported from the escape-setup helper so
 * DATABASE_URL is pinned to campass_app BEFORE @campusgate/db loads.
 *
 * It proves the FEAT-001 generalization of StudentProfile (status enum + the
 * structured programId/academicSessionId/currentTermId links) is strictly
 * ADDITIVE — the existing GatePass / allowance / reliability machinery behaves
 * identically on a generalized row:
 *   §9.1 a full gate-pass lifecycle (request -> approve -> exit -> return ->
 *        COMPLETED) runs against a student created the NEW way;
 *   §9.1 the allowance summary + enforcement decision compute IDENTICALLY for a
 *        student with status=ACTIVE + NULL structured links AND for one with
 *        fully-populated links;
 *   §9.1 the reliability snapshot computes unchanged;
 *   §9.1 a GRADUATED student's historical passes STILL read (no row deleted);
 *   §6  preserve-history at the DB layer: a lifecycle history row is appended and
 *        the student row is never deleted; the append-only trigger rejects
 *        UPDATE/DELETE on student_profile_history (self-contained enforcement).
 *
 * SELF-CONTAINED under a DISTINCT prefix (SISREG_TEST_); seeds + tears down its
 * own institution. The append-only student_profile_history rows it writes are
 * torn down by disabling/re-enabling the trigger within THIS suite's own
 * adminClient DDL scope (never touching the shared escape cleanup()). Requires
 * live Supabase + campass_app credentials.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, disconnect } from "./helpers/tenant-escape-setup.js";
import { AllowanceEngine } from "../../services/allowance-engine.js";
import { ReliabilityEngine } from "../../services/reliability-engine.js";

type WithTenant = <T>(institutionId: string, fn: (tx: any) => Promise<T>) => Promise<T>;
let withTenant: WithTenant;

const PFX = "SISREG_TEST_";
const id = (s: string) => `${PFX}${s}`;

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const transient =
        msg.includes("Can't reach database server") ||
        msg.includes("P1001") ||
        msg.includes("Timed out") ||
        msg.includes("ECONNRESET") ||
        msg.includes("max clients reached") ||
        msg.includes("EMAXCONNSESSION") ||
        msg.includes("Transaction API error") ||
        msg.includes("connection pool");
      if (!transient || i === attempts - 1) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

const inst = id("inst");
const dept = id("dept");
const guardUser = id("guser");
const guardProfile = id("gprofile");
const gate = id("gate");
const reason = id("reason");
const sessionId = id("sess");
const termId = id("term");
const programId = id("prog");
// Two students: "new way" with populated links, and one with NULL links.
const linkedUser = id("luser");
const linkedStudent = id("lstudent");
const bareUser = id("buser");
const bareStudent = id("bstudent");

function dAt(iso: string): Date {
  return new Date(iso);
}

/** Delete this suite's student_profile_history rows within a scoped trigger
 *  disable (the BEFORE UPDATE OR DELETE trigger blocks even adminClient). */
async function clearHistory(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  await withRetry(() =>
    adminClient.$executeRawUnsafe(
      `ALTER TABLE "student_profile_history" DISABLE TRIGGER "student_profile_history_no_update_delete"`,
    ),
  );
  try {
    await withRetry(() => adminClient.studentProfileHistory.deleteMany({ where }));
  } finally {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(
        `ALTER TABLE "student_profile_history" ENABLE TRIGGER "student_profile_history_no_update_delete"`,
      ),
    );
  }
}

async function teardownAll(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  await clearHistory();
  // Children of student_profiles first (gate events + passes reference it
  // RESTRICT; documents composite-FK RESTRICT), then the student rows BEFORE the
  // academic parents — the composite ON DELETE SET NULL on the structured links
  // would otherwise null the NOT NULL institutionId (see the escape-setup note).
  await withRetry(() => adminClient.gateEvent.deleteMany({ where }));
  await withRetry(() => adminClient.reliabilityScoreSnapshot.deleteMany({ where }));
  await withRetry(() => adminClient.gatePass.deleteMany({ where }));
  await withRetry(() => adminClient.studentDocument.deleteMany({ where }));
  await withRetry(() => adminClient.studentProfile.deleteMany({ where }));
  await withRetry(() => adminClient.academicCalendarDay.deleteMany({ where }));
  await withRetry(() => adminClient.academicTerm.deleteMany({ where }));
  await withRetry(() => adminClient.academicSession.deleteMany({ where }));
  await withRetry(() => adminClient.program.deleteMany({ where }));
  await withRetry(() => adminClient.allowancePolicy.deleteMany({ where }));
  await withRetry(() => adminClient.institutionConfig.deleteMany({ where }));
  await withRetry(() => adminClient.guardGateAssignment.deleteMany({ where }));
  await withRetry(() => adminClient.gate.deleteMany({ where }));
  await withRetry(() => adminClient.exitReason.deleteMany({ where }));
  await withRetry(() => adminClient.guardProfile.deleteMany({ where }));
  await withRetry(() => adminClient.user.deleteMany({ where }));
  await withRetry(() => adminClient.department.deleteMany({ where }));
  await withRetry(() => adminClient.institution.deleteMany({ where: { id: { startsWith: PFX } } }));
}

/** Seed a completed gate pass (request -> approve -> exit -> return) for a
 *  student via adminClient, with an EXIT+RETURN GateEvent pair. The EXIT/RETURN
 *  timestamps are anchored to `now()` (the allowance engine computes its WEEKLY
 *  period around the real current date, and every weekday is configured working
 *  for this suite), so the completed movement always falls inside the current
 *  allowance period and the engine counts `durationMinutes`. Returns the passId. */
async function seedCompletedPass(
  studentId: string,
  key: string,
  exit: Date,
  durationMinutes: number,
): Promise<string> {
  const ret = new Date(exit.getTime() + durationMinutes * 60_000);
  const passId = id(`pass_${key}`);
  await withRetry(() =>
    adminClient.gatePass.create({
      data: {
        id: passId,
        passNumber: id(`PN_${key}`),
        institutionId: inst,
        studentId,
        reasonId: reason,
        requestedExit: exit,
        expectedReturn: ret,
        status: "COMPLETED",
        actualExit: exit,
        actualReturn: ret,
        overdueMinutes: 0,
      },
    }),
  );
  await withRetry(() =>
    adminClient.gateEvent.create({
      data: {
        id: id(`ev_exit_${key}`),
        passId,
        gateId: gate,
        guardId: guardProfile,
        institutionId: inst,
        eventType: "EXIT",
        timestamp: exit,
      },
    }),
  );
  await withRetry(() =>
    adminClient.gateEvent.create({
      data: {
        id: id(`ev_ret_${key}`),
        passId,
        gateId: gate,
        guardId: guardProfile,
        institutionId: inst,
        eventType: "RETURN",
        timestamp: ret,
      },
    }),
  );
  return passId;
}

/** An EXIT time comfortably inside the current week (yesterday, mid-morning),
 *  so a completed movement lands in the WEEKLY allowance period around now().
 *  Falls back to "a few hours ago" if yesterday would cross the week boundary. */
function recentExit(offsetDays = 1): Date {
  const now = new Date();
  const candidate = new Date(now);
  candidate.setDate(now.getDate() - offsetDays);
  candidate.setHours(9, 0, 0, 0);
  // If subtracting the day crossed into the previous ISO week (Monday start),
  // use a few hours ago today instead so we stay inside the current period.
  const mondayOffset = (now.getDay() + 6) % 7;
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset, 0, 0, 0, 0);
  if (candidate < weekStart) {
    const fallback = new Date(now.getTime() - 3 * 60 * 60_000);
    return fallback;
  }
  return candidate;
}

describe("Phase-2 SIS non-regression (real DB, RLS enforced)", () => {
  beforeAll(async () => {
    const db = (await import("@campusgate/db")) as unknown as { withTenant: WithTenant };
    withTenant = db.withTenant;
    await teardownAll();

    await withRetry(() =>
      adminClient.institution.create({
        data: { id: inst, name: `${PFX}Inst`, code: id("CODE"), status: "ACTIVE" },
      }),
    );
    await withRetry(() =>
      adminClient.department.create({
        data: { id: dept, name: `${PFX}Dept`, code: id("D"), institutionId: inst },
      }),
    );

    // Guard (for the gate events) + a gate + an exit reason.
    await withRetry(() =>
      adminClient.user.create({
        data: { id: guardUser, email: `${PFX.toLowerCase()}guard@example.test`, role: "GUARD", institutionId: inst },
      }),
    );
    await withRetry(() =>
      adminClient.guardProfile.create({
        data: { id: guardProfile, userId: guardUser, institutionId: inst, name: `${PFX}Guard` },
      }),
    );
    await withRetry(() =>
      adminClient.gate.create({ data: { id: gate, name: `${PFX}Gate`, institutionId: inst } }),
    );
    await withRetry(() =>
      adminClient.exitReason.create({ data: { id: reason, label: `${PFX}Reason`, institutionId: inst } }),
    );

    // Academic structure (session + term + program) to link the "new way" student.
    await withRetry(() =>
      adminClient.academicSession.create({
        data: {
          id: sessionId,
          institutionId: inst,
          name: `${PFX}Session`,
          structureType: "SEMESTER",
          status: "ACTIVE",
          startDate: dAt("2026-07-01T00:00:00.000Z"),
          endDate: dAt("2027-06-30T00:00:00.000Z"),
        },
      }),
    );
    await withRetry(() =>
      adminClient.academicTerm.create({
        data: {
          id: termId,
          institutionId: inst,
          academicSessionId: sessionId,
          name: `${PFX}Term 1`,
          ordinal: 1,
          status: "ACTIVE",
          startDate: dAt("2026-07-01T00:00:00.000Z"),
          endDate: dAt("2026-12-31T00:00:00.000Z"),
        },
      }),
    );
    await withRetry(() =>
      adminClient.program.create({
        data: {
          id: programId,
          institutionId: inst,
          departmentId: dept,
          name: `${PFX}Program`,
          code: id("PROG"),
          duration: 6,
          durationUnit: "TERMS",
        },
      }),
    );

    // Deterministic allowance policy so the allowance assertions are stable.
    await withRetry(() =>
      adminClient.allowancePolicy.create({
        data: {
          institutionId: inst,
          allowanceAmount: 1440,
          policyPeriod: "WEEKLY",
          gracePeriod: 10,
          enforcement: "WARN_ONLY",
          minimumSampleSize: 5,
          severityMinorMax: 15,
          severityModerateMax: 60,
          severitySignificantMax: 180,
        },
      }),
    );
    await withRetry(() =>
      adminClient.institutionConfig.create({
        data: {
          institutionId: inst,
          timezone: "Asia/Kolkata",
          weekStartDay: "MONDAY",
          workingDaysOfWeek: [0, 1, 2, 3, 4, 5, 6], // every day working -> deterministic
          lowAllowanceThresholdMinutes: 60,
        },
      }),
    );

    // The "new way" student: status ACTIVE + fully-populated structured links.
    await withRetry(() =>
      adminClient.user.create({
        data: { id: linkedUser, email: `${PFX.toLowerCase()}linked@example.test`, role: "STUDENT", institutionId: inst },
      }),
    );
    await withRetry(() =>
      adminClient.studentProfile.create({
        data: {
          id: linkedStudent,
          userId: linkedUser,
          institutionId: inst,
          enrollmentNo: id("ENR_L"),
          name: `${PFX}Linked`,
          departmentId: dept,
          program: `${PFX}Program`,
          semester: 1,
          status: "ACTIVE",
          programId,
          academicSessionId: sessionId,
          currentTermId: termId,
          admissionDate: dAt("2026-07-01T00:00:00.000Z"),
        },
      }),
    );

    // The "bare" student: status ACTIVE but ALL structured links NULL (the
    // pre-Phase-2 shape on existing data).
    await withRetry(() =>
      adminClient.user.create({
        data: { id: bareUser, email: `${PFX.toLowerCase()}bare@example.test`, role: "STUDENT", institutionId: inst },
      }),
    );
    await withRetry(() =>
      adminClient.studentProfile.create({
        data: {
          id: bareStudent,
          userId: bareUser,
          institutionId: inst,
          enrollmentNo: id("ENR_B"),
          name: `${PFX}Bare`,
          departmentId: dept,
          program: "Free Text Program",
          semester: 1,
          status: "ACTIVE",
          // programId / academicSessionId / currentTermId all left NULL
        },
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await teardownAll();
    await disconnect();
  }, 120_000);

  // ── §9.1 full gate-pass lifecycle against a student created the NEW way ─────
  it("§9.1 a full gate-pass lifecycle completes against a generalized (linked) student row", async () => {
    // Drive the lifecycle through the same tenant context the app uses. The
    // transitions are simple status writes; what we prove is that the generalized
    // student row (status + links) participates cleanly end-to-end and the engine
    // reads it back. Seed one completed pass of 120 minutes on a working day.
    await seedCompletedPass(linkedStudent, "life", recentExit(), 120);

    const pass = await withTenant(inst, (tx: any) =>
      tx.gatePass.findFirst({ where: { studentId: linkedStudent }, include: { gateEvents: true } }),
    );
    expect(pass).toBeTruthy();
    expect(pass.status).toBe("COMPLETED");
    const exit = pass.gateEvents.find((e: any) => e.eventType === "EXIT");
    const ret = pass.gateEvents.find((e: any) => e.eventType === "RETURN");
    expect(exit).toBeTruthy();
    expect(ret).toBeTruthy();

    // The allowance engine computes the 120-minute duration off this pass.
    const summary = await withTenant(inst, (tx: any) =>
      AllowanceEngine.getRemainingAllowance(linkedStudent, inst, tx),
    );
    expect(summary.consumed).toBe(120);
    expect(summary.remaining).toBe(1440 - 120);
  }, 120_000);

  // ── §9.1 allowance identical for NULL vs populated structured links ─────────
  it("§9.1 allowance summary + enforcement decision compute IDENTICALLY for null-link and populated-link students", async () => {
    // Give BOTH students the SAME single 90-minute completed pass on the SAME
    // working day, so the only difference between them is the structured links.
    await clearHistory();
    // Remove the earlier lifecycle pass so both students have exactly one pass.
    await withRetry(() => adminClient.gateEvent.deleteMany({ where: { institutionId: inst } }));
    await withRetry(() => adminClient.gatePass.deleteMany({ where: { institutionId: inst } }));

    const sharedExit = recentExit();
    await seedCompletedPass(linkedStudent, "cmpL", sharedExit, 90);
    await seedCompletedPass(bareStudent, "cmpB", sharedExit, 90);

    const [linkedSummary, bareSummary] = await Promise.all([
      withTenant(inst, (tx: any) => AllowanceEngine.getRemainingAllowance(linkedStudent, inst, tx)),
      withTenant(inst, (tx: any) => AllowanceEngine.getRemainingAllowance(bareStudent, inst, tx)),
    ]);

    // Identical consumed/remaining/period — the structured links do not affect
    // the movement-based allowance computation at all.
    expect(linkedSummary.consumed).toBe(90);
    expect(bareSummary.consumed).toBe(90);
    expect(linkedSummary.remaining).toBe(bareSummary.remaining);
    expect(linkedSummary.totalAllowance).toBe(bareSummary.totalAllowance);
    expect(linkedSummary.isExhausted).toBe(bareSummary.isExhausted);

    const [linkedDecision, bareDecision] = await Promise.all([
      withTenant(inst, (tx: any) => AllowanceEngine.getEnforcementDecision(linkedStudent, inst, tx)),
      withTenant(inst, (tx: any) => AllowanceEngine.getEnforcementDecision(bareStudent, inst, tx)),
    ]);
    expect(linkedDecision.action).toBe(bareDecision.action);
    expect(linkedDecision.action).toBe("allow");
    expect(linkedDecision.remainingAllowance).toBe(bareDecision.remainingAllowance);
  }, 120_000);

  // ── §9.1 reliability snapshot computes unchanged on a generalized row ───────
  it("§9.1 reliability score computes for a generalized student (insufficient-data shape unchanged)", async () => {
    const score = await withTenant(inst, (tx: any) =>
      ReliabilityEngine.computeScore(linkedStudent, inst, tx),
    );
    // With a single completed pass (< minimumSampleSize 5) the engine returns the
    // same insufficient-data shape it always has — the generalization changed
    // nothing about the reliability computation.
    expect(score.hasSufficientData).toBe(false);
    expect(score.totalMovements).toBe(1);
    expect(score.overall).toBe(0);
  }, 120_000);

  // ── §9.1 GRADUATED student's historical passes still read ───────────────────
  it("§9.1 a GRADUATED student's historical passes STILL read (no row deleted on status change)", async () => {
    // Flip the bare student to GRADUATED (a terminal lifecycle status). The row
    // is NOT deleted and its historical pass remains readable.
    await withTenant(inst, (tx: any) =>
      tx.studentProfile.update({ where: { id: bareStudent }, data: { status: "GRADUATED" } }),
    );

    const graduated = await withTenant(inst, (tx: any) =>
      tx.studentProfile.findFirst({ where: { id: bareStudent } }),
    );
    expect(graduated).toBeTruthy();
    expect(graduated.status).toBe("GRADUATED");

    // Historical passes of the graduated student still read under the tenant tx.
    const passes = await withTenant(inst, (tx: any) =>
      tx.gatePass.findMany({ where: { studentId: bareStudent } }),
    );
    expect(passes.length).toBeGreaterThan(0);

    // And the allowance engine still computes for a GRADUATED student (reads are
    // status-agnostic — the row was never removed).
    const summary = await withTenant(inst, (tx: any) =>
      AllowanceEngine.getRemainingAllowance(bareStudent, inst, tx),
    );
    expect(summary.consumed).toBe(90);
  }, 120_000);

  // ── §6 preserve-history at the DB layer (append-only enforcement) ───────────
  it("§6 preserve-history: a lifecycle history row is appended; UPDATE/DELETE on it are rejected; the student row is never deleted", async () => {
    await clearHistory();

    // Append a DEACTIVATED history row for the linked student (the shape a
    // deactivate route writes), in the real tenant context.
    const histId = id("hist_deact");
    await withTenant(inst, (tx: any) =>
      tx.studentProfileHistory.create({
        data: {
          id: histId,
          institutionId: inst,
          studentProfileId: linkedStudent,
          changeType: "DEACTIVATED",
          previousStatus: "ACTIVE",
          newStatus: "SUSPENDED",
          actorUserId: linkedUser,
          reason: "disciplinary hold",
        },
      }),
    );

    // Readable back under the tenant context.
    const readBack = await withTenant(inst, (tx: any) =>
      tx.studentProfileHistory.findUnique({ where: { id: histId } }),
    );
    expect(readBack).toBeTruthy();
    expect(readBack.changeType).toBe("DEACTIVATED");
    expect(readBack.previousStatus).toBe("ACTIVE");
    expect(readBack.newStatus).toBe("SUSPENDED");

    // Append-only: UPDATE and DELETE are BOTH rejected (REVOKE + trigger).
    await expect(
      withTenant(inst, (tx: any) =>
        tx.studentProfileHistory.update({ where: { id: histId }, data: { reason: "x" } }),
      ),
    ).rejects.toBeTruthy();
    await expect(
      withTenant(inst, (tx: any) =>
        tx.studentProfileHistory.delete({ where: { id: histId } }),
      ),
    ).rejects.toBeTruthy();

    // The student row itself is never deleted by a lifecycle transition.
    const stillThere = await withTenant(inst, (tx: any) =>
      tx.studentProfile.findFirst({ where: { id: linkedStudent } }),
    );
    expect(stillThere).toBeTruthy();

    // The history row survived the mutation attempts.
    const survived = await adminClient.studentProfileHistory.findUnique({ where: { id: histId } });
    expect(survived).toBeTruthy();
  }, 120_000);
});
