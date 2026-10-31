/**
 * Phase-8 examinations BEHAVIORAL integration suite (design §19) — runs against
 * the REAL Supabase instance through a REAL Fastify app (real `authenticate` +
 * real examsRoutes + real mfaRoutes + the real withTenant/RLS path). It proves
 * the access-and-correctness-critical guarantees the mocked unit suite cannot:
 *   AC-1  a STUDENT sees ONLY the latest PUBLISHED version; unpublished invisible
 *   AC-2  a faculty out-of-scope write -> 403 + DENIED audit, no row written
 *   AC-3  a post-first-write edit writes a CORRECTED history row (append-only)
 *   AC-4  two concurrent allocations into capacity-N never yield N+1
 *   AC-5  illegal exam status transitions raise restrict_violation at the DB
 *   AC-6/7 publish is step-up-gated; an un-enrolled approver cannot mint a token
 *   AC-11 a correction = a NEW version; no prior version/snapshot row mutated
 *
 * SELF-CONTAINED under a DISTINCT prefix (EXAM_TEST_); seeds + tears down its own
 * tenants/users/academics/classes/faculty via adminClient. Requires live Supabase
 * + campass_app creds. Registered in vitest.live-db-suites.ts; passes IN ISOLATION.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

// Pin BEFORE @campusgate/db loads: `authenticate` + requireModuleActive read via
// privilegedPrisma (no tenant GUC yet), so that client MUST be the owner role.
process.env.DATABASE_URL = appDatabaseUrl;
process.env.PRIVILEGED_DATABASE_URL = adminDatabaseUrl;
process.env.DIRECT_URL = adminDatabaseUrl;

const adminClient = new PrismaClient({ datasources: { db: { url: adminDatabaseUrl } }, log: ["error"] });

const PFX = "EXAM_TEST_";
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

// ─── tenants / users / academics / classes ──────────────────────────────────
const instA = id("instA");
const deptA = id("deptA");
const sessionA = id("sessA");
const termA = id("termA");
const programA = id("progA");
const courseA = id("courseA");
const subjectA = id("subjA"); // the in-scope subject
const subjectOther = id("subjOther"); // a subject the faculty is NOT assigned to
const sectionA = id("sectA");

const adminUser = id("u_admin");
const facultyUser = id("u_faculty"); // in-scope faculty (ACTIVE profile)
const facultyProfileA = id("fac_A");
const studentUser = id("u_student");
const studentProfileA = id("sp_A");

let app: FastifyInstance;

function tokenFor(userId: string, legacyRole: string): string {
  return app.jwt.sign({ userId, role: legacyRole, institutionId: instA });
}
const authHeader = (t: string) => ({ authorization: `Bearer ${t}` });
const adminToken = () => tokenFor(adminUser, "ADMIN");
const facultyToken = () => tokenFor(facultyUser, "GUARD");
const studentToken = () => tokenFor(studentUser, "STUDENT");

// Mint an action-bound step-up token via the SAME @fastify/jwt signer the route's
// requireStepUp verifies against (mirrors the fees-behavioral stepUpToken helper).
function stepUpToken(userId: string, action: string): string {
  return app.jwt.sign({ userId, jti: `${PFX}jti_${Date.now()}_${Math.random()}`, stepUp: true, action });
}
const stepUpHeader = (userId: string, action: string) => ({ "x-step-up": stepUpToken(userId, action) });

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
      data: { id: mId, userId, institutionId: instA, membershipStatus: "ACTIVE", permissionsVersion: 0 },
    }),
  );
  await withRetry(() =>
    adminClient.membershipRole.create({
      data: { id: id(`mrl_${userId}`), membershipId: mId, roleId, institutionId: instA },
    }),
  );
}

// ─── exam-row teardown (child-first, with the guard-disable dance) ───────────
async function clearExams(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  // Strictly append-only INSERT-only tables first (append-only triggers). Slice
  // 8.2: result_snapshots + marks_record_history stay append-only; result_
  // publications moved to a COLUMN GUARD (result_publications_guard), handled in
  // the column-guard block below alongside reeval_requests.
  for (const t of ["result_snapshots", "marks_record_history"] as const) {
    await withRetry(() => adminClient.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER "${t}_no_update_delete"`));
  }
  try {
    await withRetry(() => adminClient.resultSnapshot.deleteMany({ where }));
    await withRetry(() => adminClient.marksRecordHistory.deleteMany({ where }));
  } finally {
    for (const t of ["result_snapshots", "marks_record_history"] as const) {
      await withRetry(() => adminClient.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER "${t}_no_update_delete"`));
    }
  }
  // Column-guard tables (DELETE forbidden unconditionally): reeval_requests ->
  // marks_records -> ... -> result_publications -> examinations (child-first).
  const guarded = [
    { table: "reeval_requests", trigger: "reeval_requests_guard" },
    { table: "marks_records", trigger: "marks_records_guard" },
    { table: "examinations", trigger: "examinations_guard" },
    { table: "result_publications", trigger: "result_publications_guard" },
  ] as const;
  for (const { table, trigger } of guarded) {
    await withRetry(() => adminClient.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`));
  }
  try {
    await withRetry(() => adminClient.reevalRequest.deleteMany({ where }));
    await withRetry(() => adminClient.marksRecord.deleteMany({ where }));
    await withRetry(() => adminClient.candidate.deleteMany({ where }));
    await withRetry(() => adminClient.assessment.deleteMany({ where }));
    await withRetry(() => adminClient.examSchedule.deleteMany({ where }));
    await withRetry(() => adminClient.resultPublication.deleteMany({ where }));
    await withRetry(() => adminClient.gradeBand.deleteMany({ where }));
    await withRetry(() => adminClient.gradingScheme.deleteMany({ where }));
    await withRetry(() => adminClient.examination.deleteMany({ where }));
  } finally {
    for (const { table, trigger } of guarded) {
      await withRetry(() => adminClient.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`));
    }
  }
  await deleteAuditEvents();
}

async function deleteAuditEvents(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  await withRetry(() => adminClient.$executeRawUnsafe(`ALTER TABLE "audit_events" DISABLE TRIGGER "audit_events_no_update_delete"`));
  try {
    await withRetry(() => adminClient.auditEvent.deleteMany({ where }));
  } finally {
    await withRetry(() => adminClient.$executeRawUnsafe(`ALTER TABLE "audit_events" ENABLE TRIGGER "audit_events_no_update_delete"`));
  }
}

async function teardown(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  await clearExams();
  await withRetry(() => adminClient.classEnrollment.deleteMany({ where }));
  await withRetry(() => adminClient.facultyAssignment.deleteMany({ where }));
  await withRetry(() => adminClient.subject.deleteMany({ where }));
  await withRetry(() => adminClient.course.deleteMany({ where }));
  await withRetry(() => adminClient.classSection.deleteMany({ where }));
  await withRetry(() => adminClient.facultyProfile.deleteMany({ where }));
  await withRetry(() => adminClient.membershipRole.deleteMany({ where }));
  await withRetry(() => adminClient.institutionMembership.deleteMany({ where }));
  await withRetry(() => adminClient.institutionModule.deleteMany({ where }));
  await withRetry(() => adminClient.studentProfile.deleteMany({ where }));
  await withRetry(() => adminClient.academicTerm.deleteMany({ where }));
  await withRetry(() => adminClient.academicSession.deleteMany({ where }));
  await withRetry(() => adminClient.program.deleteMany({ where }));
  await withRetry(() => adminClient.user.deleteMany({ where }));
  await withRetry(() => adminClient.department.deleteMany({ where }));
  await withRetry(() => adminClient.institution.deleteMany({ where: { id: { startsWith: PFX } } }));
}

async function seed(): Promise<void> {
  await withRetry(() => adminClient.institution.create({ data: { id: instA, name: `${PFX}A`, code: id("CODE_A"), status: "ACTIVE" } }));
  await withRetry(() => adminClient.department.create({ data: { id: deptA, name: `${PFX}Dept`, code: id("D_A"), institutionId: instA } }));
  await withRetry(() =>
    adminClient.institutionModule.create({
      data: { id: id("imod_A"), institutionId: instA, moduleKey: "examinations", state: "ACTIVE", entitledAt: new Date(), activatedAt: new Date() },
    }),
  );
  await withRetry(() =>
    adminClient.academicSession.create({
      data: { id: sessionA, institutionId: instA, name: `${PFX}Session`, structureType: "SEMESTER", status: "ACTIVE", startDate: new Date("2026-07-01T00:00:00.000Z"), endDate: new Date("2027-06-30T00:00:00.000Z") },
    }),
  );
  await withRetry(() =>
    adminClient.academicTerm.create({
      data: { id: termA, institutionId: instA, academicSessionId: sessionA, name: `${PFX}Term`, ordinal: 1, status: "ACTIVE", startDate: new Date("2026-07-01T00:00:00.000Z"), endDate: new Date("2026-12-31T00:00:00.000Z") },
    }),
  );
  await withRetry(() =>
    adminClient.program.create({
      data: { id: programA, institutionId: instA, departmentId: deptA, name: `${PFX}BCA`, code: id("BCA"), duration: 6, durationUnit: "TERMS" },
    }),
  );
  await withRetry(() =>
    adminClient.course.create({
      data: { id: courseA, institutionId: instA, programId: programA, academicTermId: termA, name: `${PFX}Course`, code: id("C1"), status: "ACTIVE" },
    }),
  );
  await withRetry(() =>
    adminClient.subject.create({ data: { id: subjectA, institutionId: instA, courseId: courseA, name: `${PFX}Subj`, code: id("S1"), credits: 4, contactHoursPerWeek: 4, status: "ACTIVE" } }),
  );
  await withRetry(() =>
    adminClient.subject.create({ data: { id: subjectOther, institutionId: instA, courseId: courseA, name: `${PFX}SubjX`, code: id("S2"), credits: 4, contactHoursPerWeek: 4, status: "ACTIVE" } }),
  );
  await withRetry(() =>
    adminClient.classSection.create({
      data: { id: sectionA, institutionId: instA, programId: programA, academicSessionId: sessionA, academicTermId: termA, label: `${PFX}Sec`, capacity: 60, status: "ACTIVE" },
    }),
  );

  // ADMIN.
  await withRetry(() => adminClient.user.create({ data: { id: adminUser, email: `${PFX.toLowerCase()}admin@a.test`, role: "ADMIN", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(adminUser, "ADMIN");

  // FACULTY (legacy role GUARD; capability from the FACULTY membership). ACTIVE
  // FacultyProfile + an ACTIVE FacultyAssignment on subjectA + sectionA + termA.
  await withRetry(() => adminClient.user.create({ data: { id: facultyUser, email: `${PFX.toLowerCase()}fac@a.test`, role: "GUARD", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(facultyUser, "FACULTY");
  await withRetry(() =>
    adminClient.facultyProfile.create({ data: { id: facultyProfileA, institutionId: instA, userId: facultyUser, name: `${PFX}Faculty`, departmentId: deptA, status: "ACTIVE" } }),
  );
  await withRetry(() =>
    adminClient.facultyAssignment.create({
      data: { id: id("facassign_A"), institutionId: instA, facultyId: facultyProfileA, subjectId: subjectA, classSectionId: sectionA, academicTermId: termA, role: "PRIMARY", status: "ACTIVE" },
    }),
  );

  // STUDENT + enrollment into sectionA (so the faculty scope resolves the section).
  await withRetry(() => adminClient.user.create({ data: { id: studentUser, email: `${PFX.toLowerCase()}stu@a.test`, role: "STUDENT", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(studentUser, "STUDENT");
  await withRetry(() =>
    adminClient.studentProfile.create({
      data: { id: studentProfileA, userId: studentUser, institutionId: instA, enrollmentNo: id("ENR_A"), name: `${PFX}Student`, departmentId: deptA, program: "TEST", semester: 1, status: "ACTIVE" },
    }),
  );
  await withRetry(() =>
    adminClient.classEnrollment.create({ data: { id: id("enroll_A"), institutionId: instA, classSectionId: sectionA, studentId: studentProfileA, status: "ENROLLED" } }),
  );
}

// ─── scenario helpers through the REAL routes ────────────────────────────────
async function createExam(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/exams",
    headers: authHeader(adminToken()),
    payload: { academicSessionId: sessionA, academicTermId: termA, programId: programA, name: `Exam ${Date.now()}`, type: "FINAL" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function advance(examId: string, to: string): Promise<number> {
  const res = await app.inject({ method: "POST", url: `/api/exams/${examId}/status`, headers: authHeader(adminToken()), payload: { to } });
  return res.statusCode;
}

async function toMarksOpen(examId: string): Promise<void> {
  expect(await advance(examId, "SCHEDULED")).toBe(200);
  expect(await advance(examId, "MARKS_OPEN")).toBe(200);
}

async function registerCandidate(examId: string, studentId: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: `/api/exams/${examId}/candidates`, headers: authHeader(adminToken()), payload: { studentIds: [studentId] } });
  expect(res.statusCode).toBe(201);
  return res.json().candidateIds[0] as string;
}

async function createAssessment(examId: string, subjectId: string, weight = 100, maxMarks = 100): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/api/exams/${examId}/assessments`,
    headers: authHeader(adminToken()),
    payload: { subjectId, name: "FINAL", maxMarks, weight },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function createActiveScheme(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/exams/grading-schemes",
    headers: authHeader(adminToken()),
    payload: {
      name: `Scheme ${Date.now()}_${Math.random()}`,
      isActive: true,
      bands: [
        { minPercentBps: 0, maxPercentBps: 3999, gradeLabel: "F", gradePoints: 0, isPassing: false },
        { minPercentBps: 4000, maxPercentBps: 10000, gradeLabel: "P", gradePoints: 1000, isPassing: true },
      ],
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

beforeAll(async () => {
  await teardown();
  await seed();

  const { examsRoutes } = await import("../exams.js");
  const { mfaRoutes } = await import("../mfa.js");

  app = Fastify();
  await app.register(jwt, { secret: "exams-behavioral-test-secret" });
  await app.register(examsRoutes, { prefix: "/api/exams" });
  await app.register(mfaRoutes, { prefix: "/api/auth/mfa" });
  await app.ready();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  await teardown();
  const { prisma } = await import("@campusgate/db");
  await prisma.$disconnect();
  await adminClient.$disconnect();
}, 120_000);

beforeEach(async () => {
  await clearExams();
});

describe("Phase-8 exams behavioral (real DB, real routes, real RLS)", () => {
  it("AC-5: illegal exam status transitions raise restrict_violation (DRAFT->MARKS_OPEN skip rejected 409)", async () => {
    const examId = await createExam();
    // Skipping SCHEDULED is illegal: the service's optimistic where misses AND the
    // trigger is the backstop; both surface as a 409.
    expect(await advance(examId, "MARKS_OPEN")).toBe(409);
    // The legal forward step succeeds.
    expect(await advance(examId, "SCHEDULED")).toBe(200);
    // Re-posting the same target (already SCHEDULED) is not a forward step, so the
    // route rejects it 409 (its LEGAL_TRANSITIONS maps only to the next state).
    const repeat = await app.inject({ method: "POST", url: `/api/exams/${examId}/status`, headers: authHeader(adminToken()), payload: { to: "SCHEDULED" } });
    expect(repeat.statusCode).toBe(409);
    // A true backward jump via a direct DB UPDATE raises at the examinations_guard
    // trigger (the DB-level forward-only backstop, AC-5).
    await expect(
      adminClient.$executeRawUnsafe(
        `UPDATE "examinations" SET "status" = 'DRAFT' WHERE "id" = '${examId}'`,
      ),
    ).rejects.toBeTruthy();
  }, 120_000);

  it("AC-2: a faculty write for an out-of-scope subject -> 403 + DENIED audit, no marks row written", async () => {
    const examId = await createExam();
    await createAssessment(examId, subjectOther, 100, 100); // subject the faculty is NOT assigned to
    const candidateId = await registerCandidate(examId, studentProfileA);
    await toMarksOpen(examId);
    const assessment = await adminClient.assessment.findFirst({ where: { institutionId: instA, examId, subjectId: subjectOther } });

    const res = await app.inject({
      method: "PUT",
      url: `/api/exams/${examId}/marks`,
      headers: authHeader(facultyToken()),
      payload: { marks: [{ assessmentId: assessment!.id, candidateId, marks: 50 }] },
    });
    expect(res.statusCode).toBe(403);

    const written = await adminClient.marksRecord.count({ where: { institutionId: instA, examId } });
    expect(written).toBe(0);
    const denied = await adminClient.auditEvent.count({
      where: { institutionId: instA, action: "exams.marks.entered", result: "DENIED" },
    });
    expect(denied).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("AC-2/AC-3: in-scope faculty first write MARKED, a second edit writes a CORRECTED history row (append-only)", async () => {
    const examId = await createExam();
    const assessmentId = await createAssessment(examId, subjectA, 100, 100);
    const candidateId = await registerCandidate(examId, studentProfileA);
    await toMarksOpen(examId);

    const first = await app.inject({
      method: "PUT",
      url: `/api/exams/${examId}/marks`,
      headers: authHeader(facultyToken()),
      payload: { marks: [{ assessmentId, candidateId, marks: 70 }] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().records[0].changeType).toBe("MARKED");

    const second = await app.inject({
      method: "PUT",
      url: `/api/exams/${examId}/marks`,
      headers: authHeader(facultyToken()),
      payload: { marks: [{ assessmentId, candidateId, marks: 85 }] },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().records[0].changeType).toBe("CORRECTED");

    const rec = await adminClient.marksRecord.findFirst({ where: { institutionId: instA, examId, assessmentId, candidateId } });
    expect(rec!.marks).toBe(85);
    const history = await adminClient.marksRecordHistory.findMany({ where: { institutionId: instA, marksRecordId: rec!.id }, orderBy: { createdAt: "asc" } });
    expect(history.length).toBe(2);
    expect(history[0].changeType).toBe("MARKED");
    expect(history[0].previousMarks).toBeNull();
    expect(history[1].changeType).toBe("CORRECTED");
    expect(history[1].previousMarks).toBe(70);
    expect(history[1].newMarks).toBe(85);
  }, 120_000);

  it("AC-3: a mark outside [0,maxMarks] is rejected 400 and nothing is written", async () => {
    const examId = await createExam();
    const assessmentId = await createAssessment(examId, subjectA, 100, 100);
    const candidateId = await registerCandidate(examId, studentProfileA);
    await toMarksOpen(examId);
    const res = await app.inject({
      method: "PUT",
      url: `/api/exams/${examId}/marks`,
      headers: authHeader(facultyToken()),
      payload: { marks: [{ assessmentId, candidateId, marks: 101 }] },
    });
    expect(res.statusCode).toBe(400);
    expect(await adminClient.marksRecord.count({ where: { institutionId: instA, examId } })).toBe(0);
  }, 120_000);

  it("AC-4: two concurrent allocations into a capacity-2 room never yield 3 occupants", async () => {
    const examId = await createExam();
    // Register three candidates on the one seeded student is impossible (unique
    // per exam+student), so create two extra student profiles for this exam.
    const s2 = id("sp_alloc2");
    const s3 = id("sp_alloc3");
    const u2 = id("u_alloc2");
    const u3 = id("u_alloc3");
    await withRetry(() => adminClient.user.create({ data: { id: u2, email: `${u2.toLowerCase()}@a.test`, role: "STUDENT", accountStatus: "ACTIVE", institutionId: instA } }));
    await withRetry(() => adminClient.user.create({ data: { id: u3, email: `${u3.toLowerCase()}@a.test`, role: "STUDENT", accountStatus: "ACTIVE", institutionId: instA } }));
    await withRetry(() => adminClient.studentProfile.create({ data: { id: s2, userId: u2, institutionId: instA, enrollmentNo: id("ENR_s2"), name: `${PFX}S2`, departmentId: deptA, program: "T", semester: 1, status: "ACTIVE" } }));
    await withRetry(() => adminClient.studentProfile.create({ data: { id: s3, userId: u3, institutionId: instA, enrollmentNo: id("ENR_s3"), name: `${PFX}S3`, departmentId: deptA, program: "T", semester: 1, status: "ACTIVE" } }));

    const c1 = await registerCandidate(examId, studentProfileA);
    const c2 = await registerCandidate(examId, s2);
    const c3 = await registerCandidate(examId, s3);

    // A capacity-2 schedule.
    const sched = await app.inject({
      method: "POST",
      url: `/api/exams/${examId}/schedules`,
      headers: authHeader(adminToken()),
      payload: { subjectId: subjectA, room: "R-ALLOC", roomCapacity: 2, startsAt: "2026-12-01T09:00:00.000Z", endsAt: "2026-12-01T12:00:00.000Z" },
    });
    expect(sched.statusCode).toBe(201);
    const scheduleId = sched.json().id as string;

    // Two concurrent allocations: {c1,c2} and {c2,c3} — overlap on c2 is a no-op
    // for one; combined distinct NEW candidates = c1,c2,c3 = 3 > capacity 2, so at
    // least one request must be rejected and total occupants must never exceed 2.
    const [r1, r2] = await Promise.all([
      app.inject({ method: "POST", url: `/api/exams/${examId}/schedules/${scheduleId}/allocate`, headers: authHeader(adminToken()), payload: { candidateIds: [c1, c2] } }),
      app.inject({ method: "POST", url: `/api/exams/${examId}/schedules/${scheduleId}/allocate`, headers: authHeader(adminToken()), payload: { candidateIds: [c3] } }),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    // Both could not fully succeed: c1+c2 (2) fills the room, so the c3 request is
    // rejected 409 room full. (Serialized by the advisory lock.)
    expect(statuses).toContain(409);

    const occupants = await adminClient.candidate.count({ where: { institutionId: instA, examScheduleId: scheduleId } });
    expect(occupants).toBeLessThanOrEqual(2);

    // cleanup the extra allocation-only students at end (teardown handles the rest).
  }, 180_000);

  it("AC-6/AC-7: publish is step-up-gated — 401 without x-step-up; an un-enrolled approver cannot mint a token", async () => {
    const examId = await createExam();
    // Without x-step-up ⇒ 401 even for the ADMIN holder.
    const noStepUp = await app.inject({ method: "POST", url: `/api/exams/${examId}/publish`, headers: authHeader(adminToken()), payload: {} });
    expect(noStepUp.statusCode).toBe(401);
    expect(noStepUp.json().error).toBe("Step-up required");

    // AC-7: an un-enrolled approver (mfaEnabled=false) cannot complete /mfa/verify,
    // so cannot obtain a real step-up token — the publish route stays unreachable.
    const verify = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/verify",
      headers: authHeader(adminToken()),
      payload: { code: "000000", action: "exams.results.publish" },
    });
    expect(verify.statusCode).toBe(400);
    expect(verify.json().error).toBe("MFA not enrolled");
  }, 120_000);

  it("AC-1/AC-6/AC-11: publish snapshots results; student sees ONLY latest PUBLISHED; a correction is a NEW version with no prior row mutated", async () => {
    const examId = await createExam();
    const assessmentId = await createAssessment(examId, subjectA, 100, 100);
    const candidateId = await registerCandidate(examId, studentProfileA);
    await createActiveScheme();
    await toMarksOpen(examId);

    // Faculty enters 80 (80% -> 'P', passing).
    const enter = await app.inject({
      method: "PUT",
      url: `/api/exams/${examId}/marks`,
      headers: authHeader(facultyToken()),
      payload: { marks: [{ assessmentId, candidateId, marks: 80 }] },
    });
    expect(enter.statusCode).toBe(200);

    // AC-1: before publish, the STUDENT sees no result.
    const before = await app.inject({ method: "GET", url: `/api/exams/me/results/${examId}`, headers: authHeader(studentToken()) });
    expect(before.statusCode).toBe(404);

    // Advance through the lifecycle to APPROVED.
    expect(await advance(examId, "MARKS_LOCKED")).toBe(200);
    expect(await advance(examId, "MODERATION")).toBe(200);
    expect(await advance(examId, "APPROVED")).toBe(200);

    // Publish v1 with a minted step-up token.
    const pub1 = await app.inject({
      method: "POST",
      url: `/api/exams/${examId}/publish`,
      headers: { ...authHeader(adminToken()), ...stepUpHeader(adminUser, "exams.results.publish") },
      payload: {},
    });
    expect(pub1.statusCode).toBe(201);
    expect(pub1.json().version).toBe(1);
    expect(pub1.json().snapshotCount).toBe(1);

    // AC-1: the STUDENT now sees exactly the latest PUBLISHED snapshot.
    const after = await app.inject({ method: "GET", url: `/api/exams/me/results/${examId}`, headers: authHeader(studentToken()) });
    expect(after.statusCode).toBe(200);
    expect(after.json().published).toBe(true);
    expect(after.json().version).toBe(1);
    expect(after.json().snapshots[0].gradeLabel).toBe("P");
    expect(after.json().snapshots[0].percentBps).toBe(8000);

    const v1pub = await adminClient.resultPublication.findFirst({ where: { institutionId: instA, examId, version: 1 } });
    const v1snap = await adminClient.resultSnapshot.findFirst({ where: { institutionId: instA, resultPublicationId: v1pub!.id } });

    // AC-11: a correction re-publish = a NEW version 2; the exam stays PUBLISHED.
    const pub2 = await app.inject({
      method: "POST",
      url: `/api/exams/${examId}/publish`,
      headers: { ...authHeader(adminToken()), ...stepUpHeader(adminUser, "exams.results.publish") },
      payload: { reason: "re-publication after review" },
    });
    expect(pub2.statusCode).toBe(201);
    expect(pub2.json().version).toBe(2);

    // Slice 8.2: the prior version header is now flipped to SUPERSEDED by the
    // re-publication supersede flip (the only legal mutation of its row); every
    // other column + its snapshot are untouched (the column guard + append-only).
    const v1pubAfter = await adminClient.resultPublication.findFirst({ where: { id: v1pub!.id } });
    expect(v1pubAfter!.version).toBe(1);
    expect(v1pubAfter!.status).toBe("SUPERSEDED");
    const v1snapAfter = await adminClient.resultSnapshot.findFirst({ where: { id: v1snap!.id } });
    expect(v1snapAfter!.percentBps).toBe(v1snap!.percentBps);

    // The student now reads the LATEST (v2) only.
    const latest = await app.inject({ method: "GET", url: `/api/exams/me/results/${examId}`, headers: authHeader(studentToken()) });
    expect(latest.json().version).toBe(2);

    // A re-publication WITHOUT a reason is rejected 400.
    const pub3 = await app.inject({
      method: "POST",
      url: `/api/exams/${examId}/publish`,
      headers: { ...authHeader(adminToken()), ...stepUpHeader(adminUser, "exams.results.publish") },
      payload: {},
    });
    expect(pub3.statusCode).toBe(400);
  }, 180_000);

  // ─── Slice 8.2: re-evaluation, supplementary, history, supersede ───────────

  // Drive an exam to a PUBLISHED v1 with one 80/100 mark for the seeded student.
  async function publishV1(): Promise<{ examId: string; assessmentId: string; candidateId: string }> {
    const examId = await createExam();
    const assessmentId = await createAssessment(examId, subjectA, 100, 100);
    const candidateId = await registerCandidate(examId, studentProfileA);
    await createActiveScheme();
    await toMarksOpen(examId);
    const enter = await app.inject({
      method: "PUT",
      url: `/api/exams/${examId}/marks`,
      headers: authHeader(facultyToken()),
      payload: { marks: [{ assessmentId, candidateId, marks: 80 }] },
    });
    expect(enter.statusCode).toBe(200);
    expect(await advance(examId, "MARKS_LOCKED")).toBe(200);
    expect(await advance(examId, "MODERATION")).toBe(200);
    expect(await advance(examId, "APPROVED")).toBe(200);
    const pub = await app.inject({
      method: "POST",
      url: `/api/exams/${examId}/publish`,
      headers: { ...authHeader(adminToken()), ...stepUpHeader(adminUser, "exams.results.publish") },
      payload: {},
    });
    expect(pub.statusCode).toBe(201);
    return { examId, assessmentId, candidateId };
  }

  it("8.2 AC-8/9/9a/12/13: end-to-end re-eval (request -> UNDER_REVIEW -> remark -> REMARKED -> re-publish supersedes); student sees only latest", async () => {
    const { examId, assessmentId, candidateId } = await publishV1();

    // Student requests re-evaluation of their OWN published result.
    const reqRes = await app.inject({
      method: "POST",
      url: "/api/exams/me/reeval",
      headers: authHeader(studentToken()),
      payload: { examId, subjectId: subjectA, reason: "please recount the final" },
    });
    expect(reqRes.statusCode).toBe(201);
    const reevalId = reqRes.json().id as string;
    expect(reqRes.json().status).toBe("REQUESTED");

    // A duplicate OPEN request is blocked by the partial unique (409).
    const dup = await app.inject({
      method: "POST",
      url: "/api/exams/me/reeval",
      headers: authHeader(studentToken()),
      payload: { examId, subjectId: subjectA, reason: "again" },
    });
    expect(dup.statusCode).toBe(409);

    // FACULTY / STUDENT cannot manage (403 on the staff route).
    const facList = await app.inject({ method: "GET", url: "/api/exams/reeval", headers: authHeader(facultyToken()) });
    expect(facList.statusCode).toBe(403);
    const stuList = await app.inject({ method: "GET", url: "/api/exams/reeval", headers: authHeader(studentToken()) });
    expect(stuList.statusCode).toBe(403);

    // Re-mark BEFORE UNDER_REVIEW is rejected (request not under review).
    const marksRec = await adminClient.marksRecord.findFirst({ where: { institutionId: instA, examId, assessmentId, candidateId } });
    const earlyRemark = await app.inject({
      method: "POST",
      url: `/api/exams/reeval/${reevalId}/remark`,
      headers: authHeader(adminToken()),
      payload: { marksRecordId: marksRec!.id, marks: 90, reason: "early" },
    });
    expect(earlyRemark.statusCode).toBe(409);

    // Staff advances to UNDER_REVIEW.
    const toReview = await app.inject({
      method: "POST",
      url: `/api/exams/reeval/${reevalId}/transition`,
      headers: authHeader(adminToken()),
      payload: { to: "UNDER_REVIEW" },
    });
    expect(toReview.statusCode).toBe(200);

    // An illegal transition (UNDER_REVIEW -> CLOSED) is rejected 409.
    const illegal = await app.inject({
      method: "POST",
      url: `/api/exams/reeval/${reevalId}/transition`,
      headers: authHeader(adminToken()),
      payload: { to: "CLOSED" },
    });
    expect(illegal.statusCode).toBe(409);

    // An out-of-range re-mark is rejected 400 + DENIED audit.
    const oor = await app.inject({
      method: "POST",
      url: `/api/exams/reeval/${reevalId}/remark`,
      headers: authHeader(adminToken()),
      payload: { marksRecordId: marksRec!.id, marks: 101, reason: "too high" },
    });
    expect(oor.statusCode).toBe(400);

    // The real re-mark: 80 -> 95. The exam stays PUBLISHED; a CORRECTED history row is written.
    const remark = await app.inject({
      method: "POST",
      url: `/api/exams/reeval/${reevalId}/remark`,
      headers: authHeader(adminToken()),
      payload: { marksRecordId: marksRec!.id, marks: 95, reason: "recount correct" },
    });
    expect(remark.statusCode).toBe(200);
    expect(remark.json().previousMarks).toBe(80);
    expect(remark.json().newMarks).toBe(95);
    const examRow = await adminClient.examination.findUnique({ where: { id: examId } });
    expect(examRow!.status).toBe("PUBLISHED"); // lifecycle untouched

    // Staff records the re-mark done.
    const toRemarked = await app.inject({
      method: "POST",
      url: `/api/exams/reeval/${reevalId}/transition`,
      headers: authHeader(adminToken()),
      payload: { to: "REMARKED" },
    });
    expect(toRemarked.statusCode).toBe(200);

    // Re-publish: version 2 is created and version 1 is flipped to SUPERSEDED.
    const pub2 = await app.inject({
      method: "POST",
      url: `/api/exams/${examId}/publish`,
      headers: { ...authHeader(adminToken()), ...stepUpHeader(adminUser, "exams.results.publish") },
      payload: { reason: "re-evaluation outcome" },
    });
    expect(pub2.statusCode).toBe(201);
    expect(pub2.json().version).toBe(2);

    const v1 = await adminClient.resultPublication.findFirst({ where: { institutionId: instA, examId, version: 1 } });
    const v2 = await adminClient.resultPublication.findFirst({ where: { institutionId: instA, examId, version: 2 } });
    expect(v1!.status).toBe("SUPERSEDED");
    expect(v2!.status).toBe("PUBLISHED");
    const supersededAudit = await adminClient.auditEvent.count({ where: { institutionId: instA, action: "exams.results.superseded", result: "SUCCESS" } });
    expect(supersededAudit).toBeGreaterThanOrEqual(1);

    // Staff closes the request.
    const close = await app.inject({
      method: "POST",
      url: `/api/exams/reeval/${reevalId}/transition`,
      headers: authHeader(adminToken()),
      payload: { to: "CLOSED" },
    });
    expect(close.statusCode).toBe(200);

    // Student history: ONLY the latest PUBLISHED version (v2, 95%).
    const hist = await app.inject({ method: "GET", url: "/api/exams/me/results/history", headers: authHeader(studentToken()) });
    expect(hist.statusCode).toBe(200);
    const entry = (hist.json().history as Array<Record<string, unknown>>).find((h) => h.examId === examId);
    expect(entry).toBeTruthy();
    expect(entry!.version).toBe(2);
    expect((entry!.subjects as Array<Record<string, unknown>>)[0].percentBps).toBe(9500);

    // Staff history shows BOTH versions (incl. superseded).
    const staffHist = await app.inject({
      method: "GET",
      url: `/api/exams/students/${studentProfileA}/results/history`,
      headers: authHeader(adminToken()),
    });
    expect(staffHist.statusCode).toBe(200);
    const versions = (staffHist.json().history as Array<Record<string, unknown>>)
      .filter((h) => h.examId === examId)
      .map((h) => ({ v: h.version, s: h.status }));
    expect(versions).toContainEqual({ v: 1, s: "SUPERSEDED" });
    expect(versions).toContainEqual({ v: 2, s: "PUBLISHED" });
  }, 240_000);

  it("8.2 AC-5/9a: remark out-of-scope record rejected; transition outcomePublicationId scope enforced", async () => {
    const { examId, candidateId } = await publishV1();

    // Request + move to UNDER_REVIEW.
    const reqRes = await app.inject({
      method: "POST",
      url: "/api/exams/me/reeval",
      headers: authHeader(studentToken()),
      payload: { examId, subjectId: subjectA, reason: "recount" },
    });
    expect(reqRes.statusCode).toBe(201);
    const reevalId = reqRes.json().id as string;
    expect((await app.inject({ method: "POST", url: `/api/exams/reeval/${reevalId}/transition`, headers: authHeader(adminToken()), payload: { to: "UNDER_REVIEW" } })).statusCode).toBe(200);

    // A fabricated / out-of-scope marksRecordId is 404.
    const bogus = await app.inject({
      method: "POST",
      url: `/api/exams/reeval/${reevalId}/remark`,
      headers: authHeader(adminToken()),
      payload: { marksRecordId: `${PFX}NOPE`, marks: 50, reason: "x" },
    });
    expect(bogus.statusCode).toBe(404);

    // Transition to REMARKED with an outcomePublicationId that belongs to ANOTHER
    // exam is rejected 404 (scope check). Build a second published exam's pub id.
    const other = await publishV1();
    const otherPub = await adminClient.resultPublication.findFirst({ where: { institutionId: instA, examId: other.examId, version: 1 } });
    const badOutcome = await app.inject({
      method: "POST",
      url: `/api/exams/reeval/${reevalId}/transition`,
      headers: authHeader(adminToken()),
      payload: { to: "REMARKED", outcomePublicationId: otherPub!.id },
    });
    expect(badOutcome.statusCode).toBe(404);
    expect(candidateId).toBeTruthy();
  }, 240_000);

  it("8.2 AC-10/11: supplementary linkage enforced; eligibility registers only non-passing; ineligible allowlist rejected atomically", async () => {
    // Parent exam: one student passes (80%) and we need a failing student. Create
    // a second student and give them a failing mark on the parent.
    const parentId = await createExam();
    const parentAssessment = await createAssessment(parentId, subjectA, 100, 100);
    const c1 = await registerCandidate(parentId, studentProfileA); // will pass
    // a failing student
    const failUser = id("u_fail");
    const failStudent = id("sp_fail");
    await withRetry(() => adminClient.user.create({ data: { id: failUser, email: `${failUser.toLowerCase()}@a.test`, role: "STUDENT", accountStatus: "ACTIVE", institutionId: instA } }));
    await withRetry(() => adminClient.studentProfile.create({ data: { id: failStudent, userId: failUser, institutionId: instA, enrollmentNo: id("ENR_fail"), name: `${PFX}Fail`, departmentId: deptA, program: "T", semester: 1, status: "ACTIVE" } }));
    await withRetry(() => adminClient.classEnrollment.create({ data: { id: id("enroll_fail"), institutionId: instA, classSectionId: sectionA, studentId: failStudent, status: "ENROLLED" } }));
    const c2 = await registerCandidate(parentId, failStudent);
    await createActiveScheme(); // F < 40%, P >= 40%
    await toMarksOpen(parentId);
    await app.inject({ method: "PUT", url: `/api/exams/${parentId}/marks`, headers: authHeader(facultyToken()), payload: { marks: [{ assessmentId: parentAssessment, candidateId: c1, marks: 80 }, { assessmentId: parentAssessment, candidateId: c2, marks: 10 }] } });
    expect(await advance(parentId, "MARKS_LOCKED")).toBe(200);
    expect(await advance(parentId, "MODERATION")).toBe(200);
    expect(await advance(parentId, "APPROVED")).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/exams/${parentId}/publish`, headers: { ...authHeader(adminToken()), ...stepUpHeader(adminUser, "exams.results.publish") }, payload: {} })).statusCode).toBe(201);

    // Creating a SUPPLEMENTARY exam WITHOUT a parent is rejected 400.
    const noParent = await app.inject({
      method: "POST",
      url: "/api/exams",
      headers: authHeader(adminToken()),
      payload: { academicSessionId: sessionA, academicTermId: termA, programId: programA, name: "Supp no parent", type: "SUPPLEMENTARY" },
    });
    expect(noParent.statusCode).toBe(400);

    // Creating a NON-supplementary exam WITH a parent link is rejected 400.
    const wrongType = await app.inject({
      method: "POST",
      url: "/api/exams",
      headers: authHeader(adminToken()),
      payload: { academicSessionId: sessionA, academicTermId: termA, programId: programA, name: "Final w/ parent", type: "FINAL", parentExaminationId: parentId },
    });
    expect(wrongType.statusCode).toBe(400);

    // A proper SUPPLEMENTARY exam linked to the parent.
    const suppRes = await app.inject({
      method: "POST",
      url: "/api/exams",
      headers: authHeader(adminToken()),
      payload: { academicSessionId: sessionA, academicTermId: termA, programId: programA, name: "Supplementary", type: "SUPPLEMENTARY", parentExaminationId: parentId },
    });
    expect(suppRes.statusCode).toBe(201);
    const suppId = suppRes.json().id as string;
    expect(suppRes.json().type).toBe("SUPPLEMENTARY");

    // Omitting studentIds registers the FULL eligible (non-passing) set = {failStudent}.
    const regAll = await app.inject({
      method: "POST",
      url: `/api/exams/${suppId}/candidates/supplementary`,
      headers: authHeader(adminToken()),
      payload: { subjectIds: [subjectA] },
    });
    expect(regAll.statusCode).toBe(201);
    expect(regAll.json().eligibleCount).toBe(1);
    expect(regAll.json().registered).toBe(1);
    const suppCands = await adminClient.candidate.findMany({ where: { institutionId: instA, examId: suppId } });
    expect(suppCands.length).toBe(1);
    expect(suppCands[0].studentId).toBe(failStudent);

    // A second SUPPLEMENTARY to test the allowlist contract.
    const supp2Res = await app.inject({
      method: "POST",
      url: "/api/exams",
      headers: authHeader(adminToken()),
      payload: { academicSessionId: sessionA, academicTermId: termA, programId: programA, name: "Supplementary 2", type: "SUPPLEMENTARY", parentExaminationId: parentId },
    });
    const supp2Id = supp2Res.json().id as string;

    // An allowlist naming the PASSING student is rejected atomically (409) — no row.
    const rejectReg = await app.inject({
      method: "POST",
      url: `/api/exams/${supp2Id}/candidates/supplementary`,
      headers: authHeader(adminToken()),
      payload: { subjectIds: [subjectA], studentIds: [studentProfileA] },
    });
    expect(rejectReg.statusCode).toBe(409);
    expect(await adminClient.candidate.count({ where: { institutionId: instA, examId: supp2Id } })).toBe(0);

    // An allowlist naming the failing (eligible) student registers exactly it.
    const okReg = await app.inject({
      method: "POST",
      url: `/api/exams/${supp2Id}/candidates/supplementary`,
      headers: authHeader(adminToken()),
      payload: { subjectIds: [subjectA], studentIds: [failStudent] },
    });
    expect(okReg.statusCode).toBe(201);
    expect(okReg.json().registered).toBe(1);

    // Registering supplementary candidates on a non-SUPPLEMENTARY exam is 409.
    const onRegular = await app.inject({
      method: "POST",
      url: `/api/exams/${parentId}/candidates/supplementary`,
      headers: authHeader(adminToken()),
      payload: { subjectIds: [subjectA] },
    });
    expect(onRegular.statusCode).toBe(409);
  }, 300_000);

  it("8.2 AC-14: staff history .xlsx streams a valid workbook + writes exams.results.exported", async () => {
    await publishV1();
    const res = await app.inject({
      method: "GET",
      url: `/api/exams/students/${studentProfileA}/results/history.xlsx`,
      headers: authHeader(adminToken()),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    // XLSX is a ZIP — the magic bytes are 'PK'.
    expect(res.rawPayload.slice(0, 2).toString("latin1")).toBe("PK");
    const exported = await adminClient.auditEvent.count({ where: { institutionId: instA, action: "exams.results.exported", result: "SUCCESS" } });
    expect(exported).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it("8.2 AC-8: a student cannot request re-eval against an unpublished exam (404, no leak)", async () => {
    const examId = await createExam();
    const res = await app.inject({
      method: "POST",
      url: "/api/exams/me/reeval",
      headers: authHeader(studentToken()),
      payload: { examId, subjectId: subjectA, reason: "nothing published" },
    });
    expect(res.statusCode).toBe(404);
  }, 120_000);
});
