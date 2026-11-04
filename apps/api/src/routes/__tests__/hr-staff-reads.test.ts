/**
 * HR staff reads/lookups (G-H1 employees list/detail projections, G-H2 users/lookup,
 * G-H3 /lookups, G-H4 GET /leave queue, G-H5 attendance roster). @campusgate/db is
 * MOCKED (fast, deterministic): this pins the ROUTE-LAYER contract — permission
 * gating per role, the requireModuleActive("hr_management") gate, query validation,
 * tenant scoping (institutionId from the token) and the minimal projections.
 * Real-DB isolation is proven by the hr-behavioral live suite.
 */
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tenantCalls: string[] = [];

vi.mock("@campusgate/db", () => {
  const prisma = {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    institutionMembership: { findUnique: vi.fn() },
    institutionModule: { findUnique: vi.fn() },
    session: { findFirst: vi.fn(), update: vi.fn() },
    hrEmployee: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    hrLeaveApplication: { findMany: vi.fn(), count: vi.fn() },
    hrEmployeeAttendance: { findMany: vi.fn() },
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
import { hrRoutes } from "../hr.js";

const m = prisma as unknown as Record<string, any>;

type RoleKey = "ADMIN" | "HR_MANAGER" | "EMPLOYEE" | "FACULTY" | "STUDENT" | "HOD";

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
  "u-hr": { role: "HR_MANAGER", legacy: "GUARD", inst: "inst-A" },
  "u-hr-b": { role: "HR_MANAGER", legacy: "GUARD", inst: "inst-B" },
  "u-admin": { role: "ADMIN", legacy: "ADMIN", inst: "inst-A" },
  "u-emp": { role: "EMPLOYEE", legacy: "GUARD", inst: "inst-A" },
  "u-faculty": { role: "FACULTY", legacy: "GUARD", inst: "inst-A" },
  "u-student": { role: "STUDENT", legacy: "STUDENT", inst: "inst-A" },
  "u-hod": { role: "HOD", legacy: "HOD", inst: "inst-A" },
};

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "hr-staff-reads-secret" });
  await app.register(hrRoutes, { prefix: "/api/hr" });
  return app;
}

function get(app: Awaited<ReturnType<typeof makeApp>>, userId: string, url: string) {
  const u = USERS[userId];
  const token = app.jwt.sign({ userId, role: u.legacy, institutionId: u.inst });
  return app.inject({ method: "GET", url: `/api/hr${url}`, headers: { authorization: `Bearer ${token}` } });
}

const NOW = new Date("2026-02-10T00:00:00.000Z");

const empRow = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  employeeNo: "EMP-1",
  designation: "Clerk",
  status: "ACTIVE",
  user: { id: "u1", email: "clerk@demo.edu", studentProfile: null, facultyProfile: { name: "Clerk One" } },
  ...over,
});

