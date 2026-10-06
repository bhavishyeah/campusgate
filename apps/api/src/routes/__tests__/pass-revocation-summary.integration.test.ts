import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    hodProfile: { findFirst: vi.fn() },
    studentProfile: { findFirst: vi.fn() },
    gatePass: { findFirst: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn(), findMany: vi.fn() },
  },
}));

import { prisma } from "@campusgate/db";
import { hodRoutes } from "../hod.js";
import { adminRoutes } from "../admin.js";
import { studentRoutes } from "../student.js";

type MockFn = ReturnType<typeof vi.fn>;

const mockedPrisma = prisma as unknown as {
  user: { findUnique: MockFn };
  hodProfile: { findFirst: MockFn };
  studentProfile: { findFirst: MockFn };
  gatePass: { findFirst: MockFn; updateMany: MockFn };
  auditLog: { create: MockFn; findMany: MockFn };
};

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "test-secret" });
  return app;
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("Pass revocation and summaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockedPrisma.user.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      const id = where.id;
      if (id === "u-hod") {
        return {
          id,
          role: "HOD",
          institutionId: "inst-1",
          accountStatus: "ACTIVE",
          institution: { status: "ACTIVE" },
        };
      }
      if (id === "u-admin") {
        return {
          id,
          role: "ADMIN",
          institutionId: "inst-1",
          accountStatus: "ACTIVE",
          institution: { status: "ACTIVE" },
        };
      }
      if (id === "u-student") {
        return {
          id,
          role: "STUDENT",
          institutionId: "inst-1",
          accountStatus: "ACTIVE",
          institution: { status: "ACTIVE" },
        };
      }
      return null;
    });
  });

  it("HOD can revoke eligible pass in their scope", async () => {
    const app = await makeApp();
    await app.register(hodRoutes, { prefix: "/api/hod" });

    mockedPrisma.hodProfile.findFirst.mockResolvedValue({ id: "hod-1", departmentId: "dept-1" });
    mockedPrisma.gatePass.findFirst.mockResolvedValue({
      id: "pass-1",
      status: "APPROVED",
      studentId: "stu-1",
    });
    mockedPrisma.gatePass.updateMany.mockResolvedValue({ count: 1 });
    mockedPrisma.auditLog.create.mockResolvedValue({});

    const token = app.jwt.sign({ userId: "u-hod", role: "HOD", institutionId: "inst-1" });

    const res = await app.inject({
      method: "POST",
      url: "/api/hod/revoke",
      headers: authHeader(token),
      payload: { passId: "pass-1", reason: "Disciplinary issue" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.gatePass.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REVOKED" }) })
    );

    await app.close();
  });

  it("Admin can revoke eligible pass in tenant scope", async () => {
    const app = await makeApp();
    await app.register(adminRoutes, { prefix: "/api/admin" });

    mockedPrisma.gatePass.findFirst.mockResolvedValue({
      id: "pass-2",
      status: "OUTSIDE",
      studentId: "stu-2",
    });
    mockedPrisma.gatePass.updateMany.mockResolvedValue({ count: 1 });
    mockedPrisma.auditLog.create.mockResolvedValue({});

    const token = app.jwt.sign({ userId: "u-admin", role: "ADMIN", institutionId: "inst-1" });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/passes/pass-2/revoke",
      headers: authHeader(token),
      payload: { reason: "Emergency restriction" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.gatePass.findFirst).toHaveBeenCalled();

    await app.close();
  });

  it("Admin revoke returns 409 when pass state changes concurrently", async () => {
    const app = await makeApp();
    await app.register(adminRoutes, { prefix: "/api/admin" });

    mockedPrisma.gatePass.findFirst.mockResolvedValue({
      id: "pass-race",
      status: "APPROVED",
      studentId: "stu-9",
    });
    mockedPrisma.gatePass.updateMany.mockResolvedValue({ count: 0 });

    const token = app.jwt.sign({ userId: "u-admin", role: "ADMIN", institutionId: "inst-1" });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/passes/pass-race/revoke",
      headers: authHeader(token),
      payload: { reason: "Concurrent state transition" },
    });

    expect(res.statusCode).toBe(409);

    await app.close();
  });

  it("Student summary returns 404 when pass is outside ownership", async () => {
    const app = await makeApp();
    await app.register(studentRoutes, { prefix: "/api/student" });

    mockedPrisma.studentProfile.findFirst.mockResolvedValue({ id: "stu-1", userId: "u-student" });
    mockedPrisma.gatePass.findFirst.mockResolvedValueOnce(null);

    const token = app.jwt.sign({ userId: "u-student", role: "STUDENT", institutionId: "inst-1" });

    const res = await app.inject({
      method: "GET",
      url: "/api/student/gate-pass/pass-x/summary",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it("Student timeline returns lifecycle events", async () => {
    const app = await makeApp();
    await app.register(studentRoutes, { prefix: "/api/student" });

    mockedPrisma.studentProfile.findFirst.mockResolvedValue({ id: "stu-1", userId: "u-student" });
    mockedPrisma.gatePass.findFirst.mockResolvedValue({
      id: "pass-3",
      passNumber: "CG-2026-XYZ",
      status: "COMPLETED",
      createdAt: new Date("2026-10-01T10:00:00.000Z"),
      approvedAt: new Date("2026-10-01T10:10:00.000Z"),
      updatedAt: new Date("2026-10-01T11:00:00.000Z"),
      requestedExit: new Date("2026-10-01T10:30:00.000Z"),
      expectedReturn: new Date("2026-10-01T11:30:00.000Z"),
      actualExit: new Date("2026-10-01T10:35:00.000Z"),
      actualReturn: new Date("2026-10-01T11:00:00.000Z"),
      rejectionReason: null,
      gateEvents: [
        { eventType: "EXIT", timestamp: new Date("2026-10-01T10:35:00.000Z"), gate: { name: "Main Gate" } },
        { eventType: "RETURN", timestamp: new Date("2026-10-01T11:00:00.000Z"), gate: { name: "Main Gate" } },
      ],
    });
    mockedPrisma.auditLog.findMany.mockResolvedValue([]);

    const token = app.jwt.sign({ userId: "u-student", role: "STUDENT", institutionId: "inst-1" });

    const res = await app.inject({
      method: "GET",
      url: "/api/student/gate-pass/pass-3/timeline",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.timeline)).toBe(true);
    expect(body.timeline.length).toBeGreaterThan(0);

    await app.close();
  });
});
