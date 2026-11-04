/**
 * Library staff circulation reads (G1 GET /loans, G2 GET /reservations,
 * G3 GET /students/lookup). @campusgate/db is MOCKED (fast, deterministic): this
 * pins the ROUTE-LAYER contract — permission gating per role, the
 * requireModuleActive("library") gate, query validation, tenant scoping of every
 * query (institutionId comes from the token), and the minimal student projection.
 * Real-DB isolation is proven by the library-behavioral live suite.
 */
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tenantCalls: string[] = [];

vi.mock("@campusgate/db", () => {
  const prisma = {
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    institutionMembership: { findUnique: vi.fn() },
    institutionModule: { findUnique: vi.fn() },
    session: { findFirst: vi.fn(), update: vi.fn() },
    libraryLoan: { findMany: vi.fn(), count: vi.fn() },
    bookReservation: { findMany: vi.fn(), count: vi.fn() },
    studentProfile: { findMany: vi.fn() },
    auditEvent: { create: vi.fn() },
  };
  return {
    prisma,
    privilegedPrisma: prisma,
    withTenant: (institutionId: string, fn: (tx: typeof prisma) => unknown) => {
      tenantCalls.push(institutionId);
      return fn(prisma);
    },
    Prisma: {},
  };
});

import { prisma } from "@campusgate/db";
import { ROLE_PERMISSIONS } from "@campusgate/shared";
import { libraryRoutes } from "../library.js";

const m = prisma as unknown as Record<string, any>;

type RoleKey = "ADMIN" | "LIBRARIAN" | "STUDENT" | "ADMISSION_OFFICER";

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
          permissions: (ROLE_PERMISSIONS[roleKey] ?? []).map((k) => ({ permission: { key: k } })),
        },
      },
    ],
  };
}

const USERS: Record<string, { role: RoleKey; legacy: string; inst: string }> = {
  "u-librarian": { role: "LIBRARIAN", legacy: "GUARD", inst: "inst-A" },
  "u-librarian-b": { role: "LIBRARIAN", legacy: "GUARD", inst: "inst-B" },
  "u-admin": { role: "ADMIN", legacy: "ADMIN", inst: "inst-A" },
  "u-student": { role: "STUDENT", legacy: "STUDENT", inst: "inst-A" },
  "u-officer": { role: "ADMISSION_OFFICER", legacy: "GUARD", inst: "inst-A" },
};

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "library-staff-reads-secret" });
  await app.register(libraryRoutes, { prefix: "/api/library" });
  return app;
}

function get(app: Awaited<ReturnType<typeof makeApp>>, userId: string, url: string) {
  const u = USERS[userId];
  const token = app.jwt.sign({ userId, role: u.legacy, institutionId: u.inst });
  return app.inject({ method: "GET", url: `/api/library${url}`, headers: { authorization: `Bearer ${token}` } });
}

