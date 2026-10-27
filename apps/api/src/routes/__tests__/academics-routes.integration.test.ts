/**
 * Phase-1 academics ROUTE / permission / audit integration suite (design §10.6),
 * mirroring the existing admin-config-calendar.integration.test.ts: @campusgate/db
 * is MOCKED (deterministic, no live pooler) so the test pins the ROUTE-LAYER
 * contract — permission gating, the success-plus-warnings envelope, the audit
 * call, and the cross-tenant not-found shape — exactly as the live handlers wire
 * them. The real-DB guarantees (RLS isolation, append-only revisions, audit-row
 * persistence, the session state machine) are proven by the escape + academics-
 * behavioral real-DB suites; this suite proves the routing/authz/audit WIRING.
 *
 * It proves:
 *   - an ADMIN with academics.* can create a session/term/program/calendar entry,
 *     each returning the { <resource>, warnings } envelope and auditing the
 *     expected academics.* action (asserted on the recordAuditEvent/auditEvent.create);
 *   - a user WITHOUT academics.sessions.manage gets 403 on a manage route;
 *   - a STUDENT with only academics.view reads the current session but a mutate
 *     attempt is 403;
 *   - a cross-tenant read of a row the tenant tx cannot see is 404.
 */
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => {
  const prisma = {
    user: { findUnique: vi.fn() },
    institutionMembership: { findUnique: vi.fn() },
    academicSession: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    academicTerm: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    program: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    department: { findFirst: vi.fn() },
    academicCalendarDay: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    academicCalendarDayRevision: { create: vi.fn() },
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
import { PERMISSIONS, ROLE_PERMISSIONS } from "@campusgate/shared";
import { adminRoutes } from "../admin.js";
import { studentRoutes } from "../student.js";

type MockFn = ReturnType<typeof vi.fn>;
const m = prisma as unknown as {
  user: { findUnique: MockFn };
  institutionMembership: { findUnique: MockFn };
  academicSession: { findMany: MockFn; findFirst: MockFn; create: MockFn; update: MockFn };
  academicTerm: { findMany: MockFn; findFirst: MockFn; create: MockFn; update: MockFn };
  program: { findMany: MockFn; findFirst: MockFn; create: MockFn; update: MockFn };
  department: { findFirst: MockFn };
  academicCalendarDay: { findMany: MockFn; findFirst: MockFn; create: MockFn; update: MockFn; delete: MockFn };
  academicCalendarDayRevision: { create: MockFn };
  auditEvent: { create: MockFn };
};

// A membership in the roles[].role.permissions[].permission.key shape that
// authenticate selects, built from the shared ROLE_PERMISSIONS map.
function membershipFor(roleKey: "ADMIN" | "STUDENT") {
  return {
    id: `mbr-${roleKey}`,
    membershipStatus: "ACTIVE",
    permissionsVersion: 0,
    departmentScope: null,
    roles: [
      {
        role: {
          key: roleKey,
          permissions: (ROLE_PERMISSIONS[roleKey] ?? []).map((k) => ({ permission: { key: k } })),
        },
      },
    ],
  };
}

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "academics-route-test-secret" });
  await app.register(adminRoutes, { prefix: "/api/admin" });
  await app.register(studentRoutes, { prefix: "/api/student" });
  return app;
}

const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

function token(app: Awaited<ReturnType<typeof makeApp>>, userId: string, role: "ADMIN" | "STUDENT") {
  return app.jwt.sign({ userId, role, institutionId: "inst-A" });
}

