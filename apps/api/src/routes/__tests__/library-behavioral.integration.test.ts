/**
 * Phase-5 library BEHAVIORAL integration suite (design §11.2) — runs against the
 * REAL Supabase instance through a REAL Fastify app (real `authenticate` + the
 * real libraryRoutes + the real withTenant/RLS path). It proves the guarantees
 * the mocked library-routes suite cannot: the concurrency contract (the
 * conditional-claim UPDATE + the two partial unique indexes), the per-student
 * borrowing-limit under a race, the title-vs-copy availability math, the
 * return/renew/overdue/fine lifecycle, the FIFO reservation + two-step
 * fulfil/collect, student self-service privacy, LIBRARIAN permission scoping,
 * and the module gate — all persisted under RLS.
 *
 * SELF-CONTAINED under a DISTINCT prefix (LIB_TEST_); seeds + tears down its own
 * institution via adminClient. Requires live Supabase + campass_app creds.
 *
 * Both DATABASE_URL (campass_app, RLS-subject) and the privileged owner URL are
 * pinned in process.env BEFORE @campusgate/db loads: the real `authenticate`
 * middleware reads users/memberships on privilegedPrisma (no tenant GUC yet), so
 * that client MUST be the owner/postgres role, not campass_app.
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

process.env.DATABASE_URL = appDatabaseUrl;
process.env.PRIVILEGED_DATABASE_URL = adminDatabaseUrl;
process.env.DIRECT_URL = adminDatabaseUrl;

const adminClient = new PrismaClient({ datasources: { db: { url: adminDatabaseUrl } }, log: ["error"] });

const PFX = "LIB_TEST_";
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

// Tenant IDs.
const instA = id("inst");
const deptA = id("dept");
const librarianUser = id("u_lib");
const studentUser = id("u_stu");
const studentUser2 = id("u_stu2");
const sessionA = id("sess");
const termA = id("term");
const programA = id("prog");
const studentProfileA = id("sp");
const studentProfileB = id("sp2");
// Tenant B (isolation foil for the staff circulation reads).
const instB = id("instB");
const deptB = id("deptB");
const librarianUserB = id("u_libB");
const studentUserInB = id("u_stuInB");
const studentProfileInB = id("spInB");

let app: FastifyInstance;
let libraryRoutes: typeof import("../library.js").libraryRoutes;

function tokenFor(userId: string, legacyRole: string): string {
  return app.jwt.sign({ userId, role: legacyRole, institutionId: instA });
}
const authHeader = (t: string) => ({ authorization: `Bearer ${t}` });
const libToken = () => tokenFor(librarianUser, "GUARD");
const stuToken = () => tokenFor(studentUser, "STUDENT");
const stu2Token = () => tokenFor(studentUser2, "STUDENT");
const libTokenB = () => app.jwt.sign({ userId: librarianUserB, role: "GUARD", institutionId: instB });

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
      data: { id: mId, userId, institutionId: instA, membershipStatus: "ACTIVE" },
    }),
  );
  await withRetry(() =>
    adminClient.membershipRole.create({
      data: { id: id(`mrl_${userId}`), membershipId: mId, roleId, institutionId: instA },
    }),
  );
}

// ─── module-state helpers (flip library ACTIVE / SUSPENDED / ENTITLED) ─────────
async function setLibraryState(state: "ACTIVE" | "SUSPENDED" | "ENTITLED"): Promise<void> {
  await withRetry(() =>
    adminClient.institutionModule.update({
      where: { institutionId_moduleKey: { institutionId: instA, moduleKey: "library" } },
      data: { state, activatedAt: state === "ACTIVE" ? new Date() : null },
    }),
  );
}

// ─── library-row teardown (child-first) between tests for isolation ────────────
async function clearLibrary(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  await withRetry(() => adminClient.libraryFine.deleteMany({ where }));
  await withRetry(() => adminClient.bookReservation.deleteMany({ where }));
  await withRetry(() => adminClient.libraryLoan.deleteMany({ where }));
  await withRetry(() => adminClient.bookCopy.deleteMany({ where }));
  await withRetry(() => adminClient.bookTitle.deleteMany({ where }));
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
  await clearLibrary();
  await withRetry(() => adminClient.notification.deleteMany({ where }));
  await deleteAuditEvents();
  await withRetry(() => adminClient.studentProfile.deleteMany({ where }));
  await withRetry(() => adminClient.membershipRole.deleteMany({ where }));
  await withRetry(() => adminClient.institutionMembership.deleteMany({ where }));
  await withRetry(() => adminClient.institutionModule.deleteMany({ where }));
  await withRetry(() => adminClient.academicTerm.deleteMany({ where }));
  await withRetry(() => adminClient.academicSession.deleteMany({ where }));
  await withRetry(() => adminClient.program.deleteMany({ where }));
  await withRetry(() => adminClient.department.deleteMany({ where }));
  await withRetry(() => adminClient.user.deleteMany({ where }));
  await withRetry(() => adminClient.institution.deleteMany({ where: { id: { startsWith: PFX } } }));
}

async function seed(): Promise<void> {
  await withRetry(() =>
    adminClient.institution.create({ data: { id: instA, name: `${PFX}Inst`, code: id("CODE"), status: "ACTIVE" } }),
  );
  await withRetry(() =>
    adminClient.department.create({ data: { id: deptA, name: `${PFX}Dept`, code: id("D"), institutionId: instA } }),
  );
  await withRetry(() =>
    adminClient.user.createMany({
      data: [
        // LIBRARIAN has no UserRole enum member — the inert GUARD legacy role is
        // the pure-librarian precedent (design A3); membership role is LIBRARIAN.
        { id: librarianUser, email: `${PFX.toLowerCase()}lib@example.test`, role: "GUARD", institutionId: instA },
        { id: studentUser, email: `${PFX.toLowerCase()}stu@example.test`, role: "STUDENT", institutionId: instA },
        { id: studentUser2, email: `${PFX.toLowerCase()}stu2@example.test`, role: "STUDENT", institutionId: instA },
      ],
    }),
  );
  await ensureMembership(librarianUser, "LIBRARIAN");
  await ensureMembership(studentUser, "STUDENT");
  await ensureMembership(studentUser2, "STUDENT");

  // library module ACTIVE for this tenant.
  await withRetry(() =>
    adminClient.institutionModule.create({
      data: { id: id("imod"), institutionId: instA, moduleKey: "library", state: "ACTIVE", entitledAt: new Date(), activatedAt: new Date() },
    }),
  );

  await withRetry(() =>
    adminClient.academicSession.create({
      data: {
        id: sessionA,
        institutionId: instA,
        name: `${PFX}Session`,
        structureType: "SEMESTER",
        status: "ACTIVE",
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        endDate: new Date("2027-06-30T00:00:00.000Z"),
      },
    }),
  );
  await withRetry(() =>
    adminClient.academicTerm.create({
      data: {
        id: termA,
        institutionId: instA,
        academicSessionId: sessionA,
        name: `${PFX}Term 1`,
        ordinal: 1,
        status: "ACTIVE",
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        endDate: new Date("2026-12-31T00:00:00.000Z"),
      },
    }),
  );
  await withRetry(() =>
    adminClient.program.create({
      data: { id: programA, institutionId: instA, departmentId: deptA, name: `${PFX}BCA`, code: id("BCA"), duration: 6, durationUnit: "TERMS" },
    }),
  );
  await withRetry(() =>
    adminClient.studentProfile.create({
      data: {
        id: studentProfileA,
        userId: studentUser,
        institutionId: instA,
        enrollmentNo: id("ENR"),
        name: `${PFX}Student`,
        departmentId: deptA,
        program: "BCA",
        semester: 1,
        status: "ACTIVE",
        programId: programA,
        academicSessionId: sessionA,
        currentTermId: termA,
      },
    }),
  );
  await withRetry(() =>
    adminClient.studentProfile.create({
      data: {
        id: studentProfileB,
        userId: studentUser2,
        institutionId: instA,
        enrollmentNo: id("ENR2"),
        name: `${PFX}Student2`,
        departmentId: deptA,
        program: "BCA",
        semester: 1,
        status: "ACTIVE",
        programId: programA,
        academicSessionId: sessionA,
        currentTermId: termA,
      },
    }),
  );
}

async function seedTenantB(): Promise<void> {
  await withRetry(() =>
    adminClient.institution.create({ data: { id: instB, name: `${PFX}InstB`, code: id("CODE_B"), status: "ACTIVE" } }),
  );
  await withRetry(() =>
    adminClient.department.create({ data: { id: deptB, name: `${PFX}DeptB`, code: id("DB"), institutionId: instB } }),
  );
  await withRetry(() =>
    adminClient.user.createMany({
      data: [
        { id: librarianUserB, email: `${PFX.toLowerCase()}libb@example.test`, role: "GUARD", institutionId: instB },
        { id: studentUserInB, email: `${PFX.toLowerCase()}stuinb@example.test`, role: "STUDENT", institutionId: instB },
      ],
    }),
  );
  const roleId = await templateRoleId("LIBRARIAN");
  const mId = id(`mbr_${librarianUserB}`);
  await withRetry(() =>
    adminClient.institutionMembership.create({ data: { id: mId, userId: librarianUserB, institutionId: instB, membershipStatus: "ACTIVE" } }),
  );
  await withRetry(() =>
    adminClient.membershipRole.create({ data: { id: id(`mrl_${librarianUserB}`), membershipId: mId, roleId, institutionId: instB } }),
  );
  await withRetry(() =>
    adminClient.institutionModule.create({
      data: { id: id("imodB"), institutionId: instB, moduleKey: "library", state: "ACTIVE", entitledAt: new Date(), activatedAt: new Date() },
    }),
  );
  await withRetry(() =>
    adminClient.studentProfile.create({
      data: {
        id: studentProfileInB,
        userId: studentUserInB,
        institutionId: instB,
        enrollmentNo: id("ENRB"),
        name: `${PFX}Zed Foreign`,
        departmentId: deptB,
        program: "BCA",
        semester: 1,
        status: "ACTIVE",
      },
    }),
  );
}

// ── direct-seed helpers (bypass the routes) used to set up specific scenarios ──
async function seedTitle(suffix: string): Promise<string> {
  const tId = id(`title_${suffix}`);
  await withRetry(() =>
    adminClient.bookTitle.create({
      data: { id: tId, institutionId: instA, title: `${PFX}Title ${suffix}`, author: `${PFX}Author`, status: "ACTIVE" },
    }),
  );
  return tId;
}
async function seedCopy(titleId: string, suffix: string, status = "AVAILABLE"): Promise<string> {
  const cId = id(`copy_${suffix}`);
  await withRetry(() =>
    adminClient.bookCopy.create({
      data: { id: cId, institutionId: instA, bookTitleId: titleId, accessionNumber: id(`ACC_${suffix}`), status: status as any, condition: "GOOD" },
    }),
  );
  return cId;
}
// Set the library module's circulation policy (settings JSON) for a scenario.
async function setPolicy(settings: Record<string, unknown>): Promise<void> {
  await withRetry(() =>
    adminClient.institutionModule.update({
      where: { institutionId_moduleKey: { institutionId: instA, moduleKey: "library" } },
      data: { settings },
    }),
  );
}

beforeAll(async () => {
  await teardown();
  await seed();
  await seedTenantB();
  const mod = await import("../library.js");
  libraryRoutes = mod.libraryRoutes;
  app = Fastify();
  await app.register(jwt, { secret: "library-behavioral-test-secret" });
  await app.register(libraryRoutes, { prefix: "/api/library" });
  await app.ready();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  const { prisma } = await import("@campusgate/db");
  await prisma.$disconnect();
  await adminClient.$disconnect();
}, 120_000);

// Each test starts from a clean library + default ACTIVE module + default policy.
beforeEach(async () => {
  await clearLibrary();
  await setLibraryState("ACTIVE");
  await setPolicy({}); // defaults (finesEnabled=false, limit 3, renewals 2)
});

describe("Phase-5 library behavioral (real DB, real routes)", () => {
  it("CONCURRENCY same-copy: two parallel issues of one copy -> exactly one 201 + one 409; one ACTIVE loan; copy ISSUED", async () => {
    const titleId = await seedTitle("cc");
    const copyId = await seedCopy(titleId, "cc"); // the ONLY copy

    const issue = () =>
      app.inject({
        method: "POST",
        url: "/api/library/loans",
        headers: authHeader(libToken()),
        payload: { bookCopyId: copyId, studentId: studentProfileA },
      });
    const [r1, r2] = await Promise.all([issue(), issue()]);

    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const loser = r1.statusCode === 409 ? r1 : r2;
    expect(loser.json()).toMatchObject({ error: "copy not available" });

    const activeLoans = await adminClient.libraryLoan.count({
      where: { institutionId: instA, bookCopyId: copyId, status: "ACTIVE" },
    });
    expect(activeLoans).toBe(1);
    const copy = await adminClient.bookCopy.findUnique({ where: { id: copyId } });
    expect(copy!.status).toBe("ISSUED");
  }, 120_000);

  it("CONCURRENCY backstop: the partial unique alone rejects a hand-forced second ACTIVE loan on a copy", async () => {
    const titleId = await seedTitle("pu");
    const copyId = await seedCopy(titleId, "pu", "ISSUED");
    await withRetry(() =>
      adminClient.libraryLoan.create({
        data: {
          id: id("loan_pu"),
          institutionId: instA,
          bookCopyId: copyId,
          studentId: studentProfileA,
          issuedByUserId: librarianUser,
          issueDate: new Date(),
          dueDate: new Date(Date.now() + 14 * 24 * 3600_000),
          status: "ACTIVE",
        },
      }),
    );
    // A second ACTIVE loan on the SAME copy violates
    // library_loans_one_active_per_copy (institutionId, bookCopyId) WHERE ACTIVE.
    await expect(
      adminClient.libraryLoan.create({
        data: {
          id: id("loan_pu2"),
          institutionId: instA,
          bookCopyId: copyId,
          studentId: studentProfileB,
          issuedByUserId: librarianUser,
          issueDate: new Date(),
          dueDate: new Date(Date.now() + 14 * 24 * 3600_000),
          status: "ACTIVE",
        },
      }),
    ).rejects.toBeTruthy();
  }, 120_000);

  it("CONCURRENCY same-student-two-copies: limit=1, two parallel issues for one student -> one 201 + one 409 'borrowing limit reached'", async () => {
    await setPolicy({ maxActiveLoansPerStudent: 1 });
    const titleId = await seedTitle("ss");
    const copy1 = await seedCopy(titleId, "ss1");
    const copy2 = await seedCopy(titleId, "ss2");

    const issue = (copyId: string) =>
      app.inject({
        method: "POST",
        url: "/api/library/loans",
        headers: authHeader(libToken()),
        payload: { bookCopyId: copyId, studentId: studentProfileA },
      });
    const [r1, r2] = await Promise.all([issue(copy1), issue(copy2)]);

    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const loser = r1.statusCode === 409 ? r1 : r2;
    expect(loser.json()).toMatchObject({ error: "borrowing limit reached" });

    const active = await adminClient.libraryLoan.count({
      where: { institutionId: instA, studentId: studentProfileA, status: "ACTIVE" },
    });
    expect(active).toBe(1); // exactly maxActiveLoansPerStudent
  }, 120_000);

  it("TITLE-vs-COPY: 3 copies support 3 loans; the 4th fails; a return frees exactly that copy and availability reflects it", async () => {
    await setPolicy({ maxActiveLoansPerStudent: 10 }); // not the limiting factor here
    const titleId = await seedTitle("tc");
    const c1 = await seedCopy(titleId, "tc1");
    const c2 = await seedCopy(titleId, "tc2");
    const c3 = await seedCopy(titleId, "tc3");

    const issue = (copyId: string, studentId: string) =>
      app.inject({ method: "POST", url: "/api/library/loans", headers: authHeader(libToken()), payload: { bookCopyId: copyId, studentId } });

    expect((await issue(c1, studentProfileA)).statusCode).toBe(201);
    expect((await issue(c2, studentProfileA)).statusCode).toBe(201);
    const r3 = await issue(c3, studentProfileB);
    expect(r3.statusCode).toBe(201);
    const loan3Id = r3.json().id as string;

    // All three copies ISSUED -> a 4th issue of c1 (already issued) is 409.
    const r4 = await issue(c1, studentProfileB);
    expect(r4.statusCode).toBe(409);

    // availableCopies via the staff detail reads 0.
    const detail = await app.inject({ method: "GET", url: `/api/library/titles/${titleId}`, headers: authHeader(libToken()) });
    expect(detail.json().availableCopies).toBe(0);

    // Return loan3 -> frees exactly c3.
    const ret = await app.inject({ method: "POST", url: `/api/library/loans/${loan3Id}/return`, headers: authHeader(libToken()), payload: {} });
    expect(ret.statusCode).toBe(200);
    const c3row = await adminClient.bookCopy.findUnique({ where: { id: c3 } });
    expect(c3row!.status).toBe("AVAILABLE"); // no pending hold -> AVAILABLE
    const detail2 = await app.inject({ method: "GET", url: `/api/library/titles/${titleId}`, headers: authHeader(libToken()) });
    expect(detail2.json().availableCopies).toBe(1);
  }, 180_000);

  it("RENEW/OVERDUE: renew succeeds under the cap then 409 at the cap", async () => {
    await setPolicy({ maxRenewals: 1 });
    const titleId = await seedTitle("rn");
    const copyId = await seedCopy(titleId, "rn");
    const issue = await app.inject({ method: "POST", url: "/api/library/loans", headers: authHeader(libToken()), payload: { bookCopyId: copyId, studentId: studentProfileA } });
    const loanId = issue.json().id as string;

    const r1 = await app.inject({ method: "POST", url: `/api/library/loans/${loanId}/renew`, headers: authHeader(libToken()), payload: {} });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({ method: "POST", url: `/api/library/loans/${loanId}/renew`, headers: authHeader(libToken()), payload: {} });
    expect(r2.statusCode).toBe(409);
    expect(r2.json()).toMatchObject({ error: "loan not renewable" });
  }, 180_000);

  it("FINES toggle: finesEnabled=false -> no fine on overdue return; finesEnabled=true -> an OVERDUE fine, then waive + mark-paid", async () => {
    const titleId = await seedTitle("fn");

    // (a) finesEnabled=false: an overdue return creates NO fine.
    await setPolicy({ finesEnabled: false, loanPeriodDays: 14 });
    const copyA = await seedCopy(titleId, "fna");
    const issA = await app.inject({ method: "POST", url: "/api/library/loans", headers: authHeader(libToken()), payload: { bookCopyId: copyA, studentId: studentProfileA } });
    const loanAId = issA.json().id as string;
    // Force the loan overdue (dueDate in the past) via adminClient.
    await withRetry(() => adminClient.libraryLoan.update({ where: { id: loanAId }, data: { dueDate: new Date(Date.now() - 5 * 24 * 3600_000) } }));
    const retA = await app.inject({ method: "POST", url: `/api/library/loans/${loanAId}/return`, headers: authHeader(libToken()), payload: {} });
    expect(retA.statusCode).toBe(200);
    expect(retA.json().fineId).toBeNull();
    const finesOff = await adminClient.libraryFine.count({ where: { institutionId: instA, libraryLoanId: loanAId } });
    expect(finesOff).toBe(0);

    // (b) finesEnabled=true: an overdue return creates an OVERDUE fine for the days * rate.
    await setPolicy({ finesEnabled: true, overdueFinePerDay: 2, loanPeriodDays: 14 });
    const copyB = await seedCopy(titleId, "fnb");
    const issB = await app.inject({ method: "POST", url: "/api/library/loans", headers: authHeader(libToken()), payload: { bookCopyId: copyB, studentId: studentProfileB } });
    const loanBId = issB.json().id as string;
    // Set dueDate exactly 5 days + 1 hour in the past so the real `now` at
    // return is unambiguously 5 whole days overdue (ceil gives 5, never 6 even
    // with the sub-second test latency between this update and the return call).
    await withRetry(() => adminClient.libraryLoan.update({ where: { id: loanBId }, data: { dueDate: new Date(Date.now() - (5 * 24 + 1) * 3600_000) } }));
    const retB = await app.inject({ method: "POST", url: `/api/library/loans/${loanBId}/return`, headers: authHeader(libToken()), payload: {} });
    expect(retB.statusCode).toBe(200);
    const overdueDays = retB.json().overdueDays as number;
    expect(overdueDays).toBe(6); // 5 days + 1 hour, ceil -> 6 whole overdue days
    const fine = await adminClient.libraryFine.findFirst({ where: { institutionId: instA, libraryLoanId: loanBId } });
    expect(fine).toBeTruthy();
    expect(Number(fine!.amount.toString())).toBe(overdueDays * 2); // overdueDays * 2/day
    expect(fine!.status).toBe("PENDING");

    // waive it.
    const waive = await app.inject({ method: "POST", url: `/api/library/fines/${fine!.id}/waive`, headers: authHeader(libToken()), payload: {} });
    expect(waive.statusCode).toBe(200);
    expect(waive.json().status).toBe("WAIVED");

    // a second fine (mark-paid path): create one manually then pay it.
    const manual = await app.inject({
      method: "POST",
      url: "/api/library/fines",
      headers: authHeader(libToken()),
      payload: { studentId: studentProfileB, reason: "DAMAGED", amount: 50 },
    });
    expect(manual.statusCode).toBe(201);
    const manualId = manual.json().id as string;
    const pay = await app.inject({ method: "POST", url: `/api/library/fines/${manualId}/pay`, headers: authHeader(libToken()), payload: {} });
    expect(pay.statusCode).toBe(200);
    expect(pay.json().status).toBe("PAID");
  }, 180_000);

  it("RESERVATIONS FIFO + partial unique: 'copy available - borrow instead' when available; a PENDING hold is one-per-student", async () => {
    const titleId = await seedTitle("rsv");
    const copyId = await seedCopy(titleId, "rsv"); // AVAILABLE

    // availableCopies>0 -> reservation refused, borrow instead.
    const r0 = await app.inject({ method: "POST", url: "/api/library/reservations", headers: authHeader(stuToken()), payload: { bookTitleId: titleId } });
    expect(r0.statusCode).toBe(409);
    expect(r0.json()).toMatchObject({ error: "copy available - borrow instead" });

    // Issue the only copy out so the title has no availability.
    await app.inject({ method: "POST", url: "/api/library/loans", headers: authHeader(libToken()), payload: { bookCopyId: copyId, studentId: studentProfileB } });

    // Now student A can reserve (queuePosition 1).
    const r1 = await app.inject({ method: "POST", url: "/api/library/reservations", headers: authHeader(stuToken()), payload: { bookTitleId: titleId } });
    expect(r1.statusCode).toBe(201);
    expect(r1.json().queuePosition).toBe(1);

    // A duplicate PENDING reservation by the SAME student is refused (partial unique).
    const r1dup = await app.inject({ method: "POST", url: "/api/library/reservations", headers: authHeader(stuToken()), payload: { bookTitleId: titleId } });
    expect(r1dup.statusCode).toBe(409);
    expect(r1dup.json()).toMatchObject({ error: "reservation already pending" });

    // Student B reserves -> queuePosition 2 (FIFO).
    const r2 = await app.inject({ method: "POST", url: "/api/library/reservations", headers: authHeader(stu2Token()), payload: { bookTitleId: titleId } });
    expect(r2.statusCode).toBe(201);
    expect(r2.json().queuePosition).toBe(2);
  }, 180_000);

  it("RESERVATIONS two-step: return parks RESERVED; fulfil keeps RESERVED with no loan; collect flips ISSUED + creates the loan; a walk-up cannot grab the parked copy", async () => {
    const titleId = await seedTitle("two");
    const copyId = await seedCopy(titleId, "two");

    // issue the copy to B so the title has no availability, then A reserves.
    const issB = await app.inject({ method: "POST", url: "/api/library/loans", headers: authHeader(libToken()), payload: { bookCopyId: copyId, studentId: studentProfileB } });
    const loanBId = issB.json().id as string;
    const resv = await app.inject({ method: "POST", url: "/api/library/reservations", headers: authHeader(stuToken()), payload: { bookTitleId: titleId } });
    const resvId = resv.json().id as string;

    // B returns -> a PENDING hold exists -> copy parks RESERVED.
    await app.inject({ method: "POST", url: `/api/library/loans/${loanBId}/return`, headers: authHeader(libToken()), payload: {} });
    let copyRow = await adminClient.bookCopy.findUnique({ where: { id: copyId } });
    expect(copyRow!.status).toBe("RESERVED");

    // A walk-up issue of the parked (RESERVED) copy is refused.
    const walkup = await app.inject({ method: "POST", url: "/api/library/loans", headers: authHeader(libToken()), payload: { bookCopyId: copyId, studentId: studentProfileB } });
    expect(walkup.statusCode).toBe(409);
    expect(walkup.json()).toMatchObject({ error: "copy not available" });

    // Fulfil: designate the parked copy to the head reservation. Copy STAYS RESERVED, NO loan yet.
    const fulfil = await app.inject({ method: "POST", url: `/api/library/reservations/${resvId}/fulfil`, headers: authHeader(libToken()), payload: { bookCopyId: copyId } });
    expect(fulfil.statusCode).toBe(200);
    expect(fulfil.json().status).toBe("FULFILLED");
    copyRow = await adminClient.bookCopy.findUnique({ where: { id: copyId } });
    expect(copyRow!.status).toBe("RESERVED");
    const loanAfterFulfil = await adminClient.libraryLoan.count({ where: { institutionId: instA, bookCopyId: copyId, status: "ACTIVE" } });
    expect(loanAfterFulfil).toBe(0);

    // Collect: flips RESERVED -> ISSUED and creates the loan for student A.
    const collect = await app.inject({ method: "POST", url: `/api/library/reservations/${resvId}/collect`, headers: authHeader(libToken()), payload: {} });
    expect(collect.statusCode).toBe(201);
    copyRow = await adminClient.bookCopy.findUnique({ where: { id: copyId } });
    expect(copyRow!.status).toBe("ISSUED");
    const activeA = await adminClient.libraryLoan.count({ where: { institutionId: instA, studentId: studentProfileA, bookCopyId: copyId, status: "ACTIVE" } });
    expect(activeA).toBe(1);
  }, 180_000);

  it("RESERVATIONS expiry sweep: an uncollected FULFILLED hold past reservationExpiryDays is EXPIRED and its parked copy released", async () => {
    await setPolicy({ reservationExpiryDays: 7 });
    const titleId = await seedTitle("exp");
    const copyId = await seedCopy(titleId, "exp", "RESERVED");
    // A FULFILLED reservation parked on the copy, fulfilledAt 10 days ago (stale).
    const resvId = id("resv_exp");
    await withRetry(() =>
      adminClient.bookReservation.create({
        data: {
          id: resvId,
          institutionId: instA,
          bookTitleId: titleId,
          studentId: studentProfileA,
          queuePosition: 1,
          status: "FULFILLED",
          fulfilledByCopyId: copyId,
          fulfilledAt: new Date(Date.now() - 10 * 24 * 3600_000),
        },
      }),
    );

    const sweep = await app.inject({ method: "POST", url: "/api/library/overdue/remind", headers: authHeader(libToken()), payload: {} });
    expect(sweep.statusCode).toBe(200);

    const resvRow = await adminClient.bookReservation.findUnique({ where: { id: resvId } });
    expect(resvRow!.status).toBe("EXPIRED");
    const copyRow = await adminClient.bookCopy.findUnique({ where: { id: copyId } });
    expect(copyRow!.status).toBe("AVAILABLE"); // released (no other PENDING head)
  }, 180_000);

  it("STUDENT PRIVACY: a student reads only their own loans; a staff list/detail route is 403 for a student", async () => {
    const titleId = await seedTitle("pv");
    const copyA = await seedCopy(titleId, "pva");
    const copyB = await seedCopy(titleId, "pvb");
    // One ACTIVE loan each for A and B.
    await app.inject({ method: "POST", url: "/api/library/loans", headers: authHeader(libToken()), payload: { bookCopyId: copyA, studentId: studentProfileA } });
    await app.inject({ method: "POST", url: "/api/library/loans", headers: authHeader(libToken()), payload: { bookCopyId: copyB, studentId: studentProfileB } });

    // Student A's GET /me/loans returns ONLY A's loan.
    const meA = await app.inject({ method: "GET", url: "/api/library/me/loans", headers: authHeader(stuToken()) });
    expect(meA.statusCode).toBe(200);
    const loans = meA.json().loans as Array<{ studentId: string }>;
    expect(loans.length).toBe(1);
    for (const l of loans) expect(l.studentId).toBe(studentProfileA);

    // A student cannot hit the staff catalogue list (needs library.books.view).
    const staffList = await app.inject({ method: "GET", url: "/api/library/titles", headers: authHeader(stuToken()) });
    expect(staffList.statusCode).toBe(403);
    // Nor the staff title detail.
    const staffDetail = await app.inject({ method: "GET", url: `/api/library/titles/${titleId}`, headers: authHeader(stuToken()) });
    expect(staffDetail.statusCode).toBe(403);
  }, 180_000);

  it("PERMISSION SCOPING: a LIBRARIAN succeeds on a library.* route and is 403 on the student self-service route", async () => {
    const titleId = await seedTitle("ps");

    // LIBRARIAN can create a copy (library.books.manage).
    const copyRes = await app.inject({
      method: "POST",
      url: `/api/library/titles/${titleId}/copies`,
      headers: authHeader(libToken()),
      payload: { accessionNumber: id("ACC_PS") },
    });
    expect(copyRes.statusCode).toBe(201);

    // A LIBRARIAN lacks library.view_own (that is the student self-service key),
    // so GET /me/loans is 403 — the representative cross-permission denial.
    const meRes = await app.inject({ method: "GET", url: "/api/library/me/loans", headers: authHeader(libToken()) });
    expect(meRes.statusCode).toBe(403);
  }, 180_000);

  it("MODULE-GATED: with library ENTITLED (not ACTIVE) every operational route is 403 'Module not active: library'; SUSPEND preserves rows", async () => {
    const titleId = await seedTitle("mg");
    const copyId = await seedCopy(titleId, "mg");
    // seed an ACTIVE loan BEFORE suspending, to prove rows survive the state flip.
    await withRetry(() =>
      adminClient.libraryLoan.create({
        data: {
          id: id("loan_mg"),
          institutionId: instA,
          bookCopyId: copyId,
          studentId: studentProfileA,
          issuedByUserId: librarianUser,
          issueDate: new Date(),
          dueDate: new Date(Date.now() + 14 * 24 * 3600_000),
          status: "ACTIVE",
        },
      }),
    );

    // ENTITLED (not ACTIVE) -> staff and student routes both 403.
    await setLibraryState("ENTITLED");
    const staff = await app.inject({ method: "GET", url: "/api/library/titles", headers: authHeader(libToken()) });
    expect(staff.statusCode).toBe(403);
    expect(staff.json()).toMatchObject({ error: "Module not active: library" });
    const student = await app.inject({ method: "GET", url: "/api/library/catalogue", headers: authHeader(stuToken()) });
    expect(student.statusCode).toBe(403);
    const issueRes = await app.inject({ method: "POST", url: "/api/library/loans", headers: authHeader(libToken()), payload: { bookCopyId: copyId, studentId: studentProfileB } });
    expect(issueRes.statusCode).toBe(403);

    // SUSPEND preserves the previously-seeded rows (the loan still exists).
    await setLibraryState("SUSPENDED");
    const stillThere = await adminClient.libraryLoan.count({ where: { institutionId: instA, bookCopyId: copyId, status: "ACTIVE" } });
    expect(stillThere).toBe(1);

    // Restore ACTIVE so later tests (and beforeEach) start clean.
    await setLibraryState("ACTIVE");
  }, 180_000);

  // ─── G1/G2/G3: staff circulation reads (loans, reservations, student lookup) ──

  it("STAFF LOANS (G1): lists loans with joined student+book fields, filters status/overdue/studentId, paginates, and is tenant-isolated", async () => {
    const titleId = await seedTitle("g1");
    const copyOverdue = await seedCopy(titleId, "g1o", "ISSUED");
    const copyFine = await seedCopy(titleId, "g1f", "ISSUED");
    const copyRet = await seedCopy(titleId, "g1r");
    const day = 24 * 3600_000;
    const loan = (lid: string, copy: string, student: string, status: string, dueOffset: number, returned = false) =>
      withRetry(() =>
        adminClient.libraryLoan.create({
          data: {
            id: id(lid),
            institutionId: instA,
            bookCopyId: copy,
            studentId: student,
            issuedByUserId: librarianUser,
            issueDate: new Date(Date.now() - 20 * day),
            dueDate: new Date(Date.now() + dueOffset * day),
            returnDate: returned ? new Date() : null,
            status: status as any,
          },
        }),
      );
    await loan("ln_over", copyOverdue, studentProfileA, "ACTIVE", -5);
    await loan("ln_ok", copyFine, studentProfileB, "ACTIVE", 5);
    await loan("ln_ret", copyRet, studentProfileA, "RETURNED", -3, true);

    // A loan in tenant B (must never appear for tenant A's librarian).
    const titleB = id("title_g1B");
    await withRetry(() => adminClient.bookTitle.create({ data: { id: titleB, institutionId: instB, title: `${PFX}TitleB`, author: "B", status: "ACTIVE" } }));
    const copyB = id("copy_g1B");
    await withRetry(() => adminClient.bookCopy.create({ data: { id: copyB, institutionId: instB, bookTitleId: titleB, accessionNumber: id("ACC_g1B"), status: "ISSUED", condition: "GOOD" } }));
    await withRetry(() =>
      adminClient.libraryLoan.create({
        data: { id: id("ln_B"), institutionId: instB, bookCopyId: copyB, studentId: studentProfileInB, issuedByUserId: librarianUserB, dueDate: new Date(Date.now() - day), status: "ACTIVE" },
      }),
    );

    type L = { id: string; isOverdue: boolean; student: Record<string, unknown>; bookCopy: { accessionNumber: string; bookTitle: { title: string } } };
    const all = await app.inject({ method: "GET", url: "/api/library/loans?pageSize=100", headers: authHeader(libToken()) });
    expect(all.statusCode).toBe(200);
    const ids = (all.json().loans as L[]).map((l) => l.id);
    expect(ids.sort()).toEqual([id("ln_over"), id("ln_ok"), id("ln_ret")].sort());
    expect(all.json().total).toBe(3);
    expect(ids).not.toContain(id("ln_B"));

    // Joined display fields; student projection is minimal (no dob/phone/address).
    const over = (all.json().loans as L[]).find((l) => l.id === id("ln_over"))!;
    expect(Object.keys(over.student).sort()).toEqual(["enrollmentNo", "id", "name", "program"]);
    expect(over.bookCopy.bookTitle.title).toBe(`${PFX}Title g1`);
    expect(over.isOverdue).toBe(true);

    // overdue=true -> only the past-due, still-open loan.
    const od = await app.inject({ method: "GET", url: "/api/library/loans?overdue=true", headers: authHeader(libToken()) });
    expect((od.json().loans as L[]).map((l) => l.id)).toEqual([id("ln_over")]);

    // status + studentId filters.
    const st = await app.inject({ method: "GET", url: "/api/library/loans?status=RETURNED", headers: authHeader(libToken()) });
    expect((st.json().loans as L[]).map((l) => l.id)).toEqual([id("ln_ret")]);
    const bySt = await app.inject({ method: "GET", url: `/api/library/loans?studentId=${studentProfileB}`, headers: authHeader(libToken()) });
    expect((bySt.json().loans as L[]).map((l) => l.id)).toEqual([id("ln_ok")]);

    // Pagination.
    const p1 = await app.inject({ method: "GET", url: "/api/library/loans?pageSize=2&page=1", headers: authHeader(libToken()) });
    const p2 = await app.inject({ method: "GET", url: "/api/library/loans?pageSize=2&page=2", headers: authHeader(libToken()) });
    expect((p1.json().loans as L[]).length).toBe(2);
    expect((p2.json().loans as L[]).length).toBe(1);
    expect(p1.json().total).toBe(3);

    // Tenant B's librarian sees only B's loan.
    const forB = await app.inject({ method: "GET", url: "/api/library/loans", headers: authHeader(libTokenB()) });
    expect((forB.json().loans as L[]).map((l) => l.id)).toEqual([id("ln_B")]);

    // Role denial + module gate.
    expect((await app.inject({ method: "GET", url: "/api/library/loans", headers: authHeader(stuToken()) })).statusCode).toBe(403);
    await setLibraryState("SUSPENDED");
    const gated = await app.inject({ method: "GET", url: "/api/library/loans", headers: authHeader(libToken()) });
    expect(gated.statusCode).toBe(403);
    expect(gated.json()).toMatchObject({ error: "Module not active: library" });
    await setLibraryState("ACTIVE");
  }, 180_000);

  it("STAFF RESERVATIONS (G2): lists the queue with joined fields, filters by status, tenant-isolated, student denied", async () => {
    const titleId = await seedTitle("g2");
    const copyId = await seedCopy(titleId, "g2", "ISSUED");
    await withRetry(() =>
      adminClient.bookReservation.create({
        data: { id: id("rv_p"), institutionId: instA, bookTitleId: titleId, studentId: studentProfileA, queuePosition: 1, status: "PENDING" },
      }),
    );
    await withRetry(() =>
      adminClient.bookReservation.create({
        data: { id: id("rv_c"), institutionId: instA, bookTitleId: titleId, studentId: studentProfileB, queuePosition: 2, status: "CANCELLED", cancelledAt: new Date() },
      }),
    );
    void copyId;

    type R = { id: string; student: Record<string, unknown>; bookTitle: { title: string } };
    const all = await app.inject({ method: "GET", url: "/api/library/reservations", headers: authHeader(libToken()) });
    expect(all.statusCode).toBe(200);
    expect((all.json().reservations as R[]).map((r) => r.id).sort()).toEqual([id("rv_p"), id("rv_c")].sort());
    const first = (all.json().reservations as R[])[0];
    expect(Object.keys(first.student).sort()).toEqual(["enrollmentNo", "id", "name", "program"]);
    expect(first.bookTitle.title).toBe(`${PFX}Title g2`);

    const pending = await app.inject({ method: "GET", url: "/api/library/reservations?status=PENDING", headers: authHeader(libToken()) });
    expect((pending.json().reservations as R[]).map((r) => r.id)).toEqual([id("rv_p")]);
    expect(pending.json().total).toBe(1);

    // Tenant isolation + role denial + invalid filter.
    const forB = await app.inject({ method: "GET", url: "/api/library/reservations", headers: authHeader(libTokenB()) });
    expect(forB.json().reservations).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/library/reservations", headers: authHeader(stuToken()) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/library/reservations?status=BOGUS", headers: authHeader(libToken()) })).statusCode).toBe(400);
  }, 180_000);

  it("STUDENT LOOKUP (G3): librarian finds students by name/enrollment in its tenant only, minimal fields; student denied; q too short -> 400", async () => {
    const byName = await app.inject({ method: "GET", url: "/api/library/students/lookup?q=Student2", headers: authHeader(libToken()) });
    expect(byName.statusCode).toBe(200);
    const found = byName.json().students as Array<Record<string, unknown>>;
    expect(found.map((s) => s.id)).toEqual([studentProfileB]);
    expect(Object.keys(found[0]).sort()).toEqual(["enrollmentNo", "id", "name", "program"]);

    const byEnr = await app.inject({ method: "GET", url: `/api/library/students/lookup?q=${encodeURIComponent(id("ENR2"))}`, headers: authHeader(libToken()) });
    expect((byEnr.json().students as Array<{ id: string }>).map((s) => s.id)).toEqual([studentProfileB]);

    // Tenant isolation: A's librarian never finds B's "Zed Foreign"; B's finds only B's.
    const cross = await app.inject({ method: "GET", url: "/api/library/students/lookup?q=Zed", headers: authHeader(libToken()) });
    expect(cross.json().students).toEqual([]);
    const own = await app.inject({ method: "GET", url: "/api/library/students/lookup?q=Zed", headers: authHeader(libTokenB()) });
    expect((own.json().students as Array<{ id: string }>).map((s) => s.id)).toEqual([studentProfileInB]);

    // Role denial + validation + module gate.
    expect((await app.inject({ method: "GET", url: "/api/library/students/lookup?q=Student", headers: authHeader(stuToken()) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/library/students/lookup?q=a", headers: authHeader(libToken()) })).statusCode).toBe(400);
    await setLibraryState("SUSPENDED");
    expect((await app.inject({ method: "GET", url: "/api/library/students/lookup?q=Student", headers: authHeader(libToken()) })).statusCode).toBe(403);
    await setLibraryState("ACTIVE");
  }, 180_000);
});
