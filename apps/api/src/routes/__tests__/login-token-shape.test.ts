import Fastify from "fastify";
import jwt from "@fastify/jwt";
import bcrypt from "bcrypt";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => {
  const prisma = {
    department: { findMany: vi.fn(), findUnique: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    institutionMembership: { findUnique: vi.fn() },
    session: { create: vi.fn() },
    securityEvent: { create: vi.fn() },
    studentProfile: { findUnique: vi.fn() },
  };
  return {
    prisma,
    privilegedPrisma: prisma,
    withTenant: (_institutionId: string, fn: (tx: typeof prisma) => unknown) => fn(prisma),
    Prisma: {},
  };
});

import { prisma } from "@campusgate/db";
import { authRoutes } from "../auth.js";
import { ROLE_PERMISSIONS } from "@campusgate/shared";

type MockFn = ReturnType<typeof vi.fn>;
const mocked = prisma as unknown as {
  user: { findUnique: MockFn; update: MockFn };
  institutionMembership: { findUnique: MockFn };
  session: { create: MockFn };
  securityEvent: { create: MockFn };
};

function membershipRoles(...roleKeys: string[]) {
  return roleKeys.map((key) => ({
    role: {
      key,
      permissions: (ROLE_PERMISSIONS[key] ?? []).map((k) => ({ permission: { key: k } })),
    },
  }));
}

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "test-secret" });
  await app.register(authRoutes, { prefix: "/api/auth" });
  return app;
}

describe("/login signs the canonical dual-shape token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.user.update.mockResolvedValue({});
    mocked.session.create.mockResolvedValue({});
    mocked.securityEvent.create.mockResolvedValue({});
  });

  it("tenant user: token carries the permissions array AND the legacy role claim", async () => {
    const app = await makeApp();
    const passwordHash = await bcrypt.hash("secret123", 4);

    mocked.user.findUnique.mockResolvedValue({
      id: "u-hod",
      email: "hod@demo.edu",
      role: "HOD",
      institutionId: "inst-1",
      accountStatus: "ACTIVE",
      passwordHash,
      institution: { status: "ACTIVE" },
      studentProfile: null,
      hodProfile: { id: "hod-1" },
      guardProfile: null,
    });
    mocked.institutionMembership.findUnique.mockResolvedValue({
      id: "mbr-1",
      permissionsVersion: 2,
      roles: membershipRoles("HOD"),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "hod@demo.edu", password: "secret123" },
    });

    expect(res.statusCode).toBe(200);
    const { token } = res.json();
    const decoded = app.jwt.decode(token) as Record<string, unknown>;

    // legacy claim kept
    expect(decoded.role).toBe("HOD");
    // new shape
    expect(decoded.membershipId).toBe("mbr-1");
    expect(decoded.permissionsVersion).toBe(2);
    expect(decoded.roles).toEqual(["HOD"]);
    expect(decoded.permissions).toEqual([...new Set(ROLE_PERMISSIONS.HOD)].sort());
  });

  it("SUPER_ADMIN: token carries platform permissions, null membership/version, legacy role", async () => {
    const app = await makeApp();
    const passwordHash = await bcrypt.hash("secret123", 4);

    mocked.user.findUnique.mockResolvedValue({
      id: "u-super",
      email: "superadmin@campusgate.local",
      role: "SUPER_ADMIN",
      institutionId: "inst-platform",
      accountStatus: "ACTIVE",
      passwordHash,
      institution: { status: "ACTIVE" },
      studentProfile: null,
      hodProfile: null,
      guardProfile: null,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "superadmin@campusgate.local", password: "secret123" },
    });

    expect(res.statusCode).toBe(200);
    const { token } = res.json();
    const decoded = app.jwt.decode(token) as Record<string, unknown>;

    expect(decoded.role).toBe("SUPER_ADMIN");
    expect(decoded.membershipId).toBeNull();
    expect(decoded.permissionsVersion).toBeNull();
    expect(decoded.roles).toEqual(["SUPER_ADMIN"]);
    expect(decoded.permissions).toEqual([...new Set(ROLE_PERMISSIONS.SUPER_ADMIN)].sort());
    // SUPER_ADMIN never triggers a membership load at login
    expect(mocked.institutionMembership.findUnique).not.toHaveBeenCalled();
  });
});
