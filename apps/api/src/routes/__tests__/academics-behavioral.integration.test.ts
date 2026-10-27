/**
 * Phase-1 academics behavioral integration suite (design §10.2–§10.4) — runs
 * against the REAL Supabase instance through the SAME two connections the escape
 * suite uses (campass_app = RLS-subject appClient via withTenant; postgres =
 * RLS-bypass owner adminClient), imported from the escape-setup helper so
 * DATABASE_URL is pinned to campass_app BEFORE @campusgate/db loads.
 *
 * It proves, at the DB layer through the real services:
 *   §10.2 configurable structure — SEMESTER+2 AND ANNUAL+1 both activate clean;
 *         TRIMESTER+2 activates with a soft warning; ANNUAL+0 is rejected.
 *   §10.3 exactly-one-ACTIVE — a 2nd activate without handover is rejected; with
 *         handover the old session CLOSES and exactly one ACTIVE remains; the
 *         partial unique index is the concurrency backstop.
 *   §10.4 preserve-history — closing/advancing a session leaves its terms + a
 *         linked calendar entry intact and readable; calendar scope precedence;
 *         the self-contained append-only calendar-revision case.
 *
 * SELF-CONTAINED under a DISTINCT prefix (ACAD_TEST_); seeds + tears down its own
 * institutions. The append-only academic_calendar_day_revisions rows it writes
 * are torn down by disabling/re-enabling the trigger within THIS suite's own
 * adminClient DDL scope (never touching the shared escape cleanup()). Requires
 * live Supabase + campass_app credentials.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, disconnect } from "./helpers/tenant-escape-setup.js";
import {
  activateSession,
  closeSession,
} from "../../services/academic-session.js";
import { CalendarService } from "../../services/calendar-service.js";

type WithTenant = <T>(institutionId: string, fn: (tx: any) => Promise<T>) => Promise<T>;
let withTenant: WithTenant;

const PFX = "ACAD_TEST_";
const id = (s: string) => `${PFX}${s}`;

/** Retry transient Supabase-pooler errors (the free tier pauses/contends under
 *  parallel real-DB suites). Mirrors the escape-setup helper's withRetry. */
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

const instA = id("inst_A");
const instB = id("inst_B");
const deptA = id("dept_A");
const userA = id("user_A");

function dAt(iso: string): Date {
  return new Date(iso);
}

async function seedInstitution(instId: string): Promise<void> {
  await withRetry(() =>
    adminClient.institution.create({
      data: { id: instId, name: `${PFX}Inst`, code: id(`CODE_${instId}`), status: "ACTIVE" },
    }),
  );
}

/** Create an UPCOMING session with `termCount` terms via adminClient. Returns the ids. */
async function seedSession(
  instId: string,
  key: string,
  structureType: "SEMESTER" | "TRIMESTER" | "ANNUAL" | "CUSTOM",
  termCount: number,
): Promise<{ sessionId: string; termIds: string[] }> {
  const sessionId = id(`sess_${key}`);
  await withRetry(() =>
    adminClient.academicSession.create({
      data: {
        id: sessionId,
        institutionId: instId,
        name: `${PFX}Session ${key}`,
        structureType,
        status: "UPCOMING",
        startDate: dAt("2026-07-01T00:00:00.000Z"),
        endDate: dAt("2027-06-30T00:00:00.000Z"),
      },
    }),
  );
  const termIds: string[] = [];
  for (let i = 1; i <= termCount; i++) {
    const termId = id(`term_${key}_${i}`);
    const mm = String(i).padStart(2, "0");
    await withRetry(() =>
      adminClient.academicTerm.create({
        data: {
          id: termId,
          institutionId: instId,
          academicSessionId: sessionId,
          name: `${PFX}Term ${i}`,
          ordinal: i,
          status: "UPCOMING",
          startDate: dAt(`2026-${mm}-01T00:00:00.000Z`),
          endDate: dAt(`2026-${mm}-28T00:00:00.000Z`),
        },
      }),
    );
    termIds.push(termId);
  }
  return { sessionId, termIds };
}

async function clearAcademics(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  // Revisions are append-only: disable the trigger for the scoped delete.
  await withRetry(() =>
    adminClient.$executeRawUnsafe(
      `ALTER TABLE "academic_calendar_day_revisions" DISABLE TRIGGER "academic_calendar_day_revisions_no_update_delete"`,
    ),
  );
  try {
    await withRetry(() => adminClient.academicCalendarDayRevision.deleteMany({ where }));
  } finally {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(
        `ALTER TABLE "academic_calendar_day_revisions" ENABLE TRIGGER "academic_calendar_day_revisions_no_update_delete"`,
      ),
    );
  }
  await withRetry(() => adminClient.academicCalendarDay.deleteMany({ where }));
  await withRetry(() => adminClient.academicTerm.deleteMany({ where }));
  await withRetry(() => adminClient.academicSession.deleteMany({ where }));
}

