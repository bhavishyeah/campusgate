import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => {
  const prisma = {
    session: { findFirst: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    institutionMembership: { findUnique: vi.fn() },
  };
  return {
    prisma,
    privilegedPrisma: prisma,
    withTenant: (_institutionId: string, fn: (tx: typeof prisma) => unknown) => fn(prisma),
    Prisma: {},
  };
});

import { prisma } from "@campusgate/db";
import { authenticate } from "../auth.js";
import { ROLE_PERMISSIONS } from "@campusgate/shared";

type MockFn = ReturnType<typeof vi.fn>;
const mocked = prisma as unknown as {
  session: { findFirst: MockFn; update: MockFn };
  user: { findUnique: MockFn };
  institutionMembership: { findUnique: MockFn };
};

// Build the membership roles[].role.permissions[].permission.key shape from a
// template role key.
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
  // Echo the resolved auth/tenant so assertions can inspect them.
  app.get("/probe", { preHandler: [authenticate] }, async (request, reply) =>
    reply.send({ auth: request.auth, tenant: request.tenant ?? null, legacyRole: request.user.role }),
  );
  return app;
}

function sign(app: Awaited<ReturnType<typeof makeApp>>, payload: Record<string, unknown>) {
  return app.jwt.sign(payload as any);
}

describe("authenticate pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.session.update.mockResolvedValue({});
  });

  it("SUPER_ADMIN branch: platform permissions, membershipId null, tenant undefined", async () => {
    const app = await makeApp();
    mocked.user.findUnique.mockResolvedValue({
      id: "u-super",
      role: "SUPER_ADMIN",
      institutionId: "inst-platform",
      accountStatus: "ACTIVE",
      institution: { status: "ACTIVE" },
    });

    const token = sign(app, {
      userId: "u-super",
      membershipId: null,
      institutionId: "inst-platform",
      roles: ["SUPER_ADMIN"],
      permissions: [],
      permissionsVersion: null,
      role: "SUPER_ADMIN",
    });

    const res = await app.inject({ method: "GET", url: "/probe", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.auth.membershipId).toBeNull();
    expect(body.auth.permissionsVersion).toBeNull();
    expect(body.auth.roles).toEqual(["SUPER_ADMIN"]);
    expect(body.auth.permissions).toEqual([...new Set(ROLE_PERMISSIONS.SUPER_ADMIN)].sort());
    // tenant MUST be left unset for a super admin
    expect(body.tenant).toBeNull();
    // membership is never loaded for SUPER_ADMIN
    expect(mocked.institutionMembership.findUnique).not.toHaveBeenCalled();
  });

  it("membership branch: resolves roles/permissions and sets tenant", async () => {
    const app = await makeApp();
    mocked.user.findUnique.mockResolvedValue({
      id: "u-hod",
      role: "HOD",
      institutionId: "inst-1",
      accountStatus: "ACTIVE",
      institution: { status: "ACTIVE" },
    });
    mocked.institutionMembership.findUnique.mockResolvedValue({
      id: "mbr-1",
      membershipStatus: "ACTIVE",
      permissionsVersion: 3,
      roles: membershipRoles("HOD"),
    });

    const token = sign(app, {
      userId: "u-hod",
      membershipId: "mbr-1",
      institutionId: "inst-1",
      roles: ["HOD"],
      permissions: [...new Set(ROLE_PERMISSIONS.HOD)].sort(),
      permissionsVersion: 3, // matches DB → fast path, token set used
      role: "HOD",
    });

    const res = await app.inject({ method: "GET", url: "/probe", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.auth.membershipId).toBe("mbr-1");
    expect(body.auth.institutionId).toBe("inst-1");
    expect(body.auth.roles).toEqual(["HOD"]);
    expect(body.auth.permissions).toEqual([...new Set(ROLE_PERMISSIONS.HOD)].sort());
    expect(body.tenant).toEqual({ institutionId: "inst-1" });
    expect(body.legacyRole).toBe("HOD");
  });

  it("permissionsVersion mismatch: re-resolves from DB to a set identical to the login-time set", async () => {
    const app = await makeApp();
    mocked.user.findUnique.mockResolvedValue({
      id: "u-admin",
      role: "ADMIN",
      institutionId: "inst-1",
      accountStatus: "ACTIVE",
      institution: { status: "ACTIVE" },
    });
    mocked.institutionMembership.findUnique.mockResolvedValue({
      id: "mbr-2",
      membershipStatus: "ACTIVE",
      permissionsVersion: 5, // DB is ahead of the token
      roles: membershipRoles("ADMIN"),
    });

    // Token signed with a STALE set + old version.
    const token = sign(app, {
      userId: "u-admin",
      membershipId: "mbr-2",
      institutionId: "inst-1",
      roles: ["ADMIN"],
      permissions: ["stale.key"],
      permissionsVersion: 4,
      role: "ADMIN",
    });

    const res = await app.inject({ method: "GET", url: "/probe", headers: { authorization: `Bearer ${token}` } });
    const body = res.json();

    // Re-resolved set must equal what login would have produced for ADMIN,
    // byte-for-byte — NOT the stale token set.
    const expected = [...new Set(ROLE_PERMISSIONS.ADMIN)].sort();
    expect(body.auth.permissions).toEqual(expected);
    expect(body.auth.permissions).not.toContain("stale.key");
    expect(body.auth.permissionsVersion).toBe(5);
  });

  it("missing membership for a non-superadmin → 401", async () => {
    const app = await makeApp();
    mocked.user.findUnique.mockResolvedValue({
      id: "u-x",
      role: "STUDENT",
      institutionId: "inst-1",
      accountStatus: "ACTIVE",
      institution: { status: "ACTIVE" },
    });
    mocked.institutionMembership.findUnique.mockResolvedValue(null);

    const token = sign(app, {
      userId: "u-x",
      membershipId: null,
      institutionId: "inst-1",
      roles: [],
      permissions: [],
      permissionsVersion: null,
      role: "STUDENT",
    });

    const res = await app.inject({ method: "GET", url: "/probe", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });

  it("suspended membership → 403 Membership suspended", async () => {
    const app = await makeApp();
    mocked.user.findUnique.mockResolvedValue({
      id: "u-s",
      role: "STUDENT",
      institutionId: "inst-1",
      accountStatus: "ACTIVE",
      institution: { status: "ACTIVE" },
    });
    mocked.institutionMembership.findUnique.mockResolvedValue({
      id: "mbr-3",
      membershipStatus: "SUSPENDED",
      permissionsVersion: 0,
      roles: membershipRoles("STUDENT"),
    });

    const token = sign(app, {
      userId: "u-s",
      membershipId: "mbr-3",
      institutionId: "inst-1",
      roles: ["STUDENT"],
      permissions: [],
      permissionsVersion: 0,
      role: "STUDENT",
    });

    const res = await app.inject({ method: "GET", url: "/probe", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "Membership suspended" });
  });

  it("membership load DB error → 500 fail-closed, no auth attached", async () => {
    const app = await makeApp();
    mocked.user.findUnique.mockResolvedValue({
      id: "u-e",
      role: "STUDENT",
      institutionId: "inst-1",
      accountStatus: "ACTIVE",
      institution: { status: "ACTIVE" },
    });
    mocked.institutionMembership.findUnique.mockRejectedValue(new Error("db down"));

    const token = sign(app, {
      userId: "u-e",
      membershipId: null,
      institutionId: "inst-1",
      roles: [],
      permissions: [],
      permissionsVersion: null,
      role: "STUDENT",
    });

    const res = await app.inject({ method: "GET", url: "/probe", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(500);
  });
});
