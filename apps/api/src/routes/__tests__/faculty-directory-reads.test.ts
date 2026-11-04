/**
 * Faculty Management directory reads (G1 GET /api/faculty, G2 GET /lookups and the
 * additive name projections on profile / workload / teaching-history reads).
 * @campusgate/db is MOCKED (fast, deterministic): this pins the ROUTE-LAYER
 * contract — permission gating per role, the requireModuleActive gate, query
 * validation, tenant scoping (institutionId from the token), and the projections.
 * Real-DB isolation is proven by the faculty-behavioral live suite.
 */
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tenantCalls: string[] = [];

vi.mock("@campusgate/db", () => {
  const prisma = {
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    institutionMembership: { findUnique: vi.fn() },
    institutionModule: { findUnique: vi.fn() },
    session: { findFirst: vi.fn(), update: vi.fn() },
    facultyProfile: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    facultyQualification: { findMany: vi.fn() },
    facultyWorkload: { findMany: vi.fn() },
    facultyTeachingHistory: { findMany: vi.fn() },
    facultyWorkloadPolicy: { findFirst: vi.fn() },
    academicTerm: { findMany: vi.fn() },
    subject: { findMany: vi.fn() },
    classSection: { findMany: vi.fn() },
    department: { findMany: vi.fn() },
    auditEvent: { create: vi.fn() },
  };
  return {
    prisma,
    privilegedPrisma: prisma,
    withTenant: (institutionId: string, fn: (tx: typeof prisma) => unknown) => {
      tenantCalls.push(institutionId);
      return fn(prisma);
    },
    Prisma: {},
  };
});

import { prisma } from "@campusgate/db";
import { ROLE_PERMISSIONS } from "@campusgate/shared";
import { facultyRoutes } from "../faculty.js";

const m = prisma as unknown as Record<string, any>;

type RoleKey = "ADMIN" | "HOD" | "FACULTY" | "STUDENT" | "HR_MANAGER";

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

const USERS: Record<string, { role: RoleKey; legacy: string; inst: string }> = {
  "u-hod": { role: "HOD", legacy: "HOD", inst: "inst-A" },
  "u-hod-b": { role: "HOD", legacy: "HOD", inst: "inst-B" },
  "u-admin": { role: "ADMIN", legacy: "ADMIN", inst: "inst-A" },
  "u-faculty": { role: "FACULTY", legacy: "GUARD", inst: "inst-A" },
  "u-student": { role: "STUDENT", legacy: "STUDENT", inst: "inst-A" },
  "u-hr": { role: "HR_MANAGER", legacy: "GUARD", inst: "inst-A" },
};

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "faculty-directory-reads-secret" });
  await app.register(facultyRoutes, { prefix: "/api/faculty" });
  return app;
}

function get(app: Awaited<ReturnType<typeof makeApp>>, userId: string, url: string) {
  const u = USERS[userId];
  const token = app.jwt.sign({ userId, role: u.legacy, institutionId: u.inst });
  return app.inject({ method: "GET", url: `/api/faculty${url}`, headers: { authorization: `Bearer ${token}` } });
}

const NOW = new Date("2026-01-15T00:00:00.000Z");

