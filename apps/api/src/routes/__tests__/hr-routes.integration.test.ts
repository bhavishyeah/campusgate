/**
 * Phase-9.2 HR Management ROUTE / permission / module / audit WIRING suite
 * (design §9 matrix, §10 fast/mocked bullet; FEAT-003), mirroring
 * exams-routes.integration.test.ts: @campusgate/db is MOCKED (deterministic, no
 * live pooler) so this pins the ROUTE-LAYER contract —
 *   - permission gating per role across EVERY permission group (AC-3):
 *     a caller lacking the route key, a STUDENT token, and a FACULTY-only token
 *     all get 403;
 *   - the module gate: hr_management not ACTIVE → 403;
 *   - Zod 400 validation shapes (bad enum / date / range / :date path);
 *   - the lifecycle deny branches: approve beyond balance → 422 AND NO status
 *     flip (no APPROVED write) + a DENIED hr.leave.approved audit (finding #3);
 *     404 for a missing employee / contract / shift / leave id;
 *   - audit emission: the supersede path writes BOTH hr.contract.superseded and
 *     hr.contract.created SUCCESS audits in one tx (finding #2);
 *   - the H1 role-grant path: POST /employees issues a membershipRole.upsert
 *     binding the target user to the resolved EMPLOYEE roleId in the same tx;
 *     a missing EMPLOYEE role → 500 role_missing with the whole tx rolled back
 *     (no hr_employees row, no committed audit); a freshly-created employee
 *     token resolves hr.view_own so GET /me/employee is 200 while a staff-only
 *     user (no employee row) is 404.
 *
 * The real-DB guarantees (RLS, append-only history, the advisory-lock approve
 * concurrency, the persisted lifecycle triggers) are proven by the live HR
 * behavioral suite; this suite proves the WIRING. It is NOT in
 * vitest.live-db-suites.ts, so it runs in the fast `npm test` pass.
 */
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => {
  const prisma = {
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    institutionMembership: { findUnique: vi.fn(), upsert: vi.fn() },
    institutionModule: { findUnique: vi.fn() },
    session: { findFirst: vi.fn(), update: vi.fn() },
    role: { findFirst: vi.fn() },
    membershipRole: { upsert: vi.fn() },
    hrEmployee: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    hrContract: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    hrLeavePolicy: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    hrLeaveApplication: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      aggregate: vi.fn(),
    },
    hrShift: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    hrEmployeeAttendance: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    hrEmployeeAttendanceHistory: { create: vi.fn() },
    auditEvent: { create: vi.fn() },
    $executeRaw: vi.fn(),
  };
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    prisma,
    privilegedPrisma: prisma,
    withTenant: (_institutionId: string, fn: (tx: typeof prisma) => unknown) => fn(prisma),
    Prisma: { PrismaClientKnownRequestError },
  };
});

import { prisma } from "@campusgate/db";
import { ROLE_PERMISSIONS } from "@campusgate/shared";
import { hrRoutes } from "../hr.js";

type MockFn = ReturnType<typeof vi.fn>;
const m = prisma as unknown as Record<string, Record<string, MockFn>>;

// Role keys exercised by the matrix. HR_MANAGER + EMPLOYEE are the Phase-9
// additive template roles; STUDENT/FACULTY hold NO hr.* key.
type RoleKey = "ADMIN" | "HR_MANAGER" | "EMPLOYEE" | "STUDENT" | "FACULTY";

// userId → role for both the user.findUnique (legacy role) and the membership
// resolve. The legacy `role` claim is decorative for these routes; the
// permission decision is driven by the resolved membership roles.
const USERS: Record<string, RoleKey> = {
  "u-admin": "ADMIN",
  "u-hrmgr": "HR_MANAGER",
  "u-emp": "EMPLOYEE",
  "u-student": "STUDENT",
  "u-faculty": "FACULTY",
};

// A legacy UserRole value to stamp on the token/user row (must be a real
// UserRole). HR_MANAGER/EMPLOYEE have no legacy equivalent, so map them onto an
// innocuous tenant role — the routes never read the legacy claim for authz.
const LEGACY_ROLE: Record<RoleKey, string> = {
  ADMIN: "ADMIN",
  HR_MANAGER: "ADMIN",
  EMPLOYEE: "STUDENT",
  STUDENT: "STUDENT",
  FACULTY: "GUARD",
};

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
  await app.register(jwt, { secret: "hr-route-test-secret" });
  await app.register(hrRoutes, { prefix: "/api/hr" });
  return app;
}

