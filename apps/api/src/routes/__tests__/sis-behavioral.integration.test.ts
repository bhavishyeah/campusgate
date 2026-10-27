/**
 * Phase-2 SIS behavioral ROUTE / permission / audit / history integration suite
 * (design §11, roadmap-named behavioral tests), mirroring the Phase-1
 * academics-routes.integration.test.ts: @campusgate/db is MOCKED (deterministic,
 * no live pooler) so the test pins the ROUTE-LAYER contract — permission gating,
 * the permitted-mutable-field rule, no-duplicate-identity on create/register/
 * re-import, the preserve-history write wiring, and self-service active-module
 * scoping — exactly as the live handlers wire them.
 *
 * The real-DB guarantees (RLS isolation, append-only history enforcement, the
 * gate-pass/allowance/reliability regression) are proven by the escape suite +
 * the sis-regression real-DB suite. THIS suite proves the routing/authz/audit/
 * history WIRING.
 *
 * The four roadmap-named behavioral tests (design §11):
 *   1. permitted-mutable-field enforcement (PATCH /students/:id)
 *   2. no-duplicate-identity (POST /students, /auth/register, bulk-import re-import)
 *   3. preserve-history (promote/transfer/deactivate write a history row; create audits)
 *   4. self-service active-module scoping (/me/profile own-record, /me/services ACTIVE-only)
 */
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => {
  const prisma = {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    institutionMembership: { findUnique: vi.fn() },
    studentProfile: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    studentProfileHistory: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    studentDocument: { create: vi.fn(), findMany: vi.fn() },
    program: { findFirst: vi.fn() },
    academicSession: { findFirst: vi.fn() },
    academicTerm: { findFirst: vi.fn() },
    department: { findFirst: vi.fn(), findUnique: vi.fn() },
    institutionModule: { findMany: vi.fn() },
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
import { studentAdminRoutes } from "../students.js";
import { studentRoutes } from "../student.js";
import { adminRoutes } from "../admin.js";

type MockFn = ReturnType<typeof vi.fn>;
const m = prisma as unknown as {
  user: { findUnique: MockFn; findFirst: MockFn; create: MockFn; update: MockFn };
  institutionMembership: { findUnique: MockFn };
  studentProfile: {
    findFirst: MockFn;
    findUnique: MockFn;
    findMany: MockFn;
    count: MockFn;
    create: MockFn;
    update: MockFn;
  };
  studentProfileHistory: { create: MockFn; findMany: MockFn; count: MockFn };
  studentDocument: { create: MockFn; findMany: MockFn };
  program: { findFirst: MockFn };
  academicSession: { findFirst: MockFn };
  academicTerm: { findFirst: MockFn };
  department: { findFirst: MockFn; findUnique: MockFn };
  institutionModule: { findMany: MockFn };
  auditEvent: { create: MockFn };
};

// A membership in the roles[].role.permissions[].permission.key shape that
// authenticate selects, built from the shared ROLE_PERMISSIONS map.
function membershipFor(roleKey: "ADMIN" | "STUDENT" | "HOD") {
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
  await app.register(jwt, { secret: "sis-behavioral-test-secret" });
  await app.register(studentAdminRoutes, { prefix: "/api/students" });
  await app.register(studentRoutes, { prefix: "/api/student" });
  await app.register(adminRoutes, { prefix: "/api/admin" });
  return app;
}

const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

function token(app: Awaited<ReturnType<typeof makeApp>>, userId: string, role: "ADMIN" | "STUDENT") {
  return app.jwt.sign({ userId, role, institutionId: "inst-A" });
}

// A fully-populated generalized student profile row the handlers reason over.
function studentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sp-1",
    userId: "u-student",
    institutionId: "inst-A",
    enrollmentNo: "ENR-1",
    name: "Asha",
    rollNumber: "R-1",
    section: "A",
    dob: null,
    phone: null,
    address: null,
    departmentId: "dept-A",
    program: "BCA",
    programId: "prog-A",
    semester: 2,
    status: "ACTIVE",
    admissionDate: null,
    academicSessionId: "sess-A",
    currentTermId: "term-A",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("Phase-2 SIS behavioral (routes + permission + audit + history wiring)", () => {
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
      return {
        id: where.id,
        role,
        institutionId: "inst-A",
        accountStatus: "ACTIVE",
        institution: { status: "ACTIVE" },
      };
    });
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("ADMIN"));
  });

  it("catalogue: students.* permissions are registered and bound to the template roles", () => {
    const keys = new Set(PERMISSIONS.map((p) => p.key));
    for (const k of [
      "students.view",
      "students.create",
      "students.update",
      "students.enroll",
      "students.promote",
      "students.deactivate",
      "students.view_own",
    ]) {
      expect(keys.has(k), `missing permission ${k}`).toBe(true);
    }
    // ADMIN holds every admin key + view_own; STUDENT holds only view_own.
    for (const k of [
      "students.view",
      "students.create",
      "students.update",
      "students.enroll",
      "students.promote",
      "students.deactivate",
      "students.view_own",
    ]) {
      expect(ROLE_PERMISSIONS.ADMIN).toContain(k);
    }
    expect(ROLE_PERMISSIONS.STUDENT).toContain("students.view_own");
    expect(ROLE_PERMISSIONS.STUDENT).not.toContain("students.create");
    // students.export is NOT a new key — export stays on admin.students.export.
    expect(keys.has("students.export")).toBe(false);
  });

  // ── §11 (1) permitted-mutable-field enforcement ────────────────────────────
  describe("permitted-mutable-field enforcement (PATCH /students/:id)", () => {
    it.each(["enrollmentNo", "status", "programId", "semester", "departmentId"])(
      "rejects the forbidden key %s with 400 'field not editable' and never updates",
      async (forbiddenKey) => {
        const app = await makeApp();
        const res = await app.inject({
          method: "PATCH",
          url: "/api/students/sp-1",
          headers: authHeader(token(app, "u-admin", "ADMIN")),
          payload: { [forbiddenKey]: forbiddenKey === "semester" ? 5 : "X" },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("field not editable");
        expect(m.studentProfile.update).not.toHaveBeenCalled();
        await app.close();
      },
    );

    it("with only permitted keys -> 200, updates exactly those fields + writes an UPDATED history row", async () => {
      const app = await makeApp();
      const before = studentRow();
      m.studentProfile.findFirst.mockResolvedValue(before);
      m.studentProfile.update.mockResolvedValue({ ...before, name: "Asha B", phone: "999" });
      m.studentProfileHistory.create.mockResolvedValue({});
      m.auditEvent.create.mockResolvedValue({});

      const res = await app.inject({
        method: "PATCH",
        url: "/api/students/sp-1",
        headers: authHeader(token(app, "u-admin", "ADMIN")),
        payload: { name: "Asha B", phone: "999" },
      });

      expect(res.statusCode).toBe(200);
      // Only the permitted keys reach the update data (no enrollmentNo/status/etc).
      expect(m.studentProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { name: "Asha B", phone: "999" } }),
      );
      // An UPDATED history row is written in-tx.
      expect(m.studentProfileHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ changeType: "UPDATED" }) }),
      );
      expect(m.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: "students.student.updated" }) }),
      );
      await app.close();
    });
  });

  // ── §11 (2) no-duplicate-identity ───────────────────────────────────────────
  describe("no-duplicate-identity", () => {
    it("POST /students with an existing enrollmentNo -> 409 and no second row created", async () => {
      const app = await makeApp();
      // enrollmentNo already present in tenant.
      m.studentProfile.findFirst.mockResolvedValue({ id: "sp-existing" });
      m.auditEvent.create.mockResolvedValue({});

      const res = await app.inject({
        method: "POST",
        url: "/api/students",
        headers: authHeader(token(app, "u-admin", "ADMIN")),
        payload: {
          email: "new@demo.edu",
          name: "Dup",
          enrollmentNo: "ENR-1",
          departmentId: "dept-A",
          program: "BCA",
          semester: 1,
        },
      });

      expect(res.statusCode).toBe(409);
      expect(m.user.create).not.toHaveBeenCalled();
      expect(m.studentProfile.create).not.toHaveBeenCalled();
      // A DENIED audit is still recorded.
      expect(m.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ result: "DENIED" }) }),
      );
      await app.close();
    });

    it("POST /auth/register with an enrollmentNo already present -> 409 (collision check preserved)", async () => {
      // auth.ts /register uses privilegedPrisma directly (pre-tenant); register
      // the auth routes on their own app with the mocked db.
      const authRoutes = (await import("../auth.js")).authRoutes;
      const app = Fastify();
      await app.register(jwt, { secret: "sis-behavioral-test-secret" });
      await app.register(authRoutes, { prefix: "/api/auth" });

      m.department.findUnique.mockResolvedValue({
        id: "dept-A",
        institutionId: "inst-A",
        institution: { status: "ACTIVE" },
      });
      // No existing user by email, but the enrollmentNo is already taken.
      m.user.findUnique.mockResolvedValue(null);
      m.studentProfile.findUnique.mockResolvedValue({ id: "sp-existing", enrollmentNo: "ENR-1" });

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: {
          email: "fresh@demo.edu",
          password: "password123",
          name: "Fresh",
          role: "STUDENT",
          enrollmentNo: "ENR-1",
          departmentId: "dept-A",
          program: "BCA",
          semester: 1,
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain("Enrollment number already registered");
      expect(m.user.create).not.toHaveBeenCalled();
      await app.close();
    });

    it("bulk-import re-import: an existing enrollmentNo is UPDATED not duplicated; results.updated increments", async () => {
      const app = await makeApp();
      m.institutionMembership.findUnique.mockImplementation(() => membershipFor("ADMIN"));
      // Course resolves.
      m.department.findFirst.mockResolvedValue({ id: "dept-A", institutionId: "inst-A" });
      // The enrollmentNo already belongs to a student in this tenant -> UPDATE path.
      m.studentProfile.findFirst.mockResolvedValue({ id: "sp-existing" });
      m.user.findUnique.mockImplementation(({ where }: { where: { id?: string; email?: string } }) => {
        // authenticate's user lookup
        if (where.id === "u-admin") {
          return { id: "u-admin", role: "ADMIN", institutionId: "inst-A", accountStatus: "ACTIVE", institution: { status: "ACTIVE" } };
        }
        // bulk-import's email lookup -> none (the enrollmentNo path wins anyway)
        return null;
      });
      m.program.findFirst.mockResolvedValue(null);
      m.studentProfile.update.mockResolvedValue({ id: "sp-existing" });
      m.studentProfileHistory.create.mockResolvedValue({});
      m.auditEvent.create.mockResolvedValue({});

      const res = await app.inject({
        method: "POST",
        url: "/api/admin/students/bulk-import",
        headers: authHeader(token(app, "u-admin", "ADMIN")),
        payload: {
          students: [
            {
              name: "Reimport",
              email: "reimport@demo.edu",
              enrollmentNo: "ENR-1",
              courseCode: "D_A",
              program: "BCA",
              semester: 2,
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      // The handler replies with the results summary directly.
      expect(body.updated).toBe(1);
      expect(body.created).toBe(0);
      // Update-in-place, never a second create.
      expect(m.studentProfile.update).toHaveBeenCalledTimes(1);
      expect(m.user.create).not.toHaveBeenCalled();
      // An UPDATED history row for the re-imported student.
      expect(m.studentProfileHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ changeType: "UPDATED" }) }),
      );
      // The summarizing audit uses the new students.student.imported action.
      expect(m.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: "students.student.imported" }) }),
      );
      await app.close();
    });
  });

  // ── §11 (3) preserve-history ────────────────────────────────────────────────
  describe("preserve-history: lifecycle mutations append a history row with correct snapshot", () => {
    it("promote writes a PROMOTED row capturing previous term/semester, status ACTIVE", async () => {
      const app = await makeApp();
      const before = studentRow({ currentTermId: "term-A", semester: 2 });
      m.studentProfile.findFirst.mockResolvedValue(before);
      m.academicTerm.findFirst.mockResolvedValue({ id: "term-B" });
      m.studentProfile.update.mockResolvedValue({ ...before, currentTermId: "term-B", semester: 3 });
      m.studentProfileHistory.create.mockResolvedValue({});
      m.auditEvent.create.mockResolvedValue({});

      const res = await app.inject({
        method: "POST",
        url: "/api/students/sp-1/promote",
        headers: authHeader(token(app, "u-admin", "ADMIN")),
        payload: { currentTermId: "term-B", semester: 3 },
      });

      expect(res.statusCode).toBe(200);
      expect(m.studentProfileHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            changeType: "PROMOTED",
            previousTermId: "term-A",
            newTermId: "term-B",
            previousSemester: 2,
            newSemester: 3,
            newStatus: "ACTIVE",
          }),
        }),
      );
      expect(m.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: "students.student.promoted" }) }),
      );
      await app.close();
    });

    it("transfer writes a TRANSFERRED row on the department + program axes", async () => {
      const app = await makeApp();
      const before = studentRow({ departmentId: "dept-A", programId: "prog-A", program: "BCA" });
      m.studentProfile.findFirst.mockResolvedValue(before);
      m.department.findFirst.mockResolvedValue({ id: "dept-B" });
      m.program.findFirst.mockResolvedValue({ id: "prog-B", name: "BBA" });
      m.studentProfile.update.mockResolvedValue({ ...before, departmentId: "dept-B", programId: "prog-B", program: "BBA" });
      m.studentProfileHistory.create.mockResolvedValue({});
      m.auditEvent.create.mockResolvedValue({});

      const res = await app.inject({
        method: "POST",
        url: "/api/students/sp-1/transfer",
        headers: authHeader(token(app, "u-admin", "ADMIN")),
        payload: { departmentId: "dept-B", programId: "prog-B" },
      });

      expect(res.statusCode).toBe(200);
      expect(m.studentProfileHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            changeType: "TRANSFERRED",
            previousDepartmentId: "dept-A",
            newDepartmentId: "dept-B",
            previousProgramId: "prog-A",
            newProgramId: "prog-B",
          }),
        }),
      );
      await app.close();
    });

    it("deactivate writes a DEACTIVATED row with the status flip + reason; never deletes", async () => {
      const app = await makeApp();
      const before = studentRow({ status: "ACTIVE" });
      m.studentProfile.findFirst.mockResolvedValue(before);
      m.studentProfile.update.mockResolvedValue({ ...before, status: "WITHDRAWN" });
      m.studentProfileHistory.create.mockResolvedValue({});
      m.auditEvent.create.mockResolvedValue({});

      const res = await app.inject({
        method: "POST",
        url: "/api/students/sp-1/deactivate",
        headers: authHeader(token(app, "u-admin", "ADMIN")),
        payload: { status: "WITHDRAWN", reason: "left the institution" },
      });

      expect(res.statusCode).toBe(200);
      expect(m.studentProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "WITHDRAWN" } }),
      );
      expect(m.studentProfileHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            changeType: "DEACTIVATED",
            previousStatus: "ACTIVE",
            newStatus: "WITHDRAWN",
            reason: "left the institution",
          }),
        }),
      );
      await app.close();
    });

    it("create writes a CREATED history row + audits students.student.created", async () => {
      const app = await makeApp();
      // no enrollment/email collision
      m.studentProfile.findFirst.mockResolvedValue(null);
      m.user.findFirst.mockResolvedValue(null);
      m.program.findFirst.mockResolvedValue(null);
      m.user.create.mockResolvedValue({ id: "u-new", studentProfile: studentRow({ id: "sp-new" }) });
      m.studentProfileHistory.create.mockResolvedValue({});
      m.auditEvent.create.mockResolvedValue({});

      const res = await app.inject({
        method: "POST",
        url: "/api/students",
        headers: authHeader(token(app, "u-admin", "ADMIN")),
        payload: {
          email: "new@demo.edu",
          name: "New Student",
          enrollmentNo: "ENR-NEW",
          departmentId: "dept-A",
          program: "BCA",
          semester: 1,
        },
      });

      expect(res.statusCode).toBe(201);
      expect(m.studentProfileHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ changeType: "CREATED" }) }),
      );
      expect(m.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: "students.student.created", result: "SUCCESS" }),
        }),
      );
      await app.close();
    });
  });

  // ── §11 (4) self-service active-module scoping ──────────────────────────────
  describe("self-service scoping (/api/student/me/*)", () => {
    it("GET /me/profile resolves the caller's OWN record via userId (never a request id)", async () => {
      const app = await makeApp();
      m.institutionMembership.findUnique.mockImplementation(() => membershipFor("STUDENT"));
      // getStudentInTenant resolves by the authenticated userId.
      m.studentProfile.findFirst.mockResolvedValue(studentRow({ userId: "u-student" }));
      m.department.findFirst.mockResolvedValue({ id: "dept-A", name: "CS", code: "CS" });
      m.program.findFirst.mockResolvedValue({ id: "prog-A", name: "BCA", code: "BCA" });
      m.academicSession.findFirst.mockResolvedValue({ id: "sess-A", name: "2026-2027" });
      m.academicTerm.findFirst.mockResolvedValue({ id: "term-A", name: "Sem 1", ordinal: 1 });

      const res = await app.inject({
        method: "GET",
        url: "/api/student/me/profile",
        headers: authHeader(token(app, "u-student", "STUDENT")),
      });

      expect(res.statusCode).toBe(200);
      // Ownership is resolved by userId, not a request-supplied id.
      expect(m.studentProfile.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: "u-student" }) }),
      );
      expect(res.json().id).toBe("sp-1");
      await app.close();
    });

    it("GET /me/services lists only ACTIVE-module services; a SUSPENDED module never appears", async () => {
      const app = await makeApp();
      m.institutionMembership.findUnique.mockImplementation(() => membershipFor("STUDENT"));
      m.studentProfile.findFirst.mockResolvedValue(studentRow({ userId: "u-student" }));
      // Only ACTIVE modules are returned by the query (the handler filters on
      // state: 'ACTIVE'); assert the where-clause pins that, and the mapped shape.
      m.institutionModule.findMany.mockResolvedValue([{ moduleKey: "campus_movement" }]);

      const res = await app.inject({
        method: "GET",
        url: "/api/student/me/services",
        headers: authHeader(token(app, "u-student", "STUDENT")),
      });

      expect(res.statusCode).toBe(200);
      expect(m.institutionModule.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ state: "ACTIVE" }) }),
      );
      const services = res.json().services;
      expect(services).toHaveLength(1);
      expect(services[0].module).toBe("campus_movement");
      expect(services[0].entryPoints.length).toBeGreaterThan(0);
      await app.close();
    });

    it("GET /me/services with NO active modules returns an empty service list", async () => {
      const app = await makeApp();
      m.institutionMembership.findUnique.mockImplementation(() => membershipFor("STUDENT"));
      m.studentProfile.findFirst.mockResolvedValue(studentRow({ userId: "u-student" }));
      m.institutionModule.findMany.mockResolvedValue([]); // nothing ACTIVE

      const res = await app.inject({
        method: "GET",
        url: "/api/student/me/services",
        headers: authHeader(token(app, "u-student", "STUDENT")),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().services).toEqual([]);
      await app.close();
    });

    it("an admin SIS route is 403 for a STUDENT (students.view not held)", async () => {
      const app = await makeApp();
      m.institutionMembership.findUnique.mockImplementation(() => membershipFor("STUDENT"));

      const res = await app.inject({
        method: "GET",
        url: "/api/students",
        headers: authHeader(token(app, "u-student", "STUDENT")),
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });
});