describe("faculty directory reads (G1/G2 + projections)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantCalls.length = 0;
    m.user.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      const u = USERS[where.id];
      if (!u) return null;
      return {
        id: where.id,
        role: u.legacy,
        institutionId: u.inst,
        accountStatus: "ACTIVE",
        institution: { status: "ACTIVE" },
      };
    });
    m.institutionMembership.findUnique.mockImplementation(({ where }: any) => {
      const userId: string | undefined = where?.userId_institutionId?.userId;
      return membershipFor(USERS[userId ?? "u-hod"]?.role ?? "HOD");
    });
    m.institutionModule.findUnique.mockResolvedValue({ state: "ACTIVE" });
    m.auditEvent.create.mockResolvedValue({});
    m.facultyProfile.findMany.mockResolvedValue([]);
    m.facultyProfile.count.mockResolvedValue(0);
    m.facultyQualification.findMany.mockResolvedValue([]);
    m.facultyWorkload.findMany.mockResolvedValue([]);
    m.facultyTeachingHistory.findMany.mockResolvedValue([]);
    m.facultyWorkloadPolicy.findFirst.mockResolvedValue({ maxWeeklyHours: 20 });
    m.academicTerm.findMany.mockResolvedValue([]);
    m.subject.findMany.mockResolvedValue([]);
    m.classSection.findMany.mockResolvedValue([]);
    m.department.findMany.mockResolvedValue([]);
  });

  it("ADMIN and HOD hold faculty.directory.view; FACULTY/STUDENT/HR_MANAGER do not", () => {
    expect(ROLE_PERMISSIONS.ADMIN).toContain("faculty.directory.view");
    expect(ROLE_PERMISSIONS.HOD).toContain("faculty.directory.view");
    expect(ROLE_PERMISSIONS.FACULTY).not.toContain("faculty.directory.view");
    expect(ROLE_PERMISSIONS.STUDENT).not.toContain("faculty.directory.view");
    expect(ROLE_PERMISSIONS.HR_MANAGER).not.toContain("faculty.directory.view");
    // HOD gets the lookup via a scoped endpoint, not a broad academics grant.
    expect(ROLE_PERMISSIONS.HOD).not.toContain("academics.sessions.manage");
    expect(ROLE_PERMISSIONS.HOD).not.toContain("admin.departments.manage");
  });

  describe("GET /api/faculty", () => {
    it("lists identity rows with department names, paging and a total", async () => {
      m.facultyProfile.count.mockResolvedValue(41);
      m.facultyProfile.findMany.mockResolvedValue([
        {
          id: "f1",
          userId: "u1",
          name: "Dr Rao",
          departmentId: "d1",
          status: "ACTIVE",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "f2",
          userId: "u2",
          name: "Ms Iyer",
          departmentId: null,
          status: "INACTIVE",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]);
      m.department.findMany.mockResolvedValue([{ id: "d1", name: "Computer Science" }]);
      const app = await makeApp();
      const res = await get(app, "u-hod", "?page=2&pageSize=2");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(41);
      expect(body.page).toBe(2);
      expect(body.pageSize).toBe(2);
      expect(body.faculty[0].department).toEqual({ id: "d1", name: "Computer Science" });
      expect(body.faculty[1].department).toBeNull();
      const arg = m.facultyProfile.findMany.mock.calls[0][0];
      expect(arg.skip).toBe(2);
      expect(arg.take).toBe(2);
      // identity projection only: no profile payload (qualifications etc.) on the list.
      expect(Object.keys(body.faculty[0]).sort()).toEqual(
        ["createdAt", "department", "departmentId", "id", "name", "status", "updatedAt", "userId"].sort(),
      );
      await app.close();
    });

    it("scopes every query to the token's institution and applies q/status/department filters", async () => {
      const app = await makeApp();
      await get(app, "u-hod-b", "?q=rao&status=ACTIVE&departmentId=d9");
      expect(tenantCalls).toContain("inst-B");
      expect(tenantCalls).not.toContain("inst-A");
      const where = m.facultyProfile.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        institutionId: "inst-B",
        status: "ACTIVE",
        departmentId: "d9",
        name: { contains: "rao", mode: "insensitive" },
      });
      expect(m.facultyProfile.count.mock.calls[0][0].where.institutionId).toBe("inst-B");
      await app.close();
    });

    it("400s on an invalid status or pageSize", async () => {
      const app = await makeApp();
      expect((await get(app, "u-hod", "?status=BOGUS")).statusCode).toBe(400);
      expect((await get(app, "u-hod", "?pageSize=101")).statusCode).toBe(400);
      expect(m.facultyProfile.findMany).not.toHaveBeenCalled();
      await app.close();
    });

    it("ADMIN allowed; FACULTY, STUDENT and HR_MANAGER are 403", async () => {
      const app = await makeApp();
      expect((await get(app, "u-admin", "")).statusCode).toBe(200);
      expect((await get(app, "u-faculty", "")).statusCode).toBe(403);
      expect((await get(app, "u-student", "")).statusCode).toBe(403);
      expect((await get(app, "u-hr", "")).statusCode).toBe(403);
      await app.close();
    });

    it("403s when faculty_management is not active", async () => {
      m.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });
      const app = await makeApp();
      const res = await get(app, "u-hod", "");
      expect(res.statusCode).toBe(403);
      expect(String(res.json().error)).toMatch(/Module not active/);
      expect(m.facultyProfile.findMany).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe("GET /api/faculty/lookups", () => {
    it("returns tenant-scoped terms (with session) and departments", async () => {
      m.academicTerm.findMany.mockResolvedValue([
        {
          id: "t1",
          name: "Semester 1",
          status: "ACTIVE",
          startDate: NOW,
          endDate: NOW,
          academicSession: { id: "s1", name: "2026-27" },
        },
      ]);
      m.department.findMany.mockResolvedValue([{ id: "d1", name: "CS", code: "CS" }]);
      const app = await makeApp();
      const res = await get(app, "u-hod-b", "/lookups");
      expect(res.statusCode).toBe(200);
      expect(res.json().terms[0]).toMatchObject({ id: "t1", name: "Semester 1", session: { id: "s1", name: "2026-27" } });
      expect(res.json().departments).toEqual([{ id: "d1", name: "CS", code: "CS" }]);
      expect(m.academicTerm.findMany.mock.calls[0][0].where.institutionId).toBe("inst-B");
      expect(m.department.findMany.mock.calls[0][0].where.institutionId).toBe("inst-B");
      await app.close();
    });

    it("is staff-only: FACULTY/STUDENT 403; module inactive 403", async () => {
      const app = await makeApp();
      expect((await get(app, "u-faculty", "/lookups")).statusCode).toBe(403);
      expect((await get(app, "u-student", "/lookups")).statusCode).toBe(403);
      m.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });
      expect((await get(app, "u-hod", "/lookups")).statusCode).toBe(403);
      expect(m.academicTerm.findMany).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe("name projections on existing reads", () => {
    const history = {
      id: "h1",
      facultyId: "f1",
      subjectId: "sub1",
      classSectionId: "sec1",
      academicTermId: "t1",
      sourceAssignmentId: "a1",
      role: "PRIMARY",
      changeType: "ASSIGNED",
      effectiveAt: NOW,
      recordedByUserId: "u",
      createdAt: NOW,
    };

    it("teaching-history rows carry subject / classSection / academicTerm names (ids unchanged)", async () => {
      m.facultyProfile.findFirst.mockResolvedValue({ id: "f1" });
      m.facultyTeachingHistory.findMany.mockResolvedValue([history, { ...history, id: "h2", classSectionId: null }]);
      m.academicTerm.findMany.mockResolvedValue([{ id: "t1", name: "Semester 1" }]);
      m.subject.findMany.mockResolvedValue([{ id: "sub1", name: "Algorithms", code: "CS201" }]);
      m.classSection.findMany.mockResolvedValue([{ id: "sec1", label: "A" }]);
      const app = await makeApp();
      const res = await get(app, "u-hod", "/f1/teaching-history");
      expect(res.statusCode).toBe(200);
      const rows = res.json().teachingHistory;
      expect(rows[0]).toMatchObject({
        id: "h1",
        subjectId: "sub1",
        subject: { id: "sub1", name: "Algorithms", code: "CS201" },
        classSection: { id: "sec1", label: "A" },
        academicTerm: { id: "t1", name: "Semester 1" },
      });
      expect(rows[1].classSection).toBeNull();
      // every name lookup is tenant-scoped
      expect(m.subject.findMany.mock.calls[0][0].where.institutionId).toBe("inst-A");
      expect(m.classSection.findMany.mock.calls[0][0].where.institutionId).toBe("inst-A");
      expect(m.academicTerm.findMany.mock.calls[0][0].where.institutionId).toBe("inst-A");
      await app.close();
    });

    it("workload rows carry the term name", async () => {
      m.facultyProfile.findFirst.mockResolvedValue({ id: "f1" });
      m.facultyWorkload.findMany.mockResolvedValue([
        {
          id: "w1",
          facultyId: "f1",
          academicTermId: "t1",
          teachingHours: 10,
          nonTeachingHours: 2,
          totalHours: 12,
          overAllocated: false,
          overrideReason: null,
          lastReconciledAt: null,
          updatedByUserId: "u",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]);
      m.academicTerm.findMany.mockResolvedValue([{ id: "t1", name: "Semester 1" }]);
      const app = await makeApp();
      const res = await get(app, "u-admin", "/f1/workload");
      expect(res.statusCode).toBe(200);
      expect(res.json().workloads[0]).toMatchObject({
        academicTermId: "t1",
        academicTerm: { id: "t1", name: "Semester 1" },
        policyMaxWeeklyHours: 20,
      });
      await app.close();
    });

    it("consolidated profile carries department + term/subject names", async () => {
      m.facultyProfile.findFirst.mockResolvedValue({
        id: "f1",
        userId: "u1",
        name: "Dr Rao",
        departmentId: "d1",
        status: "ACTIVE",
        createdAt: NOW,
        updatedAt: NOW,
      });
      m.facultyTeachingHistory.findMany.mockResolvedValue([history]);
      m.academicTerm.findMany.mockResolvedValue([{ id: "t1", name: "Semester 1" }]);
      m.subject.findMany.mockResolvedValue([{ id: "sub1", name: "Algorithms", code: "CS201" }]);
      m.classSection.findMany.mockResolvedValue([{ id: "sec1", label: "A" }]);
      m.department.findMany.mockResolvedValue([{ id: "d1", name: "Computer Science" }]);
      const app = await makeApp();
      const res = await get(app, "u-hod", "/f1/profile");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.identity.department).toEqual({ id: "d1", name: "Computer Science" });
      expect(body.teachingHistory[0].subject.name).toBe("Algorithms");
      expect(body.teachingHistory[0].academicTerm.name).toBe("Semester 1");
      await app.close();
    });
  });
});