describe("library staff circulation reads (G1/G2/G3)", () => {
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
    // Resolve the membership of whoever is calling (keyed by the user id).
    m.institutionMembership.findUnique.mockImplementation(({ where }: any) => {
      const userId: string | undefined = where?.userId_institutionId?.userId;
      return membershipFor(USERS[userId ?? "u-librarian"]?.role ?? "LIBRARIAN");
    });
    m.institutionModule.findUnique.mockResolvedValue({ state: "ACTIVE" });
    m.auditEvent.create.mockResolvedValue({});
    m.libraryLoan.count.mockResolvedValue(0);
    m.libraryLoan.findMany.mockResolvedValue([]);
    m.bookReservation.count.mockResolvedValue(0);
    m.bookReservation.findMany.mockResolvedValue([]);
    m.studentProfile.findMany.mockResolvedValue([]);
  });

  it("LIBRARIAN does NOT hold students.view (G3 is solved by a scoped lookup, not a grant)", () => {
    expect(ROLE_PERMISSIONS.LIBRARIAN).not.toContain("students.view");
    expect(ROLE_PERMISSIONS.LIBRARIAN).toContain("library.issue");
    expect(ROLE_PERMISSIONS.LIBRARIAN).toContain("library.books.view");
  });

  describe("GET /loans", () => {
    it("returns loans with joined display fields, paging and a derived isOverdue flag", async () => {
      const past = new Date(Date.now() - 3 * 86_400_000);
      const future = new Date(Date.now() + 3 * 86_400_000);
      m.libraryLoan.count.mockResolvedValue(2);
      m.libraryLoan.findMany.mockResolvedValue([
        {
          id: "l1",
          status: "ACTIVE",
          dueDate: past,
          returnDate: null,
          student: { id: "s1", name: "Asha", enrollmentNo: "E1", program: "BCA" },
          bookCopy: { id: "c1", accessionNumber: "A-1", bookTitle: { id: "t1", title: "T", author: "X" } },
        },
        {
          id: "l2",
          status: "ACTIVE",
          dueDate: future,
          returnDate: null,
          student: { id: "s2", name: "Ravi", enrollmentNo: "E2", program: "BCA" },
          bookCopy: { id: "c2", accessionNumber: "A-2", bookTitle: { id: "t2", title: "U", author: "Y" } },
        },
      ]);
      const app = await makeApp();
      const res = await get(app, "u-librarian", "/loans?page=1&pageSize=10");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(2);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(10);
      expect(body.loans.map((l: any) => l.isOverdue)).toEqual([true, false]);
      expect(body.loans[0].student.enrollmentNo).toBe("E1");
      expect(body.loans[0].bookCopy.bookTitle.title).toBe("T");
      await app.close();
    });

    it("scopes every query to the token's institution and projects a minimal student", async () => {
      const app = await makeApp();
      await get(app, "u-librarian-b", "/loans");
      expect(tenantCalls).toContain("inst-B");
      expect(tenantCalls).not.toContain("inst-A");
      const arg = m.libraryLoan.findMany.mock.calls[0][0];
      expect(arg.where.institutionId).toBe("inst-B");
      expect(Object.keys(arg.include.student.select).sort()).toEqual(["enrollmentNo", "id", "name", "program"]);
      expect(m.libraryLoan.count.mock.calls[0][0].where.institutionId).toBe("inst-B");
      await app.close();
    });

    it("overdue=true filters to still-open loans past due, oldest due date first", async () => {
      const app = await makeApp();
      await get(app, "u-librarian", "/loans?overdue=true");
      const arg = m.libraryLoan.findMany.mock.calls[0][0];
      expect(arg.where.status).toEqual({ in: ["ACTIVE", "OVERDUE"] });
      expect(arg.where.returnDate).toBeNull();
      expect(arg.where.dueDate.lt).toBeInstanceOf(Date);
      expect(arg.orderBy[0]).toEqual({ dueDate: "asc" });
      await app.close();
    });

    it("passes status and studentId filters through", async () => {
      const app = await makeApp();
      await get(app, "u-librarian", "/loans?status=RETURNED&studentId=s9");
      const where = m.libraryLoan.findMany.mock.calls[0][0].where;
      expect(where.status).toBe("RETURNED");
      expect(where.studentId).toBe("s9");
      await app.close();
    });

    it("400s on an invalid status or pageSize", async () => {
      const app = await makeApp();
      expect((await get(app, "u-librarian", "/loans?status=BOGUS")).statusCode).toBe(400);
      expect((await get(app, "u-librarian", "/loans?pageSize=101")).statusCode).toBe(400);
      await app.close();
    });

    it("ADMIN is allowed; STUDENT (view_own only) and ADMISSION_OFFICER are 403", async () => {
      const app = await makeApp();
      expect((await get(app, "u-admin", "/loans")).statusCode).toBe(200);
      expect((await get(app, "u-student", "/loans")).statusCode).toBe(403);
      expect((await get(app, "u-officer", "/loans")).statusCode).toBe(403);
      await app.close();
    });

    it("403s when the library module is not active", async () => {
      m.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });
      const app = await makeApp();
      const res = await get(app, "u-librarian", "/loans");
      expect(res.statusCode).toBe(403);
      expect(String(res.json().error)).toMatch(/Module not active/);
      expect(m.libraryLoan.findMany).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe("GET /reservations", () => {
    it("returns the queue with joined display fields and tenant scoping", async () => {
      m.bookReservation.count.mockResolvedValue(1);
      m.bookReservation.findMany.mockResolvedValue([
        {
          id: "r1",
          status: "PENDING",
          queuePosition: 1,
          student: { id: "s1", name: "Asha", enrollmentNo: "E1", program: "BCA" },
          bookTitle: { id: "t1", title: "T", author: "X" },
          fulfilledByCopy: null,
        },
      ]);
      const app = await makeApp();
      const res = await get(app, "u-librarian-b", "/reservations?status=PENDING");
      expect(res.statusCode).toBe(200);
      expect(res.json().reservations[0].bookTitle.title).toBe("T");
      expect(res.json().total).toBe(1);
      const arg = m.bookReservation.findMany.mock.calls[0][0];
      expect(arg.where).toMatchObject({ institutionId: "inst-B", status: "PENDING" });
      expect(Object.keys(arg.include.student.select).sort()).toEqual(["enrollmentNo", "id", "name", "program"]);
      await app.close();
    });

    it("400s on an invalid status; 403 for STUDENT; 403 when module inactive", async () => {
      const app = await makeApp();
      expect((await get(app, "u-librarian", "/reservations?status=NOPE")).statusCode).toBe(400);
      expect((await get(app, "u-student", "/reservations")).statusCode).toBe(403);
      m.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });
      expect((await get(app, "u-librarian", "/reservations")).statusCode).toBe(403);
      await app.close();
    });
  });

  describe("GET /students/lookup", () => {
    it("returns only id/name/enrollmentNo/program, tenant-scoped, excluding APPLICANT-status profiles", async () => {
      m.studentProfile.findMany.mockResolvedValue([{ id: "s1", name: "Asha", enrollmentNo: "E1", program: "BCA" }]);
      const app = await makeApp();
      const res = await get(app, "u-librarian-b", "/students/lookup?q=as&limit=5");
      expect(res.statusCode).toBe(200);
      expect(res.json().students).toEqual([{ id: "s1", name: "Asha", enrollmentNo: "E1", program: "BCA" }]);
      const arg = m.studentProfile.findMany.mock.calls[0][0];
      expect(arg.where.institutionId).toBe("inst-B");
      expect(arg.where.status).toEqual({ not: "APPLICANT" });
      expect(arg.take).toBe(5);
      expect(Object.keys(arg.select).sort()).toEqual(["enrollmentNo", "id", "name", "program"]);
      await app.close();
    });

    it("400s when q is missing or shorter than 2 characters", async () => {
      const app = await makeApp();
      expect((await get(app, "u-librarian", "/students/lookup")).statusCode).toBe(400);
      expect((await get(app, "u-librarian", "/students/lookup?q=a")).statusCode).toBe(400);
      expect(m.studentProfile.findMany).not.toHaveBeenCalled();
      await app.close();
    });

    it("is gated by library.issue: STUDENT and ADMISSION_OFFICER are 403; module inactive is 403", async () => {
      const app = await makeApp();
      expect((await get(app, "u-student", "/students/lookup?q=as")).statusCode).toBe(403);
      expect((await get(app, "u-officer", "/students/lookup?q=as")).statusCode).toBe(403);
      m.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });
      expect((await get(app, "u-librarian", "/students/lookup?q=as")).statusCode).toBe(403);
      expect(m.studentProfile.findMany).not.toHaveBeenCalled();
      await app.close();
    });
  });
});
