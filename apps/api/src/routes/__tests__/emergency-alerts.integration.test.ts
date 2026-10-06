import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    emergencyAlert: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

import { prisma } from "@campusgate/db";
import { studentRoutes } from "../student.js";

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
