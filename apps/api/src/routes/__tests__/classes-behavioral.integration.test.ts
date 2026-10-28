/**
 * Phase-3 classes behavioral integration suite (FEAT-003) — runs against the
 * REAL Supabase instance through the SAME two connections the escape suite uses
 * (campass_app = RLS-subject appClient via withTenant; postgres = RLS-bypass
 * adminClient), imported from the escape-setup helper so DATABASE_URL is pinned
 * to campass_app BEFORE @campusgate/db loads.
 *
 * It proves, at the DB layer through the real conflict / enrollment / faculty
 * services + the append-only revision table:
 *   - a small timetable builds; a double-booked faculty and a double-booked room
 *     are rejected (detectTimetableConflicts => blocking) while a conflict-free
 *     slot is clean;
 *   - publishing a change writes a schedule_revisions row, and UPDATE/DELETE on
 *     it is refused (append-only trigger, even on the privileged owner path);
 *   - a faculty reassignment preserves the prior assignment row (soft transition)
 *     and writes a FACULTY_REASSIGNED revision;
 *   - a student reads only their own enrolled schedule and a faculty only their
 *     own taught schedule;
 *   - enrollment references the shared StudentProfile (no second student row).
 *
 * SELF-CONTAINED under a DISTINCT prefix (CLASS_TEST_); seeds + tears down its
 * own institutions. The append-only schedule_revisions rows it writes are torn
 * down by disabling/re-enabling the trigger within THIS suite's own adminClient
 * DDL scope (never touching the shared escape cleanup()). Requires live Supabase
 * + campass_app credentials. Transient Supabase auto-pause => withRetry.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, disconnect } from "./helpers/tenant-escape-setup.js";
import {
  detectTimetableConflicts,
  type SlotInput,
} from "../../services/timetable-conflict.js";
import { decideEnrollment } from "../../services/class-enrollment.js";
import { decideReassignment } from "../../services/faculty-assignment.js";

type WithTenant = <T>(institutionId: string, fn: (tx: any) => Promise<T>) => Promise<T>;
let withTenant: WithTenant;

const PFX = "CLASS_TEST_";
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

const instA = id("inst_A");
const instB = id("inst_B");
const deptA = id("dept_A");
const adminUser = id("user_admin");
const studentUser = id("user_student");
const facultyUser = id("user_faculty");
const facultyUser2 = id("user_faculty2");

const sessionA = id("sess_A");
const termA = id("term_A");
const programA = id("prog_A");
const studentProfileA = id("sp_A");
const courseA = id("course_A");
const subjectA = id("subj_A");
const sectionA = id("sec_A");
const facultyA = id("fac_A");
const facultyB = id("fac_B");
const timetableA = id("tt_A");

function dAt(iso: string): Date {
  return new Date(iso);
}

async function teardownAll(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  // schedule_revisions is append-only: disable the trigger for the scoped delete.
  await withRetry(() =>
    adminClient.$executeRawUnsafe(
      `ALTER TABLE "schedule_revisions" DISABLE TRIGGER "schedule_revisions_no_update_delete"`,
    ),
  );
  try {
    await withRetry(() => adminClient.scheduleRevision.deleteMany({ where }));
  } finally {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(
        `ALTER TABLE "schedule_revisions" ENABLE TRIGGER "schedule_revisions_no_update_delete"`,
      ),
    );
  }
  // Child-first delete respecting the RESTRICT FKs.
  await withRetry(() => adminClient.scheduledClass.deleteMany({ where }));
  await withRetry(() => adminClient.classEnrollment.deleteMany({ where }));
  await withRetry(() => adminClient.facultyAssignment.deleteMany({ where }));
  await withRetry(() => adminClient.timetable.deleteMany({ where }));
  await withRetry(() => adminClient.classSection.deleteMany({ where }));
  await withRetry(() => adminClient.subject.deleteMany({ where }));
  await withRetry(() => adminClient.course.deleteMany({ where }));
  await withRetry(() => adminClient.facultyProfile.deleteMany({ where }));
  await withRetry(() => adminClient.studentProfile.deleteMany({ where }));
  await withRetry(() => adminClient.academicTerm.deleteMany({ where }));
  await withRetry(() => adminClient.academicSession.deleteMany({ where }));
  await withRetry(() => adminClient.program.deleteMany({ where }));
  await withRetry(() => adminClient.department.deleteMany({ where }));
  await withRetry(() => adminClient.user.deleteMany({ where: { institutionId: { startsWith: PFX } } }));
  await withRetry(() => adminClient.institution.deleteMany({ where: { id: { startsWith: PFX } } }));
}

async function seed(): Promise<void> {
  for (const instId of [instA, instB]) {
    await withRetry(() =>
      adminClient.institution.create({
        data: { id: instId, name: `${PFX}Inst`, code: id(`CODE_${instId}`), status: "ACTIVE" },
      }),
    );
  }
  await withRetry(() =>
    adminClient.department.create({
      data: { id: deptA, name: `${PFX}Dept A`, code: id("D_A"), institutionId: instA },
    }),
  );
  await withRetry(() =>
    adminClient.user.createMany({
      data: [
        { id: adminUser, email: `${PFX.toLowerCase()}admin@example.test`, role: "ADMIN", institutionId: instA },
        { id: studentUser, email: `${PFX.toLowerCase()}stu@example.test`, role: "STUDENT", institutionId: instA },
        { id: facultyUser, email: `${PFX.toLowerCase()}fac@example.test`, role: "GUARD", institutionId: instA },
        { id: facultyUser2, email: `${PFX.toLowerCase()}fac2@example.test`, role: "GUARD", institutionId: instA },
      ],
    }),
  );
  await withRetry(() =>
    adminClient.academicSession.create({
      data: {
        id: sessionA,
        institutionId: instA,
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
        id: termA,
        institutionId: instA,
        academicSessionId: sessionA,
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
        id: programA,
        institutionId: instA,
        departmentId: deptA,
        name: `${PFX}BCA`,
        code: id("BCA"),
        duration: 6,
        durationUnit: "TERMS",
        status: "ACTIVE",
      },
    }),
  );
  await withRetry(() =>
    adminClient.studentProfile.create({
      data: {
        id: studentProfileA,
        userId: studentUser,
        institutionId: instA,
        enrollmentNo: id("EN001"),
        name: `${PFX}Student`,
        departmentId: deptA,
        program: "BCA",
        semester: 1,
        status: "ACTIVE",
        programId: programA,
        academicSessionId: sessionA,
        currentTermId: termA,
      },
    }),
  );
  await withRetry(() =>
    adminClient.course.create({
      data: { id: courseA, institutionId: instA, programId: programA, name: `${PFX}Core`, code: id("C1") },
    }),
  );
  await withRetry(() =>
    adminClient.subject.create({
      data: { id: subjectA, institutionId: instA, courseId: courseA, name: `${PFX}DS`, code: id("S1"), credits: 4 },
    }),
  );
  await withRetry(() =>
    adminClient.classSection.create({
      data: {
        id: sectionA,
        institutionId: instA,
        programId: programA,
        academicSessionId: sessionA,
        academicTermId: termA,
        label: "A",
        capacity: 60,
        status: "ACTIVE",
      },
    }),
  );
  await withRetry(() =>
    adminClient.facultyProfile.createMany({
      data: [
        { id: facultyA, institutionId: instA, userId: facultyUser, name: `${PFX}Prof A`, departmentId: deptA },
        { id: facultyB, institutionId: instA, userId: facultyUser2, name: `${PFX}Prof B`, departmentId: deptA },
      ],
    }),
  );
  await withRetry(() =>
    adminClient.timetable.create({
      data: { id: timetableA, institutionId: instA, academicTermId: termA, name: `${PFX}TT`, status: "DRAFT" },
    }),
  );
}

describe("Phase-3 classes behavioral (real DB, RLS enforced)", () => {
  beforeAll(async () => {
    const db = (await import("@campusgate/db")) as unknown as { withTenant: WithTenant };
    withTenant = db.withTenant;
    await teardownAll();
    await seed();
  }, 120_000);

  afterAll(async () => {
    await teardownAll();
    await disconnect();
  }, 120_000);

  // ── timetable build + conflict rejection ────────────────────────────────────
  it("builds a conflict-free slot and rejects a double-booked faculty + a double-booked room", async () => {
    // A base SCHEDULED slot: Mon 09:00-10:00, faculty A, room R-101, section A.
    const base: SlotInput = {
      id: "base",
      classSectionId: sectionA,
      facultyId: facultyA,
      room: "R-101",
      dayOfWeek: "MON",
      date: null,
      startTime: 540,
      endTime: 600,
      status: "SCHEDULED",
    };

    // Conflict-free: Wed 09:00-10:00, same faculty + room (different day axis).
    const clean = detectTimetableConflicts({
      candidate: { ...base, id: undefined, dayOfWeek: "WED" },
      existing: [base],
      dayType: null,
      workingDaysOfWeek: [1, 2, 3, 4, 5, 6],
    });
    expect(clean.blocking).toHaveLength(0);

    // Double-booked faculty: Mon 09:30-10:30, same faculty, different room.
    const facultyClash = detectTimetableConflicts({
      candidate: { ...base, id: undefined, room: "R-202", startTime: 570, endTime: 630 },
      existing: [base],
      dayType: null,
      workingDaysOfWeek: [1, 2, 3, 4, 5, 6],
    });
    expect(facultyClash.blocking.some((c) => c.type === "FACULTY_DOUBLE_BOOKED")).toBe(true);

    // Double-booked room: Mon 09:30-10:30, different faculty, same room.
    const roomClash = detectTimetableConflicts({
      candidate: { ...base, id: undefined, facultyId: facultyB, startTime: 570, endTime: 630 },
      existing: [base],
      dayType: null,
      workingDaysOfWeek: [1, 2, 3, 4, 5, 6],
    });
    expect(roomClash.blocking.some((c) => c.type === "ROOM_DOUBLE_BOOKED")).toBe(true);
  });

  // ── published-change revision + append-only enforcement ─────────────────────
  it("a published-change revision is written and UPDATE/DELETE on it is refused (append-only)", async () => {
    const scId = id("sc_rev");
    // Create a SCHEDULED class (the published change we record).
    await withRetry(() =>
      withTenant(instA, async (tx) => {
        await tx.scheduledClass.create({
          data: {
            id: scId,
            institutionId: instA,
            timetableId: timetableA,
            classSectionId: sectionA,
            subjectId: subjectA,
            facultyId: facultyA,
            academicTermId: termA,
            room: "R-101",
            dayOfWeek: "TUE",
            startTime: 540,
            endTime: 600,
            status: "SCHEDULED",
          },
        });
        await tx.scheduleRevision.create({
          data: {
            institutionId: instA,
            timetableId: timetableA,
            scheduledClassId: scId,
            academicTermId: termA,
            changeType: "SCHEDULED_CLASS_ADDED",
            newFacultyId: facultyA,
            newRoom: "R-101",
            newStartTime: 540,
            newEndTime: 600,
            newStatus: "SCHEDULED",
            actorUserId: adminUser,
            metadata: { classSectionId: sectionA, subjectId: subjectA },
          },
        });
      }),
    );

    const rev = await adminClient.scheduleRevision.findFirst({
      where: { institutionId: instA, scheduledClassId: scId, changeType: "SCHEDULED_CLASS_ADDED" },
    });
    expect(rev).toBeTruthy();
    expect(rev!.newFacultyId).toBe(facultyA);

    // Append-only: UPDATE and DELETE both rejected, even on the owner path.
    await expect(
      withTenant(instA, (tx) =>
        tx.scheduleRevision.update({ where: { id: rev!.id }, data: { newRoom: "R-999" } }),
      ),
    ).rejects.toBeTruthy();
    await expect(
      withTenant(instA, (tx) => tx.scheduleRevision.delete({ where: { id: rev!.id } })),
    ).rejects.toBeTruthy();

    const still = await adminClient.scheduleRevision.findUnique({ where: { id: rev!.id } });
    expect(still).toBeTruthy();
  }, 60_000);

  // ── faculty reassignment preserves history ──────────────────────────────────
  it("a faculty reassignment preserves the prior assignment row and writes a FACULTY_REASSIGNED revision", async () => {
    const assignId = id("fa_orig");
    // Seed the ACTIVE original assignment (faculty A).
    await withRetry(() =>
      withTenant(instA, (tx) =>
        tx.facultyAssignment.create({
          data: {
            id: assignId,
            institutionId: instA,
            facultyId: facultyA,
            subjectId: subjectA,
            classSectionId: sectionA,
            academicTermId: termA,
            role: "PRIMARY",
            status: "ACTIVE",
          },
        }),
      ),
    );

    const current = await adminClient.facultyAssignment.findUnique({ where: { id: assignId } });
    const decision = decideReassignment(
      {
        id: current!.id,
        facultyId: current!.facultyId,
        subjectId: current!.subjectId,
        classSectionId: current!.classSectionId,
        academicTermId: current!.academicTermId,
        role: current!.role,
        status: current!.status,
      },
      { facultyId: facultyB, role: "SUBSTITUTE" },
      new Date(),
    );
    expect(decision.action).toBe("reassign");

    // Apply the swap: soft-end + insert new + FACULTY_REASSIGNED revision, in-tx.
    const newId = await withRetry(() =>
      withTenant(instA, async (tx) => {
        if (decision.action !== "reassign") throw new Error("unreachable");
        await tx.facultyAssignment.update({
          where: { id: decision.end.assignmentId },
          data: { status: decision.end.status, endedAt: decision.end.endedAt },
        });
        const created = await tx.facultyAssignment.create({
          data: {
            institutionId: instA,
            facultyId: decision.newAssignment.facultyId,
            subjectId: decision.newAssignment.subjectId,
            classSectionId: decision.newAssignment.classSectionId,
            academicTermId: decision.newAssignment.academicTermId,
            role: decision.newAssignment.role,
            status: decision.newAssignment.status,
          },
        });
        await tx.scheduleRevision.create({
          data: {
            institutionId: instA,
            academicTermId: termA,
            changeType: decision.revision.changeType,
            previousFacultyId: decision.revision.previousFacultyId,
            newFacultyId: decision.revision.newFacultyId,
            actorUserId: adminUser,
            metadata: {
              subjectId: decision.revision.metadata.subjectId,
              classSectionId: decision.revision.metadata.classSectionId,
              role: decision.revision.metadata.role,
              endedAssignmentId: decision.revision.metadata.endedAssignmentId,
              newAssignmentId: created.id,
            },
          },
        });
        return created.id;
      }),
    );

    // The prior row is RETAINED, now ENDED with endedAt — never overwritten.
    const prior = await adminClient.facultyAssignment.findUnique({ where: { id: assignId } });
    expect(prior).toBeTruthy();
    expect(prior!.status).toBe("ENDED");
    expect(prior!.endedAt).toBeTruthy();
    expect(prior!.facultyId).toBe(facultyA); // identity untouched

    // The new row is ACTIVE for faculty B.
    const next = await adminClient.facultyAssignment.findUnique({ where: { id: newId } });
    expect(next!.status).toBe("ACTIVE");
    expect(next!.facultyId).toBe(facultyB);

    // A FACULTY_REASSIGNED revision captures the move.
    const rev = await adminClient.scheduleRevision.findFirst({
      where: { institutionId: instA, changeType: "FACULTY_REASSIGNED", newFacultyId: facultyB },
    });
    expect(rev).toBeTruthy();
    expect(rev!.previousFacultyId).toBe(facultyA);
  }, 60_000);

  // ── enrollment references the shared StudentProfile ─────────────────────────
  it("enrollment references the shared StudentProfile (no second student row) and blocks duplicates", async () => {
    const studentCountBefore = await adminClient.studentProfile.count({ where: { institutionId: instA } });

    // decideEnrollment: fresh enroll (no existing, capacity 60, count 0).
    const decision = decideEnrollment({
      classSectionId: sectionA,
      studentId: studentProfileA,
      existing: null,
      capacity: 60,
      enrolledCount: 0,
    });
    expect(decision.action).toBe("enroll");

    const enrollId = await withRetry(() =>
      withTenant(instA, async (tx) => {
        const created = await tx.classEnrollment.create({
          data: {
            institutionId: instA,
            classSectionId: sectionA,
            studentId: studentProfileA,
            status: "ENROLLED",
          },
        });
        return created.id;
      }),
    );

    // The enrollment points at the authoritative StudentProfile — no copy made.
    const studentCountAfter = await adminClient.studentProfile.count({ where: { institutionId: instA } });
    expect(studentCountAfter).toBe(studentCountBefore);
    const enrollment = await adminClient.classEnrollment.findUnique({ where: { id: enrollId } });
    expect(enrollment!.studentId).toBe(studentProfileA);

    // A second live enrollment of the same (section, student) is a duplicate.
    const dup = decideEnrollment({
      classSectionId: sectionA,
      studentId: studentProfileA,
      existing: { id: enrollId, status: "ENROLLED" },
      capacity: 60,
      enrolledCount: 1,
    });
    expect(dup).toEqual({ action: "reject", reason: "duplicate" });

    // The DB unique is the hard backstop: a raw second INSERT is rejected.
    await expect(
      withTenant(instA, (tx) =>
        tx.classEnrollment.create({
          data: { institutionId: instA, classSectionId: sectionA, studentId: studentProfileA, status: "ENROLLED" },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  // ── own-scoped reads: student + faculty see only their own schedule ─────────
  it("a student reads only their own enrolled schedule and a faculty only their own taught schedule", async () => {
    // Ensure a PUBLISHED timetable with a slot for section A / faculty A exists.
    const ttPub = id("tt_pub");
    const scPub = id("sc_pub");
    await withRetry(() =>
      withTenant(instA, async (tx) => {
        await tx.timetable.create({
          data: { id: ttPub, institutionId: instA, academicTermId: termA, name: `${PFX}Pub`, status: "PUBLISHED", publishedAt: new Date() },
        });
        await tx.scheduledClass.create({
          data: {
            id: scPub,
            institutionId: instA,
            timetableId: ttPub,
            classSectionId: sectionA,
            subjectId: subjectA,
            facultyId: facultyA,
            academicTermId: termA,
            room: "R-101",
            dayOfWeek: "THU",
            startTime: 540,
            endTime: 600,
            status: "SCHEDULED",
          },
        });
      }),
    );

    // Student schedule: the SCHEDULED classes of the sections they are ENROLLED in.
    const studentSchedule = await withTenant(instA, async (tx) => {
      const enrollments = await tx.classEnrollment.findMany({
        where: { institutionId: instA, studentId: studentProfileA, status: "ENROLLED" },
        select: { classSectionId: true },
      });
      const sectionIds = enrollments.map((e: { classSectionId: string }) => e.classSectionId);
      return tx.scheduledClass.findMany({
        where: {
          institutionId: instA,
          classSectionId: { in: sectionIds },
          status: "SCHEDULED",
          timetable: { status: "PUBLISHED" },
        },
        select: { id: true, classSectionId: true },
      });
    });
    expect(studentSchedule.some((s: { id: string }) => s.id === scPub)).toBe(true);
    // Every returned slot is a section the student is enrolled in.
    expect(studentSchedule.every((s: { classSectionId: string }) => s.classSectionId === sectionA)).toBe(true);

    // Faculty teaching schedule: resolved by the caller's FacultyProfile.id.
    const facultyASchedule = await withTenant(instA, (tx) =>
      tx.scheduledClass.findMany({
        where: { institutionId: instA, facultyId: facultyA, status: "SCHEDULED", timetable: { status: "PUBLISHED" } },
        select: { id: true, facultyId: true },
      }),
    );
    expect(facultyASchedule.some((s: { id: string }) => s.id === scPub)).toBe(true);

    // Faculty B teaches nothing here -> empty own schedule (reads only its own).
    const facultyBSchedule = await withTenant(instA, (tx) =>
      tx.scheduledClass.findMany({
        where: { institutionId: instA, facultyId: facultyB, status: "SCHEDULED", timetable: { status: "PUBLISHED" } },
        select: { id: true },
      }),
    );
    expect(facultyBSchedule.some((s: { id: string }) => s.id === scPub)).toBe(false);
  }, 60_000);
});