describe("Phase-1 academics routes (permission + audit wiring)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // authenticate: user + membership in caller tenant.
    m.user.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      const roleByUser: Record<string, "ADMIN" | "STUDENT"> = {
        "u-admin": "ADMIN",
        "u-student": "STUDENT",
      };
      const role = roleByUser[where.id];
      if (!role) return null;
      return { id: where.id, role, institutionId: "inst-A", accountStatus: "ACTIVE", institution: { status: "ACTIVE" } };
    });
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("ADMIN"));
  });

  it("the four academics.* permissions are in the catalogue and bound to ADMIN", () => {
    const keys = new Set(PERMISSIONS.map((p) => p.key));
    for (const k of ["academics.sessions.manage", "academics.programs.manage", "academics.calendar.manage", "academics.view"]) {
      expect(keys.has(k), `missing permission ${k}`).toBe(true);
      expect(ROLE_PERMISSIONS.ADMIN).toContain(k);
    }
    // academics.view is bound to every tenant template role.
    for (const role of ["STUDENT", "GUARD", "HOD"] as const) {
      expect(ROLE_PERMISSIONS[role]).toContain("academics.view");
    }
  });

  it("ADMIN creates a session and the handler audits academics.session.created in-tx", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("ADMIN"));
    m.academicSession.findFirst.mockResolvedValue(null); // no name dup
    m.academicSession.create.mockResolvedValue({ id: "sess-1", name: "2026-2027", structureType: "SEMESTER" });
    m.auditEvent.create.mockResolvedValue({});

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/academic/sessions",
      headers: authHeader(token(app, "u-admin", "ADMIN")),
      payload: { name: "2026-2027", structureType: "SEMESTER", startDate: "2026-07-01", endDate: "2027-06-30" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ session: { id: "sess-1" }, warnings: [] });
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "academics.session.created", result: "SUCCESS", resourceId: "sess-1" }) }),
    );
    await app.close();
  });

  it("ADMIN creates a program and the handler audits academics.program.created", async () => {
    const app = await makeApp();
    m.department.findFirst.mockResolvedValue({ id: "dept-A", institutionId: "inst-A" });
    m.program.findFirst.mockResolvedValue(null); // no code dup
    m.program.create.mockResolvedValue({ id: "prog-1", code: "BCA", name: "BCA" });
    m.auditEvent.create.mockResolvedValue({});

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/academic/programs",
      headers: authHeader(token(app, "u-admin", "ADMIN")),
      payload: { departmentId: "dept-A", name: "BCA", code: "BCA", duration: 6, durationUnit: "TERMS" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ program: { id: "prog-1" }, warnings: [] });
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "academics.program.created", resourceId: "prog-1" }) }),
    );
    await app.close();
  });

  it("ADMIN PUT calendar day writes an append-only revision + audits academics.calendar.updated", async () => {
    const app = await makeApp();
    m.academicCalendarDay.findFirst.mockResolvedValue(null); // CREATE path
    m.academicCalendarDay.create.mockResolvedValue({ id: "acd-1", date: new Date("2026-09-01"), dayType: "HOLIDAY" });
    m.academicCalendarDayRevision.create.mockResolvedValue({ id: "rev-1" });
    m.auditEvent.create.mockResolvedValue({});

    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/academic-calendar/day",
      headers: authHeader(token(app, "u-admin", "ADMIN")),
      payload: { date: "2026-09-01", dayType: "HOLIDAY", note: "Founders Day" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ calendarDay: { id: "acd-1" }, warnings: [] });
    // Append-only revision written in-tenant BEFORE the mutation.
    expect(m.academicCalendarDayRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ changeType: "CREATE", institutionId: "inst-A" }) }),
    );
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "academics.calendar.updated", resourceType: "AcademicCalendarDay" }) }),
    );
    await app.close();
  });

  it("a user WITHOUT academics.sessions.manage is 403 on the manage route", async () => {
    const app = await makeApp();
    // STUDENT membership: holds academics.view, NOT academics.sessions.manage.
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("STUDENT"));

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/academic/sessions",
      headers: authHeader(token(app, "u-student", "STUDENT")),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("a STUDENT with academics.view reads the current session but a mutate attempt is 403", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("STUDENT"));
    m.academicSession.findFirst.mockResolvedValue({
      id: "sess-active",
      institutionId: "inst-A",
      status: "ACTIVE",
      name: "2026-2027",
      terms: [],
    });

    // Read (academics.view) => 200 with the ACTIVE session envelope.
    const readRes = await app.inject({
      method: "GET",
      url: "/api/student/me/academic/current-session",
      headers: authHeader(token(app, "u-student", "STUDENT")),
    });
    expect(readRes.statusCode).toBe(200);
    expect(readRes.json().session.status).toBe("ACTIVE");
    expect(readRes.json().warnings).toEqual([]);

    // Mutate (needs academics.sessions.manage) => 403.
    const mutateRes = await app.inject({
      method: "POST",
      url: "/api/admin/academic/sessions",
      headers: authHeader(token(app, "u-student", "STUDENT")),
      payload: { name: "illegal", structureType: "ANNUAL", startDate: "2026-07-01", endDate: "2027-06-30" },
    });
    expect(mutateRes.statusCode).toBe(403);
    await app.close();
  });

  it("cross-tenant read: a session invisible to the tenant tx (findFirst null) is 404", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("ADMIN"));
    // RLS + withTenant in production hides the other tenant's row; the mock models
    // that as findFirst => null, which the handler maps to 404.
    m.academicSession.findFirst.mockResolvedValue(null);

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/academic/sessions/foreign-session-id",
      headers: authHeader(token(app, "u-admin", "ADMIN")),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
