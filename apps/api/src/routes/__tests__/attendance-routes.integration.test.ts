/**
 * Phase-4 attendance ROUTE / permission / module-gate / audit integration suite,
 * mirroring classes-routes.integration.test.ts: @campusgate/db is MOCKED
 * (deterministic, no live pooler) so the test pins the ROUTE-LAYER contract —
 * permission gating per role, the requireModuleActive("attendance") gate (403
 * when the module is not ACTIVE, incl. GET /me on historical data), the Zod 400
 * envelope, and the recordAuditEvent call shape. The real-DB guarantees (RLS,
 * append-only history, faculty-scope ownership, the correction transaction) are
 * proven by the attendance-behavioral real-DB suite; this suite proves the WIRING.
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
    facultyProfile: { findFirst: vi.fn() },
    scheduledClass: { findFirst: vi.fn() },
    facultyAssignment: { findFirst: vi.fn() },
    attendanceSession: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    attendanceRecord: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    attendanceRecordHistory: { create: vi.fn() },
    attendanceCorrection: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    classEnrollment: { findMany: vi.fn() },
    studentProfile: { findFirst: vi.fn() },
    classSection: { findFirst: vi.fn() },
    auditEvent: { create: vi.fn() },
  };
  return {
    prisma,
    privilegedPrisma: prisma,
    withTenant: (_institutionId: string, fn: (tx: typeof prisma) => unknown) => fn(prisma),
    Prisma: {},
  };
});

import { prisma } from "@campusgate/db";
import { PERMISSIONS, ROLE_PERMISSIONS } from "@campusgate/shared";
import { attendanceRoutes } from "../attendance.js";

type MockFn = ReturnType<typeof vi.fn>;
const m = prisma as unknown as Record<string, Record<string, MockFn>>;

type RoleKey = "ADMIN" | "HOD" | "FACULTY" | "STUDENT";

function membershipFor(roleKey: RoleKey, departmentScope: string | null = null) {
  return {
    id: `mbr-${roleKey}`,
    membershipStatus: "ACTIVE",
    permissionsVersion: 0,
    departmentScope,
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

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "attendance-route-test-secret" });
  await app.register(attendanceRoutes, { prefix: "/api/attendance" });
  return app;
}

const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

function token(app: Awaited<ReturnType<typeof makeApp>>, userId: string, role: RoleKey) {
  const legacyRole = role === "FACULTY" ? "GUARD" : role;
  return app.jwt.sign({ userId, role: legacyRole, institutionId: "inst-A" });
}

const USERS: Record<string, RoleKey> = {
  "u-admin": "ADMIN",
  "u-hod": "HOD",
  "u-faculty": "FACULTY",
  "u-student": "STUDENT",
};

describe("Phase-4 attendance routes (permission + module-gate + audit wiring)", () => {
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
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("ADMIN"));
    // Default: the attendance module IS active.
    m.institutionModule.findUnique.mockResolvedValue({ state: "ACTIVE" });
    m.auditEvent.create.mockResolvedValue({});
  });

  it("the 5 attendance.* permissions are catalogued with the documented role mapping", () => {
    const keys = new Set(PERMISSIONS.map((p) => p.key));
    for (const k of ["attendance.view", "attendance.mark", "attendance.correct", "attendance.export", "attendance.view_own"]) {
      expect(keys.has(k), `missing permission ${k}`).toBe(true);
    }
    expect(ROLE_PERMISSIONS.STUDENT).toContain("attendance.view_own");
    expect(ROLE_PERMISSIONS.FACULTY).toEqual(
      expect.arrayContaining(["attendance.mark", "attendance.view_own"]),
    );
    expect(ROLE_PERMISSIONS.FACULTY).not.toContain("attendance.correct");
    for (const k of ["attendance.view", "attendance.correct", "attendance.export"]) {
      expect(ROLE_PERMISSIONS.HOD).toContain(k);
      expect(ROLE_PERMISSIONS.ADMIN).toContain(k);
    }
  });

  it("STUDENT (view_own only) is 403 on POST /sessions (lacks attendance.mark)", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("STUDENT"));
    const res = await app.inject({
      method: "POST",
      url: "/api/attendance/sessions",
      headers: authHeader(token(app, "u-student", "STUDENT")),
      payload: { scheduledClassId: "sc-1", date: "2026-11-02" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("FACULTY (no attendance.correct) is 403 on POST /corrections/:id/approve", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("FACULTY"));
    const res = await app.inject({
      method: "POST",
      url: "/api/attendance/corrections/corr-1/approve",
      headers: authHeader(token(app, "u-faculty", "FACULTY")),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("module-inactive: every operational route is 403 when attendance is not ACTIVE (incl. GET /me)", async () => {
    const app = await makeApp();
    m.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });

    // A faculty with attendance.mark still gets 403 because the module gate fails.
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("FACULTY"));
    const markRes = await app.inject({
      method: "POST",
      url: "/api/attendance/sessions",
      headers: authHeader(token(app, "u-faculty", "FACULTY")),
      payload: { scheduledClassId: "sc-1", date: "2026-11-02" },
    });
    expect(markRes.statusCode).toBe(403);

    // A student reading OWN historical data is also 403 (gated-module behavior).
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("STUDENT"));
    const meRes = await app.inject({
      method: "GET",
      url: "/api/attendance/me?academicTermId=term-1",
      headers: authHeader(token(app, "u-student", "STUDENT")),
    });
    expect(meRes.statusCode).toBe(403);

    // An HOD report read is 403 too.
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("HOD", "dept-A"));
    const reportRes = await app.inject({
      method: "GET",
      url: "/api/attendance/reports/section/sec-1?academicTermId=term-1",
      headers: authHeader(token(app, "u-hod", "HOD")),
    });
    expect(reportRes.statusCode).toBe(403);
    await app.close();
  });

  it("FACULTY opens a session: faculty-scope passes (assigned) and audits attendance.session.opened", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("FACULTY"));
    m.facultyProfile.findFirst.mockResolvedValue({ id: "fac-1" });
    m.scheduledClass.findFirst.mockResolvedValue({
      id: "sc-1",
      classSectionId: "sec-1",
      subjectId: "subj-1",
      academicTermId: "term-1",
      facultyId: "fac-1", // fast-path assigned
      status: "SCHEDULED",
      dayOfWeek: "MON",
      date: null,
    });
    m.attendanceSession.findFirst.mockResolvedValue(null); // no dup
    m.attendanceSession.create.mockResolvedValue({ id: "asess-1" });
    m.classEnrollment.findMany.mockResolvedValue([{ studentId: "stu-1" }]);
    m.attendanceRecord.create.mockResolvedValue({ id: "arec-1" });
    m.attendanceRecordHistory.create.mockResolvedValue({ id: "ahist-1" });

    const res = await app.inject({
      method: "POST",
      url: "/api/attendance/sessions",
      headers: authHeader(token(app, "u-faculty", "FACULTY")),
      payload: { scheduledClassId: "sc-1", date: "2026-11-02" }, // 2026-11-02 is a Monday
    });
    expect(res.statusCode).toBe(201);
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "attendance.session.opened", result: "SUCCESS" }),
      }),
    );
    await app.close();
  });

  it("FACULTY opens a session for an UNASSIGNED class: 403 + a DENIED audit is written", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("FACULTY"));
    m.facultyProfile.findFirst.mockResolvedValue({ id: "fac-1" });
    m.scheduledClass.findFirst.mockResolvedValue({
      id: "sc-1",
      classSectionId: "sec-1",
      subjectId: "subj-1",
      academicTermId: "term-1",
      facultyId: "fac-other", // not this faculty
      status: "SCHEDULED",
      dayOfWeek: "MON",
      date: null,
    });
    m.facultyAssignment.findFirst.mockResolvedValue(null); // no ACTIVE assignment

    const res = await app.inject({
      method: "POST",
      url: "/api/attendance/sessions",
      headers: authHeader(token(app, "u-faculty", "FACULTY")),
      payload: { scheduledClassId: "sc-1", date: "2026-11-02" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "not assigned to this class" });
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "attendance.session.opened", result: "DENIED" }),
      }),
    );
    await app.close();
  });

  it("open session with a date that does not match the slot recurrence: 409", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("FACULTY"));
    m.facultyProfile.findFirst.mockResolvedValue({ id: "fac-1" });
    m.scheduledClass.findFirst.mockResolvedValue({
      id: "sc-1",
      classSectionId: "sec-1",
      subjectId: "subj-1",
      academicTermId: "term-1",
      facultyId: "fac-1",
      status: "SCHEDULED",
      dayOfWeek: "MON",
      date: null,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/attendance/sessions",
      headers: authHeader(token(app, "u-faculty", "FACULTY")),
      payload: { scheduledClassId: "sc-1", date: "2026-11-03" }, // a Tuesday
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "date does not match scheduled class" });
    await app.close();
  });

  it("open session against a CANCELLED scheduled class: 409", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("FACULTY"));
    m.facultyProfile.findFirst.mockResolvedValue({ id: "fac-1" });
    m.scheduledClass.findFirst.mockResolvedValue({
      id: "sc-1",
      classSectionId: "sec-1",
      subjectId: "subj-1",
      academicTermId: "term-1",
      facultyId: "fac-1",
      status: "CANCELLED",
      dayOfWeek: "MON",
      date: null,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/attendance/sessions",
      headers: authHeader(token(app, "u-faculty", "FACULTY")),
      payload: { scheduledClassId: "sc-1", date: "2026-11-02" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "scheduled class cancelled" });
    await app.close();
  });

  it("request correction with requestedStatus == current status: 400 no change requested", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("FACULTY"));
    m.facultyProfile.findFirst.mockResolvedValue({ id: "fac-1" });
    m.attendanceRecord.findFirst.mockResolvedValue({
      id: "arec-1",
      status: "ABSENT",
      attendanceSession: { id: "asess-1", status: "FINALIZED", markedByFacultyId: "fac-1" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/attendance/corrections",
      headers: authHeader(token(app, "u-faculty", "FACULTY")),
      payload: { attendanceRecordId: "arec-1", requestedStatus: "ABSENT", reason: "fix" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "no change requested" });
    await app.close();
  });

  it("invalid body (missing reason) is 400 with a flattened error", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("FACULTY"));
    const res = await app.inject({
      method: "POST",
      url: "/api/attendance/corrections",
      headers: authHeader(token(app, "u-faculty", "FACULTY")),
      payload: { attendanceRecordId: "arec-1", requestedStatus: "PRESENT" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("HOD approve applies the record + writes CORRECTED history + audits", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("HOD", "dept-A"));
    m.attendanceCorrection.findFirst.mockResolvedValue({
      id: "corr-1",
      reviewStatus: "PENDING",
      priorStatus: "ABSENT",
      requestedStatus: "PRESENT",
      attendanceRecordId: "arec-1",
    });
    m.attendanceRecord.findFirst.mockResolvedValue({
      id: "arec-1",
      status: "ABSENT",
      attendanceSession: { status: "FINALIZED" },
    });
    m.attendanceRecordHistory.create.mockResolvedValue({ id: "ahist-2" });
    m.attendanceRecord.update.mockResolvedValue({ id: "arec-1", status: "PRESENT" });
    m.attendanceCorrection.update.mockResolvedValue({ id: "corr-1", reviewStatus: "APPROVED" });

    const res = await app.inject({
      method: "POST",
      url: "/api/attendance/corrections/corr-1/approve",
      headers: authHeader(token(app, "u-hod", "HOD")),
      payload: { reviewNote: "ok" },
    });
    expect(res.statusCode).toBe(200);
    expect(m.attendanceRecordHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ changeType: "CORRECTED", previousStatus: "ABSENT", newStatus: "PRESENT" }),
      }),
    );
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "attendance.correction.approved", result: "SUCCESS" }),
      }),
    );
    await app.close();
  });

  it("HOD approve when the live record changed since request: 409 record changed since request", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("HOD", "dept-A"));
    m.attendanceCorrection.findFirst.mockResolvedValue({
      id: "corr-1",
      reviewStatus: "PENDING",
      priorStatus: "ABSENT",
      requestedStatus: "PRESENT",
      attendanceRecordId: "arec-1",
    });
    m.attendanceRecord.findFirst.mockResolvedValue({
      id: "arec-1",
      status: "LATE", // drifted from the snapshotted priorStatus (ABSENT)
      attendanceSession: { status: "FINALIZED" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/attendance/corrections/corr-1/approve",
      headers: authHeader(token(app, "u-hod", "HOD")),
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "record changed since request" });
    await app.close();
  });
});
