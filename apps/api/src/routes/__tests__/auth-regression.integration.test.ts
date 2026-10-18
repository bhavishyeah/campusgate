import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── FEAT-004 auth-regression suite (design §7 / §9) ────────────────────────
// Each route group flipped from the legacy requireTenantRole hook to a bare
// authenticate hook + per-route requirePermission MUST keep identical access
// outcomes. For every flipped group we prove: the role that holds the key still
// succeeds (route reached), and a role that does NOT hold it still 403s — the
// same result the old requireTenantRole produced. These are before/after
// equivalence assertions, not new behaviour.

vi.mock("@campusgate/db", () => {
  const prisma = {
    user: { findUnique: vi.fn(), findMany: vi.fn(() => Promise.resolve([])), count: vi.fn(() => Promise.resolve(0)) },
    institutionMembership: { findUnique: vi.fn() },
    // delegates the flipped handlers touch once a route is reached — stubbed to
    // benign values; the regression is about the 200-vs-403 gate, not payloads.
    emergencyAlert: { findFirst: vi.fn(() => Promise.resolve(null)), findMany: vi.fn(() => Promise.resolve([])) },
    exitReason: { findFirst: vi.fn(), findMany: vi.fn(() => Promise.resolve([])) },
    gatePass: { findFirst: vi.fn(() => Promise.resolve(null)), findMany: vi.fn(() => Promise.resolve([])), count: vi.fn(() => Promise.resolve(0)) },
    guardShift: { findFirst: vi.fn(() => Promise.resolve(null)), count: vi.fn(() => Promise.resolve(0)) },
    guardProfile: { findFirst: vi.fn() },
    hodProfile: { findFirst: vi.fn() },
    studentProfile: { findFirst: vi.fn() },
    department: { findMany: vi.fn(() => Promise.resolve([])) },
    gate: { findMany: vi.fn(() => Promise.resolve([])) },
    auditLog: { findMany: vi.fn(() => Promise.resolve([])), count: vi.fn(() => Promise.resolve(0)) },
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
import { guardRoutes } from "../guard.js";
import { studentRoutes } from "../student.js";
import { hodRoutes } from "../hod.js";
import { adminRoutes } from "../admin.js";

type MockFn = ReturnType<typeof vi.fn>;
const mocked = prisma as unknown as {
  user: { findUnique: MockFn };
  institutionMembership: { findUnique: MockFn };
  hodProfile: { findFirst: MockFn };
  guardProfile: { findFirst: MockFn };
  studentProfile: { findFirst: MockFn };
  gatePass: { findFirst: MockFn };
};

// Build the roles[].role.permissions[].permission.key shape authenticate selects.
function membershipRoles(...roleKeys: string[]) {
  return roleKeys.map((key) => ({
    role: {
      key,
      permissions: (ROLE_PERMISSIONS[key] ?? []).map((k) => ({ permission: { key: k } })),
    },
  }));
}

// Each demo user is bound to a single template role; both authenticate's user
// load and its membership load are driven off the user id so a token for that
// user resolves exactly the permission set of its role.
const USERS: Record<string, { role: string; institutionId: string }> = {
  "u-guard": { role: "GUARD", institutionId: "inst-1" },
  "u-student": { role: "STUDENT", institutionId: "inst-1" },
  "u-hod": { role: "HOD", institutionId: "inst-1" },
  "u-admin": { role: "ADMIN", institutionId: "inst-1" },
};

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "test-secret" });
  return app;
}

