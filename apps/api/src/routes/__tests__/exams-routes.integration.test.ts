/**
 * Phase-8 examinations ROUTE / permission / module / audit WIRING suite
 * (design §19), mirroring classes-routes.integration.test.ts: @campusgate/db is
 * MOCKED (deterministic, no live pooler) so the test pins the ROUTE-LAYER
 * contract — permission gating per role, the module gate, publish step-up
 * gating (fast portion), Zod 400s, the marks-range 400, the weight-sum 400, the
 * status-advance 409, and the publish 409 (not approved / no active scheme). The
 * real-DB guarantees (RLS, append-only history/publication, the capacity-aware
 * allocation concurrency, the grading math persisted) are proven by the
 * exams-behavioral real-DB suite; this suite proves the WIRING.
 *
 * This suite is NOT in vitest.live-db-suites.ts, so it runs in the fast
 * `npm test` pass.
 */
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => {
  const prisma = {
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    institutionMembership: { findUnique: vi.fn() },
    institutionModule: { findUnique: vi.fn() },
    session: { findFirst: vi.fn(), update: vi.fn() },
    examination: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    gradingScheme: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    gradeBand: { findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    examSchedule: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    candidate: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    assessment: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    marksRecord: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    marksRecordHistory: { create: vi.fn() },
    resultPublication: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    resultSnapshot: { findMany: vi.fn(), create: vi.fn() },
    academicSession: { findFirst: vi.fn() },
    academicTerm: { findFirst: vi.fn() },
    program: { findFirst: vi.fn() },
    subject: { findFirst: vi.fn() },
    studentProfile: { findFirst: vi.fn(), findMany: vi.fn() },
    classEnrollment: { findMany: vi.fn() },
    facultyProfile: { findFirst: vi.fn() },
    facultyAssignment: { findFirst: vi.fn() },
    auditEvent: { create: vi.fn() },
    $executeRaw: vi.fn(),
  };
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    prisma,
    privilegedPrisma: prisma,
    withTenant: (_institutionId: string, fn: (tx: typeof prisma) => unknown) => fn(prisma),
    Prisma: { PrismaClientKnownRequestError },
  };
});

import { prisma } from "@campusgate/db";
import { PERMISSIONS, ROLE_PERMISSIONS } from "@campusgate/shared";
import { mintStepUpToken } from "../../services/mfa.js";
import { examsRoutes } from "../exams.js";

type MockFn = ReturnType<typeof vi.fn>;
const m = prisma as unknown as Record<string, Record<string, MockFn>>;

type RoleKey = "ADMIN" | "HOD" | "FACULTY" | "STUDENT";

function membershipFor(roleKey: RoleKey) {
  return {
    id: `mbr-${roleKey}`,
    membershipStatus: "ACTIVE",
    permissionsVersion: 0,
    departmentScope: null,
    roles: [
      {
        role: {
          key: roleKey,
          permissions: (ROLE_PERMISSIONS[roleKey] ?? []).map((k) => ({ permission: { key: k } })),
        },
      },
    ],
  };
}

const USERS: Record<string, RoleKey> = {
  "u-admin": "ADMIN",
  "u-hod": "HOD",
  "u-faculty": "FACULTY",
  "u-student": "STUDENT",
};

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "exams-route-test-secret" });
  await app.register(examsRoutes, { prefix: "/api/exams" });
  return app;
}

const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

function token(app: Awaited<ReturnType<typeof makeApp>>, userId: string, role: RoleKey) {
  const legacyRole = role === "FACULTY" ? "GUARD" : role;
  return app.jwt.sign({ userId, role: legacyRole, institutionId: "inst-A" });
}

function stepUpHeader(app: Awaited<ReturnType<typeof makeApp>>, userId: string, action: string) {
  const signer = { sign: (p: unknown, o: unknown) => app.jwt.sign(p as never, o as never) };
  return { "x-step-up": mintStepUpToken(signer, userId, action) };
}

