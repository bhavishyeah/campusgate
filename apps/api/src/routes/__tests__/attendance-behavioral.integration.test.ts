/**
 * Phase-4 attendance BEHAVIORAL integration suite — runs against the REAL
 * Supabase instance through a REAL Fastify app (real `authenticate` + the real
 * attendanceRoutes + the real withTenant/RLS path). It proves the guarantees the
 * mocked attendance-routes suite cannot: the full lifecycle persisted under RLS,
 * the real FacultyAssignment-backed faculty-scope 403, the correction transaction
 * (record rewrite + append-only CORRECTED history + audit atomicity), finalized
 * immutability (incl. the DB-enforced append-only history), student own-read
 * isolation, the low-attendance notification on the downward crossing, and
 * term-integrity via the three-column FK.
 *
 * SELF-CONTAINED under a DISTINCT prefix (ATT_TEST_); seeds + tears down its own
 * institution via adminClient. Requires live Supabase + campass_app creds.
 *
 * Both DATABASE_URL (campass_app, RLS-subject) and the privileged owner URL are
 * pinned in process.env BEFORE @campusgate/db loads: the real `authenticate`
 * middleware reads users/memberships on privilegedPrisma (no tenant GUC yet), so
 * that client MUST be the owner/postgres role, not campass_app.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../..");

function parseEnv(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const apiEnv = parseEnv(path.join(repoRoot, "apps", "api", ".env"));
const dbEnv = parseEnv(path.join(repoRoot, "packages", "db", ".env"));

const appDatabaseUrl = apiEnv.DATABASE_URL; // campass_app (RLS-subject)
const adminDatabaseUrl = dbEnv.DIRECT_URL ?? dbEnv.DATABASE_URL; // postgres (owner)
if (!appDatabaseUrl) throw new Error("apps/api/.env DATABASE_URL not found");
if (!adminDatabaseUrl) throw new Error("packages/db/.env DIRECT_URL not found");

// Pin BOTH the runtime (campass_app) and privileged (owner) URLs BEFORE
// @campusgate/db loads so withTenant runs as campass_app AND privilegedPrisma
// (used by authenticate) runs as the owner.
process.env.DATABASE_URL = appDatabaseUrl;
process.env.PRIVILEGED_DATABASE_URL = adminDatabaseUrl;
process.env.DIRECT_URL = adminDatabaseUrl;

const adminClient = new PrismaClient({ datasources: { db: { url: adminDatabaseUrl } }, log: ["error"] });

const PFX = "ATT_TEST_";
const id = (s: string) => `${PFX}${s}`;

async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
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
        msg.includes("tenant or user not found") ||
        msg.includes("Transaction API error") ||
        msg.includes("connection pool");
      if (!transient || i === attempts - 1) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw lastErr;
}

// Tenant IDs.
const instA = id("inst");
const deptA = id("dept");
const adminUser = id("u_admin");
const hodUser = id("u_hod");
const studentUser = id("u_student");
const facultyUser = id("u_fac"); // assigned faculty (marker)
const facultyUser2 = id("u_fac2"); // unassigned faculty
const sessionA = id("sess");
const termA = id("term");
const programA = id("prog");
const studentProfileA = id("sp");
const courseA = id("course");
const subjectA = id("subj");
const sectionA = id("sec");
const facultyProfileA = id("fac");
const facultyProfileB = id("fac2");
const timetableA = id("tt");
const scheduledClassA = id("sc"); // MON, assigned to facultyProfileA
const scheduledClassUnassigned = id("sc_un"); // MON, assigned to facultyProfileB

let app: FastifyInstance;
let attendanceRoutes: typeof import("../attendance.js").attendanceRoutes;

const MON_DATE = "2026-11-02"; // a Monday

function tokenFor(userId: string, legacyRole: string): string {
  return app.jwt.sign({ userId, role: legacyRole, institutionId: instA });
}
const authHeader = (t: string) => ({ authorization: `Bearer ${t}` });

async function teardown(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  // Append-only history: delete within a scoped trigger-disable.
  await withRetry(() =>
    adminClient.$executeRawUnsafe(
      `ALTER TABLE "attendance_record_history" DISABLE TRIGGER "attendance_record_history_no_update_delete"`,
    ),
  );
  try {
    await withRetry(() => adminClient.attendanceRecordHistory.deleteMany({ where }));
  } finally {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(
        `ALTER TABLE "attendance_record_history" ENABLE TRIGGER "attendance_record_history_no_update_delete"`,
      ),
    );
  }
  await withRetry(() => adminClient.attendanceCorrection.deleteMany({ where }));
  await withRetry(() => adminClient.attendanceRecord.deleteMany({ where }));
  await withRetry(() => adminClient.attendanceSession.deleteMany({ where }));
  await withRetry(() => adminClient.notification.deleteMany({ where }));
  await deleteAuditEvents(where);
  await withRetry(() => adminClient.scheduledClass.deleteMany({ where }));
  await withRetry(() => adminClient.classEnrollment.deleteMany({ where }));
  await withRetry(() => adminClient.facultyAssignment.deleteMany({ where }));
  await withRetry(() => adminClient.timetable.deleteMany({ where }));
  await withRetry(() => adminClient.classSection.deleteMany({ where }));
  await withRetry(() => adminClient.subject.deleteMany({ where }));
  await withRetry(() => adminClient.course.deleteMany({ where }));
  await withRetry(() => adminClient.facultyProfile.deleteMany({ where }));
  await withRetry(() => adminClient.studentProfile.deleteMany({ where }));
  await withRetry(() => adminClient.membershipRole.deleteMany({ where }));
  await withRetry(() => adminClient.institutionMembership.deleteMany({ where }));
  await withRetry(() => adminClient.institutionModule.deleteMany({ where }));
  await withRetry(() => adminClient.academicTerm.deleteMany({ where }));
  await withRetry(() => adminClient.academicSession.deleteMany({ where }));
  await withRetry(() => adminClient.program.deleteMany({ where }));
  await withRetry(() => adminClient.department.deleteMany({ where }));
  await withRetry(() => adminClient.user.deleteMany({ where }));
  await withRetry(() => adminClient.institution.deleteMany({ where: { id: { startsWith: PFX } } }));
}

async function templateRoleId(key: string): Promise<string> {
  const role = await adminClient.role.findFirst({ where: { key, institutionId: null }, select: { id: true } });
  if (!role) throw new Error(`template role ${key} not found — run the seed/migrations first`);
  return role.id;
}

async function ensureMembership(userId: string, roleKey: string): Promise<void> {
  const mId = id(`mbr_${userId}`);
  const roleId = await templateRoleId(roleKey);
  await withRetry(() =>
    adminClient.institutionMembership.create({
      data: { id: mId, userId, institutionId: instA, membershipStatus: "ACTIVE", departmentScope: roleKey === "HOD" ? deptA : null },
    }),
  );
  await withRetry(() =>
    adminClient.membershipRole.create({
      data: { id: id(`mrl_${userId}`), membershipId: mId, roleId, institutionId: instA },
    }),
  );
}

async function seed(): Promise<void> {
  await withRetry(() =>
    adminClient.institution.create({ data: { id: instA, name: `${PFX}Inst`, code: id("CODE"), status: "ACTIVE" } }),
  );
  await withRetry(() =>
    adminClient.department.create({ data: { id: deptA, name: `${PFX}Dept`, code: id("D"), institutionId: instA } }),
  );
  await withRetry(() =>
    adminClient.user.createMany({
      data: [
        { id: adminUser, email: `${PFX.toLowerCase()}admin@example.test`, role: "ADMIN", institutionId: instA },
        { id: hodUser, email: `${PFX.toLowerCase()}hod@example.test`, role: "HOD", institutionId: instA },
        { id: studentUser, email: `${PFX.toLowerCase()}stu@example.test`, role: "STUDENT", institutionId: instA },
        { id: facultyUser, email: `${PFX.toLowerCase()}fac@example.test`, role: "GUARD", institutionId: instA },
        { id: facultyUser2, email: `${PFX.toLowerCase()}fac2@example.test`, role: "GUARD", institutionId: instA },
      ],
    }),
  );
  await ensureMembership(adminUser, "ADMIN");
  await ensureMembership(hodUser, "HOD");
  await ensureMembership(studentUser, "STUDENT");
  await ensureMembership(facultyUser, "FACULTY");
  await ensureMembership(facultyUser2, "FACULTY");

  // attendance module ACTIVE for this tenant.
  await withRetry(() =>
    adminClient.institutionModule.create({
      data: { id: id("imod"), institutionId: instA, moduleKey: "attendance", state: "ACTIVE", entitledAt: new Date(), activatedAt: new Date() },
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
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        endDate: new Date("2027-06-30T00:00:00.000Z"),
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
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        endDate: new Date("2026-12-31T00:00:00.000Z"),
      },
    }),
  );
  await withRetry(() =>
    adminClient.program.create({
      data: { id: programA, institutionId: instA, departmentId: deptA, name: `${PFX}BCA`, code: id("BCA"), duration: 6, durationUnit: "TERMS" },
    }),
  );
  await withRetry(() =>
    adminClient.studentProfile.create({
      data: {
        id: studentProfileA,
        userId: studentUser,
        institutionId: instA,
        enrollmentNo: id("ENR"),
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
      data: { id: courseA, institutionId: instA, programId: programA, academicTermId: termA, name: `${PFX}Course`, code: id("C"), status: "ACTIVE" },
    }),
  );
  await withRetry(() =>
    adminClient.subject.create({
      data: { id: subjectA, institutionId: instA, courseId: courseA, name: `${PFX}Subj`, code: id("S"), credits: 4, contactHoursPerWeek: 4, status: "ACTIVE" },
    }),
  );
  await withRetry(() =>
    adminClient.classSection.create({
      data: { id: sectionA, institutionId: instA, programId: programA, academicSessionId: sessionA, academicTermId: termA, label: id("A"), capacity: 60, status: "ACTIVE" },
    }),
  );
  await withRetry(() =>
    adminClient.classEnrollment.create({
      data: { id: id("enr"), institutionId: instA, classSectionId: sectionA, studentId: studentProfileA, status: "ENROLLED" },
    }),
  );
  await withRetry(() =>
    adminClient.facultyProfile.create({
      data: { id: facultyProfileA, institutionId: instA, userId: facultyUser, name: `${PFX}Faculty`, departmentId: deptA, status: "ACTIVE" },
    }),
  );
  await withRetry(() =>
    adminClient.facultyProfile.create({
      data: { id: facultyProfileB, institutionId: instA, userId: facultyUser2, name: `${PFX}Faculty2`, departmentId: deptA, status: "ACTIVE" },
    }),
  );
  await withRetry(() =>
    adminClient.facultyAssignment.create({
      data: { id: id("fassign"), institutionId: instA, facultyId: facultyProfileA, subjectId: subjectA, classSectionId: sectionA, academicTermId: termA, role: "PRIMARY", status: "ACTIVE" },
    }),
  );
  await withRetry(() =>
    adminClient.timetable.create({
      data: { id: timetableA, institutionId: instA, academicTermId: termA, name: `${PFX}TT`, status: "PUBLISHED", publishedAt: new Date() },
    }),
  );
  await withRetry(() =>
    adminClient.scheduledClass.create({
      data: { id: scheduledClassA, institutionId: instA, timetableId: timetableA, classSectionId: sectionA, subjectId: subjectA, facultyId: facultyProfileA, academicTermId: termA, room: id("R"), dayOfWeek: "MON", startTime: 540, endTime: 600, status: "SCHEDULED" },
    }),
  );
  // A second MON slot assigned to facultyProfileB (for the unassigned-faculty 403).
  await withRetry(() =>
    adminClient.scheduledClass.create({
      data: { id: scheduledClassUnassigned, institutionId: instA, timetableId: timetableA, classSectionId: sectionA, subjectId: subjectA, facultyId: facultyProfileB, academicTermId: termA, room: id("R2"), dayOfWeek: "MON", startTime: 600, endTime: 660, status: "SCHEDULED" },
    }),
  );
}

beforeAll(async () => {
  await teardown();
  await seed();
  const mod = await import("../attendance.js");
  attendanceRoutes = mod.attendanceRoutes;
  app = Fastify();
  await app.register(jwt, { secret: "attendance-behavioral-test-secret" });
  await app.register(attendanceRoutes, { prefix: "/api/attendance" });
  await app.ready();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  const { prisma } = await import("@campusgate/db");
  await prisma.$disconnect();
  await adminClient.$disconnect();
}, 120_000);

describe("Phase-4 attendance behavioral (real DB, real routes)", () => {
  it("full lifecycle: open -> mark -> submit -> finalize; records + append-only history persist", async () => {
    const facToken = tokenFor(facultyUser, "GUARD");

    const openRes = await app.inject({
      method: "POST",
      url: "/api/attendance/sessions",
      headers: authHeader(facToken),
      payload: { scheduledClassId: scheduledClassA, date: MON_DATE },
    });
    expect(openRes.statusCode).toBe(201);
    const sessionId = openRes.json().session.id as string;
    expect(openRes.json().recordCount).toBe(1);

    // one ABSENT record + one MARKED history row snapshotted
    const record = await adminClient.attendanceRecord.findFirst({
      where: { attendanceSessionId: sessionId, studentId: studentProfileA },
    });
    expect(record!.status).toBe("ABSENT");
    const hist0 = await adminClient.attendanceRecordHistory.count({ where: { attendanceRecordId: record!.id } });
    expect(hist0).toBe(1);

    // mark PRESENT
    const markRes = await app.inject({
      method: "PATCH",
      url: `/api/attendance/sessions/${sessionId}/records`,
      headers: authHeader(facToken),
      payload: { records: [{ studentId: studentProfileA, status: "PRESENT" }] },
    });
    expect(markRes.statusCode).toBe(200);
    expect(markRes.json().changed).toBe(1);

    const submitRes = await app.inject({ method: "POST", url: `/api/attendance/sessions/${sessionId}/submit`, headers: authHeader(facToken) });
    expect(submitRes.statusCode).toBe(200);

    const finalizeRes = await app.inject({ method: "POST", url: `/api/attendance/sessions/${sessionId}/finalize`, headers: authHeader(facToken) });
    expect(finalizeRes.statusCode).toBe(200);
    expect(finalizeRes.json().status).toBe("FINALIZED");

    const finalRecord = await adminClient.attendanceRecord.findFirst({ where: { id: record!.id } });
    expect(finalRecord!.status).toBe("PRESENT");
    const hist1 = await adminClient.attendanceRecordHistory.count({ where: { attendanceRecordId: record!.id } });
    expect(hist1).toBe(2); // MARKED (ABSENT) + MARKED (PRESENT)

    // cleanup this session's rows for isolation of later tests
    await teardownSessions();
  }, 120_000);

  it("faculty-scope: an unassigned faculty posting a class they do not teach gets 403 + DENIED audit", async () => {
    const facToken2 = tokenFor(facultyUser2, "GUARD");
    // facultyUser2 (facultyProfileB) is assigned to scheduledClassUnassigned, NOT
    // scheduledClassA. Posting scheduledClassA must be denied.
    const res = await app.inject({
      method: "POST",
      url: "/api/attendance/sessions",
      headers: authHeader(facToken2),
      payload: { scheduledClassId: scheduledClassA, date: MON_DATE },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "not assigned to this class" });

    const denied = await adminClient.auditEvent.findFirst({
      where: { institutionId: instA, action: "attendance.session.opened", result: "DENIED", actorUserId: facultyUser2 },
    });
    expect(denied).toBeTruthy();
  }, 120_000);

  it("correction workflow: request -> HOD approve rewrites record + CORRECTED history + audit; reject leaves it untouched", async () => {
    const facToken = tokenFor(facultyUser, "GUARD");
    const hodToken = tokenFor(hodUser, "HOD");

    // open -> mark PRESENT -> submit -> finalize
    const sessionId = await finalizeSessionPresent(facToken);
    const record = await adminClient.attendanceRecord.findFirst({ where: { attendanceSessionId: sessionId, studentId: studentProfileA } });

    // request a correction PRESENT -> ABSENT
    const reqRes = await app.inject({
      method: "POST",
      url: "/api/attendance/corrections",
      headers: authHeader(facToken),
      payload: { attendanceRecordId: record!.id, requestedStatus: "ABSENT", reason: "marked wrong" },
    });
    expect(reqRes.statusCode).toBe(201);
    const correctionId = reqRes.json().id as string;

    // a second PENDING request on the same record is rejected (partial unique)
    const dupRes = await app.inject({
      method: "POST",
      url: "/api/attendance/corrections",
      headers: authHeader(facToken),
      payload: { attendanceRecordId: record!.id, requestedStatus: "LATE", reason: "again" },
    });
    expect(dupRes.statusCode).toBe(409);

    // HOD approves
    const approveRes = await app.inject({
      method: "POST",
      url: `/api/attendance/corrections/${correctionId}/approve`,
      headers: authHeader(hodToken),
      payload: { reviewNote: "verified" },
    });
    expect(approveRes.statusCode).toBe(200);

    const afterApprove = await adminClient.attendanceRecord.findFirst({ where: { id: record!.id } });
    expect(afterApprove!.status).toBe("ABSENT");
    const corrected = await adminClient.attendanceRecordHistory.findFirst({
      where: { attendanceRecordId: record!.id, changeType: "CORRECTED" },
    });
    expect(corrected).toBeTruthy();
    expect(corrected!.previousStatus).toBe("PRESENT");
    expect(corrected!.newStatus).toBe("ABSENT");
    const approvedAudit = await adminClient.auditEvent.findFirst({
      where: { institutionId: instA, action: "attendance.correction.approved" },
    });
    expect(approvedAudit).toBeTruthy();

    // now a REJECT path on a fresh correction leaves the record unchanged
    const req2 = await app.inject({
      method: "POST",
      url: "/api/attendance/corrections",
      headers: authHeader(facToken),
      payload: { attendanceRecordId: record!.id, requestedStatus: "PRESENT", reason: "revert" },
    });
    expect(req2.statusCode).toBe(201);
    const correction2 = req2.json().id as string;
    const histBefore = await adminClient.attendanceRecordHistory.count({ where: { attendanceRecordId: record!.id } });

    const rejectRes = await app.inject({
      method: "POST",
      url: `/api/attendance/corrections/${correction2}/reject`,
      headers: authHeader(hodToken),
      payload: { reviewNote: "denied" },
    });
    expect(rejectRes.statusCode).toBe(200);
    const afterReject = await adminClient.attendanceRecord.findFirst({ where: { id: record!.id } });
    expect(afterReject!.status).toBe("ABSENT"); // unchanged
    const histAfter = await adminClient.attendanceRecordHistory.count({ where: { attendanceRecordId: record!.id } });
    expect(histAfter).toBe(histBefore); // no new history row on reject

    await teardownSessions();
  }, 180_000);

  it("finalized immutability: marking a FINALIZED session is 409; append-only history cannot be updated", async () => {
    const facToken = tokenFor(facultyUser, "GUARD");
    const sessionId = await finalizeSessionPresent(facToken);

    const markRes = await app.inject({
      method: "PATCH",
      url: `/api/attendance/sessions/${sessionId}/records`,
      headers: authHeader(facToken),
      payload: { records: [{ studentId: studentProfileA, status: "ABSENT" }] },
    });
    expect(markRes.statusCode).toBe(409);
    expect(markRes.json()).toMatchObject({ error: "session finalized" });

    // direct UPDATE of an append-only history row is refused (REVOKE + trigger)
    const record = await adminClient.attendanceRecord.findFirst({ where: { attendanceSessionId: sessionId } });
    const hist = await adminClient.attendanceRecordHistory.findFirst({ where: { attendanceRecordId: record!.id } });
    const { withTenant } = await import("@campusgate/db");
    await expect(
      withTenant(instA, (tx) => tx.attendanceRecordHistory.update({ where: { id: hist!.id }, data: { reason: "mutate" } })),
    ).rejects.toBeTruthy();

    await teardownSessions();
  }, 180_000);

  it("student own-read: GET /me returns only the caller's records + computed rate", async () => {
    const facToken = tokenFor(facultyUser, "GUARD");
    await finalizeSessionPresent(facToken);

    const stuToken = tokenFor(studentUser, "STUDENT");
    const res = await app.inject({
      method: "GET",
      url: `/api/attendance/me?academicTermId=${termA}`,
      headers: authHeader(stuToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.records)).toBe(true);
    for (const r of body.records) expect(r.studentId).toBe(studentProfileA);
    expect(body.attendanceRate).toBe(100); // the one FINALIZED record is PRESENT

    await teardownSessions();
  }, 180_000);

  it("low-attendance: finalizing a session that drops the student below threshold emits a notification + alert audit", async () => {
    const facToken = tokenFor(facultyUser, "GUARD");
    // Open + mark ABSENT (not present) + submit + finalize => rate 0% < 75% => crossing.
    const sessionId = await finalizeSessionAbsent(facToken);
    expect(sessionId).toBeTruthy();

    // the post-commit alert runs asynchronously within the handler; give it a beat
    await new Promise((r) => setTimeout(r, 500));
    const note = await adminClient.notification.findFirst({
      where: { institutionId: instA, userId: studentUser, type: "attendance.low" },
    });
    expect(note).toBeTruthy();
    const alertAudit = await adminClient.auditEvent.findFirst({
      where: { institutionId: instA, action: "attendance.low_attendance.alerted", resourceId: studentProfileA },
    });
    expect(alertAudit).toBeTruthy();

    await teardownSessions();
  }, 180_000);

  it("term-integrity: the three-column FK rejects a session whose academicTermId is not the scheduled class's term", async () => {
    const { withTenant } = await import("@campusgate/db");
    // Build a second term, then try to insert a session pairing scheduledClassA
    // (term = termA) with the other term — the three-column FK must reject it.
    const otherTerm = id("term2");
    await withRetry(() =>
      adminClient.academicTerm.create({
        data: { id: otherTerm, institutionId: instA, academicSessionId: sessionA, name: `${PFX}Term 2`, ordinal: 2, status: "ACTIVE", startDate: new Date("2027-01-01T00:00:00.000Z"), endDate: new Date("2027-06-30T00:00:00.000Z") },
      }),
    );
    await expect(
      withTenant(instA, (tx) =>
        tx.attendanceSession.create({
          data: {
            id: id("tamper"),
            institutionId: instA,
            scheduledClassId: scheduledClassA,
            academicTermId: otherTerm, // not scheduledClassA's term
            date: new Date(`${MON_DATE}T00:00:00.000Z`),
            status: "OPEN",
            markedByFacultyId: facultyProfileA,
          },
        }),
      ),
    ).rejects.toBeTruthy();
    await withRetry(() => adminClient.academicTerm.delete({ where: { id: otherTerm } }));
  }, 120_000);
});

// ── helpers that drive the real routes to a FINALIZED state ───────────────────

async function finalizeSessionPresent(facToken: string): Promise<string> {
  return finalizeSessionWith(facToken, "PRESENT");
}
async function finalizeSessionAbsent(facToken: string): Promise<string> {
  return finalizeSessionWith(facToken, "ABSENT");
}
async function finalizeSessionWith(facToken: string, status: string): Promise<string> {
  const openRes = await app.inject({
    method: "POST",
    url: "/api/attendance/sessions",
    headers: authHeader(facToken),
    payload: { scheduledClassId: scheduledClassA, date: MON_DATE },
  });
  if (openRes.statusCode !== 201) throw new Error(`open failed: ${openRes.statusCode} ${openRes.body}`);
  const sessionId = openRes.json().session.id as string;
  if (status !== "ABSENT") {
    await app.inject({
      method: "PATCH",
      url: `/api/attendance/sessions/${sessionId}/records`,
      headers: authHeader(facToken),
      payload: { records: [{ studentId: studentProfileA, status }] },
    });
  }
  await app.inject({ method: "POST", url: `/api/attendance/sessions/${sessionId}/submit`, headers: authHeader(facToken) });
  await app.inject({ method: "POST", url: `/api/attendance/sessions/${sessionId}/finalize`, headers: authHeader(facToken) });
  return sessionId;
}

// Remove only the attendance session/record/correction/history + notifications +
// audits between tests so the (scheduledClassId, date) unique never blocks a
// re-open. The scheduled classes / enrollments / faculty remain seeded.
async function teardownSessions(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  await withRetry(() =>
    adminClient.$executeRawUnsafe(
      `ALTER TABLE "attendance_record_history" DISABLE TRIGGER "attendance_record_history_no_update_delete"`,
    ),
  );
  try {
    await withRetry(() => adminClient.attendanceRecordHistory.deleteMany({ where }));
  } finally {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(
        `ALTER TABLE "attendance_record_history" ENABLE TRIGGER "attendance_record_history_no_update_delete"`,
      ),
    );
  }
  await withRetry(() => adminClient.attendanceCorrection.deleteMany({ where }));
  await withRetry(() => adminClient.attendanceRecord.deleteMany({ where }));
  await withRetry(() => adminClient.attendanceSession.deleteMany({ where }));
  await withRetry(() => adminClient.notification.deleteMany({ where }));
  await deleteAuditEvents(where);
}

// audit_events is append-only (trigger rejects DELETE even for the owner); disable
// the trigger for this scoped teardown delete, then re-enable it.
async function deleteAuditEvents(where: { institutionId: { startsWith: string } }): Promise<void> {
  await withRetry(() =>
    adminClient.$executeRawUnsafe(`ALTER TABLE "audit_events" DISABLE TRIGGER "audit_events_no_update_delete"`),
  );
  try {
    await withRetry(() => adminClient.auditEvent.deleteMany({ where }));
  } finally {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(`ALTER TABLE "audit_events" ENABLE TRIGGER "audit_events_no_update_delete"`),
    );
  }
}
