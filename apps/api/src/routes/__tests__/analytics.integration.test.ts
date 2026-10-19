import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => {
  const prisma = {
    user: { findUnique: vi.fn() },
    institutionMembership: { findUnique: vi.fn() },
    gatePass: { count: vi.fn(), findMany: vi.fn() },
    gateEvent: { findMany: vi.fn() },
    emergencyAlert: { findMany: vi.fn(), findFirst: vi.fn() },
    // requireModuleActive point-read: campus_movement is ACTIVE (backfilled).
    institutionModule: { findUnique: vi.fn(() => Promise.resolve({ state: "ACTIVE" })) },
  };
  return {
    prisma,
    privilegedPrisma: prisma,
    withTenant: (_institutionId: string, fn: (tx: typeof prisma) => unknown) => fn(prisma),
    Prisma: {},
  };
});

import { prisma } from "@campusgate/db";
import { ROLE_PERMISSIONS } from "@campusgate/shared";
import { adminRoutes } from "../admin.js";

// An ADMIN membership so the flipped (§7) /admin/analytics route resolves the
// campus_movement.analytics.view key.
function adminMembership() {
  return {
    id: "mbr-test",
    membershipStatus: "ACTIVE",
    permissionsVersion: 0,
    roles: [
      {
        role: {
          key: "ADMIN",
          permissions: (ROLE_PERMISSIONS.ADMIN ?? []).map((k) => ({ permission: { key: k } })),
        },
      },
    ],
  };
}

type MockFn = ReturnType<typeof vi.fn>;

const mockedPrisma = prisma as unknown as {
  user: { findUnique: MockFn };
  gatePass: { count: MockFn; findMany: MockFn };
  gateEvent: { findMany: MockFn };
  emergencyAlert: { findMany: MockFn; findFirst: MockFn };
};

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "test-secret" });
  return app;
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("Admin analytics routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (prisma as any).institutionMembership.findUnique.mockResolvedValue(adminMembership());

    mockedPrisma.user.findUnique.mockResolvedValue({
      id: "u-admin",
      role: "ADMIN",
      institutionId: "inst-1",
      accountStatus: "ACTIVE",
      institution: { status: "ACTIVE" },
    });

    mockedPrisma.gatePass.count
      .mockResolvedValueOnce(20) // total
      .mockResolvedValueOnce(14) // approved
      .mockResolvedValueOnce(3) // rejected
      .mockResolvedValueOnce(2) // revoked
      .mockResolvedValueOnce(1) // revoked while outside
      .mockResolvedValueOnce(8) // completed
      .mockResolvedValueOnce(2) // currently outside
      .mockResolvedValueOnce(1); // overdue

    mockedPrisma.gatePass.findMany
      .mockResolvedValueOnce([
        {
          id: "p1",
          createdAt: new Date("2026-10-01T09:00:00.000Z"),
          status: "COMPLETED",
          reason: { label: "Personal Work" },
          student: { department: { name: "BCA" } },
        },
        {
          id: "p2",
          createdAt: new Date("2026-10-01T12:00:00.000Z"),
          status: "REJECTED",
          reason: { label: "Medical" },
          student: { department: { name: "BBA" } },
        },
      ])
      .mockResolvedValueOnce([
        {
          actualExit: new Date("2026-10-01T10:00:00.000Z"),
          actualReturn: new Date("2026-10-01T10:45:00.000Z"),
          reason: { label: "Personal Work" },
          student: { department: { name: "BCA" } },
        },
      ]);

    mockedPrisma.gateEvent.findMany.mockResolvedValue([
      {
        eventType: "EXIT",
        timestamp: new Date("2026-10-01T10:00:00.000Z"),
        gate: { name: "Main Gate" },
      },
      {
        eventType: "RETURN",
        timestamp: new Date("2026-10-01T10:45:00.000Z"),
        gate: { name: "Main Gate" },
      },
    ]);

    mockedPrisma.emergencyAlert.findMany.mockResolvedValue([
      {
        declaredAt: new Date("2026-10-02T09:00:00.000Z"),
        resolvedAt: new Date("2026-10-02T09:30:00.000Z"),
        type: "FIRE",
        status: "RESOLVED",
      },
    ]);

    mockedPrisma.emergencyAlert.findFirst.mockResolvedValue(null);
  });

  it("returns tenant-scoped analytics payload", async () => {
    const app = await makeApp();
    await app.register(adminRoutes, { prefix: "/api/admin" });

    const token = app.jwt.sign({ userId: "u-admin", role: "ADMIN", institutionId: "inst-1" });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/analytics?from=2026-10-01T00:00:00.000Z&to=2026-10-31T23:59:59.999Z",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);

    expect(mockedPrisma.gatePass.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ student: { user: { institutionId: "inst-1" } } }),
      })
    );

    expect(mockedPrisma.gateEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ pass: { student: { user: { institutionId: "inst-1" } } } }),
      })
    );

    const body = JSON.parse(res.body) as any;
    expect(body.overview.totalRequests).toBe(20);
    expect(Array.isArray(body.departmentStats)).toBe(true);
    expect(Array.isArray(body.reasonStats)).toBe(true);
    expect(Array.isArray(body.gateStats)).toBe(true);
    expect(Array.isArray(body.hourlyExitDistribution)).toBe(true);
    expect(Array.isArray(body.dailyTrend)).toBe(true);
    expect(body.overview.revokedRequests).toBe(2);
    expect(body.overview.revokedWhileOutside).toBe(1);
    expect(body.emergencyOverview.declaredCount).toBe(1);
    expect(Array.isArray(body.emergencyByType)).toBe(true);
    expect(Array.isArray(body.emergencyDailyTrend)).toBe(true);

    await app.close();
  });
});