describe("Phase-8 exams routes (permission + module + step-up + validation wiring)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.user.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      const role = USERS[where.id];
      if (!role) return null;
      const legacyRole = role === "FACULTY" ? "GUARD" : role;
      return {
        id: where.id,
        role: legacyRole,
        institutionId: "inst-A",
        accountStatus: "ACTIVE",
        institution: { status: "ACTIVE" },
      };
    });
    // authenticate re-resolves membership by userId; map each user to its role.
    m.institutionMembership.findUnique.mockImplementation(({ where }: { where: { userId_institutionId?: { userId: string } } }) => {
      const userId = where.userId_institutionId?.userId ?? "u-admin";
      return membershipFor(USERS[userId] ?? "ADMIN");
    });
    // Module gate: examinations ACTIVE by default.
    m.institutionModule.findUnique.mockResolvedValue({ state: "ACTIVE" });
    m.auditEvent.create.mockResolvedValue({});
  });

  it("the 8 exams.* permissions are catalogued with the exact MUST-FIX role bindings", () => {
    const keys = new Set(PERMISSIONS.map((p) => p.key));
    const all = [
      "exams.manage",
      "exams.grading.manage",
      "exams.candidates.manage",
      "exams.marks.enter",
      "exams.moderate",
      "exams.results.publish",
      "exams.results.view",
      "exams.results.view_own",
    ];
    for (const k of all) expect(keys.has(k), `missing permission ${k}`).toBe(true);

    const adminSix = [
      "exams.manage",
      "exams.grading.manage",
      "exams.candidates.manage",
      "exams.moderate",
      "exams.results.publish",
      "exams.results.view",
    ];
    for (const k of adminSix) {
      expect(ROLE_PERMISSIONS.ADMIN).toContain(k);
      expect(ROLE_PERMISSIONS.HOD).toContain(k);
    }
    // Separation of duties: ADMIN never gets marks entry nor the student read.
    expect(ROLE_PERMISSIONS.ADMIN).not.toContain("exams.marks.enter");
    expect(ROLE_PERMISSIONS.ADMIN).not.toContain("exams.results.view_own");
    expect(ROLE_PERMISSIONS.FACULTY).toEqual(
      expect.arrayContaining(["exams.marks.enter"]),
    );
    expect(ROLE_PERMISSIONS.FACULTY).not.toContain("exams.manage");
    expect(ROLE_PERMISSIONS.STUDENT).toContain("exams.results.view_own");
    expect(ROLE_PERMISSIONS.STUDENT).not.toContain("exams.results.view");
  });

  it("POST /exams is 403 for a STUDENT (lacks exams.manage)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/exams",
      headers: authHeader(token(app, "u-student", "STUDENT")),
      payload: { academicSessionId: "s1", academicTermId: "t1", programId: "p1", name: "Midterm", type: "MIDTERM" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /exams is 403 when the examinations module is not ACTIVE", async () => {
    m.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/exams",
      headers: authHeader(token(app, "u-admin", "ADMIN")),
      payload: { academicSessionId: "s1", academicTermId: "t1", programId: "p1", name: "Midterm", type: "MIDTERM" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("examinations");
  });

  it("POST /exams Zod 400 on a bad body", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/exams",
      headers: authHeader(token(app, "u-admin", "ADMIN")),
      payload: { name: "", type: "NOPE" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /exams 201 for an ADMIN with a valid body (audits exams.examination.created)", async () => {
    m.academicSession.findFirst.mockResolvedValue({ id: "s1" });
    m.academicTerm.findFirst.mockResolvedValue({ id: "t1" });
    m.program.findFirst.mockResolvedValue({ id: "p1" });
    m.examination.create.mockResolvedValue({
      id: "e1",
      academicSessionId: "s1",
      academicTermId: "t1",
      programId: "p1",
      name: "Midterm",
      type: "MIDTERM",
      status: "DRAFT",
      createdByUserId: "u-admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/exams",
      headers: authHeader(token(app, "u-admin", "ADMIN")),
      payload: { academicSessionId: "s1", academicTermId: "t1", programId: "p1", name: "Midterm", type: "MIDTERM" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBe("e1");
    expect(m.auditEvent.create).toHaveBeenCalled();
  });

  it("POST /exams/:id/status 409 on an illegal transition (DRAFT -> MARKS_OPEN)", async () => {
    m.examination.findFirst.mockResolvedValue({ status: "DRAFT" });
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/exams/e1/status",
      headers: authHeader(token(app, "u-admin", "ADMIN")),
      payload: { to: "MARKS_OPEN" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("illegal");
  });

  it("POST /exams/:id/status 403 when a manage-only actor targets a moderate step (APPROVED)", async () => {
    // FACULTY holds neither exams.manage nor exams.moderate -> 403 before any DB.
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/exams/e1/status",
      headers: authHeader(token(app, "u-faculty", "FACULTY")),
      payload: { to: "APPROVED" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /exams/:id/assessments 400 when the weight sum would exceed 100", async () => {
    m.examination.findFirst.mockResolvedValue({ id: "e1" });
    m.subject.findFirst.mockResolvedValue({ id: "sub1" });
    m.assessment.findMany.mockResolvedValue([{ weight: 70 }]);
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/exams/e1/assessments",
      headers: authHeader(token(app, "u-admin", "ADMIN")),
      payload: { subjectId: "sub1", name: "External", maxMarks: 100, weight: 50 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("sum to 100");
  });

  it("PUT /exams/:id/marks 400 on a marks value out of range", async () => {
    m.examination.findFirst.mockResolvedValue({ id: "e1", status: "MARKS_OPEN", academicTermId: "t1" });
    m.facultyProfile.findFirst.mockResolvedValue({ id: "fac1" });
    m.assessment.findFirst.mockResolvedValue({ id: "a1", subjectId: "sub1", maxMarks: 100 });
    m.candidate.findFirst.mockResolvedValue({ id: "c1", studentId: "stu1" });
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/exams/e1/marks",
      headers: authHeader(token(app, "u-faculty", "FACULTY")),
      payload: { marks: [{ assessmentId: "a1", candidateId: "c1", marks: 150 }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("out of range");
  });

  it("PUT /exams/:id/marks 409 when the exam is not MARKS_OPEN", async () => {
    m.examination.findFirst.mockResolvedValue({ id: "e1", status: "MARKS_LOCKED", academicTermId: "t1" });
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/exams/e1/marks",
      headers: authHeader(token(app, "u-faculty", "FACULTY")),
      payload: { marks: [{ assessmentId: "a1", candidateId: "c1", marks: 50 }] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("marks locked");
  });

  it("PUT /exams/:id/marks 403 + DENIED audit when the caller is not an ACTIVE faculty", async () => {
    m.examination.findFirst.mockResolvedValue({ id: "e1", status: "MARKS_OPEN", academicTermId: "t1" });
    m.facultyProfile.findFirst.mockResolvedValue(null); // resolveMarkingFaculty -> null
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/exams/e1/marks",
      headers: authHeader(token(app, "u-faculty", "FACULTY")),
      payload: { marks: [{ assessmentId: "a1", candidateId: "c1", marks: 50 }] },
    });
    expect(res.statusCode).toBe(403);
    // recordAuditEvent writes the row via tx.auditEvent.create; assert the
    // DENIED exams.marks.entered row was written (data shape).
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "exams.marks.entered", result: "DENIED" }),
      }),
    );
  });

  it("POST /exams/:id/publish 401 without a step-up token", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/exams/e1/publish",
      headers: authHeader(token(app, "u-admin", "ADMIN")),
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Step-up required");
  });

  it("POST /exams/:id/publish 403 for a STUDENT even with a step-up token (lacks publish perm)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/exams/e1/publish",
      headers: {
        ...authHeader(token(app, "u-student", "STUDENT")),
        ...stepUpHeader(app, "u-student", "exams.results.publish"),
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /exams/:id/publish 409 when the exam is not APPROVED", async () => {
    m.examination.findFirst.mockResolvedValue({ id: "e1", status: "MARKS_OPEN" });
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/exams/e1/publish",
      headers: {
        ...authHeader(token(app, "u-admin", "ADMIN")),
        ...stepUpHeader(app, "u-admin", "exams.results.publish"),
      },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("not approved");
  });

  it("POST /exams/:id/publish 409 when there is no active grading scheme", async () => {
    m.examination.findFirst.mockResolvedValue({ id: "e1", status: "APPROVED" });
    m.gradingScheme.findFirst.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/exams/e1/publish",
      headers: {
        ...authHeader(token(app, "u-admin", "ADMIN")),
        ...stepUpHeader(app, "u-admin", "exams.results.publish"),
      },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("no active grading scheme");
  });

  it("GET /me/results is 403 for an ADMIN (lacks exams.results.view_own)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/exams/me/results",
      headers: authHeader(token(app, "u-admin", "ADMIN")),
    });
    expect(res.statusCode).toBe(403);
  });
});
