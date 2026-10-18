import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => {
  const prisma = {
    user: { findUnique: vi.fn() },
    institutionMembership: { findUnique: vi.fn() },
    emergencyAlert: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
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
import { studentRoutes } from "../student.js";

// Build the membership roles[].role.permissions[].permission.key shape the
// authenticate middleware selects, so the flipped (§7) routes resolve a real
// permission set for the token's role.
function membershipRoles(...roleKeys: string[]) {
  return roleKeys.map((key) => ({
    role: {
      key,
      permissions: (ROLE_PERMISSIONS[key] ?? []).map((k) => ({ permission: { key: k } })),
    },
  }));
}

type MockFn = ReturnType<typeof vi.fn>;

const mockedPrisma = prisma as unknown as {
  user: { findUnique: MockFn };
  emergencyAlert: { findFirst: MockFn; findMany: MockFn; create: MockFn; update: MockFn };
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

describe("Emergency alerts routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const roleByUser: Record<string, string> = { "u-admin": "ADMIN", "u-student": "STUDENT" };
    (prisma as any).institutionMembership.findUnique.mockImplementation(
      ({ where }: { where: { userId_institutionId: { userId: string } } }) => {
        const userId = where.userId_institutionId.userId;
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
      if (where.id === "u-admin") {
        return {
          id: "u-admin",
          role: "ADMIN",
          institutionId: "inst-1",
          accountStatus: "ACTIVE",
          institution: { status: "ACTIVE" },
        };
      }

      if (where.id === "u-student") {
        return {
          id: "u-student",
          role: "STUDENT",
          institutionId: "inst-1",
          accountStatus: "ACTIVE",
          institution: { status: "ACTIVE" },
        };
      }

      return null;
    });
  });


  it("student reads only tenant active emergency", async () => {
    const app = await makeApp();
    await app.register(studentRoutes, { prefix: "/api/student" });

    mockedPrisma.emergencyAlert.findFirst.mockResolvedValue({
      id: "em-2",
      institutionId: "inst-1",
      type: "SECURITY",
      status: "ACTIVE",
      title: "Security Lockdown",
      message: "Stay in classrooms",
      declaredAt: new Date().toISOString(),
    });

    const token = app.jwt.sign({ userId: "u-student", role: "STUDENT", institutionId: "inst-1" });

    const res = await app.inject({
      method: "GET",
      url: "/api/student/emergency/active",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.emergencyAlert.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { institutionId: "inst-1", status: "ACTIVE" } })
    );

    await app.close();
  });
});