const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

function token(app: Awaited<ReturnType<typeof makeApp>>, userId: string) {
  const role = USERS[userId];
  return app.jwt.sign({ userId, role: LEGACY_ROLE[role], institutionId: "inst-A" });
}

const auth = (app: Awaited<ReturnType<typeof makeApp>>, userId: string) =>
  authHeader(token(app, userId));

describe("Phase-9 HR routes (permission + module + validation + lifecycle + audit wiring)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.user.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      const role = USERS[where.id];
      if (!role) return null;
      return {
        id: where.id,
        role: LEGACY_ROLE[role],
        institutionId: "inst-A",
        accountStatus: "ACTIVE",
        institution: { status: "ACTIVE" },
      };
    });
    m.institutionMembership.findUnique.mockImplementation(
      ({ where }: { where: { userId_institutionId?: { userId: string } } }) => {
        const userId = where.userId_institutionId?.userId ?? "u-admin";
        return membershipFor(USERS[userId] ?? "ADMIN");
      },
    );
    // Module gate: hr_management ACTIVE by default.
    m.institutionModule.findUnique.mockResolvedValue({ state: "ACTIVE" });
    m.auditEvent.create.mockResolvedValue({});
  });

  // ─── Catalogue bindings (AC-3 role separation) ──────────────────────────────
  it("the hr.* role bindings are catalogued: staff keys on ADMIN+HR_MANAGER, only hr.view_own on EMPLOYEE, nothing on STUDENT/FACULTY", () => {
    const staffKeys = [
      "hr.employees.manage",
      "hr.contracts.manage",
      "hr.leave.manage",
      "hr.attendance.manage",
      "hr.reports.view",
      "hr.directory.view",
    ];
    for (const k of staffKeys) {
      expect(ROLE_PERMISSIONS.ADMIN).toContain(k);
      expect(ROLE_PERMISSIONS.HR_MANAGER).toContain(k);
    }
    // EMPLOYEE holds the HR self key and NO HR staff key. (EMPLOYEE also holds
    // the Phase-9.7 baseline documents.download like every non-applicant tenant
    // role, so this asserts the HR invariant by membership rather than exact
    // array-equality on the now cross-module EMPLOYEE key set.)
    expect(ROLE_PERMISSIONS.EMPLOYEE).toContain("hr.view_own");
    for (const k of staffKeys) {
      expect(ROLE_PERMISSIONS.EMPLOYEE).not.toContain(k);
    }
    // ADMIN/HR_MANAGER never get the self-service key; STUDENT/FACULTY get nothing.
    expect(ROLE_PERMISSIONS.ADMIN).not.toContain("hr.view_own");
    for (const k of [...staffKeys, "hr.view_own"]) {
      expect(ROLE_PERMISSIONS.STUDENT ?? []).not.toContain(k);
      expect(ROLE_PERMISSIONS.FACULTY ?? []).not.toContain(k);
    }
  });

  // ─── Authz: 403 across every permission group ───────────────────────────────
  // One representative route per permission group; a STUDENT and a FACULTY-only
  // token (neither holds any hr.* key) must be 403 on all of them.
  const groupRoutes: Array<{ group: string; method: "GET" | "POST"; url: string; body?: unknown }> = [
    { group: "hr.employees.manage", method: "POST", url: "/api/hr/employees", body: {} },
    { group: "hr.contracts.manage", method: "POST", url: "/api/hr/employees/e1/contracts", body: {} },
    { group: "hr.leave.manage", method: "POST", url: "/api/hr/leave/a1/approve", body: {} },
    { group: "hr.attendance.manage", method: "POST", url: "/api/hr/shifts", body: {} },
    { group: "hr.directory.view", method: "GET", url: "/api/hr/employees" },
    { group: "hr.reports.view", method: "GET", url: "/api/hr/reports/leave-summary" },
    { group: "hr.view_own", method: "GET", url: "/api/hr/me/employee" },
  ];

  for (const r of groupRoutes) {
    it(`${r.method} ${r.url} (${r.group}) is 403 for a STUDENT token`, async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: r.method,
        url: r.url,
        headers: auth(app, "u-student"),
        ...(r.body !== undefined ? { payload: r.body } : {}),
      });
      expect(res.statusCode).toBe(403);
    });

    it(`${r.method} ${r.url} (${r.group}) is 403 for a FACULTY-only token`, async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: r.method,
        url: r.url,
        headers: auth(app, "u-faculty"),
        ...(r.body !== undefined ? { payload: r.body } : {}),
      });
      expect(res.statusCode).toBe(403);
    });
  }

  it("a staff route is 403 for an EMPLOYEE token (holds only hr.view_own)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/hr/employees",
      headers: auth(app, "u-emp"),
    });
    expect(res.statusCode).toBe(403);
  });

  it("the self-service /me route is 403 for a staff HR_MANAGER (lacks hr.view_own)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/hr/me/employee",
      headers: auth(app, "u-hrmgr"),
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── Module gate ─────────────────────────────────────────────────────────────
  it("every hr route is 403 when hr_management is not ACTIVE (even for an authorized actor)", async () => {
    m.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/hr/employees",
      headers: auth(app, "u-admin"),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("hr_management");
  });

  it("is 403 when the module row is entirely absent (fail-closed)", async () => {
    m.institutionModule.findUnique.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/hr/employees",
      headers: auth(app, "u-admin"),
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── Validation 400 shapes ───────────────────────────────────────────────────
  it("POST /employees 400 (flatten shape) on a bad body — missing/invalid fields", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hr/employees",
      headers: auth(app, "u-admin"),
      payload: { userId: "", employmentType: "NOPE", joiningDate: "not-a-date" },
    });
    expect(res.statusCode).toBe(400);
    // Zod flatten() shape: { error: { formErrors, fieldErrors } }.
    expect(res.json().error).toHaveProperty("fieldErrors");
  });

  it("PUT /leave-policies/:leaveType 400 on a bad leaveType enum in the path", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/hr/leave-policies/NOT_A_TYPE",
      headers: auth(app, "u-admin"),
      payload: { annualQuotaDays: 24, accrualRule: "ANNUAL_LUMP_SUM" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("invalid leaveType");
  });

  it("POST /employees/:id/leave 400 when start/end span two calendar years", async () => {
    m.hrEmployee.findFirst.mockResolvedValue({ id: "e1", institutionId: "inst-A" });
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hr/employees/e1/leave",
      headers: auth(app, "u-admin"),
      payload: {
        leaveType: "CASUAL",
        startDate: "2026-12-30",
        endDate: "2027-01-02",
        reason: "spanning",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toHaveProperty("fieldErrors");
  });

  it("GET /reports/attendance-summary 400 when the range exceeds 366 days", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/hr/reports/attendance-summary?from=2024-01-01&to=2026-01-01",
      headers: auth(app, "u-admin"),
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH /employees/:id/attendance/:date 400 on a malformed :date path (not YYYY-MM-DD)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/hr/employees/e1/attendance/2026-13-99",
      headers: auth(app, "u-admin"),
      payload: { status: "PRESENT" },
    });
    expect(res.statusCode).toBe(400);
  });

  // ─── 404 not-found branches ──────────────────────────────────────────────────
  it("POST /employees/:id/contracts 404 + DENIED audit when the employee is missing", async () => {
    m.hrEmployee.findFirst.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hr/employees/missing/contracts",
      headers: auth(app, "u-admin"),
      payload: { contractType: "PERMANENT", startDate: "2026-01-01" },
    });
    expect(res.statusCode).toBe(404);
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "hr.contract.created", result: "DENIED" }),
      }),
    );
  });

  it("PATCH /shifts/:id 404 + DENIED hr.shift.updated when the shift id is unknown", async () => {
    m.hrShift.findFirst.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/hr/shifts/missing",
      headers: auth(app, "u-admin"),
      payload: { active: false },
    });
    expect(res.statusCode).toBe(404);
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "hr.shift.updated", result: "DENIED" }),
      }),
    );
  });

  it("POST /leave/:appId/approve 404 when the leave application id is missing", async () => {
    m.hrLeaveApplication.findFirst.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hr/leave/missing/approve",
      headers: auth(app, "u-admin"),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "hr.leave.approved", result: "DENIED" }),
      }),
    );
  });

  it("POST /employees/:id/contracts/:contractId/supersede 404 when the contract id is unknown", async () => {
    m.hrEmployee.findFirst.mockResolvedValue({ id: "e1", institutionId: "inst-A" });
    m.hrContract.findFirst.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hr/employees/e1/contracts/missing/supersede",
      headers: auth(app, "u-admin"),
      payload: { contractType: "PERMANENT", startDate: "2026-01-01" },
    });
    expect(res.statusCode).toBe(404);
  });

  // ─── Lifecycle deny: over-balance approve → 422, NO flip, DENIED audit (finding #3) ──
  it("POST /leave/:appId/approve over balance → 422 + DENIED audit AND does NOT flip the status", async () => {
    m.hrLeaveApplication.findFirst.mockResolvedValue({
      id: "a1",
      institutionId: "inst-A",
      employeeId: "e1",
      leaveType: "CASUAL",
      periodYear: 2026,
      days: 10,
      status: "REQUESTED",
    });
    // ANNUAL_LUMP_SUM policy with a tiny quota so 10 days blows the balance.
    m.hrLeavePolicy.findFirst.mockResolvedValue({
      annualQuotaDays: 5,
      accrualRule: "ANNUAL_LUMP_SUM",
    });
    // No other approved days.
    m.hrLeaveApplication.aggregate.mockResolvedValue({ _sum: { days: 0 } });

    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hr/leave/a1/approve",
      headers: auth(app, "u-admin"),
      payload: {},
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toContain("insufficient");
    expect(body).toHaveProperty("remaining");
    expect(body).toHaveProperty("requested", 10);

    // NO flip: the application was never updated to APPROVED.
    expect(m.hrLeaveApplication.update).not.toHaveBeenCalled();
    // A DENIED hr.leave.approved audit WAS written.
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "hr.leave.approved", result: "DENIED" }),
      }),
    );
    // No SUCCESS hr.leave.approved audit was written.
    expect(m.auditEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "hr.leave.approved", result: "SUCCESS" }),
      }),
    );
  });

  it("POST /leave/:appId/approve within balance → flips REQUESTED→APPROVED + SUCCESS audit", async () => {
    m.hrLeaveApplication.findFirst.mockResolvedValue({
      id: "a1",
      institutionId: "inst-A",
      employeeId: "e1",
      leaveType: "CASUAL",
      periodYear: 2026,
      days: 3,
      status: "REQUESTED",
    });
    m.hrLeavePolicy.findFirst.mockResolvedValue({
      annualQuotaDays: 24,
      accrualRule: "ANNUAL_LUMP_SUM",
    });
    m.hrLeaveApplication.aggregate.mockResolvedValue({ _sum: { days: 0 } });
    m.hrLeaveApplication.update.mockResolvedValue({
      id: "a1",
      employeeId: "e1",
      leaveType: "CASUAL",
      startDate: new Date("2026-06-01"),
      endDate: new Date("2026-06-03"),
      days: 3,
      periodYear: 2026,
      reason: "x",
      status: "APPROVED",
      reviewedByUserId: "u-admin",
      reviewedAt: new Date(),
      reviewNote: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hr/leave/a1/approve",
      headers: auth(app, "u-admin"),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("APPROVED");
    expect(m.hrLeaveApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPROVED" }) }),
    );
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "hr.leave.approved", result: "SUCCESS" }),
      }),
    );
  });

  // ─── Supersede: BOTH SUCCESS audits in one tx (finding #2) ───────────────────
  it("POST .../supersede writes BOTH hr.contract.superseded and hr.contract.created SUCCESS audits in one tx", async () => {
    m.hrEmployee.findFirst.mockResolvedValue({ id: "e1", institutionId: "inst-A" });
    m.hrContract.findFirst.mockResolvedValue({
      id: "c1",
      institutionId: "inst-A",
      employeeId: "e1",
      status: "ACTIVE",
    });
    m.hrContract.create.mockResolvedValue({
      id: "c2",
      employeeId: "e1",
      contractType: "PERMANENT",
      startDate: new Date("2026-01-01"),
      endDate: null,
      termsMetadata: null,
      salaryAmount: null,
      currency: "INR",
      status: "ACTIVE",
      supersedesContractId: "c1",
      createdByUserId: "u-admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    m.hrContract.update.mockResolvedValue({ id: "c1", status: "SUPERSEDED" });

    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hr/employees/e1/contracts/c1/supersede",
      headers: auth(app, "u-admin"),
      payload: { contractType: "PERMANENT", startDate: "2026-01-01" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().supersedesContractId).toBe("c1");
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "hr.contract.superseded", result: "SUCCESS" }),
      }),
    );
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "hr.contract.created", result: "SUCCESS" }),
      }),
    );
    // The old row was flipped to SUPERSEDED in the same tx.
    expect(m.hrContract.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SUPERSEDED" }) }),
    );
  });

  it("POST .../supersede 409 (before the guard) when the target contract is not ACTIVE", async () => {
    m.hrEmployee.findFirst.mockResolvedValue({ id: "e1", institutionId: "inst-A" });
    m.hrContract.findFirst.mockResolvedValue({
      id: "c1",
      institutionId: "inst-A",
      employeeId: "e1",
      status: "SUPERSEDED",
    });
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hr/employees/e1/contracts/c1/supersede",
      headers: auth(app, "u-admin"),
      payload: { contractType: "PERMANENT", startDate: "2026-01-01" },
    });
    expect(res.statusCode).toBe(409);
    // No new contract row created on the 409 pre-check.
    expect(m.hrContract.create).not.toHaveBeenCalled();
  });

  // ─── H1 role-grant path (POST /employees) ────────────────────────────────────
  it("POST /employees binds the target user to the resolved EMPLOYEE roleId in the same tx", async () => {
    m.role.findFirst.mockResolvedValue({ id: "role-emp" });
    m.hrEmployee.create.mockResolvedValue({
      id: "e1",
      institutionId: "inst-A",
      userId: "u-emp",
      employeeNo: "E-001",
      designation: null,
      employmentType: "PERMANENT",
      departmentId: null,
      joiningDate: new Date("2026-01-01"),
      status: "ACTIVE",
      createdByUserId: "u-admin",
      updatedByUserId: "u-admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    m.institutionMembership.upsert.mockResolvedValue({ id: "mbr-emp" });
    m.membershipRole.upsert.mockResolvedValue({});

    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hr/employees",
      headers: auth(app, "u-admin"),
      payload: {
        userId: "u-emp",
        employeeNo: "E-001",
        employmentType: "PERMANENT",
        joiningDate: "2026-01-01",
      },
    });

    expect(res.statusCode).toBe(201);
    // The EMPLOYEE template role was resolved as a GLOBAL (institutionId null) role.
    expect(m.role.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ key: "EMPLOYEE", institutionId: null }),
      }),
    );
    // membershipRole.upsert binds membership → resolved roleId in-tx.
    expect(m.membershipRole.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ roleId: "role-emp", membershipId: "mbr-emp" }),
      }),
    );
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "hr.employee.created", result: "SUCCESS" }),
      }),
    );
  });

  it("POST /employees 500 role_missing with the whole tx rolled back (no employee row, no committed audit)", async () => {
    m.role.findFirst.mockResolvedValue(null); // EMPLOYEE template role absent

    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hr/employees",
      headers: auth(app, "u-admin"),
      payload: {
        userId: "u-emp",
        employeeNo: "E-001",
        employmentType: "PERMANENT",
        joiningDate: "2026-01-01",
      },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("role_missing");
    // The deny short-circuits BEFORE any write — no employee row, no role bind,
    // no SUCCESS audit committed.
    expect(m.hrEmployee.create).not.toHaveBeenCalled();
    expect(m.membershipRole.upsert).not.toHaveBeenCalled();
    expect(m.auditEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "hr.employee.created", result: "SUCCESS" }),
      }),
    );
  });

  // ─── Self-service isolation (H1) ──────────────────────────────────────────────
  it("GET /me/employee is 200 for a freshly-created employee token (resolves its own row)", async () => {
    m.hrEmployee.findFirst.mockResolvedValue({
      id: "e1",
      institutionId: "inst-A",
      userId: "u-emp",
      employeeNo: "E-001",
      designation: null,
      employmentType: "PERMANENT",
      departmentId: null,
      joiningDate: new Date("2026-01-01"),
      status: "ACTIVE",
      createdByUserId: "u-admin",
      updatedByUserId: "u-admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      // Display projections added for the frontend (include: user + department).
      user: { id: "u-emp", email: "emp@a.test", studentProfile: null, facultyProfile: null },
      department: null,
    });
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/hr/me/employee",
      headers: auth(app, "u-emp"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe("u-emp");
    // Self-service scopes by the TOKEN userId, never input.
    expect(m.hrEmployee.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ institutionId: "inst-A", userId: "u-emp" }),
      }),
    );
  });

  it("GET /me/employee is 404 (not a leak) for an EMPLOYEE token with no employee row", async () => {
    m.hrEmployee.findFirst.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/hr/me/employee",
      headers: auth(app, "u-emp"),
    });
    expect(res.statusCode).toBe(404);
  });
});
