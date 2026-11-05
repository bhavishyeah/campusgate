/**
 * Fees-scoped student picker (GET /api/fees/students/lookup) — the charge-form
 * student search. @campusgate/db is MOCKED (fast, deterministic): this pins the
 * ROUTE-LAYER contract — permission gating (fees.charges.manage, NOT
 * students.view which ACCOUNTANT does not hold), the requireModuleActive("fees")
 * gate, query validation (min-2 q), tenant scoping (institutionId from the
 * token), the APPLICANT exclusion, and the minimal {id,name,enrollmentNo,program}
 * projection. Real-DB tenant isolation is proven by the fees behavioral live
 * suite. Mirrors transport-staff-reads.test.ts.
 */
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tenantCalls: string[] = [];

vi.mock("@campusgate/db", () => {
  const prisma = {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    institutionMembership: { findUnique: vi.fn() },
    institutionModule: { findUnique: vi.fn() },
    session: { findFirst: vi.fn(), update: vi.fn() },
    studentProfile: { findMany: vi.fn(), findFirst: vi.fn() },
    auditEvent: { create: vi.fn() },
  };
  return {
    prisma,
    privilegedPrisma: prisma,
    withTenant: (institutionId: string, fn: (tx: typeof prisma) => unknown) => {
      tenantCalls.push(institutionId);
      return fn(prisma);
    },
    Prisma: {
      PrismaClientKnownRequestError: class extends Error {},
    },
  };
});

import { prisma } from "@campusgate/db";
import { ROLE_PERMISSIONS } from "@campusgate/shared";
import { feesRoutes } from "../fees.js";

const m = prisma as unknown as Record<string, any>;

type RoleKey = "ADMIN" | "ACCOUNTANT" | "STUDENT" | "FEES_VIEWER";

// Permission lists per synthetic role. FEES_VIEWER is a test-only role holding
// fees.view but NOT fees.charges.manage (no real role has this split) — it proves
// the lookup is charges.manage-gated, not merely fees-scoped.
function permsFor(roleKey: RoleKey): string[] {
  if (roleKey === "FEES_VIEWER") return ["fees.view"];
  return [...(ROLE_PERMISSIONS[roleKey] ?? [])];
}

function membershipFor(roleKey: RoleKey) {
  return {
    id: `mbr-${roleKey}`,
    membershipStatus: "ACTIVE",
    permissionsVersion: 0,
    departmentScope: null,
    roles: [
      {
        role: {
          key: roleKey,
          permissions: permsFor(roleKey).map((k) => ({ permission: { key: k } })),
        },
      },
    ],
  };
}

const USERS: Record<string, { role: RoleKey; legacy: string; inst: string }> = {
  "u-acct": { role: "ACCOUNTANT", legacy: "GUARD", inst: "inst-A" },
  "u-acct-b": { role: "ACCOUNTANT", legacy: "GUARD", inst: "inst-B" },
  "u-admin": { role: "ADMIN", legacy: "ADMIN", inst: "inst-A" },
  "u-student": { role: "STUDENT", legacy: "STUDENT", inst: "inst-A" },
  "u-viewer": { role: "FEES_VIEWER", legacy: "GUARD", inst: "inst-A" },
};

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "fees-staff-reads-secret" });
  await app.register(feesRoutes, { prefix: "/api/fees" });
  return app;
}

function get(app: Awaited<ReturnType<typeof makeApp>>, userId: string, url: string) {
  const u = USERS[userId];
  const token = app.jwt.sign({ userId, role: u.legacy, institutionId: u.inst });
  return app.inject({ method: "GET", url: `/api/fees${url}`, headers: { authorization: `Bearer ${token}` } });
}

describe("Fees student picker (GET /api/fees/students/lookup)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantCalls.length = 0;
    m.user.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      const u = USERS[where.id];
      if (!u) return null;
      return {
        id: where.id,
        role: u.legacy,
        institutionId: u.inst,
        accountStatus: "ACTIVE",
        institution: { status: "ACTIVE" },
      };
    });
    m.institutionMembership.findUnique.mockImplementation(({ where }: any) => {
      const userId: string | undefined = where?.userId_institutionId?.userId;
      return membershipFor(USERS[userId ?? "u-acct"]?.role ?? "ACCOUNTANT");
    });
    m.institutionModule.findUnique.mockResolvedValue({ state: "ACTIVE" });
    m.auditEvent.create.mockResolvedValue({});
    m.studentProfile.findMany.mockResolvedValue([]);
  });

  it("role matrix: ACCOUNTANT holds fees.charges.manage but not students.view; STUDENT holds neither", () => {
    expect(ROLE_PERMISSIONS.ACCOUNTANT).toContain("fees.charges.manage");
    expect(ROLE_PERMISSIONS.ADMIN).toContain("fees.charges.manage");
    // The picker is solved by a scoped lookup, not by granting students.view.
    expect(ROLE_PERMISSIONS.ACCOUNTANT).not.toContain("students.view");
    expect(ROLE_PERMISSIONS.STUDENT).not.toContain("fees.charges.manage");
  });

  it("returns minimal rows, excludes applicants, tenant-scoped", async () => {
    m.studentProfile.findMany.mockResolvedValue([{ id: "s1", name: "Asha", enrollmentNo: "E1", program: "BCA" }]);
    const app = await makeApp();
    const res = await get(app, "u-acct-b", "/students/lookup?q=as&limit=5");
    expect(res.statusCode).toBe(200);
    expect(res.json().students).toEqual([{ id: "s1", name: "Asha", enrollmentNo: "E1", program: "BCA" }]);
    const arg = m.studentProfile.findMany.mock.calls[0][0];
    expect(arg.where.institutionId).toBe("inst-B");
    expect(arg.where.status).toEqual({ not: "APPLICANT" });
    expect(arg.take).toBe(5);
    expect(Object.keys(arg.select).sort()).toEqual(["enrollmentNo", "id", "name", "program"]);
    expect(tenantCalls).toEqual(["inst-B"]);
    expect(tenantCalls).not.toContain("inst-A");
    await app.close();
  });

  it("400 when q missing or too short", async () => {
    const app = await makeApp();
    expect((await get(app, "u-acct", "/students/lookup")).statusCode).toBe(400);
    expect((await get(app, "u-acct", "/students/lookup?q=a")).statusCode).toBe(400);
    expect(m.studentProfile.findMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("gated by fees.charges.manage: a fees.view-only role and a STUDENT are 403; ACCOUNTANT + ADMIN are 200", async () => {
    const app = await makeApp();
    expect((await get(app, "u-viewer", "/students/lookup?q=ab")).statusCode).toBe(403);
    expect((await get(app, "u-student", "/students/lookup?q=ab")).statusCode).toBe(403);
    expect((await get(app, "u-acct", "/students/lookup?q=ab")).statusCode).toBe(200);
    expect((await get(app, "u-admin", "/students/lookup?q=ab")).statusCode).toBe(200);
    await app.close();
  });

  it("module gate: 403 (no query) when fees is SUSPENDED", async () => {
    const app = await makeApp();
    m.studentProfile.findMany.mockClear();
    m.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });
    expect((await get(app, "u-acct", "/students/lookup?q=ab")).statusCode).toBe(403);
    expect(m.studentProfile.findMany).not.toHaveBeenCalled();
    await app.close();
  });
});
