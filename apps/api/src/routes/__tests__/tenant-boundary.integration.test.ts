import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => {
  const prisma = {
    user: { findUnique: vi.fn() },
    institutionMembership: { findUnique: vi.fn() },
    institution: { count: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    gatePass: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    exitReason: { findMany: vi.fn() },
    hodProfile: { findFirst: vi.fn() },
  };
  return {
    prisma,
    // privilegedPrisma shares the same mocked delegates: the authenticate
    // middleware and platform routes call it, and the assertions inspect the
    // same objects.
    privilegedPrisma: prisma,
    // withTenant runs the callback immediately against the mocked prisma so
    // tenant-route DB calls land on the delegates the assertions inspect.
    withTenant: (_institutionId: string, fn: (tx: typeof prisma) => unknown) => fn(prisma),
    Prisma: {},
  };
});

import { prisma } from "@campusgate/db";
import { ROLE_PERMISSIONS } from "@campusgate/shared";

// Build the membership roles[].role.permissions[].permission.key shape the
// authenticate middleware selects, from a template role key. After the §7 flip
// the migrated routes read request.auth.permissions, so the mocked membership
// MUST carry the role template so requirePermission resolves a real key set.
function membershipRoles(...roleKeys: string[]) {
  return roleKeys.map((key) => ({
    role: {
      key,
      permissions: (ROLE_PERMISSIONS[key] ?? []).map((k) => ({ permission: { key: k } })),
    },
  }));
}
import { studentRoutes } from "../student.js";
import { platformRoutes } from "../platform.js";
import { guardRoutes } from "../guard.js";
import { hodRoutes } from "../hod.js";

type MockFn = ReturnType<typeof vi.fn>;

const mockedPrisma = prisma as unknown as {
  user: { findUnique: MockFn };
  institution: { count: MockFn; findMany: MockFn; findUnique: MockFn; create: MockFn; update: MockFn };
  gatePass: { count: MockFn; findFirst: MockFn; findMany: MockFn };
  exitReason: { findMany: MockFn };
  hodProfile: { findFirst: MockFn };
};

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "test-secret" });
  return app;
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("Tenant boundary enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Role-aware membership so the flipped (§7) tenant routes resolve the
    // right permission set. SUPER_ADMIN has no membership (null).
    mockedPrisma.institutionMembership.findUnique.mockImplementation(
      ({ where }: { where: { userId_institutionId: { userId: string } } }) => {
        const userId = where.userId_institutionId.userId;
        const roleByUser: Record<string, string> = {
          "u-admin": "ADMIN",
          "u-guard": "GUARD",
          "u-hod": "HOD",
        };
        const roleKey = roleByUser[userId];
        if (!roleKey) return Promise.resolve(null);
        return Promise.resolve({
          id: `mbr-${userId}`,
          membershipStatus: "ACTIVE",
          permissionsVersion: 0,
          roles: membershipRoles(roleKey),
        });
      },
    );

    mockedPrisma.user.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      const id = where.id;

      if (id === "u-super") {
        return {
          id,
          role: "SUPER_ADMIN",
          institutionId: "inst-platform",
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

      if (id === "u-guard") {
        return {
          id,
          role: "GUARD",
          institutionId: "inst-1",
          accountStatus: "ACTIVE",
          institution: { status: "ACTIVE" },
        };
      }

      if (id === "u-hod") {
        return {
          id,
          role: "HOD",
          institutionId: "inst-1",
          accountStatus: "ACTIVE",
          institution: { status: "ACTIVE" },
        };
      }

      return null;
    });
  });

  it("blocks SUPER_ADMIN from tenant endpoints", async () => {
    const app = await makeApp();
    await app.register(studentRoutes, { prefix: "/api/student" });

    const token = app.jwt.sign({
      userId: "u-super",
      role: "SUPER_ADMIN",
      institutionId: "inst-platform",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/student/reasons",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(403);
    expect(mockedPrisma.exitReason.findMany).not.toHaveBeenCalled();

    await app.close();
  });

  it("blocks tenant ADMIN from platform endpoints", async () => {
    const app = await makeApp();
    await app.register(platformRoutes, { prefix: "/api/platform" });

    const token = app.jwt.sign({
      userId: "u-admin",
      role: "ADMIN",
      institutionId: "inst-1",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/platform/stats",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(403);
    expect(mockedPrisma.institution.count).not.toHaveBeenCalled();

    await app.close();
  });

  it("scopes guard QR verify by authenticated institution", async () => {
    const app = await makeApp();
    await app.register(guardRoutes, { prefix: "/api/guard" });

    mockedPrisma.gatePass.findFirst.mockResolvedValue(null);

    const token = app.jwt.sign({
      userId: "u-guard",
      role: "GUARD",
      institutionId: "inst-1",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/guard/verify",
      headers: authHeader(token),
      payload: { qrToken: "QR-TOKEN-123" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.gatePass.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          qrToken: "QR-TOKEN-123",
          student: { user: { institutionId: "inst-1" } },
        }),
      })
    );

    await app.close();
  });

  it("scopes HOD request listing by department + institution", async () => {
    const app = await makeApp();
    await app.register(hodRoutes, { prefix: "/api/hod" });

    mockedPrisma.hodProfile.findFirst.mockResolvedValue({
      id: "hod-1",
      userId: "u-hod",
      departmentId: "dept-1",
    });
    mockedPrisma.gatePass.findMany.mockResolvedValue([]);

    const token = app.jwt.sign({
      userId: "u-hod",
      role: "HOD",
      institutionId: "inst-1",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/hod/requests",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.gatePass.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "PENDING",
          student: {
            departmentId: "dept-1",
            user: { institutionId: "inst-1" },
          },
        },
      })
    );

    await app.close();
  });
});
