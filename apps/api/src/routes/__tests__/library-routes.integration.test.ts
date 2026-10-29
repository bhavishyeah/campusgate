/**
 * Phase-5 library ROUTE / permission / module-gate / audit / validation suite.
 * @campusgate/db is MOCKED (deterministic, no live pooler) so the test pins the
 * ROUTE-LAYER contract that the mocked layer can prove without a real DB:
 *   - permission gating per role (LIBRARIAN vs STUDENT vs an unprivileged user);
 *   - the requireModuleActive("library") gate (403 when library is not ACTIVE);
 *   - the Zod 400 envelope + ISBN normalization 400;
 *   - borrowing-limit 409 + its DENIED audit (deny branch writes then RETURNS);
 *   - the conditional-claim zero-rows -> 409 mapping;
 *   - the renewal-cap zero-rows -> 409 mapping.
 * The real-DB guarantees (RLS, the per-copy/per-student concurrency contract,
 * student-privacy, reservations lifecycle) are proven by the library-behavioral
 * real-DB suite; this suite proves the WIRING.
 */
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => {
  const prisma = {
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    institutionMembership: { findUnique: vi.fn() },
    institutionModule: { findUnique: vi.fn() },
    session: { findFirst: vi.fn(), update: vi.fn() },
    bookTitle: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    bookCopy: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    libraryLoan: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    bookReservation: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), aggregate: vi.fn() },
    libraryFine: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), aggregate: vi.fn() },
    studentProfile: { findFirst: vi.fn() },
    auditEvent: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  };
  class PrismaClientKnownRequestError extends Error {
    code: string;
    meta?: Record<string, unknown>;
    constructor(message: string, opts: { code: string; meta?: Record<string, unknown> }) {
      super(message);
      this.code = opts.code;
      this.meta = opts.meta;
    }
  }
  class Decimal {
    private v: string;
    constructor(value: number | string) {
      this.v = String(value);
    }
    toString() {
      return this.v;
    }
  }
  return {
    prisma,
    privilegedPrisma: prisma,
    withTenant: (_institutionId: string, fn: (tx: typeof prisma) => unknown) => fn(prisma),
    Prisma: { PrismaClientKnownRequestError, Decimal },
  };
});

import { prisma, Prisma } from "@campusgate/db";
import { PERMISSIONS, ROLE_PERMISSIONS } from "@campusgate/shared";
import { libraryRoutes } from "../library.js";

const m = prisma as unknown as Record<string, any>;

type RoleKey = "ADMIN" | "LIBRARIAN" | "STUDENT";

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

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "library-route-test-secret" });
  await app.register(libraryRoutes, { prefix: "/api/library" });
  return app;
}

const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

// Legacy role claim — LIBRARIAN has no UserRole enum member, so its users carry
// the inert GUARD legacy role (the pure-faculty/librarian precedent, design A3).
const USERS: Record<string, RoleKey> = {
  "u-admin": "ADMIN",
  "u-librarian": "LIBRARIAN",
  "u-student": "STUDENT",
};
function token(app: Awaited<ReturnType<typeof makeApp>>, userId: string) {
  const role = USERS[userId];
  const legacyRole = role === "LIBRARIAN" ? "GUARD" : role;
  return app.jwt.sign({ userId, role: legacyRole, institutionId: "inst-A" });
}