describe("HR staff reads/lookups", () => {
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
      return membershipFor(USERS[userId ?? "u-hr"]?.role ?? "HR_MANAGER");
    });
    m.institutionModule.findUnique.mockResolvedValue({ state: "ACTIVE" });
    m.auditEvent.create.mockResolvedValue({});
    m.user.findMany.mockResolvedValue([]);
    m.hrEmployee.findMany.mockResolvedValue([]);
    m.hrEmployee.count.mockResolvedValue(0);
    m.hrLeaveApplication.findMany.mockResolvedValue([]);
    m.hrLeaveApplication.count.mockResolvedValue(0);
    m.hrEmployeeAttendance.findMany.mockResolvedValue([]);
    m.department.findMany.mockResolvedValue([]);
  });

  it("role matrix: HR_MANAGER holds all six staff keys; EMPLOYEE only view_own; others none", () => {
    for (const k of [
      "hr.employees.manage",
      "hr.contracts.manage",
      "hr.leave.manage",
      "hr.attendance.manage",
      "hr.reports.view",
      "hr.directory.view",
    ]) {
      expect(ROLE_PERMISSIONS.HR_MANAGER).toContain(k);
      expect(ROLE_PERMISSIONS.ADMIN).toContain(k);
      expect(ROLE_PERMISSIONS.EMPLOYEE).not.toContain(k);
      expect(ROLE_PERMISSIONS.FACULTY).not.toContain(k);
      expect(ROLE_PERMISSIONS.STUDENT).not.toContain(k);
      expect(ROLE_PERMISSIONS.HOD).not.toContain(k);
    }
    expect(ROLE_PERMISSIONS.EMPLOYEE).toContain("hr.view_own");
    // The user/department pickers are solved by scoped lookups, not by grants.
    expect(ROLE_PERMISSIONS.HR_MANAGER).not.toContain("admin.users.view");
    expect(ROLE_PERMISSIONS.HR_MANAGER).not.toContain("admin.departments.manage");
  });

  describe("GET /employees", () => {
    it("returns display projections with paging/total and tenant scoping", async () => {
      m.hrEmployee.count.mockResolvedValue(7);
      m.hrEmployee.findMany.mockResolvedValue([empRow()]);
      const app = await makeApp();
      const res = await get(app, "u-hr-b", "/employees?page=2&pageSize=5&status=ACTIVE&departmentId=d1");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ total: 7, page: 2, pageSize: 5 });
      expect(body.employees[0]).toEqual({
        id: "e1",
        employeeNo: "EMP-1",
        designation: "Clerk",
        status: "ACTIVE",
        email: "clerk@demo.edu",
        name: "Clerk One",
      });
      const arg = m.hrEmployee.findMany.mock.calls[0][0];
      expect(arg.where).toMatchObject({ institutionId: "inst-B", status: "ACTIVE", departmentId: "d1" });
      expect(arg.skip).toBe(5);
      expect(arg.take).toBe(5);
      expect(tenantCalls).not.toContain("inst-A");
      await app.close();
    });

    it("q searches employeeNo/designation/email/profile name inside the tenant", async () => {
      const app = await makeApp();
      await get(app, "u-hr", "/employees?q=clerk");
      const where = m.hrEmployee.findMany.mock.calls[0][0].where;
      expect(where.institutionId).toBe("inst-A");
      expect(where.OR).toHaveLength(5);
      await app.close();
    });

    it("400s on an invalid status/pageSize; 403 for EMPLOYEE, FACULTY, STUDENT, HOD", async () => {
      const app = await makeApp();
      expect((await get(app, "u-hr", "/employees?status=NOPE")).statusCode).toBe(400);
      expect((await get(app, "u-hr", "/employees?pageSize=500")).statusCode).toBe(400);
      for (const u of ["u-emp", "u-faculty", "u-student", "u-hod"]) {
        expect((await get(app, u, "/employees")).statusCode).toBe(403);
      }
      expect((await get(app, "u-admin", "/employees")).statusCode).toBe(200);
      await app.close();
    });
  });

  describe("GET /employees/:id", () => {
    it("returns the row plus user display and department; 404 when absent", async () => {
      m.hrEmployee.findFirst.mockResolvedValueOnce({
        id: "e1",
        institutionId: "inst-A",
        userId: "u1",
        employeeNo: "EMP-1",
        designation: "Clerk",
        employmentType: "PERMANENT",
        departmentId: "d1",
        joiningDate: NOW,
        status: "ACTIVE",
        createdByUserId: "x",
        updatedByUserId: "x",
        createdAt: NOW,
        updatedAt: NOW,
        user: { id: "u1", email: "clerk@demo.edu", studentProfile: null, facultyProfile: null },
        department: { id: "d1", name: "Admin Office" },
      });
      const app = await makeApp();
      const ok = await get(app, "u-hr", "/employees/e1");
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({
        id: "e1",
        user: { id: "u1", email: "clerk@demo.edu", name: null },
        department: { id: "d1", name: "Admin Office" },
      });
      expect(m.hrEmployee.findFirst.mock.calls[0][0].where).toEqual({ id: "e1", institutionId: "inst-A" });
      m.hrEmployee.findFirst.mockResolvedValueOnce(null);
      expect((await get(app, "u-hr", "/employees/nope")).statusCode).toBe(404);
      await app.close();
    });
  });

  describe("GET /users/lookup", () => {
    it("returns minimal rows for users without an employee record, tenant-scoped", async () => {
      m.user.findMany.mockResolvedValue([
        { id: "u1", email: "a@demo.edu", role: "GUARD", studentProfile: null, facultyProfile: { name: "Asha" } },
        { id: "u2", email: "b@demo.edu", role: "GUARD", studentProfile: null, facultyProfile: null },
      ]);
      const app = await makeApp();
      const res = await get(app, "u-hr-b", "/users/lookup?q=de&limit=5");
      expect(res.statusCode).toBe(200);
      expect(res.json().users).toEqual([
        { id: "u1", email: "a@demo.edu", role: "GUARD", name: "Asha" },
        { id: "u2", email: "b@demo.edu", role: "GUARD", name: null },
      ]);
      const arg = m.user.findMany.mock.calls[0][0];
      expect(arg.where.institutionId).toBe("inst-B");
      expect(arg.where.hrEmployees).toEqual({ none: {} });
      expect(arg.take).toBe(5);
      // never selects credential / MFA material
      expect(Object.keys(arg.select).sort()).toEqual(["email", "facultyProfile", "id", "role", "studentProfile"]);
      await app.close();
    });

    it("400 when q is short; gated by hr.employees.manage (EMPLOYEE/FACULTY/STUDENT 403)", async () => {
      const app = await makeApp();
      expect((await get(app, "u-hr", "/users/lookup")).statusCode).toBe(400);
      expect((await get(app, "u-hr", "/users/lookup?q=a")).statusCode).toBe(400);
      for (const u of ["u-emp", "u-faculty", "u-student", "u-hod"]) {
        expect((await get(app, u, "/users/lookup?q=ab")).statusCode).toBe(403);
      }
      expect(m.user.findMany).not.toHaveBeenCalled();
      m.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });
      expect((await get(app, "u-hr", "/users/lookup?q=ab")).statusCode).toBe(403);
      await app.close();
    });
  });

  describe("GET /lookups", () => {
    it("returns tenant-scoped departments; EMPLOYEE 403", async () => {
      m.department.findMany.mockResolvedValue([{ id: "d1", name: "Admin", code: "ADM" }]);
      const app = await makeApp();
      const res = await get(app, "u-hr-b", "/lookups");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ departments: [{ id: "d1", name: "Admin", code: "ADM" }] });
      expect(m.department.findMany.mock.calls[0][0].where.institutionId).toBe("inst-B");
      expect((await get(app, "u-emp", "/lookups")).statusCode).toBe(403);
      await app.close();
    });
  });

  describe("GET /leave (approval queue)", () => {
    it("lists applications with employee display fields, filters and paging", async () => {
      m.hrLeaveApplication.count.mockResolvedValue(1);
      m.hrLeaveApplication.findMany.mockResolvedValue([
        {
          id: "l1",
          employeeId: "e1",
          leaveType: "CASUAL",
          startDate: NOW,
          endDate: NOW,
          days: 1,
          periodYear: 2026,
          reason: "r",
          status: "REQUESTED",
          reviewedByUserId: null,
          reviewedAt: null,
          reviewNote: null,
          createdAt: NOW,
          updatedAt: NOW,
          employee: empRow(),
        },
      ]);
      const app = await makeApp();
      const res = await get(app, "u-hr-b", "/leave?status=REQUESTED&leaveType=CASUAL&page=1&pageSize=10");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ total: 1, page: 1, pageSize: 10 });
      expect(body.leaveApplications[0]).toMatchObject({
        id: "l1",
        status: "REQUESTED",
        employee: { id: "e1", employeeNo: "EMP-1", email: "clerk@demo.edu", name: "Clerk One" },
      });
      const where = m.hrLeaveApplication.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ institutionId: "inst-B", status: "REQUESTED", leaveType: "CASUAL" });
      await app.close();
    });

    it("400 on a bad status; gated by hr.leave.manage (EMPLOYEE/HOD/STUDENT 403)", async () => {
      const app = await makeApp();
      expect((await get(app, "u-hr", "/leave?status=PENDING")).statusCode).toBe(400);
      for (const u of ["u-emp", "u-hod", "u-student", "u-faculty"]) {
        expect((await get(app, u, "/leave")).statusCode).toBe(403);
      }
      expect((await get(app, "u-admin", "/leave")).statusCode).toBe(200);
      await app.close();
    });
  });

  describe("GET /attendance/roster", () => {
    it("merges each non-terminated employee with that day's record (or null)", async () => {
      m.hrEmployee.count.mockResolvedValue(2);
      m.hrEmployee.findMany.mockResolvedValue([empRow(), empRow({ id: "e2", employeeNo: "EMP-2" })]);
      m.hrEmployeeAttendance.findMany.mockResolvedValue([
        {
          id: "a1",
          employeeId: "e1",
          attendanceDate: new Date("2026-02-10T00:00:00.000Z"),
          status: "PRESENT",
          source: "MANUAL",
          shiftId: null,
          recordedByUserId: "u",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]);
      const app = await makeApp();
      const res = await get(app, "u-hr-b", "/attendance/roster?date=2026-02-10");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.date).toBe("2026-02-10");
      expect(body.total).toBe(2);
      expect(body.roster[0].attendance).toMatchObject({ id: "a1", status: "PRESENT", attendanceDate: "2026-02-10" });
      expect(body.roster[1].attendance).toBeNull();
      expect(m.hrEmployee.findMany.mock.calls[0][0].where).toEqual({
        institutionId: "inst-B",
        status: { not: "TERMINATED" },
      });
      expect(m.hrEmployeeAttendance.findMany.mock.calls[0][0].where.institutionId).toBe("inst-B");
      await app.close();
    });

    it("400 on a bad/missing date; gated by hr.attendance.manage (EMPLOYEE/HOD 403)", async () => {
      const app = await makeApp();
      expect((await get(app, "u-hr", "/attendance/roster")).statusCode).toBe(400);
      expect((await get(app, "u-hr", "/attendance/roster?date=10-02-2026")).statusCode).toBe(400);
      expect((await get(app, "u-emp", "/attendance/roster?date=2026-02-10")).statusCode).toBe(403);
      expect((await get(app, "u-hod", "/attendance/roster?date=2026-02-10")).statusCode).toBe(403);
      m.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });
      expect((await get(app, "u-hr", "/attendance/roster?date=2026-02-10")).statusCode).toBe(403);
      await app.close();
    });
  });
});
