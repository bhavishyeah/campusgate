/**
 * Transport frontend reads/lookups (G-TRN1 GET /students/lookup, G-TRN2 assignment
 * vehicle/driver, G-TRN3 enrollment + roster student/route/stop, G-TRN4 maintenance
 * vehicle, G-TRN5 /me/enrollments route + stop). @campusgate/db is MOCKED (fast,
 * deterministic): this pins the ROUTE-LAYER contract — permission gating per role,
 * the requireModuleActive("transport") gate, query validation, tenant scoping
 * (institutionId from the token) and the minimal projections. Real-DB isolation is
 * proven by the transport.behavioral live suite.
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
    studentProfile: { findMany: vi.fn(), findFirst: vi.fn() },
    transportRoute: { findFirst: vi.fn(), findMany: vi.fn() },
    transportRouteAssignment: { findMany: vi.fn() },
    transportEnrollment: { findMany: vi.fn(), count: vi.fn() },
    transportVehicleMaintenanceRequest: { findMany: vi.fn(), count: vi.fn() },
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
import { transportRoutes } from "../transport.js";

const m = prisma as unknown as Record<string, any>;

type RoleKey = "ADMIN" | "TRANSPORT_MANAGER" | "STUDENT" | "FACULTY" | "HOD" | "WARDEN";

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
  "u-tm": { role: "TRANSPORT_MANAGER", legacy: "GUARD", inst: "inst-A" },
  "u-tm-b": { role: "TRANSPORT_MANAGER", legacy: "GUARD", inst: "inst-B" },
  "u-admin": { role: "ADMIN", legacy: "ADMIN", inst: "inst-A" },
  "u-student": { role: "STUDENT", legacy: "STUDENT", inst: "inst-A" },
  "u-faculty": { role: "FACULTY", legacy: "GUARD", inst: "inst-A" },
  "u-hod": { role: "HOD", legacy: "HOD", inst: "inst-A" },
  "u-warden": { role: "WARDEN", legacy: "GUARD", inst: "inst-A" },
};

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "transport-staff-reads-secret" });
  await app.register(transportRoutes, { prefix: "/api/transport" });
  return app;
}

function get(app: Awaited<ReturnType<typeof makeApp>>, userId: string, url: string) {
  const u = USERS[userId];
  const token = app.jwt.sign({ userId, role: u.legacy, institutionId: u.inst });
  return app.inject({ method: "GET", url: `/api/transport${url}`, headers: { authorization: `Bearer ${token}` } });
}

const NOW = new Date("2026-02-10T00:00:00.000Z");

describe("Transport frontend reads/lookups", () => {
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
      return membershipFor(USERS[userId ?? "u-tm"]?.role ?? "TRANSPORT_MANAGER");
    });
    m.institutionModule.findUnique.mockResolvedValue({ state: "ACTIVE" });
    m.auditEvent.create.mockResolvedValue({});
    m.studentProfile.findMany.mockResolvedValue([]);
    m.transportRoute.findFirst.mockResolvedValue({ id: "rt1" });
    m.transportRouteAssignment.findMany.mockResolvedValue([]);
    m.transportEnrollment.findMany.mockResolvedValue([]);
    m.transportEnrollment.count.mockResolvedValue(0);
    m.transportVehicleMaintenanceRequest.findMany.mockResolvedValue([]);
    m.transportVehicleMaintenanceRequest.count.mockResolvedValue(0);
  });

  it("role matrix: TRANSPORT_MANAGER has all seven staff keys, no view_own / student keys; STUDENT only view_own", () => {
    for (const k of [
      "transport.vehicles.manage",
      "transport.drivers.manage",
      "transport.routes.manage",
      "transport.assignments.manage",
      "transport.enrollments.manage",
      "transport.maintenance.manage",
      "transport.view",
    ]) {
      expect(ROLE_PERMISSIONS.TRANSPORT_MANAGER).toContain(k);
      expect(ROLE_PERMISSIONS.ADMIN).toContain(k);
      expect(ROLE_PERMISSIONS.STUDENT).not.toContain(k);
      expect(ROLE_PERMISSIONS.FACULTY).not.toContain(k);
      expect(ROLE_PERMISSIONS.HOD).not.toContain(k);
      expect(ROLE_PERMISSIONS.WARDEN).not.toContain(k);
    }
    expect(ROLE_PERMISSIONS.STUDENT).toContain("transport.view_own");
    expect(ROLE_PERMISSIONS.TRANSPORT_MANAGER).not.toContain("transport.view_own");
    // The student picker is solved by a scoped lookup, not by a grant.
    expect(ROLE_PERMISSIONS.TRANSPORT_MANAGER).not.toContain("students.view");
  });

  describe("GET /students/lookup", () => {
    it("returns minimal rows, excludes applicants, tenant-scoped", async () => {
      m.studentProfile.findMany.mockResolvedValue([{ id: "s1", name: "Asha", enrollmentNo: "E1", program: "BCA" }]);
      const app = await makeApp();
      const res = await get(app, "u-tm-b", "/students/lookup?q=as&limit=5");
      expect(res.statusCode).toBe(200);
      expect(res.json().students).toEqual([{ id: "s1", name: "Asha", enrollmentNo: "E1", program: "BCA" }]);
      const arg = m.studentProfile.findMany.mock.calls[0][0];
      expect(arg.where.institutionId).toBe("inst-B");
      expect(arg.where.status).toEqual({ not: "APPLICANT" });
      expect(arg.take).toBe(5);
      expect(Object.keys(arg.select).sort()).toEqual(["enrollmentNo", "id", "name", "program"]);
      expect(tenantCalls).not.toContain("inst-A");
      await app.close();
    });
    it("400 when q is short; gated by enrollments.manage (STUDENT/FACULTY/HOD/WARDEN 403); module gate", async () => {
      const app = await makeApp();
      expect((await get(app, "u-tm", "/students/lookup")).statusCode).toBe(400);
      expect((await get(app, "u-tm", "/students/lookup?q=a")).statusCode).toBe(400);
      for (const u of ["u-student", "u-faculty", "u-hod", "u-warden"]) {
        expect((await get(app, u, "/students/lookup?q=ab")).statusCode).toBe(403);
      }
      expect((await get(app, "u-admin", "/students/lookup?q=ab")).statusCode).toBe(200);
      m.studentProfile.findMany.mockClear();
      m.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });
      expect((await get(app, "u-tm", "/students/lookup?q=ab")).statusCode).toBe(403);
      expect(m.studentProfile.findMany).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe("display projections", () => {
    it("assignments include vehicle + driver, scoped to the tenant route", async () => {
      m.transportRouteAssignment.findMany.mockResolvedValue([
        {
          id: "as1",
          routeId: "rt1",
          vehicleId: "v1",
          driverId: "d1",
          status: "ACTIVE",
          effectiveFrom: NOW,
          vehicle: { id: "v1", registrationNo: "KA-01", type: "BUS", seatCapacity: 40, status: "ACTIVE" },
          driver: { id: "d1", name: "Ravi", licenseNo: "L1", phone: null, status: "ACTIVE" },
        },
      ]);
      const app = await makeApp();
      const res = await get(app, "u-tm-b", "/routes/rt1/assignments");
      expect(res.statusCode).toBe(200);
      expect(res.json().assignments[0]).toMatchObject({
        vehicleId: "v1",
        vehicle: { registrationNo: "KA-01", seatCapacity: 40 },
        driver: { name: "Ravi" },
      });
      expect(m.transportRouteAssignment.findMany.mock.calls[0][0].where).toMatchObject({
        institutionId: "inst-B",
        routeId: "rt1",
      });
      expect(tenantCalls).not.toContain("inst-A");
      await app.close();
    });
    it("enrollments and roster include student, route and stop", async () => {
      m.transportEnrollment.count.mockResolvedValue(1);
      m.transportEnrollment.findMany.mockResolvedValue([
        {
          id: "e1",
          studentId: "s1",
          routeId: "rt1",
          stopId: "st1",
          status: "ACTIVE",
          enrolledAt: NOW,
          student: { id: "s1", name: "Asha", enrollmentNo: "E1", program: "BCA" },
          route: { id: "rt1", code: "R1", name: "North" },
          stop: { id: "st1", name: "Gate", sequence: 1 },
        },
      ]);
      const app = await makeApp();
      const list = await get(app, "u-tm", "/enrollments?routeId=rt1&status=ACTIVE");
      expect(list.statusCode).toBe(200);
      expect(list.json().enrollments[0]).toMatchObject({
        studentId: "s1",
        student: { name: "Asha" },
        route: { code: "R1" },
        stop: { name: "Gate", sequence: 1 },
      });
      const roster = await get(app, "u-tm", "/reports/roster?routeId=rt1");
      expect(roster.statusCode).toBe(200);
      expect(roster.json().roster[0]).toMatchObject({ student: { enrollmentNo: "E1" }, stop: { name: "Gate" } });
      for (const call of m.transportEnrollment.findMany.mock.calls) {
        expect(call[0].where.institutionId).toBe("inst-A");
        expect(Object.keys(call[0].include.student.select).sort()).toEqual(["enrollmentNo", "id", "name", "program"]);
      }
      await app.close();
    });
    it("maintenance includes the vehicle", async () => {
      const app = await makeApp();
      await get(app, "u-tm", "/maintenance");
      expect(m.transportVehicleMaintenanceRequest.findMany.mock.calls[0][0].include.vehicle.select).toEqual({
        id: true,
        registrationNo: true,
        type: true,
      });
      await app.close();
    });
    it("staff reads stay 403 for STUDENT / WARDEN", async () => {
      const app = await makeApp();
      for (const u of ["u-student", "u-warden"]) {
        expect((await get(app, u, "/enrollments")).statusCode).toBe(403);
        expect((await get(app, u, "/reports/roster")).statusCode).toBe(403);
      }
      await app.close();
    });
  });

  describe("GET /me/enrollments", () => {
    it("includes route + stop for the student's own ACTIVE enrollments; empty when no profile", async () => {
      m.studentProfile.findFirst.mockResolvedValueOnce({ id: "s1" });
      m.transportEnrollment.findMany.mockResolvedValueOnce([
        {
          id: "e1",
          studentId: "s1",
          routeId: "rt1",
          stopId: "st1",
          status: "ACTIVE",
          route: { id: "rt1", code: "R1", name: "North" },
          stop: { id: "st1", name: "Gate", sequence: 1, landmark: null, pickupOffsetMinutes: 5 },
        },
      ]);
      const app = await makeApp();
      const res = await get(app, "u-student", "/me/enrollments");
      expect(res.statusCode).toBe(200);
      expect(res.json().enrollments[0]).toMatchObject({
        routeId: "rt1",
        route: { code: "R1" },
        stop: { name: "Gate", pickupOffsetMinutes: 5 },
      });
      expect(m.transportEnrollment.findMany.mock.calls[0][0].where).toEqual({
        institutionId: "inst-A",
        studentId: "s1",
        status: "ACTIVE",
      });
      m.studentProfile.findFirst.mockResolvedValueOnce(null);
      const none = await get(app, "u-student", "/me/enrollments");
      expect(none.statusCode).toBe(200);
      expect(none.json()).toEqual({ enrollments: [] });
      await app.close();
    });
  });
});