function tokenFor(app: Awaited<ReturnType<typeof makeApp>>, userId: string) {
  const u = USERS[userId];
  // Legacy-shape token (no permissions claim) → authenticate re-resolves from
  // the mocked membership, exactly like a freshly-issued token after the flip.
  return app.jwt.sign({ userId, role: u.role, institutionId: u.institutionId });
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("FEAT-004 auth-regression: no access change after the requirePermission flip", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocked.user.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      const u = USERS[where.id];
      if (!u) return Promise.resolve(null);
      return Promise.resolve({
        id: where.id,
        role: u.role,
        institutionId: u.institutionId,
        accountStatus: "ACTIVE",
        institution: { status: "ACTIVE" },
      });
    });

    mocked.institutionMembership.findUnique.mockImplementation(
      ({ where }: { where: { userId_institutionId: { userId: string } } }) => {
        const userId = where.userId_institutionId.userId;
        const u = USERS[userId];
        if (!u) return Promise.resolve(null);
        return Promise.resolve({
          id: `mbr-${userId}`,
          membershipStatus: "ACTIVE",
          permissionsVersion: 0,
          roles: membershipRoles(u.role),
        });
      },
    );

    // Record-level lookups so a reached handler returns cleanly (200/404), never
    // a 403 (which must come only from the permission gate).
    mocked.guardProfile.findFirst.mockResolvedValue({ id: "guard-1", userId: "u-guard" });
    mocked.hodProfile.findFirst.mockResolvedValue({ id: "hod-1", userId: "u-hod", departmentId: "dept-1" });
    mocked.studentProfile.findFirst.mockResolvedValue({ id: "stu-1", userId: "u-student", departmentId: "dept-1" });
    mocked.gatePass.findFirst.mockResolvedValue(null);
  });

  // ─── GROUP 1: GUARD ───────────────────────────────────────────────────────
  describe("guard group", () => {
    it("GUARD (holds campus_movement.gate.verify) still reaches POST /guard/verify", async () => {
      const app = await makeApp();
      await app.register(guardRoutes, { prefix: "/api/guard" });

      const res = await app.inject({
        method: "POST",
        url: "/api/guard/verify",
        headers: authHeader(tokenFor(app, "u-guard")),
        payload: { qrToken: "QR-TOKEN-123" },
      });

      // Reached the handler (pass not found → valid:false body), NOT a 403.
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("STUDENT (lacks the gate key) still 403s on POST /guard/verify", async () => {
      const app = await makeApp();
      await app.register(guardRoutes, { prefix: "/api/guard" });

      const res = await app.inject({
        method: "POST",
        url: "/api/guard/verify",
        headers: authHeader(tokenFor(app, "u-student")),
        payload: { qrToken: "QR-TOKEN-123" },
      });

      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  // ─── GROUP 2: STUDENT ─────────────────────────────────────────────────────
  describe("student group", () => {
    it("STUDENT (holds campus_movement.pass.view_own) still reaches GET /student/reasons", async () => {
      const app = await makeApp();
      await app.register(studentRoutes, { prefix: "/api/student" });

      const res = await app.inject({
        method: "GET",
        url: "/api/student/reasons",
        headers: authHeader(tokenFor(app, "u-student")),
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("GUARD (lacks pass.view_own) still 403s on GET /student/reasons", async () => {
      const app = await makeApp();
      await app.register(studentRoutes, { prefix: "/api/student" });

      const res = await app.inject({
        method: "GET",
        url: "/api/student/reasons",
        headers: authHeader(tokenFor(app, "u-guard")),
      });

      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  // ─── GROUP 3: HOD ─────────────────────────────────────────────────────────
  describe("hod group", () => {
    it("HOD (holds campus_movement.pass.view_department) still reaches GET /hod/requests", async () => {
      const app = await makeApp();
      await app.register(hodRoutes, { prefix: "/api/hod" });

      const res = await app.inject({
        method: "GET",
        url: "/api/hod/requests",
        headers: authHeader(tokenFor(app, "u-hod")),
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("STUDENT (lacks pass.view_department) still 403s on GET /hod/requests", async () => {
      const app = await makeApp();
      await app.register(hodRoutes, { prefix: "/api/hod" });

      const res = await app.inject({
        method: "GET",
        url: "/api/hod/requests",
        headers: authHeader(tokenFor(app, "u-student")),
      });

      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  // ─── GROUP 4: ADMIN ───────────────────────────────────────────────────────
  describe("admin group", () => {
    it("ADMIN (holds admin.users.view) still reaches GET /admin/users", async () => {
      const app = await makeApp();
      await app.register(adminRoutes, { prefix: "/api/admin" });

      const res = await app.inject({
        method: "GET",
        url: "/api/admin/users",
        headers: authHeader(tokenFor(app, "u-admin")),
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("HOD (lacks admin.users.view) still 403s on GET /admin/users", async () => {
      const app = await makeApp();
      await app.register(adminRoutes, { prefix: "/api/admin" });

      const res = await app.inject({
        method: "GET",
        url: "/api/admin/users",
        headers: authHeader(tokenFor(app, "u-hod")),
      });

      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });
});
