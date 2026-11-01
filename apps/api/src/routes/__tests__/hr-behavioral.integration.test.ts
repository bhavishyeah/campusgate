/**
 * Phase-9.2 HR Management BEHAVIORAL integration suite (design §10, NFR-5, NFR-6,
 * AC-12) — runs against the REAL Supabase instance through a REAL Fastify app
 * (real `authenticate` + real hrRoutes + the real withTenant/RLS path). It proves
 * the DB-enforced guarantees the mocked unit suite cannot:
 *   - the hr_contracts_guard rejects an illegal status transition AND DELETE
 *   - the hr_leave_applications_guard rejects an illegal status transition AND DELETE
 *   - the hr_employee_attendance_history append-only trigger rejects UPDATE + DELETE
 *     at the DB even via the owner client
 *   - the business unique constraints fire (one employee per user; employeeNo per
 *     tenant; one shift name per tenant; one attendance row per employee/day)
 *   - two CONCURRENT approvals under the advisory lock never overspend the balance
 *   - H1: POST /employees produces a real membershipRole row, so a token minted
 *     for that user carries hr.view_own and GET /me/employee round-trips 200
 *   - /me/* is RLS-scoped: another employee's row is never leaked (self resolves
 *     by token userId only; a staff-only user with no employee row is 404)
 *   - HR access-isolation: a STUDENT and a FACULTY-only caller are 403 on HR routes
 *
 * SELF-CONTAINED under a DISTINCT prefix (HR9_TEST_); seeds + tears down its own
 * tenant/users/department via adminClient. Requires live Supabase + campass_app
 * creds. Registered in vitest.live-db-suites.ts; passes IN ISOLATION.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../..");

function parseEnv(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const apiEnv = parseEnv(path.join(repoRoot, "apps", "api", ".env"));
const dbEnv = parseEnv(path.join(repoRoot, "packages", "db", ".env"));
const appDatabaseUrl = apiEnv.DATABASE_URL; // campass_app (RLS-subject)
const adminDatabaseUrl = dbEnv.DIRECT_URL ?? dbEnv.DATABASE_URL; // postgres (owner)
if (!appDatabaseUrl) throw new Error("apps/api/.env DATABASE_URL not found");
if (!adminDatabaseUrl) throw new Error("packages/db/.env DIRECT_URL not found");

// Pin BEFORE @campusgate/db loads: `authenticate` + requireModuleActive read via
// privilegedPrisma (no tenant GUC yet), so that client MUST be the owner role.
process.env.DATABASE_URL = appDatabaseUrl;
process.env.PRIVILEGED_DATABASE_URL = adminDatabaseUrl;
process.env.DIRECT_URL = adminDatabaseUrl;

const adminClient = new PrismaClient({ datasources: { db: { url: adminDatabaseUrl } }, log: ["error"] });

const PFX = "HR9_TEST_";
const id = (s: string) => `${PFX}${s}`;

async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const transient =
        msg.includes("Can't reach database server") ||
        msg.includes("P1001") ||
        msg.includes("Timed out") ||
        msg.includes("ECONNRESET") ||
        msg.includes("max clients reached") ||
        msg.includes("EMAXCONNSESSION") ||
        msg.includes("tenant or user not found") ||
        msg.includes("Transaction API error") ||
        msg.includes("connection pool");
      if (!transient || i === attempts - 1) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw lastErr;
}

// ─── tenant / users / department ─────────────────────────────────────────────
const instA = id("instA");
const deptA = id("deptA");

const adminUser = id("u_admin");
const employeeUser = id("u_emp"); // becomes an hr_employees row (H1 role grant)
const employeeUserB = id("u_empB"); // a SECOND employee (RLS-scoping of /me/*)
const studentUser = id("u_student"); // STUDENT — must be 403 on HR
const facultyUser = id("u_faculty"); // FACULTY-only — must be 403 on HR

let app: FastifyInstance;

function tokenFor(userId: string, legacyRole: string): string {
  return app.jwt.sign({ userId, role: legacyRole, institutionId: instA });
}
const authHeader = (t: string) => ({ authorization: `Bearer ${t}` });
const adminToken = () => tokenFor(adminUser, "ADMIN");
const studentToken = () => tokenFor(studentUser, "STUDENT");
const facultyToken = () => tokenFor(facultyUser, "GUARD");

async function templateRoleId(key: string): Promise<string> {
  const role = await adminClient.role.findFirst({ where: { key, institutionId: null }, select: { id: true } });
  if (!role) throw new Error(`template role ${key} not found — run the seed/migrations first`);
  return role.id;
}

async function ensureMembership(userId: string, roleKey: string): Promise<void> {
  const mId = id(`mbr_${userId}`);
  const roleId = await templateRoleId(roleKey);
  await withRetry(() =>
    adminClient.institutionMembership.create({
      data: { id: mId, userId, institutionId: instA, membershipStatus: "ACTIVE", permissionsVersion: 0 },
    }),
  );
  await withRetry(() =>
    adminClient.membershipRole.create({
      data: { id: id(`mrl_${userId}`), membershipId: mId, roleId, institutionId: instA },
    }),
  );
}

// ─── HR-row teardown (child-first; append-only trigger-disable dance) ────────
async function clearHrDomain(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  // hr_employee_attendance_history is strictly append-only; disable its trigger
  // for the delete span (the faculty_teaching_history / marks_record_history
  // precedent) so the shared teardown is not blocked by a lingering ledger row.
  await withRetry(() =>
    adminClient.$executeRawUnsafe(
      `ALTER TABLE "hr_employee_attendance_history" DISABLE TRIGGER "hr_employee_attendance_history_no_update_delete"`,
    ),
  );
  try {
    await withRetry(() => adminClient.hrEmployeeAttendanceHistory.deleteMany({ where }));
  } finally {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(
        `ALTER TABLE "hr_employee_attendance_history" ENABLE TRIGGER "hr_employee_attendance_history_no_update_delete"`,
      ),
    );
  }
  await withRetry(() => adminClient.hrEmployeeAttendance.deleteMany({ where }));
  // hr_leave_applications + hr_contracts carry column-guard triggers that forbid
  // DELETE unconditionally; delete them with the guard disabled (the
  // examinations / marks_records teardown precedent).
  await withRetry(() =>
    adminClient.$executeRawUnsafe(
      `ALTER TABLE "hr_leave_applications" DISABLE TRIGGER "hr_leave_applications_guard"`,
    ),
  );
  await withRetry(() =>
    adminClient.$executeRawUnsafe(`ALTER TABLE "hr_contracts" DISABLE TRIGGER "hr_contracts_guard"`),
  );
  try {
    await withRetry(() => adminClient.hrLeaveApplication.deleteMany({ where }));
    await withRetry(() => adminClient.hrContract.deleteMany({ where }));
  } finally {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(
        `ALTER TABLE "hr_leave_applications" ENABLE TRIGGER "hr_leave_applications_guard"`,
      ),
    );
    await withRetry(() =>
      adminClient.$executeRawUnsafe(`ALTER TABLE "hr_contracts" ENABLE TRIGGER "hr_contracts_guard"`),
    );
  }
  await withRetry(() => adminClient.hrLeavePolicy.deleteMany({ where }));
  await withRetry(() => adminClient.hrShift.deleteMany({ where }));
  await withRetry(() => adminClient.hrEmployee.deleteMany({ where }));
  await deleteAuditEvents();
}

async function deleteAuditEvents(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  await withRetry(() =>
    adminClient.$executeRawUnsafe(`ALTER TABLE "audit_events" DISABLE TRIGGER "audit_events_no_update_delete"`),
  );
  try {
    await withRetry(() => adminClient.auditEvent.deleteMany({ where }));
  } finally {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(`ALTER TABLE "audit_events" ENABLE TRIGGER "audit_events_no_update_delete"`),
    );
  }
}

async function teardown(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  await clearHrDomain();
  // The H1 role grant creates membership_roles / institution_memberships for the
  // employee users; delete them (child-first) before the users.
  await withRetry(() => adminClient.membershipRole.deleteMany({ where }));
  await withRetry(() => adminClient.institutionMembership.deleteMany({ where }));
  await withRetry(() => adminClient.institutionModule.deleteMany({ where }));
  await withRetry(() => adminClient.user.deleteMany({ where }));
  await withRetry(() => adminClient.department.deleteMany({ where }));
  await withRetry(() => adminClient.institution.deleteMany({ where: { id: { startsWith: PFX } } }));
}

async function seed(): Promise<void> {
  await withRetry(() =>
    adminClient.institution.create({ data: { id: instA, name: `${PFX}A`, code: id("CODE_A"), status: "ACTIVE" } }),
  );
  await withRetry(() =>
    adminClient.department.create({ data: { id: deptA, name: `${PFX}Dept`, code: id("D_A"), institutionId: instA } }),
  );
  await withRetry(() =>
    adminClient.institutionModule.create({
      data: {
        id: id("imod_A"),
        institutionId: instA,
        moduleKey: "hr_management",
        state: "ACTIVE",
        entitledAt: new Date(),
        activatedAt: new Date(),
      },
    }),
  );

  // ADMIN (holds the six hr.* staff keys via the ADMIN template role).
  await withRetry(() =>
    adminClient.user.create({ data: { id: adminUser, email: `${PFX.toLowerCase()}admin@a.test`, role: "ADMIN", accountStatus: "ACTIVE", institutionId: instA } }),
  );
  await ensureMembership(adminUser, "ADMIN");

  // Two users that will BECOME employees (no HR role yet — the POST /employees
  // path grants the EMPLOYEE template role in-tx; proving H1 is the point).
  await withRetry(() =>
    adminClient.user.create({ data: { id: employeeUser, email: `${PFX.toLowerCase()}emp@a.test`, role: "GUARD", accountStatus: "ACTIVE", institutionId: instA } }),
  );
  await withRetry(() =>
    adminClient.user.create({ data: { id: employeeUserB, email: `${PFX.toLowerCase()}empb@a.test`, role: "GUARD", accountStatus: "ACTIVE", institutionId: instA } }),
  );

  // A STUDENT and a FACULTY-only user: neither holds any hr.* key, so both are
  // 403 on every HR route (separation of duties — design §9 / AC-3).
  await withRetry(() =>
    adminClient.user.create({ data: { id: studentUser, email: `${PFX.toLowerCase()}stu@a.test`, role: "STUDENT", accountStatus: "ACTIVE", institutionId: instA } }),
  );
  await ensureMembership(studentUser, "STUDENT");
  await withRetry(() =>
    adminClient.user.create({ data: { id: facultyUser, email: `${PFX.toLowerCase()}fac@a.test`, role: "GUARD", accountStatus: "ACTIVE", institutionId: instA } }),
  );
  await ensureMembership(facultyUser, "FACULTY");
}

// ─── route helpers ───────────────────────────────────────────────────────────
async function createEmployee(userId: string, employeeNo: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/api/hr/employees`,
    headers: authHeader(adminToken()),
    payload: { userId, employeeNo, employmentType: "PERMANENT", joiningDate: "2026-01-01" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function putLeavePolicy(leaveType: string, quota: number): Promise<void> {
  const res = await app.inject({
    method: "PUT",
    url: `/api/hr/leave-policies/${leaveType}`,
    headers: authHeader(adminToken()),
    payload: { annualQuotaDays: quota, accrualRule: "ANNUAL_LUMP_SUM", active: true },
  });
  expect(res.statusCode).toBe(200);
}

// Staff-on-behalf leave application; returns the created application id.
async function applyLeave(employeeId: string, leaveType: string, startDate: string, endDate: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/api/hr/employees/${employeeId}/leave`,
    headers: authHeader(adminToken()),
    payload: { leaveType, startDate, endDate, reason: "behavioral" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

beforeAll(async () => {
  await teardown();
  await seed();

  const { hrRoutes } = await import("../hr.js");

  app = Fastify();
  await app.register(jwt, { secret: "hr-behavioral-test-secret" });
  await app.register(hrRoutes, { prefix: "/api/hr" });
  await app.ready();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  await teardown();
  const { prisma } = await import("@campusgate/db");
  await prisma.$disconnect();
  await adminClient.$disconnect();
}, 120_000);

beforeEach(async () => {
  await clearHrDomain();
});

describe("Phase-9.2 HR management behavioral (real DB, real routes, real RLS)", () => {
  it("H1: POST /employees grants the EMPLOYEE role in-tx; a token for that user reaches GET /me/employee (200); /me/* is RLS-scoped", async () => {
    const empId = await createEmployee(employeeUser, "E-0001");

    // A real membership-role binding to the EMPLOYEE template role was written
    // in the SAME tx (not a separate grant endpoint).
    const employeeRoleId = await templateRoleId("EMPLOYEE");
    const membership = await adminClient.institutionMembership.findFirst({
      where: { institutionId: instA, userId: employeeUser },
      select: { id: true },
    });
    expect(membership).not.toBeNull();
    const binding = await adminClient.membershipRole.findFirst({
      where: { institutionId: instA, membershipId: membership!.id, roleId: employeeRoleId },
    });
    expect(binding).not.toBeNull();

    // A SUCCESS audit was emitted.
    expect(
      await adminClient.auditEvent.count({
        where: { institutionId: instA, action: "hr.employee.created", resourceId: empId, result: "SUCCESS" },
      }),
    ).toBe(1);

    // A token minted for the employee user now carries hr.view_own, so the
    // self-service route round-trips 200 and resolves THAT user's own row.
    const mine = await app.inject({
      method: "GET",
      url: `/api/hr/me/employee`,
      headers: authHeader(tokenFor(employeeUser, "GUARD")),
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().id).toBe(empId);
    expect(mine.json().userId).toBe(employeeUser);

    // A second employee exists; the first employee's /me/* NEVER sees it (scoped
    // by token userId only — not by any client-supplied id, so no cross-row leak).
    const empIdB = await createEmployee(employeeUserB, "E-0002");
    const mineB = await app.inject({
      method: "GET",
      url: `/api/hr/me/employee`,
      headers: authHeader(tokenFor(employeeUserB, "GUARD")),
    });
    expect(mineB.statusCode).toBe(200);
    expect(mineB.json().id).toBe(empIdB);
    // A's token still resolves A's row, never B's.
    const mineAgain = await app.inject({
      method: "GET",
      url: `/api/hr/me/employee`,
      headers: authHeader(tokenFor(employeeUser, "GUARD")),
    });
    expect(mineAgain.json().id).toBe(empId);
    expect(mineAgain.json().id).not.toBe(empIdB);

    // A staff-only user with NO hr_employees row => 404 on /me/employee (never a
    // leak of someone else's record). ADMIN holds hr.view_own? No — but it holds
    // the directory key; /me requires hr.view_own, which ADMIN also carries via
    // the staff set? ADMIN has the six staff keys, NOT hr.view_own, so ADMIN is
    // 403 on /me. Use a FRESH user granted EMPLOYEE but with no employee row.
    const orphanUser = id("u_orphan");
    await withRetry(() =>
      adminClient.user.create({ data: { id: orphanUser, email: `${PFX.toLowerCase()}orphan@a.test`, role: "GUARD", accountStatus: "ACTIVE", institutionId: instA } }),
    );
    await ensureMembership(orphanUser, "EMPLOYEE");
    const orphan = await app.inject({
      method: "GET",
      url: `/api/hr/me/employee`,
      headers: authHeader(tokenFor(orphanUser, "GUARD")),
    });
    expect(orphan.statusCode).toBe(404);
  }, 120_000);

  it("HR access-isolation: a STUDENT and a FACULTY-only caller are 403 on HR routes", async () => {
    // A representative staff route (directory.view) + a self route (view_own).
    for (const token of [studentToken(), facultyToken()]) {
      const dir = await app.inject({ method: "GET", url: `/api/hr/employees`, headers: authHeader(token) });
      expect(dir.statusCode).toBe(403);

      const me = await app.inject({ method: "GET", url: `/api/hr/me/employee`, headers: authHeader(token) });
      expect(me.statusCode).toBe(403);

      const manage = await app.inject({
        method: "POST",
        url: `/api/hr/shifts`,
        headers: authHeader(token),
        payload: { name: "Day", startMinute: 540, endMinute: 1020 },
      });
      expect(manage.statusCode).toBe(403);
    }
  }, 120_000);

  it("contract guard: forward-only lifecycle (DELETE + illegal transition rejected at the DB)", async () => {
    const empId = await createEmployee(employeeUser, "E-0001");

    // Create a contract, end it via the route (ACTIVE -> ENDED is legal).
    const createRes = await app.inject({
      method: "POST",
      url: `/api/hr/employees/${empId}/contracts`,
      headers: authHeader(adminToken()),
      payload: { contractType: "PERMANENT", startDate: "2026-01-01", salaryAmount: 5000000 },
    });
    expect(createRes.statusCode).toBe(201);
    const contractId = createRes.json().id as string;

    const endRes = await app.inject({
      method: "POST",
      url: `/api/hr/employees/${empId}/contracts/${contractId}/end`,
      headers: authHeader(adminToken()),
    });
    expect(endRes.statusCode).toBe(200);
    expect(endRes.json().status).toBe("ENDED");

    // An ENDED contract is terminal: ending it AGAIN via the route is a 409
    // (the app pre-checks before the guard backstop).
    const endAgain = await app.inject({
      method: "POST",
      url: `/api/hr/employees/${empId}/contracts/${contractId}/end`,
      headers: authHeader(adminToken()),
    });
    expect(endAgain.statusCode).toBe(409);

    // The column guard rejects an illegal transition at the DB even via the owner
    // client (ENDED -> ACTIVE is not an allowed edge).
    await expect(
      adminClient.$executeRawUnsafe(
        `UPDATE "hr_contracts" SET "status" = 'ACTIVE' WHERE "id" = $1`,
        contractId,
      ),
    ).rejects.toThrow();

    // And DELETE is forbidden unconditionally (the guard raises on DELETE).
    await expect(
      adminClient.$executeRawUnsafe(`DELETE FROM "hr_contracts" WHERE "id" = $1`, contractId),
    ).rejects.toThrow();
  }, 120_000);

  it("leave guard: forward-only lifecycle (DELETE + illegal transition rejected at the DB)", async () => {
    const empId = await createEmployee(employeeUser, "E-0001");
    await putLeavePolicy("CASUAL", 10);
    const appId = await applyLeave(empId, "CASUAL", "2026-03-01", "2026-03-03");

    // Approve via the route (REQUESTED -> APPROVED is legal, within balance).
    const approve = await app.inject({
      method: "POST",
      url: `/api/hr/leave/${appId}/approve`,
      headers: authHeader(adminToken()),
      payload: {},
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe("APPROVED");

    // An APPROVED application is terminal: rejecting it via the route is a 409.
    const reject = await app.inject({
      method: "POST",
      url: `/api/hr/leave/${appId}/reject`,
      headers: authHeader(adminToken()),
      payload: {},
    });
    expect(reject.statusCode).toBe(409);

    // The column guard rejects an illegal transition at the DB even via the owner
    // client (APPROVED -> REQUESTED is not an allowed edge).
    await expect(
      adminClient.$executeRawUnsafe(
        `UPDATE "hr_leave_applications" SET "status" = 'REQUESTED' WHERE "id" = $1`,
        appId,
      ),
    ).rejects.toThrow();

    // And DELETE is forbidden unconditionally.
    await expect(
      adminClient.$executeRawUnsafe(`DELETE FROM "hr_leave_applications" WHERE "id" = $1`, appId),
    ).rejects.toThrow();
  }, 120_000);

  it("attendance history is append-only: the trigger rejects UPDATE + DELETE at the DB even via the owner client", async () => {
    const empId = await createEmployee(employeeUser, "E-0001");

    // Record attendance via the route — this writes a RECORDED history row.
    const rec = await app.inject({
      method: "POST",
      url: `/api/hr/employees/${empId}/attendance`,
      headers: authHeader(adminToken()),
      payload: { attendanceDate: "2026-02-02", status: "PRESENT" },
    });
    expect(rec.statusCode).toBe(201);

    // Correcting the same day writes a CORRECTED history row (two ledger rows).
    const corr = await app.inject({
      method: "PATCH",
      url: `/api/hr/employees/${empId}/attendance/2026-02-02`,
      headers: authHeader(adminToken()),
      payload: { status: "ABSENT", reason: "mistake" },
    });
    expect(corr.statusCode).toBe(200);
    expect(corr.json().status).toBe("ABSENT");

    const histCount = await adminClient.hrEmployeeAttendanceHistory.count({
      where: { institutionId: instA },
    });
    expect(histCount).toBe(2);

    const row = await adminClient.hrEmployeeAttendanceHistory.findFirst({
      where: { institutionId: instA },
      select: { id: true },
    });
    expect(row).not.toBeNull();

    // UPDATE rejected at the DB even via the owner client (append-only trigger).
    await expect(
      adminClient.$executeRawUnsafe(
        `UPDATE "hr_employee_attendance_history" SET "reason" = 'mutate' WHERE "id" = $1`,
        row!.id,
      ),
    ).rejects.toThrow();

    // DELETE rejected at the DB even via the owner client.
    await expect(
      adminClient.$executeRawUnsafe(
        `DELETE FROM "hr_employee_attendance_history" WHERE "id" = $1`,
        row!.id,
      ),
    ).rejects.toThrow();
  }, 120_000);

  it("business unique constraints fire: one employee per user, employeeNo per tenant, shift name, attendance per day", async () => {
    const empId = await createEmployee(employeeUser, "E-0001");

    // (institutionId, userId) unique: a second employee for the SAME user => 409.
    const dupUser = await app.inject({
      method: "POST",
      url: `/api/hr/employees`,
      headers: authHeader(adminToken()),
      payload: { userId: employeeUser, employeeNo: "E-9999", employmentType: "PERMANENT", joiningDate: "2026-01-01" },
    });
    expect(dupUser.statusCode).toBe(409);

    // (institutionId, employeeNo) unique: the same employeeNo for a DIFFERENT
    // user => 409.
    const dupNo = await app.inject({
      method: "POST",
      url: `/api/hr/employees`,
      headers: authHeader(adminToken()),
      payload: { userId: employeeUserB, employeeNo: "E-0001", employmentType: "PERMANENT", joiningDate: "2026-01-01" },
    });
    expect(dupNo.statusCode).toBe(409);

    // (institutionId, name) unique on hr_shifts.
    const shift = await app.inject({
      method: "POST",
      url: `/api/hr/shifts`,
      headers: authHeader(adminToken()),
      payload: { name: "Morning", startMinute: 540, endMinute: 1020 },
    });
    expect(shift.statusCode).toBe(201);
    const dupShift = await app.inject({
      method: "POST",
      url: `/api/hr/shifts`,
      headers: authHeader(adminToken()),
      payload: { name: "Morning", startMinute: 600, endMinute: 1080 },
    });
    expect(dupShift.statusCode).toBe(409);

    // (institutionId, employeeId, attendanceDate) unique on hr_employee_attendance.
    const att = await app.inject({
      method: "POST",
      url: `/api/hr/employees/${empId}/attendance`,
      headers: authHeader(adminToken()),
      payload: { attendanceDate: "2026-02-02", status: "PRESENT" },
    });
    expect(att.statusCode).toBe(201);
    const dupAtt = await app.inject({
      method: "POST",
      url: `/api/hr/employees/${empId}/attendance`,
      headers: authHeader(adminToken()),
      payload: { attendanceDate: "2026-02-02", status: "ABSENT" },
    });
    expect(dupAtt.statusCode).toBe(409);
  }, 120_000);

  it("advisory-locked concurrent approvals never overspend the leave balance", async () => {
    const empId = await createEmployee(employeeUser, "E-0001");
    // Entitlement 3 days. Two single-day applications (1 day each) both fit, but a
    // third 2-day application would push over if approved concurrently.
    await putLeavePolicy("CASUAL", 3);
    const app1 = await applyLeave(empId, "CASUAL", "2026-04-01", "2026-04-02"); // 2 days
    const app2 = await applyLeave(empId, "CASUAL", "2026-04-10", "2026-04-11"); // 2 days
    // Approving BOTH would total 4 > entitlement 3 — the advisory lock serializes
    // the two approve transactions so exactly ONE wins and the other is 422.

    const [r1, r2] = await Promise.all([
      app.inject({ method: "POST", url: `/api/hr/leave/${app1}/approve`, headers: authHeader(adminToken()), payload: {} }),
      app.inject({ method: "POST", url: `/api/hr/leave/${app2}/approve`, headers: authHeader(adminToken()), payload: {} }),
    ]);

    const statuses = [r1.statusCode, r2.statusCode].sort();
    // Exactly one 200 (approved) and one 422 (over-balance) — never two 200s.
    expect(statuses).toEqual([200, 422]);

    const approvedCount = await adminClient.hrLeaveApplication.count({
      where: { institutionId: instA, employeeId: empId, leaveType: "CASUAL", status: "APPROVED" },
    });
    expect(approvedCount).toBe(1);

    // The approved days never exceed the entitlement (2 <= 3).
    const agg = await adminClient.hrLeaveApplication.aggregate({
      _sum: { days: true },
      where: { institutionId: instA, employeeId: empId, leaveType: "CASUAL", status: "APPROVED" },
    });
    expect(agg._sum.days ?? 0).toBeLessThanOrEqual(3);

    // The 422 carries the remaining/requested envelope and did NOT flip the row.
    const rejected = r1.statusCode === 422 ? r1 : r2;
    expect(rejected.json().error).toBe("insufficient leave balance");
    expect(rejected.json()).toHaveProperty("requested");
  }, 120_000);
});
