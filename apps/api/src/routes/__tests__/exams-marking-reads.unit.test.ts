/**
 * FAST mocked unit spec for the faculty marking read endpoints
 * (GET /my-marking, GET /:id/marks-sheet). No DB: withTenant hands the handler a
 * fake tx; auth + authz guards are replaced with header-driven stand-ins that keep
 * the same 403 semantics (permission key / module state).
 */
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockFn = ReturnType<typeof vi.fn>;
const tx = {
  examination: { findFirst: vi.fn(), findMany: vi.fn() },
  facultyProfile: { findFirst: vi.fn() },
  facultyAssignment: { findMany: vi.fn() },
  assessment: { findMany: vi.fn() },
  candidate: { findMany: vi.fn() },
  classEnrollment: { findMany: vi.fn() },
  marksRecord: { findMany: vi.fn() },
};

vi.mock("@campusgate/db", () => ({
  prisma: {},
  privilegedPrisma: {},
  withTenant: (_i: string, fn: (t: typeof tx) => unknown) => fn(tx),
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));
vi.mock("../../middleware/auth.js", () => ({
  authenticate: async (request: any) => {
    request.user = { userId: "u1", institutionId: "inst1", role: "X" };
    request.auth = { perms: String(request.headers["x-perms"] ?? "").split(",").filter(Boolean) };
  },
}));
vi.mock("../../services/authz-engine.js", () => ({
  requirePermission: (key: string) => async (request: any, reply: any) => {
    if (!request.auth.perms.includes(key)) return reply.status(403).send({ error: "forbidden" });
  },
  requireModuleActive: () => async (request: any, reply: any) => {
    if (request.headers["x-module"] === "off") return reply.status(403).send({ error: "Module not active" });
  },
}));
vi.mock("../../middleware/step-up.js", () => ({ requireStepUp: () => async () => {} }));
vi.mock("../../services/audit.js", () => ({ recordAuditEvent: vi.fn() }));

import { examsRoutes } from "../exams.js";

const FACULTY = { "x-perms": "exams.marks.enter" };
const ADMIN = { "x-perms": "exams.results.view,exams.manage" };
const STUDENT = { "x-perms": "exams.results.view_own" };

async function makeApp() {
  const app = Fastify();
  await app.register(examsRoutes, { prefix: "/api/exams" });
  await app.ready();
  return app;
}

const exam = { id: "e1", name: "Mid", type: "FINAL", status: "MARKS_OPEN", academicTermId: "t1" };

beforeEach(() => {
  for (const group of Object.values(tx)) for (const fn of Object.values(group) as MockFn[]) fn.mockReset();
  tx.facultyProfile.findFirst.mockResolvedValue({ id: "f1" });
  tx.examination.findFirst.mockResolvedValue(exam);
});

describe.each([
  ["/api/exams/my-marking"],
  ["/api/exams/e1/marks-sheet"],
])("permission + module gates: GET %s", (url) => {
  it("ADMIN/HOD (results.view, no marks.enter) -> 403", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url, headers: ADMIN })).statusCode).toBe(403);
  });
  it("STUDENT -> 403", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url, headers: STUDENT })).statusCode).toBe(403);
  });
  it("module inactive -> 403", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url, headers: { ...FACULTY, "x-module": "off" } })).statusCode).toBe(403);
  });
  it("marks.enter holder without an ACTIVE faculty profile -> 403 not a faculty member", async () => {
    tx.facultyProfile.findFirst.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url, headers: FACULTY });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not a faculty member");
  });
});

describe("GET /my-marking", () => {
  it("no assignments -> 200 { exams: [] } and no exam query", async () => {
    tx.facultyAssignment.findMany.mockResolvedValue([]);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/exams/my-marking", headers: FACULTY });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exams: [] });
    expect(tx.examination.findMany).not.toHaveBeenCalled();
  });

  it("filters by assigned term/subjects, status set, newest first, cap 100", async () => {
    tx.facultyAssignment.findMany.mockResolvedValue([
      { subjectId: "s1", academicTermId: "t1" },
      { subjectId: "s2", academicTermId: "t1" },
      { subjectId: "s3", academicTermId: "t2" },
    ]);
    tx.examination.findMany.mockResolvedValue([exam]);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/exams/my-marking", headers: FACULTY });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exams: [exam] });
    const arg = tx.examination.findMany.mock.calls[0]![0];
    expect(arg.where.status.in).toEqual(["MARKS_OPEN", "MARKS_LOCKED", "MODERATION"]);
    expect(arg.where.OR).toHaveLength(2);
    expect(arg.where.OR[0].assessments.some.subjectId.in).toEqual(["s1", "s2"]);
    expect(arg.orderBy).toEqual([{ createdAt: "desc" }]);
    expect(arg.take).toBe(100);
  });
});

