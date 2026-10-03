import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    institutionConfig: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
    academicCalendarDay: { findMany: vi.fn(), upsert: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

import { prisma } from "@campusgate/db";
import { adminRoutes } from "../admin.js";

type MockFn = ReturnType<typeof vi.fn>;

const mockedPrisma = prisma as unknown as {
  user: { findUnique: MockFn };
  institutionConfig: { findUnique: MockFn; create: MockFn; upsert: MockFn };
  academicCalendarDay: { findMany: MockFn; upsert: MockFn; findUnique: MockFn; delete: MockFn };
  auditLog: { create: MockFn };
};

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "test-secret" });
  return app;
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("Admin config/calendar routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockedPrisma.user.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === "u-admin") {
        return {
          id: "u-admin",
          role: "ADMIN",
          institutionId: "inst-1",
          accountStatus: "ACTIVE",
          institution: { status: "ACTIVE" },
        };
      }
      return null;
    });
  });

  it("GET /institution-config resolves config in caller tenant", async () => {
    const app = await makeApp();
    await app.register(adminRoutes, { prefix: "/api/admin" });

    mockedPrisma.institutionConfig.findUnique.mockResolvedValue({
      id: "cfg-1",
      institutionId: "inst-1",
      timezone: "Asia/Kolkata",
      weekStartDay: "MONDAY",
      workingDaysOfWeek: [1, 2, 3, 4, 5, 6],
      lowAllowanceThresholdMinutes: 60,
    });

    const token = app.jwt.sign({ userId: "u-admin", role: "ADMIN", institutionId: "inst-1" });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/institution-config",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.institutionConfig.findUnique).toHaveBeenCalledWith({
      where: { institutionId: "inst-1" },
    });

    await app.close();
  });

  it("PUT /institution-config upserts using auth tenant scope", async () => {
    const app = await makeApp();
    await app.register(adminRoutes, { prefix: "/api/admin" });

    mockedPrisma.institutionConfig.upsert.mockResolvedValue({ id: "cfg-1" });
    mockedPrisma.auditLog.create.mockResolvedValue({});

    const token = app.jwt.sign({ userId: "u-admin", role: "ADMIN", institutionId: "inst-1" });

    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/institution-config",
      headers: authHeader(token),
      payload: {
        timezone: "Asia/Kolkata",
        weekStartDay: "MONDAY",
        workingDaysOfWeek: [1, 2, 3, 4, 5],
        lowAllowanceThresholdMinutes: 45,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.institutionConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { institutionId: "inst-1" },
      })
    );

    await app.close();
  });

  it("GET /academic-calendar filters by auth tenant and range", async () => {
    const app = await makeApp();
    await app.register(adminRoutes, { prefix: "/api/admin" });

    mockedPrisma.academicCalendarDay.findMany.mockResolvedValue([]);

    const token = app.jwt.sign({ userId: "u-admin", role: "ADMIN", institutionId: "inst-1" });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/academic-calendar?startDate=2026-10-01T00:00:00.000Z&endDate=2026-10-31T23:59:59.999Z",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.academicCalendarDay.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ institutionId: "inst-1" }),
      })
    );

    await app.close();
  });

  it("PUT/DELETE calendar day keep tenant boundary", async () => {
    const app = await makeApp();
    await app.register(adminRoutes, { prefix: "/api/admin" });

    mockedPrisma.academicCalendarDay.upsert.mockResolvedValue({
      id: "acd-1",
      date: new Date("2026-10-12T00:00:00.000Z"),
      dayType: "HOLIDAY",
    });
    mockedPrisma.auditLog.create.mockResolvedValue({});
    mockedPrisma.academicCalendarDay.findUnique.mockResolvedValue({
      id: "acd-1",
      institutionId: "inst-1",
      date: new Date("2026-10-12T00:00:00.000Z"),
    });
    mockedPrisma.academicCalendarDay.delete.mockResolvedValue({});

    const token = app.jwt.sign({ userId: "u-admin", role: "ADMIN", institutionId: "inst-1" });

    const upsertRes = await app.inject({
      method: "PUT",
      url: "/api/admin/academic-calendar/day",
      headers: authHeader(token),
      payload: { date: "2026-10-12", dayType: "HOLIDAY", note: "Dussehra" },
    });

    expect(upsertRes.statusCode).toBe(200);
    expect(mockedPrisma.academicCalendarDay.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          institutionId_date: expect.objectContaining({ institutionId: "inst-1" }),
        }),
      })
    );

    const deleteRes = await app.inject({
      method: "DELETE",
      url: "/api/admin/academic-calendar/day/2026-10-12",
      headers: authHeader(token),
    });

    expect(deleteRes.statusCode).toBe(200);
    expect(mockedPrisma.academicCalendarDay.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          institutionId_date: expect.objectContaining({ institutionId: "inst-1" }),
        }),
      })
    );

    await app.close();
  });
});
