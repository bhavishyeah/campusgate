/**
 * Hostel staff reads/lookups added for the frontend (G-HOS1 GET /rooms, G-HOS2
 * building warden/roomCount, G-HOS3 allocation/maintenance/leave display
 * projections, G-HOS4 GET /check-events, G-HOS5 GET /students/lookup, G-HOS6 GET
 * /users/lookup, G-HOS7 /me/allocation room). @campusgate/db is MOCKED (fast,
 * deterministic): this pins the ROUTE-LAYER contract — permission gating per role,
 * the requireModuleActive("hostel") gate, query validation, tenant scoping
 * (institutionId from the token) and the minimal projections. Real-DB isolation is
 * proven by the hostel.behavioral live suite.
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
    hostelBuilding: { findMany: vi.fn(), count: vi.fn() },
    hostelRoom: { findMany: vi.fn(), count: vi.fn() },
    hostelRoomAllocation: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), findFirst: vi.fn() },
    hostelMaintenanceRequest: { findMany: vi.fn(), count: vi.fn() },
    hostelLeaveApplication: { findMany: vi.fn(), count: vi.fn() },
    hostelCheckEvent: { findMany: vi.fn(), count: vi.fn() },
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
import { hostelRoutes } from "../hostel.js";

const m = prisma as unknown as Record<string, any>;

type RoleKey = "ADMIN" | "WARDEN" | "STUDENT" | "FACULTY" | "HOD" | "TRANSPORT_MANAGER";

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
  "u-warden": { role: "WARDEN", legacy: "GUARD", inst: "inst-A" },
  "u-warden-b": { role: "WARDEN", legacy: "GUARD", inst: "inst-B" },
  "u-admin": { role: "ADMIN", legacy: "ADMIN", inst: "inst-A" },
  "u-student": { role: "STUDENT", legacy: "STUDENT", inst: "inst-A" },
  "u-faculty": { role: "FACULTY", legacy: "GUARD", inst: "inst-A" },
  "u-hod": { role: "HOD", legacy: "HOD", inst: "inst-A" },
  "u-tm": { role: "TRANSPORT_MANAGER", legacy: "GUARD", inst: "inst-A" },
};

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "hostel-staff-reads-secret" });
  await app.register(hostelRoutes, { prefix: "/api/hostel" });
  return app;
}

function get(app: Awaited<ReturnType<typeof makeApp>>, userId: string, url: string) {
  const u = USERS[userId];
  const token = app.jwt.sign({ userId, role: u.legacy, institutionId: u.inst });
  return app.inject({ method: "GET", url: `/api/hostel${url}`, headers: { authorization: `Bearer ${token}` } });
}

const NOW = new Date("2026-02-10T00:00:00.000Z");

describe("Hostel frontend reads/lookups", () => {
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
      return membershipFor(USERS[userId ?? "u-warden"]?.role ?? "WARDEN");
    });
    m.institutionModule.findUnique.mockResolvedValue({ state: "ACTIVE" });
    m.auditEvent.create.mockResolvedValue({});
    m.user.findMany.mockResolvedValue([]);
    m.studentProfile.findMany.mockResolvedValue([]);
    m.hostelBuilding.findMany.mockResolvedValue([]);
    m.hostelBuilding.count.mockResolvedValue(0);
    m.hostelRoom.findMany.mockResolvedValue([]);
    m.hostelRoom.count.mockResolvedValue(0);
    m.hostelRoomAllocation.findMany.mockResolvedValue([]);
    m.hostelRoomAllocation.count.mockResolvedValue(0);
    m.hostelRoomAllocation.groupBy.mockResolvedValue([]);
    m.hostelMaintenanceRequest.findMany.mockResolvedValue([]);
    m.hostelMaintenanceRequest.count.mockResolvedValue(0);
    m.hostelLeaveApplication.findMany.mockResolvedValue([]);
    m.hostelLeaveApplication.count.mockResolvedValue(0);
    m.hostelCheckEvent.findMany.mockResolvedValue([]);
    m.hostelCheckEvent.count.mockResolvedValue(0);
  });

  it("role matrix: WARDEN has all five staff keys and no view_own / admin keys; STUDENT only view_own", () => {
    for (const k of [
      "hostel.buildings.manage",
      "hostel.allocations.manage",
      "hostel.leave.manage",
      "hostel.maintenance.manage",
      "hostel.view",
    ]) {
      expect(ROLE_PERMISSIONS.WARDEN).toContain(k);
      expect(ROLE_PERMISSIONS.ADMIN).toContain(k);
      expect(ROLE_PERMISSIONS.STUDENT).not.toContain(k);
      expect(ROLE_PERMISSIONS.FACULTY).not.toContain(k);
      expect(ROLE_PERMISSIONS.HOD).not.toContain(k);
      expect(ROLE_PERMISSIONS.TRANSPORT_MANAGER).not.toContain(k);
    }
    expect(ROLE_PERMISSIONS.STUDENT).toContain("hostel.view_own");
    expect(ROLE_PERMISSIONS.WARDEN).not.toContain("hostel.view_own");
    // The student / user pickers are solved by scoped lookups, not by grants.
    expect(ROLE_PERMISSIONS.WARDEN).not.toContain("students.view");
    expect(ROLE_PERMISSIONS.WARDEN).not.toContain("admin.users.view");
  });

  describe("GET /buildings", () => {
    it("adds roomCount and a resolved warden display, tenant-scoped", async () => {
      m.hostelBuilding.count.mockResolvedValue(2);
      m.hostelBuilding.findMany.mockResolvedValue([
        { id: "b1", name: "Block A", type: "BOYS", wardenUserId: "w1", isActive: true, _count: { rooms: 4 } },
        { id: "b2", name: "Block B", type: "GIRLS", wardenUserId: null, isActive: true, _count: { rooms: 0 } },
      ]);
      m.user.findMany.mockResolvedValue([{ id: "w1", email: "w@demo.edu", facultyProfile: { name: "Warden One" } }]);
      const app = await makeApp();
      const res = await get(app, "u-warden-b", "/buildings");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ total: 2, page: 1, pageSize: 20 });
      expect(body.buildings[0]).toMatchObject({
        id: "b1",
        wardenUserId: "w1",
        roomCount: 4,
        warden: { id: "w1", email: "w@demo.edu", name: "Warden One" },
      });
      expect(body.buildings[0]._count).toBeUndefined();
      expect(body.buildings[1]).toMatchObject({ roomCount: 0, warden: null });
      expect(m.user.findMany.mock.calls[0][0].where).toEqual({ institutionId: "inst-B", id: { in: ["w1"] } });
      expect(tenantCalls).not.toContain("inst-A");
      await app.close();
    });
  });

  describe("GET /rooms", () => {
    it("lists rooms with building and computed occupancy, filters and paging", async () => {
      m.hostelRoom.count.mockResolvedValue(3);
      m.hostelRoom.findMany.mockResolvedValue([
        { id: "r1", buildingId: "b1", roomNumber: "101", capacity: 3, floor: 1, status: "AVAILABLE", building: { id: "b1", name: "Block A", type: "BOYS" } },
      ]);
      m.hostelRoomAllocation.groupBy.mockResolvedValue([{ roomId: "r1", _count: { _all: 2 } }]);
      const app = await makeApp();
      const res = await get(app, "u-warden-b", "/rooms?buildingId=b1&status=AVAILABLE&page=2&pageSize=5");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ total: 3, page: 2, pageSize: 5 });
      expect(body.rooms[0]).toMatchObject({
        id: "r1",
        building: { name: "Block A" },
        occupancy: { capacity: 3, occupied: 2, available: 1 },
      });
      const arg = m.hostelRoom.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({ institutionId: "inst-B", buildingId: "b1", status: "AVAILABLE" });
      expect(arg.skip).toBe(5);
      expect(arg.take).toBe(5);
      expect(m.hostelRoomAllocation.groupBy.mock.calls[0][0].where).toMatchObject({
        institutionId: "inst-B",
        status: "ACTIVE",
        roomId: { in: ["r1"] },
      });
      expect(tenantCalls).not.toContain("inst-A");
      await app.close();
    });
    it("400 on a bad status; 403 for STUDENT/FACULTY/HOD/TRANSPORT_MANAGER; 403 when module inactive", async () => {
      const app = await makeApp();
      expect((await get(app, "u-warden", "/rooms?status=NOPE")).statusCode).toBe(400);
      for (const u of ["u-student", "u-faculty", "u-hod", "u-tm"]) {
        expect((await get(app, u, "/rooms")).statusCode).toBe(403);
      }
      expect((await get(app, "u-admin", "/rooms")).statusCode).toBe(200);
      m.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });
      expect((await get(app, "u-warden", "/rooms")).statusCode).toBe(403);
      await app.close();
    });
  });

  describe("display projections", () => {
    it("allocations include student + room/building and honour buildingId", async () => {
      m.hostelRoomAllocation.findMany.mockResolvedValue([
        {
          id: "a1",
          roomId: "r1",
          studentId: "s1",
          status: "ACTIVE",
          allocatedAt: NOW,
          student: { id: "s1", name: "Asha", enrollmentNo: "E1", program: "BCA" },
          room: { id: "r1", roomNumber: "101", floor: 1, building: { id: "b1", name: "Block A" } },
        },
      ]);
      m.hostelRoomAllocation.count.mockResolvedValue(1);
      const app = await makeApp();
      const res = await get(app, "u-warden-b", "/allocations?buildingId=b1&status=ACTIVE");
      expect(res.statusCode).toBe(200);
      expect(res.json().allocations[0]).toMatchObject({
        roomId: "r1",
        studentId: "s1",
        student: { name: "Asha", enrollmentNo: "E1" },
        room: { roomNumber: "101", building: { name: "Block A" } },
      });
      const arg = m.hostelRoomAllocation.findMany.mock.calls[0][0];
      expect(arg.where).toMatchObject({ institutionId: "inst-B", status: "ACTIVE", room: { buildingId: "b1" } });
      expect(Object.keys(arg.include.student.select).sort()).toEqual(["enrollmentNo", "id", "name", "program"]);
      expect(tenantCalls).not.toContain("inst-A");
      await app.close();
    });
    it("leave queue includes the student; maintenance includes the room/building", async () => {
      const app = await makeApp();
      await get(app, "u-warden", "/leave");
      expect(m.hostelLeaveApplication.findMany.mock.calls[0][0].include.student.select).toMatchObject({
        name: true,
        enrollmentNo: true,
      });
      await get(app, "u-warden", "/maintenance");
      expect(m.hostelMaintenanceRequest.findMany.mock.calls[0][0].include.room.select).toMatchObject({
        roomNumber: true,
        building: { select: { id: true, name: true } },
      });
      await app.close();
    });
  });

  describe("GET /check-events", () => {
    it("returns events with student + room, filtered and tenant-scoped", async () => {
      m.hostelCheckEvent.count.mockResolvedValue(1);
      m.hostelCheckEvent.findMany.mockResolvedValue([
        {
          id: "c1",
          allocationId: "a1",
          studentId: "s1",
          eventType: "CHECK_IN",
          occurredAt: NOW,
          student: { id: "s1", name: "Asha", enrollmentNo: "E1", program: "BCA" },
          allocation: { id: "a1", room: { id: "r1", roomNumber: "101", floor: 1, building: { id: "b1", name: "Block A" } } },
        },
      ]);
      const app = await makeApp();
      const res = await get(app, "u-warden-b", "/check-events?allocationId=a1");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ total: 1, page: 1, pageSize: 20 });
      expect(res.json().events[0]).toMatchObject({ eventType: "CHECK_IN", student: { name: "Asha" } });
      expect(m.hostelCheckEvent.findMany.mock.calls[0][0].where).toEqual({
        institutionId: "inst-B",
        allocationId: "a1",
      });
      expect(tenantCalls).not.toContain("inst-A");
      expect((await get(app, "u-student", "/check-events")).statusCode).toBe(403);
      expect((await get(app, "u-warden", "/check-events?pageSize=500")).statusCode).toBe(400);
      await app.close();
    });
  });

  describe("GET /students/lookup", () => {
    it("returns minimal rows with hasActiveAllocation, excludes applicants, tenant-scoped", async () => {
      m.studentProfile.findMany.mockResolvedValue([
        { id: "s1", name: "Asha", enrollmentNo: "E1", program: "BCA", hostelRoomAllocations: [{ id: "a1" }] },
        { id: "s2", name: "Ashok", enrollmentNo: "E2", program: "BCA", hostelRoomAllocations: [] },
      ]);
      const app = await makeApp();
      const res = await get(app, "u-warden-b", "/students/lookup?q=as&limit=5");
      expect(res.statusCode).toBe(200);
      expect(res.json().students).toEqual([
        { id: "s1", name: "Asha", enrollmentNo: "E1", program: "BCA", hasActiveAllocation: true },
        { id: "s2", name: "Ashok", enrollmentNo: "E2", program: "BCA", hasActiveAllocation: false },
      ]);
      const arg = m.studentProfile.findMany.mock.calls[0][0];
      expect(arg.where.institutionId).toBe("inst-B");
      expect(arg.where.status).toEqual({ not: "APPLICANT" });
      expect(arg.take).toBe(5);
      expect(Object.keys(arg.select).sort()).toEqual(["enrollmentNo", "hostelRoomAllocations", "id", "name", "program"]);
      expect(tenantCalls).not.toContain("inst-A");
      await app.close();
    });
    it("400 when q is short; gated by allocations.manage (STUDENT/FACULTY/HOD/TRANSPORT_MANAGER 403); module gate", async () => {
      const app = await makeApp();
      expect((await get(app, "u-warden", "/students/lookup")).statusCode).toBe(400);
      expect((await get(app, "u-warden", "/students/lookup?q=a")).statusCode).toBe(400);
      for (const u of ["u-student", "u-faculty", "u-hod", "u-tm"]) {
        expect((await get(app, u, "/students/lookup?q=ab")).statusCode).toBe(403);
      }
      expect(m.studentProfile.findMany).not.toHaveBeenCalled();
      m.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });
      expect((await get(app, "u-warden", "/students/lookup?q=ab")).statusCode).toBe(403);
      await app.close();
    });
  });

  describe("GET /users/lookup", () => {
    it("returns id/email/name only, excludes student profiles, tenant-scoped", async () => {
      m.user.findMany.mockResolvedValue([
        { id: "u1", email: "a@demo.edu", facultyProfile: { name: "Asha" } },
        { id: "u2", email: "b@demo.edu", facultyProfile: null },
      ]);
      const app = await makeApp();
      const res = await get(app, "u-warden-b", "/users/lookup?q=de&limit=5");
      expect(res.statusCode).toBe(200);
      expect(res.json().users).toEqual([
        { id: "u1", email: "a@demo.edu", name: "Asha" },
        { id: "u2", email: "b@demo.edu", name: null },
      ]);
      const arg = m.user.findMany.mock.calls[0][0];
      expect(arg.where.institutionId).toBe("inst-B");
      expect(arg.where.studentProfile).toBeNull();
      expect(arg.take).toBe(5);
      expect(Object.keys(arg.select).sort()).toEqual(["email", "facultyProfile", "id"]);
      await app.close();
    });
    it("400 when q is short; gated by buildings.manage (STUDENT/FACULTY/HOD/TRANSPORT_MANAGER 403)", async () => {
      const app = await makeApp();
      expect((await get(app, "u-warden", "/users/lookup?q=a")).statusCode).toBe(400);
      for (const u of ["u-student", "u-faculty", "u-hod", "u-tm"]) {
        expect((await get(app, u, "/users/lookup?q=ab")).statusCode).toBe(403);
      }
      expect(m.user.findMany).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe("GET /me/allocation", () => {
    it("includes room + building for the student's own ACTIVE allocation", async () => {
      m.studentProfile.findFirst.mockResolvedValue({ id: "s1" });
      m.hostelRoomAllocation.findFirst.mockResolvedValue({
        id: "a1",
        roomId: "r1",
        studentId: "s1",
        status: "ACTIVE",
        room: { id: "r1", roomNumber: "101", floor: 1, building: { id: "b1", name: "Block A", type: "BOYS" } },
      });
      const app = await makeApp();
      const res = await get(app, "u-student", "/me/allocation");
      expect(res.statusCode).toBe(200);
      expect(res.json().allocation).toMatchObject({
        id: "a1",
        roomId: "r1",
        room: { roomNumber: "101", building: { name: "Block A" } },
      });
      expect(m.hostelRoomAllocation.findFirst.mock.calls[0][0].where).toEqual({
        institutionId: "inst-A",
        studentId: "s1",
        status: "ACTIVE",
      });
      await app.close();
    });
  });
});