describe("Phase-5 library routes (permission + module-gate + validation + audit wiring)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.user.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      const role = USERS[where.id];
      if (!role) return null;
      const legacyRole = role === "LIBRARIAN" ? "GUARD" : role;
      return {
        id: where.id,
        role: legacyRole,
        institutionId: "inst-A",
        accountStatus: "ACTIVE",
        institution: { status: "ACTIVE" },
      };
    });
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("LIBRARIAN"));
    // Default: the library module IS active.
    m.institutionModule.findUnique.mockResolvedValue({ state: "ACTIVE" });
    m.auditEvent.create.mockResolvedValue({});
  });

  it("the 7 library.* permissions are catalogued with the documented role mapping", () => {
    const keys = new Set(PERMISSIONS.map((p) => p.key));
    for (const k of [
      "library.books.view",
      "library.books.manage",
      "library.issue",
      "library.return",
      "library.reservations.manage",
      "library.fines.manage",
      "library.view_own",
    ]) {
      expect(keys.has(k), `missing permission ${k}`).toBe(true);
    }
    // STUDENT reads only their own stuff; LIBRARIAN holds the six staff keys.
    expect(ROLE_PERMISSIONS.STUDENT).toContain("library.view_own");
    expect(ROLE_PERMISSIONS.STUDENT).not.toContain("library.issue");
    for (const k of [
      "library.books.view",
      "library.books.manage",
      "library.issue",
      "library.return",
      "library.reservations.manage",
      "library.fines.manage",
    ]) {
      expect(ROLE_PERMISSIONS.LIBRARIAN).toContain(k);
      expect(ROLE_PERMISSIONS.ADMIN).toContain(k);
    }
    // ADMIN is a staff role — it does NOT carry the student self-service key.
    expect(ROLE_PERMISSIONS.LIBRARIAN).not.toContain("library.view_own");
  });

  it("STUDENT (view_own only) is 403 on POST /loans (lacks library.issue)", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("STUDENT"));
    const res = await app.inject({
      method: "POST",
      url: "/api/library/loans",
      headers: authHeader(token(app, "u-student")),
      payload: { bookCopyId: "copy-1", studentId: "stu-1" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("module-inactive: an operational route is 403 when library is not ACTIVE (SUSPENDED)", async () => {
    const app = await makeApp();
    m.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });
    const res = await app.inject({
      method: "POST",
      url: "/api/library/loans",
      headers: authHeader(token(app, "u-librarian")),
      payload: { bookCopyId: "copy-1", studentId: "stu-1" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "Module not active: library" });

    // The student self-service catalogue is gated too.
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("STUDENT"));
    const catRes = await app.inject({
      method: "GET",
      url: "/api/library/catalogue",
      headers: authHeader(token(app, "u-student")),
    });
    expect(catRes.statusCode).toBe(403);
    await app.close();
  });

  it("Zod 400: POST /titles with a missing title returns the flattened error envelope", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/library/titles",
      headers: authHeader(token(app, "u-librarian")),
      payload: { author: "Someone" }, // title missing
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
    await app.close();
  });

  it("ISBN normalization: a present-but-not-10/13-digit ISBN is a 400", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/library/titles",
      headers: authHeader(token(app, "u-librarian")),
      payload: { title: "A Book", author: "An Author", isbn: "123-45" }, // 5 digits
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "isbn must be 10 or 13 digits" });
    await app.close();
  });

  it("ISBN normalization: a hyphenated 13-digit ISBN is accepted and stored digits-only", async () => {
    const app = await makeApp();
    m.bookTitle.findFirst.mockResolvedValue(null); // no soft-duplicate
    m.bookTitle.create.mockResolvedValue({ id: "title-1", title: "A Book" });
    const res = await app.inject({
      method: "POST",
      url: "/api/library/titles",
      headers: authHeader(token(app, "u-librarian")),
      payload: { title: "A Book", author: "An Author", isbn: "978-0-262-03384-8" },
    });
    expect(res.statusCode).toBe(201);
    expect(m.bookTitle.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isbn: "9780262033848" }) }),
    );
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "library.title.created", result: "SUCCESS" }) }),
    );
    await app.close();
  });

  it("borrowing-limit: POST /loans at the cap returns 409 + writes a DENIED library.loan.issued audit", async () => {
    const app = await makeApp();
    m.$executeRaw.mockResolvedValue(1); // advisory lock
    m.studentProfile.findFirst.mockResolvedValue({ id: "stu-1" });
    m.institutionModule.findUnique.mockResolvedValue({ state: "ACTIVE", settings: { maxActiveLoansPerStudent: 1 } });
    m.libraryLoan.count.mockResolvedValue(1); // already at the limit

    const res = await app.inject({
      method: "POST",
      url: "/api/library/loans",
      headers: authHeader(token(app, "u-librarian")),
      payload: { bookCopyId: "copy-1", studentId: "stu-1" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "borrowing limit reached" });
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "library.loan.issued", result: "DENIED" }),
      }),
    );
    // The conditional claim UPDATE must NOT have run once the limit denied.
    expect(m.$queryRaw).not.toHaveBeenCalled();
    await app.close();
  });

  it("conditional-claim zero-rows: POST /loans when the copy is not AVAILABLE returns 409 + DENIED audit", async () => {
    const app = await makeApp();
    m.$executeRaw.mockResolvedValue(1); // advisory lock
    m.studentProfile.findFirst.mockResolvedValue({ id: "stu-1" });
    m.libraryLoan.count.mockResolvedValue(0); // under the default limit
    m.$queryRaw.mockResolvedValue([]); // the claim UPDATE ... RETURNING matched zero rows

    const res = await app.inject({
      method: "POST",
      url: "/api/library/loans",
      headers: authHeader(token(app, "u-librarian")),
      payload: { bookCopyId: "copy-1", studentId: "stu-1" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "copy not available" });
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "library.loan.issued", result: "DENIED" }),
      }),
    );
    // No loan was created when the claim failed.
    expect(m.libraryLoan.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("renewal-cap zero-rows: POST /loans/:id/renew at the cap returns 409 'loan not renewable'", async () => {
    const app = await makeApp();
    m.libraryLoan.findFirst.mockResolvedValue({ id: "loan-1", bookCopyId: "copy-1", status: "ACTIVE", dueDate: new Date() });
    m.bookCopy.findFirst.mockResolvedValue({ bookTitleId: "title-1" });
    m.bookReservation.findFirst.mockResolvedValue(null); // no pending queue
    m.$queryRaw.mockResolvedValue([]); // the conditional renew matched zero rows (renewalCount >= cap)

    const res = await app.inject({
      method: "POST",
      url: "/api/library/loans/loan-1/renew",
      headers: authHeader(token(app, "u-librarian")),
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "loan not renewable" });
    await app.close();
  });

  it("issue success: a valid POST /loans creates the loan and audits library.loan.issued SUCCESS", async () => {
    const app = await makeApp();
    m.$executeRaw.mockResolvedValue(1); // advisory lock
    m.studentProfile.findFirst.mockResolvedValue({ id: "stu-1" });
    m.libraryLoan.count.mockResolvedValue(0);
    m.$queryRaw.mockResolvedValue([{ id: "copy-1", bookTitleId: "title-1" }]); // claim succeeded
    m.libraryLoan.create.mockResolvedValue({ id: "loan-1" });
    m.bookReservation.findFirst.mockResolvedValue(null); // no own PENDING reservation to fulfil

    const res = await app.inject({
      method: "POST",
      url: "/api/library/loans",
      headers: authHeader(token(app, "u-librarian")),
      payload: { bookCopyId: "copy-1", studentId: "stu-1" },
    });
    expect(res.statusCode).toBe(201);
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "library.loan.issued", result: "SUCCESS" }),
      }),
    );
    await app.close();
  });

  it("student-privacy wiring: GET /me/loans resolves the studentId from the caller's own StudentProfile", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("STUDENT"));
    m.studentProfile.findFirst.mockResolvedValue({ id: "stu-self" });
    m.libraryLoan.findMany.mockResolvedValue([]);

    const res = await app.inject({
      method: "GET",
      url: "/api/library/me/loans",
      headers: authHeader(token(app, "u-student")),
    });
    expect(res.statusCode).toBe(200);
    // The ownership lookup keys on the caller's userId, never on request input.
    expect(m.studentProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: "u-student" }) }),
    );
    // The loan query is scoped to the resolved own studentId.
    expect(m.libraryLoan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ studentId: "stu-self" }) }),
    );
    await app.close();
  });

  it("accession conflict: a P2002 on POST /titles/:id/copies maps to 409", async () => {
    const app = await makeApp();
    m.bookTitle.findFirst.mockResolvedValue({ id: "title-1", status: "ACTIVE" });
    m.bookCopy.create.mockRejectedValue(
      new (Prisma as any).PrismaClientKnownRequestError("dup", { code: "P2002", meta: { target: ["institutionId", "accessionNumber"] } }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/library/titles/title-1/copies",
      headers: authHeader(token(app, "u-librarian")),
      payload: { accessionNumber: "LIB-001" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "accession number already exists" });
    await app.close();
  });

  it("reservation-when-available: POST /reservations with an available copy returns 409 'copy available - borrow instead'", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("STUDENT"));
    m.studentProfile.findFirst.mockResolvedValue({ id: "stu-self" });
    m.bookTitle.findFirst.mockResolvedValue({ id: "title-1", status: "ACTIVE" });
    m.bookCopy.count.mockResolvedValue(2); // copies are available -> borrow instead

    const res = await app.inject({
      method: "POST",
      url: "/api/library/reservations",
      headers: authHeader(token(app, "u-student")),
      payload: { bookTitleId: "title-1" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "copy available - borrow instead" });
    expect(m.bookReservation.create).not.toHaveBeenCalled();
    await app.close();
  });
});