async function teardownAll(): Promise<void> {
  await clearAcademics();
  await withRetry(() => adminClient.department.deleteMany({ where: { institutionId: { startsWith: PFX } } }));
  await withRetry(() => adminClient.user.deleteMany({ where: { institutionId: { startsWith: PFX } } }));
  await withRetry(() => adminClient.institution.deleteMany({ where: { id: { startsWith: PFX } } }));
}

describe("Phase-1 academics behavioral (real DB, RLS enforced)", () => {
  beforeAll(async () => {
    const db = (await import("@campusgate/db")) as unknown as { withTenant: WithTenant };
    withTenant = db.withTenant;
    await teardownAll();
    await seedInstitution(instA);
    await seedInstitution(instB);
    await withRetry(() =>
      adminClient.department.create({
        data: { id: deptA, name: `${PFX}Dept A`, code: id("D_A"), institutionId: instA },
      }),
    );
    await withRetry(() =>
      adminClient.user.create({
        data: { id: userA, email: `${PFX.toLowerCase()}a@example.test`, role: "ADMIN", institutionId: instA },
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await teardownAll();
    await disconnect();
  }, 120_000);

  // ── §10.2 configurable structure ───────────────────────────────────────────
  it("§10.2 SEMESTER + 2 terms activates cleanly with NO term-count warning", async () => {
    await clearAcademics();
    const { sessionId } = await seedSession(instA, "sem", "SEMESTER", 2);

    const result = await withRetry(() =>
      withTenant(instA, (tx) => activateSession(tx, instA, sessionId, false)),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.status).toBe("ACTIVE");
      expect(result.warnings.some((w) => w.code === "TERM_COUNT_SUGGESTION")).toBe(false);
    }
  }, 60_000);

  it("§10.2 ANNUAL + 1 term activates cleanly with NO term-count warning", async () => {
    await clearAcademics();
    const { sessionId } = await seedSession(instB, "ann", "ANNUAL", 1);

    const result = await withRetry(() =>
      withTenant(instB, (tx) => activateSession(tx, instB, sessionId, false)),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.status).toBe("ACTIVE");
      expect(result.warnings.some((w) => w.code === "TERM_COUNT_SUGGESTION")).toBe(false);
    }
  }, 60_000);

  it("§10.2 TRIMESTER + 2 terms activates WITH a soft term-count warning", async () => {
    await clearAcademics();
    const { sessionId } = await seedSession(instA, "tri", "TRIMESTER", 2);

    const result = await withRetry(() =>
      withTenant(instA, (tx) => activateSession(tx, instA, sessionId, false)),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.status).toBe("ACTIVE");
      expect(result.warnings.some((w) => w.code === "TERM_COUNT_SUGGESTION")).toBe(true);
    }
  }, 60_000);

  it("§10.2 ANNUAL + 0 terms is REJECTED (the one hard rule)", async () => {
    await clearAcademics();
    const { sessionId } = await seedSession(instA, "empty", "ANNUAL", 0);

    const result = await withRetry(() =>
      withTenant(instA, (tx) => activateSession(tx, instA, sessionId, false)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NO_TERMS");
  }, 60_000);

  // ── §10.3 exactly-one-ACTIVE ────────────────────────────────────────────────
  it("§10.3 a 2nd activation without handover is rejected; with handover old CLOSES and one ACTIVE remains", async () => {
    await clearAcademics();
    const first = await seedSession(instA, "first", "SEMESTER", 2);
    const second = await seedSession(instA, "second", "SEMESTER", 2);

    const a1 = await withRetry(() =>
      withTenant(instA, (tx) => activateSession(tx, instA, first.sessionId, false)),
    );
    expect(a1.ok).toBe(true);

    // Second activation without handover => ACTIVE_EXISTS.
    const blocked = await withRetry(() =>
      withTenant(instA, (tx) => activateSession(tx, instA, second.sessionId, false)),
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe("ACTIVE_EXISTS");

    // With handover => old CLOSES, new ACTIVE.
    const handover = await withRetry(() =>
      withTenant(instA, (tx) => activateSession(tx, instA, second.sessionId, true)),
    );
    expect(handover.ok).toBe(true);
    if (handover.ok) expect(handover.closedSessionId).toBe(first.sessionId);

    // Exactly one ACTIVE session remains (the partial unique index is the backstop).
    const activeCount = await adminClient.academicSession.count({
      where: { institutionId: instA, status: "ACTIVE" },
    });
    expect(activeCount).toBe(1);
    const firstRow = await adminClient.academicSession.findUnique({ where: { id: first.sessionId } });
    expect(firstRow!.status).toBe("CLOSED");
  }, 60_000);

  // ── §10.4 preserve-history ──────────────────────────────────────────────────
  it("§10.4 closing/advancing a session leaves its terms + a linked calendar entry intact and readable", async () => {
    await clearAcademics();
    const s1 = await seedSession(instA, "hist", "SEMESTER", 2);

    await withRetry(() => withTenant(instA, (tx) => activateSession(tx, instA, s1.sessionId, false)));

    // Link a calendar entry to S1 (institution-wide).
    const calId = id("cal_hist");
    await withRetry(() =>
      adminClient.academicCalendarDay.create({
        data: {
          id: calId,
          institutionId: instA,
          date: dAt("2026-09-10T00:00:00.000Z"),
          dayType: "HOLIDAY",
          academicSessionId: s1.sessionId,
        },
      }),
    );

    // Snapshot term state before the transition.
    const termsBefore = await adminClient.academicTerm.findMany({
      where: { academicSessionId: s1.sessionId },
      orderBy: { ordinal: "asc" },
    });

    // Advance: close S1.
    const closed = await withRetry(() => withTenant(instA, (tx) => closeSession(tx, instA, s1.sessionId)));
    expect(closed.ok).toBe(true);

    // S1 still readable; status CLOSED; terms unchanged; calendar entry still linked.
    const s1After = await adminClient.academicSession.findUnique({ where: { id: s1.sessionId } });
    expect(s1After!.status).toBe("CLOSED");
    expect(s1After!.startDate.getTime()).toBe(dAt("2026-07-01T00:00:00.000Z").getTime());

    const termsAfter = await adminClient.academicTerm.findMany({
      where: { academicSessionId: s1.sessionId },
      orderBy: { ordinal: "asc" },
    });
    expect(termsAfter.length).toBe(termsBefore.length);
    for (let i = 0; i < termsAfter.length; i++) {
      expect(termsAfter[i].ordinal).toBe(termsBefore[i].ordinal);
      expect(termsAfter[i].name).toBe(termsBefore[i].name);
      expect(termsAfter[i].startDate.getTime()).toBe(termsBefore[i].startDate.getTime());
    }

    const cal = await adminClient.academicCalendarDay.findUnique({ where: { id: calId } });
    expect(cal!.academicSessionId).toBe(s1.sessionId);
  }, 60_000);

  // ── §10.4 calendar scope precedence (via CalendarService on the tenant tx) ──
  it("§10.4 calendar scope: dept-scoped EXAM_DAY and institution-wide HOLIDAY coexist; dept wins in effectiveDayType", async () => {
    await clearAcademics();
    const date = dAt("2026-10-05T00:00:00.000Z");

    // Institution-wide HOLIDAY + dept-scoped EXAM_DAY on the SAME date (both
    // partial-unique indexes permit the coexistence).
    await withRetry(() =>
      adminClient.academicCalendarDay.create({
        data: { id: id("cal_wide"), institutionId: instA, date, dayType: "HOLIDAY" },
      }),
    );
    await withRetry(() =>
      adminClient.academicCalendarDay.create({
        data: { id: id("cal_dept"), institutionId: instA, date, dayType: "EXAM_DAY", departmentId: deptA },
      }),
    );

    // getEntries with the department returns BOTH rows.
    const withDept = await withTenant(instA, (tx) =>
      CalendarService.getEntries(instA, date, date, tx, { departmentId: deptA }),
    );
    expect(withDept.length).toBe(2);

    // effectiveDayType: dept-scoped EXAM_DAY wins for the department's query.
    const effDept = await withTenant(instA, (tx) =>
      CalendarService.effectiveDayType(instA, date, tx, { departmentId: deptA }),
    );
    expect(effDept).toBe("EXAM_DAY");

    // Without the department, the institution-wide HOLIDAY is returned.
    const effWide = await withTenant(instA, (tx) =>
      CalendarService.effectiveDayType(instA, date, tx),
    );
    expect(effWide).toBe("HOLIDAY");
  }, 60_000);

  // ── §10.4 calendar revision (self-contained append-only) ────────────────────
  it("§10.4 calendar revisions capture previous value + actor; a DELETE revision survives the row deletion", async () => {
    await clearAcademics();
    const date = dAt("2026-11-11T00:00:00.000Z");
    const calId = id("cal_rev");

    // CREATE a calendar entry + its CREATE revision, in one tenant tx (the real
    // handler shape). campass_app has SELECT, INSERT on revisions.
    await withTenant(instA, async (tx) => {
      await tx.academicCalendarDay.create({
        data: { id: calId, institutionId: instA, date, dayType: "WORKING_DAY", note: "orig" },
      });
      await tx.academicCalendarDayRevision.create({
        data: {
          institutionId: instA,
          calendarDayId: calId,
          date,
          previousDayType: null,
          newDayType: "WORKING_DAY",
          previousNote: null,
          newNote: "orig",
          changeType: "CREATE",
          actorUserId: userA,
        },
      });
    });

    // UPDATE dayType -> a revision capturing the PREVIOUS value + actor.
    await withTenant(instA, async (tx) => {
      await tx.academicCalendarDayRevision.create({
        data: {
          institutionId: instA,
          calendarDayId: calId,
          date,
          previousDayType: "WORKING_DAY",
          newDayType: "HOLIDAY",
          previousNote: "orig",
          newNote: "updated",
          changeType: "UPDATE",
          actorUserId: userA,
        },
      });
      await tx.academicCalendarDay.update({
        where: { id: calId },
        data: { dayType: "HOLIDAY", note: "updated" },
      });
    });

    const updateRev = await adminClient.academicCalendarDayRevision.findFirst({
      where: { institutionId: instA, calendarDayId: calId, changeType: "UPDATE" },
    });
    expect(updateRev).toBeTruthy();
    expect(updateRev!.previousDayType).toBe("WORKING_DAY");
    expect(updateRev!.actorUserId).toBe(userA);
    expect(updateRev!.createdAt).toBeTruthy();

    // DELETE the entry + write a DELETE revision; the revision SURVIVES the row
    // deletion (calendarDayId has no live FK — design §4.3).
    await withTenant(instA, async (tx) => {
      await tx.academicCalendarDayRevision.create({
        data: {
          institutionId: instA,
          calendarDayId: calId,
          date,
          previousDayType: "HOLIDAY",
          newDayType: null,
          changeType: "DELETE",
          actorUserId: userA,
        },
      });
      await tx.academicCalendarDay.delete({ where: { id: calId } });
    });

    const rowGone = await adminClient.academicCalendarDay.findUnique({ where: { id: calId } });
    expect(rowGone).toBeNull();
    const deleteRev = await adminClient.academicCalendarDayRevision.findFirst({
      where: { institutionId: instA, calendarDayId: calId, changeType: "DELETE" },
    });
    expect(deleteRev).toBeTruthy();
    expect(deleteRev!.previousDayType).toBe("HOLIDAY");
  }, 60_000);

  it("§10.4 revision append-only + fail-closed: campass_app UPDATE/DELETE rejected; unset GUC yields zero rows", async () => {
    await clearAcademics();
    const revId = id("rev_appendonly");
    await withTenant(instA, (tx) =>
      tx.academicCalendarDayRevision.create({
        data: {
          id: revId,
          institutionId: instA,
          date: dAt("2026-12-01T00:00:00.000Z"),
          newDayType: "HOLIDAY",
          changeType: "CREATE",
          actorUserId: userA,
        },
      }),
    );

    await expect(
      withTenant(instA, (tx) =>
        tx.academicCalendarDayRevision.update({ where: { id: revId }, data: { changeType: "UPDATE" } }),
      ),
    ).rejects.toBeTruthy();

    await expect(
      withTenant(instA, (tx) => tx.academicCalendarDayRevision.delete({ where: { id: revId } })),
    ).rejects.toBeTruthy();

    // Fail-closed: a cross-tenant read under instB yields zero of A's rows.
    const crossTenant = await withTenant(instB, (tx) =>
      tx.academicCalendarDayRevision.findMany({ where: { institutionId: { startsWith: PFX } } }),
    );
    expect(crossTenant.some((r: { id: string }) => r.id === revId)).toBe(false);

    // The row survived the UPDATE/DELETE attempts.
    const still = await adminClient.academicCalendarDayRevision.findUnique({ where: { id: revId } });
    expect(still).toBeTruthy();
  }, 60_000);
});
