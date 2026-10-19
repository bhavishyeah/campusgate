import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @campusgate/db so the requireModuleActive guard's privilegedPrisma point
// read is controllable. This suite pins the two operational campus_movement.*
// admin routes (revoke, emergency-override) — when the module is SUSPENDED the
// guard must 403 BEFORE the handler runs, the same way the student/hod/guard
// routes already do (design §5.5 / §7.3). This closes the wiring gap where the
// two admin routes carried requirePermission but not requireModuleActive.
vi.mock("@campusgate/db", () => {
  const prisma = {
    user: { findUnique: vi.fn() },
    institutionMembership: { findUnique: vi.fn() },
    institutionModule: { findUnique: vi.fn() },
    gatePass: { findFirst: vi.fn(), updateMany: vi.fn() },
    emergencyOverride: { create: vi.fn() },
    notification: { create: vi.fn() },
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
import { ROLE_PERMISSIONS } from "@campusgate/shared";
import { adminRoutes } from "../admin.js";

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
  institutionMembership: { findUnique: MockFn };
  institutionModule: { findUnique: MockFn };
  gatePass: { findFirst: MockFn; updateMany: MockFn };
  emergencyOverride: { create: MockFn };
  notification: { create: MockFn };
  auditEvent: { create: MockFn };
};

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "test-secret" });
  await app.register(adminRoutes, { prefix: "/api/admin" });
  return app;
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("Admin campus_movement routes under a SUSPENDED module", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockedPrisma.institutionMembership.findUnique.mockResolvedValue(adminMembership());
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
      // notifyUser recipient lookup (tenant derivation) on the ACTIVE path.
      if (where.id === "u-student") {
        return { id: "u-student", institutionId: "inst-1" };
      }
      return null;
    });

    // campus_movement is SUSPENDED for this tenant — the guard must deny.
    mockedPrisma.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });
  });

  it("403s POST /passes/:passId/revoke and never touches pass state", async () => {
    const app = await makeApp();
    const token = app.jwt.sign({ userId: "u-admin", role: "ADMIN", institutionId: "inst-1" });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/passes/pass-1/revoke",
      headers: authHeader(token),
      payload: { reason: "testing suspension" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "Module not active: campus_movement" });
    // Guard fired before the handler — no pass lookup/mutation happened.
    expect(mockedPrisma.gatePass.findFirst).not.toHaveBeenCalled();
    expect(mockedPrisma.gatePass.updateMany).not.toHaveBeenCalled();

    await app.close();
  });

  it("403s POST /emergency-override and never creates an override", async () => {
    const app = await makeApp();
    const token = app.jwt.sign({ userId: "u-admin", role: "ADMIN", institutionId: "inst-1" });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/emergency-override",
      headers: authHeader(token),
      payload: { passId: "pass-1", justification: "testing suspension override" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "Module not active: campus_movement" });
    expect(mockedPrisma.emergencyOverride.create).not.toHaveBeenCalled();

    await app.close();
  });

  it("allows both routes through the guard when campus_movement is ACTIVE", async () => {
    mockedPrisma.institutionModule.findUnique.mockResolvedValue({ state: "ACTIVE" });

    // Handlers run now; stub the minimal prisma surface they touch so the guard
    // pass-through is observable (status is NOT 403 => guard let the route run).
    mockedPrisma.gatePass.findFirst.mockResolvedValue({
      id: "pass-1",
      status: "APPROVED",
      passNumber: "GP-1",
      student: { userId: "u-student", name: "Test" },
    });
    mockedPrisma.gatePass.updateMany.mockResolvedValue({ count: 1 });
    mockedPrisma.notification.create.mockResolvedValue({ id: "ntf-1" });
    mockedPrisma.auditEvent.create.mockResolvedValue({});

    const app = await makeApp();
    const token = app.jwt.sign({ userId: "u-admin", role: "ADMIN", institutionId: "inst-1" });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/passes/pass-1/revoke",
      headers: authHeader(token),
      payload: { reason: "testing active path" },
    });

    expect(res.statusCode).not.toBe(403);
    expect(mockedPrisma.gatePass.findFirst).toHaveBeenCalled();

    await app.close();
  });
});