describe("GET /:id/marks-sheet", () => {
  it("unknown exam -> 404", async () => {
    tx.examination.findFirst.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/exams/e1/marks-sheet", headers: FACULTY });
    expect(res.statusCode).toBe(404);
  });

  it("no assignment -> 200 with empty assessments and rows", async () => {
    tx.facultyAssignment.findMany.mockResolvedValue([]);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/exams/e1/marks-sheet", headers: FACULTY });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exam, editable: true, assessments: [], rows: [] });
  });

  it("returns only in-scope cells; out-of-scope pairs/candidates/assessments are absent", async () => {
    // s1: restricted to sec1. s2: subject-wide. s3 not assigned (not queried).
    tx.facultyAssignment.findMany.mockResolvedValue([
      { subjectId: "s1", classSectionId: "sec1" },
      { subjectId: "s2", classSectionId: null },
    ]);
    tx.assessment.findMany.mockResolvedValue([
      { id: "a1", name: "Theory", subjectId: "s1", maxMarks: 100, weight: 70 },
      { id: "a2", name: "Viva", subjectId: "s2", maxMarks: 50, weight: 30 },
    ]);
    tx.candidate.findMany.mockResolvedValue([
      { id: "c1", studentId: "st1", student: { enrollmentNo: "E1", name: "One" } }, // sec1
      { id: "c2", studentId: "st2", student: { enrollmentNo: "E2", name: "Two" } }, // sec2
      { id: "c3", studentId: "st3", student: { enrollmentNo: "E3", name: "Three" } }, // no section
    ]);
    tx.classEnrollment.findMany.mockResolvedValue([
      { studentId: "st1", classSectionId: "sec1" },
      { studentId: "st2", classSectionId: "sec2" },
    ]);
    tx.marksRecord.findMany.mockResolvedValue([
      { id: "m1", assessmentId: "a1", candidateId: "c1", marks: 77 },
      { id: "m9", assessmentId: "a1", candidateId: "c2", marks: 11 }, // out of scope: must not leak
    ]);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/exams/e1/marks-sheet", headers: FACULTY });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.assessments.map((a: { id: string }) => a.id)).toEqual(["a1", "a2"]);
    const cellMap = Object.fromEntries(
      body.rows.map((r: any) => [r.candidateId, r.cells.map((c: any) => c.assessmentId)]),
    );
    expect(cellMap).toEqual({ c1: ["a1", "a2"], c2: ["a2"], c3: ["a2"] });
    const c1 = body.rows.find((r: any) => r.candidateId === "c1");
    expect(c1.cells[0]).toEqual({ assessmentId: "a1", marksRecordId: "m1", marks: 77 });
    expect(c1.cells[1]).toEqual({ assessmentId: "a2", marksRecordId: null, marks: null });
    expect(JSON.stringify(body)).not.toContain("m9");
  });

  it("drops assessments with no in-scope candidate and sets editable=false when locked", async () => {
    tx.examination.findFirst.mockResolvedValue({ ...exam, status: "MARKS_LOCKED" });
    tx.facultyAssignment.findMany.mockResolvedValue([{ subjectId: "s1", classSectionId: "secX" }]);
    tx.assessment.findMany.mockResolvedValue([
      { id: "a1", name: "Theory", subjectId: "s1", maxMarks: 100, weight: 100 },
    ]);
    tx.candidate.findMany.mockResolvedValue([
      { id: "c1", studentId: "st1", student: { enrollmentNo: "E1", name: "One" } },
    ]);
    tx.classEnrollment.findMany.mockResolvedValue([{ studentId: "st1", classSectionId: "sec1" }]);
    tx.marksRecord.findMany.mockResolvedValue([]);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/exams/e1/marks-sheet", headers: FACULTY });
    expect(res.statusCode).toBe(200);
    expect(res.json().editable).toBe(false);
    expect(res.json().assessments).toEqual([]);
    expect(res.json().rows).toEqual([]);
  });
});
