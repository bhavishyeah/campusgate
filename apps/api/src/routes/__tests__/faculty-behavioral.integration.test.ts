/**
 * Phase-9.1 Faculty Management BEHAVIORAL integration suite (design §B.13) — runs
 * against the REAL Supabase instance through a REAL Fastify app (real
 * `authenticate` + real facultyRoutes + the real withTenant/RLS path). It proves
 * the guarantees the mocked unit suite cannot:
 *   - qualification create/update/delete + audit (staff), FACULTY caller is 403
 *   - workload recompute derives teachingHours from ACTIVE PRIMARY assignments
 *   - workload PATCH over-allocation: 422 without override; written with reason +
 *     a faculty.workload.overallocated audit WITH override
 *   - the append-only trigger: UPDATE and DELETE on faculty_teaching_history both
 *     rejected (restrict_violation) at the DB even via the owner client
 *   - self-service scoping: GET /me/profile resolves the caller's own faculty;
 *     403 when the caller is not a faculty member
 *
 * SELF-CONTAINED under a DISTINCT prefix (FAC9_TEST_); seeds + tears down its own
 * tenants/users/academics/classes/faculty via adminClient. Requires live Supabase
 * + campass_app creds. Registered in vitest.live-db-suites.ts; passes IN ISOLATION.
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

const PFX = "FAC9_TEST_";
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

// ─── tenants / users / academics / classes ──────────────────────────────────
const instA = id("instA");
const deptA = id("deptA");
const sessionA = id("sessA");
const termA = id("termA");
const programA = id("progA");
const courseA = id("courseA");
const subjectA = id("subjA"); // contactHoursPerWeek = 4
const subjectB = id("subjB"); // contactHoursPerWeek = 3
const sectionA = id("sectA");
const sectionB = id("sectB");

const adminUser = id("u_admin");
const facultyUser = id("u_faculty"); // in-scope faculty (ACTIVE profile)
const facultyProfileA = id("fac_A");
const nonFacultyUser = id("u_nonfac"); // holds FACULTY role but NO FacultyProfile
// Tenant B fixtures (cross-tenant isolation for the directory list / lookups).
const instB = id("instB");
const deptB = id("deptB");
const sessionB = id("sessB");
const termB = id("termB");
const adminUserB = id("u_adminB");
const facultyUserB = id("u_facultyB");
const facultyProfileB = id("fac_B");

let app: FastifyInstance;

function tokenFor(userId: string, legacyRole: string, institutionId: string = instA): string {
  return app.jwt.sign({ userId, role: legacyRole, institutionId });
}
const authHeader = (t: string) => ({ authorization: `Bearer ${t}` });
const adminToken = () => tokenFor(adminUser, "ADMIN");
const facultyToken = () => tokenFor(facultyUser, "GUARD");
const nonFacultyToken = () => tokenFor(nonFacultyUser, "GUARD");

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

// ─── faculty-row teardown (child-first, append-only trigger-disable dance) ───
async function clearFacultyDomain(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  // faculty_teaching_history is strictly append-only; disable the trigger for the
  // delete span (the marks_record_history precedent).
  await withRetry(() =>
    adminClient.$executeRawUnsafe(
      `ALTER TABLE "faculty_teaching_history" DISABLE TRIGGER "faculty_teaching_history_no_update_delete"`,
    ),
  );
  try {
    await withRetry(() => adminClient.facultyTeachingHistory.deleteMany({ where }));
  } finally {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(
        `ALTER TABLE "faculty_teaching_history" ENABLE TRIGGER "faculty_teaching_history_no_update_delete"`,
      ),
    );
  }
  await withRetry(() => adminClient.facultyWorkload.deleteMany({ where }));
  await withRetry(() => adminClient.facultyWorkloadPolicy.deleteMany({ where }));
  await withRetry(() => adminClient.facultyQualification.deleteMany({ where }));
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
  await clearFacultyDomain();
  await withRetry(() => adminClient.facultyAssignment.deleteMany({ where }));
  await withRetry(() => adminClient.subject.deleteMany({ where }));
  await withRetry(() => adminClient.course.deleteMany({ where }));
  await withRetry(() => adminClient.classSection.deleteMany({ where }));
  await withRetry(() => adminClient.facultyProfile.deleteMany({ where }));
  await withRetry(() => adminClient.membershipRole.deleteMany({ where }));
  await withRetry(() => adminClient.institutionMembership.deleteMany({ where }));
  await withRetry(() => adminClient.institutionModule.deleteMany({ where }));
  await withRetry(() => adminClient.academicTerm.deleteMany({ where }));
  await withRetry(() => adminClient.academicSession.deleteMany({ where }));
  await withRetry(() => adminClient.program.deleteMany({ where }));
  await withRetry(() => adminClient.user.deleteMany({ where }));
  await withRetry(() => adminClient.department.deleteMany({ where }));
  await withRetry(() => adminClient.institution.deleteMany({ where: { id: { startsWith: PFX } } }));
}

async function seed(): Promise<void> {
  await withRetry(() => adminClient.institution.create({ data: { id: instA, name: `${PFX}A`, code: id("CODE_A"), status: "ACTIVE" } }));
  await withRetry(() => adminClient.department.create({ data: { id: deptA, name: `${PFX}Dept`, code: id("D_A"), institutionId: instA } }));
  await withRetry(() =>
    adminClient.institutionModule.create({
      data: { id: id("imod_A"), institutionId: instA, moduleKey: "faculty_management", state: "ACTIVE", entitledAt: new Date(), activatedAt: new Date() },
    }),
  );
  await withRetry(() =>
    adminClient.academicSession.create({
      data: { id: sessionA, institutionId: instA, name: `${PFX}Session`, structureType: "SEMESTER", status: "ACTIVE", startDate: new Date("2026-07-01T00:00:00.000Z"), endDate: new Date("2027-06-30T00:00:00.000Z") },
    }),
  );
  await withRetry(() =>
    adminClient.academicTerm.create({
      data: { id: termA, institutionId: instA, academicSessionId: sessionA, name: `${PFX}Term`, ordinal: 1, status: "ACTIVE", startDate: new Date("2026-07-01T00:00:00.000Z"), endDate: new Date("2026-12-31T00:00:00.000Z") },
    }),
  );
  await withRetry(() =>
    adminClient.program.create({
      data: { id: programA, institutionId: instA, departmentId: deptA, name: `${PFX}BCA`, code: id("BCA"), duration: 6, durationUnit: "TERMS" },
    }),
  );
  await withRetry(() =>
    adminClient.course.create({
      data: { id: courseA, institutionId: instA, programId: programA, academicTermId: termA, name: `${PFX}Course`, code: id("C1"), status: "ACTIVE" },
    }),
  );
  await withRetry(() =>
    adminClient.subject.create({ data: { id: subjectA, institutionId: instA, courseId: courseA, name: `${PFX}SubjA`, code: id("S1"), credits: 4, contactHoursPerWeek: 4, status: "ACTIVE" } }),
  );
  await withRetry(() =>
    adminClient.subject.create({ data: { id: subjectB, institutionId: instA, courseId: courseA, name: `${PFX}SubjB`, code: id("S2"), credits: 3, contactHoursPerWeek: 3, status: "ACTIVE" } }),
  );
  await withRetry(() =>
    adminClient.classSection.create({
      data: { id: sectionA, institutionId: instA, programId: programA, academicSessionId: sessionA, academicTermId: termA, label: `${PFX}SecA`, capacity: 60, status: "ACTIVE" },
    }),
  );
  await withRetry(() =>
    adminClient.classSection.create({
      data: { id: sectionB, institutionId: instA, programId: programA, academicSessionId: sessionA, academicTermId: termA, label: `${PFX}SecB`, capacity: 60, status: "ACTIVE" },
    }),
  );

  // ADMIN.
  await withRetry(() => adminClient.user.create({ data: { id: adminUser, email: `${PFX.toLowerCase()}admin@a.test`, role: "ADMIN", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(adminUser, "ADMIN");

  // FACULTY (legacy role GUARD; capability from the FACULTY membership). ACTIVE
  // FacultyProfile + ACTIVE PRIMARY assignments: subjectA on sectionA AND sectionB
  // (two sections = two loads = 8h), and subjectB on sectionA (3h) => 11h.
  await withRetry(() => adminClient.user.create({ data: { id: facultyUser, email: `${PFX.toLowerCase()}fac@a.test`, role: "GUARD", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(facultyUser, "FACULTY");
  await withRetry(() =>
    adminClient.facultyProfile.create({ data: { id: facultyProfileA, institutionId: instA, userId: facultyUser, name: `${PFX}Faculty`, departmentId: deptA, status: "ACTIVE" } }),
  );
  await withRetry(() =>
    adminClient.facultyAssignment.create({
      data: { id: id("fa_A1"), institutionId: instA, facultyId: facultyProfileA, subjectId: subjectA, classSectionId: sectionA, academicTermId: termA, role: "PRIMARY", status: "ACTIVE" },
    }),
  );
  await withRetry(() =>
    adminClient.facultyAssignment.create({
      data: { id: id("fa_A2"), institutionId: instA, facultyId: facultyProfileA, subjectId: subjectA, classSectionId: sectionB, academicTermId: termA, role: "PRIMARY", status: "ACTIVE" },
    }),
  );
  await withRetry(() =>
    adminClient.facultyAssignment.create({
      data: { id: id("fa_B1"), institutionId: instA, facultyId: facultyProfileA, subjectId: subjectB, classSectionId: sectionA, academicTermId: termA, role: "PRIMARY", status: "ACTIVE" },
    }),
  );
  // A SUBSTITUTE assignment that must be EXCLUDED from teachingHours.
  await withRetry(() =>
    adminClient.facultyAssignment.create({
      data: { id: id("fa_sub"), institutionId: instA, facultyId: facultyProfileA, subjectId: subjectB, classSectionId: sectionB, academicTermId: termA, role: "SUBSTITUTE", status: "ACTIVE" },
    }),
  );

  // A user with the FACULTY role but NO FacultyProfile (self-service 403 case).
  await withRetry(() => adminClient.user.create({ data: { id: nonFacultyUser, email: `${PFX.toLowerCase()}nonfac@a.test`, role: "GUARD", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(nonFacultyUser, "FACULTY");

  // ── Tenant B (isolation fixtures for the directory list / lookups) ──
  await withRetry(() => adminClient.institution.create({ data: { id: instB, name: `${PFX}B`, code: id("CODE_B"), status: "ACTIVE" } }));
  await withRetry(() => adminClient.department.create({ data: { id: deptB, name: `${PFX}DeptB`, code: id("D_B"), institutionId: instB } }));
  await withRetry(() =>
    adminClient.institutionModule.create({
      data: { id: id("imod_B"), institutionId: instB, moduleKey: "faculty_management", state: "ACTIVE", entitledAt: new Date(), activatedAt: new Date() },
    }),
  );
  await withRetry(() =>
    adminClient.academicSession.create({
      data: { id: sessionB, institutionId: instB, name: `${PFX}SessionB`, structureType: "SEMESTER", status: "ACTIVE", startDate: new Date("2026-07-01T00:00:00.000Z"), endDate: new Date("2027-06-30T00:00:00.000Z") },
    }),
  );
  await withRetry(() =>
    adminClient.academicTerm.create({
      data: { id: termB, institutionId: instB, academicSessionId: sessionB, name: `${PFX}TermB`, ordinal: 1, status: "ACTIVE", startDate: new Date("2026-07-01T00:00:00.000Z"), endDate: new Date("2026-12-31T00:00:00.000Z") },
    }),
  );
  await withRetry(() => adminClient.user.create({ data: { id: adminUserB, email: `${PFX.toLowerCase()}admin@b.test`, role: "ADMIN", accountStatus: "ACTIVE", institutionId: instB } }));
  {
    const mId = id(`mbr_${adminUserB}`);
    const roleId = await templateRoleId("ADMIN");
    await withRetry(() =>
      adminClient.institutionMembership.create({ data: { id: mId, userId: adminUserB, institutionId: instB, membershipStatus: "ACTIVE", permissionsVersion: 0 } }),
    );
    await withRetry(() =>
      adminClient.membershipRole.create({ data: { id: id(`mrl_${adminUserB}`), membershipId: mId, roleId, institutionId: instB } }),
    );
  }
  await withRetry(() => adminClient.user.create({ data: { id: facultyUserB, email: `${PFX.toLowerCase()}fac@b.test`, role: "GUARD", accountStatus: "ACTIVE", institutionId: instB } }));
  await withRetry(() =>
    adminClient.facultyProfile.create({ data: { id: facultyProfileB, institutionId: instB, userId: facultyUserB, name: `${PFX}FacultyB`, departmentId: deptB, status: "ACTIVE" } }),
  );
}

beforeAll(async () => {
  await teardown();
  await seed();

  const { facultyRoutes } = await import("../faculty.js");

  app = Fastify();
  await app.register(jwt, { secret: "faculty-behavioral-test-secret" });
  await app.register(facultyRoutes, { prefix: "/api/faculty" });
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
  await clearFacultyDomain();
});

describe("Phase-9.1 faculty management behavioral (real DB, real routes, real RLS)", () => {
  it("qualification create/update/delete + audit (staff); FACULTY staff route is 403", async () => {
    // create
    const createRes = await app.inject({
      method: "POST",
      url: `/api/faculty/${facultyProfileA}/qualifications`,
      headers: authHeader(adminToken()),
      payload: { title: "M.Tech CS", kind: "DEGREE", issuingBody: "IIT", year: 2015 },
    });
    expect(createRes.statusCode).toBe(201);
    const qId = createRes.json().id as string;

    const createdAudit = await adminClient.auditEvent.findFirst({
      where: { institutionId: instA, action: "faculty.qualification.created", resourceId: qId },
    });
    expect(createdAudit?.result).toBe("SUCCESS");

    // update
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/faculty/${facultyProfileA}/qualifications/${qId}`,
      headers: authHeader(adminToken()),
      payload: { field: "Machine Learning" },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().field).toBe("Machine Learning");
    expect(
      await adminClient.auditEvent.count({
        where: { institutionId: instA, action: "faculty.qualification.updated", resourceId: qId },
      }),
    ).toBe(1);

    // a FACULTY caller is 403 on a staff route (has faculty.view_own, not .manage)
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/faculty/${facultyProfileA}/qualifications`,
      headers: authHeader(facultyToken()),
      payload: { title: "X" },
    });
    expect(forbidden.statusCode).toBe(403);

    // delete
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/faculty/${facultyProfileA}/qualifications/${qId}`,
      headers: authHeader(adminToken()),
    });
    expect(delRes.statusCode).toBe(204);
    expect(await adminClient.facultyQualification.count({ where: { id: qId } })).toBe(0);
    expect(
      await adminClient.auditEvent.count({
        where: { institutionId: instA, action: "faculty.qualification.deleted", resourceId: qId },
      }),
    ).toBe(1);

    // deleting again is a 404 (count 0 -> DENIED, not a silent 200)
    const delAgain = await app.inject({
      method: "DELETE",
      url: `/api/faculty/${facultyProfileA}/qualifications/${qId}`,
      headers: authHeader(adminToken()),
    });
    expect(delAgain.statusCode).toBe(404);
  });

  it("workload recompute derives teachingHours from ACTIVE PRIMARY assignments (subs excluded)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/faculty/${facultyProfileA}/workload/${termA}/recompute`,
      headers: authHeader(adminToken()),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // subjectA on 2 sections (4+4) + subjectB on 1 section (3) = 11; SUBSTITUTE excluded
    expect(body.teachingHours).toBe(11);
    expect(body.totalHours).toBe(11);
    expect(body.excludedAssignmentIds).toContain(id("fa_sub"));
    expect(
      await adminClient.auditEvent.count({
        where: { institutionId: instA, action: "faculty.workload.recomputed" },
      }),
    ).toBe(1);
  });

  it("workload PATCH over-allocation: 422 without override; written with reason + overallocated audit WITH override", async () => {
    // cap below the derived 11h so any non-teaching push is over
    await app.inject({
      method: "PUT",
      url: `/api/faculty/workload-policy`,
      headers: authHeader(adminToken()),
      payload: { maxWeeklyHours: 12 },
    });

    // nonTeachingHours 5 => total 16 > 12 and no override => 422
    const rejected = await app.inject({
      method: "PATCH",
      url: `/api/faculty/${facultyProfileA}/workload/${termA}`,
      headers: authHeader(adminToken()),
      payload: { nonTeachingHours: 5 },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error).toBe("workload exceeds policy max");
    expect(await adminClient.facultyWorkload.count({ where: { institutionId: instA, facultyId: facultyProfileA } })).toBe(0);

    // with override + reason => written, overAllocated true, overallocated audit
    const accepted = await app.inject({
      method: "PATCH",
      url: `/api/faculty/${facultyProfileA}/workload/${termA}`,
      headers: authHeader(adminToken()),
      payload: { nonTeachingHours: 5, override: true, overrideReason: "approved by dean" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().overAllocated).toBe(true);
    expect(accepted.json().overrideReason).toBe("approved by dean");
    expect(accepted.json().policyMaxWeeklyHours).toBe(12);
    expect(
      await adminClient.auditEvent.count({
        where: { institutionId: instA, action: "faculty.workload.overallocated" },
      }),
    ).toBe(1);
  });

  it("teaching-history reconcile appends ASSIGNED rows; the append-only trigger rejects UPDATE and DELETE", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/faculty/${facultyProfileA}/teaching-history/reconcile`,
      headers: authHeader(adminToken()),
    });
    expect(res.statusCode).toBe(200);
    // 4 ACTIVE assignments, all ASSIGNED (none ended) => 4 rows
    expect(res.json().appended).toBe(4);

    // re-running is idempotent (plans nothing)
    const again = await app.inject({
      method: "POST",
      url: `/api/faculty/${facultyProfileA}/teaching-history/reconcile`,
      headers: authHeader(adminToken()),
    });
    expect(again.json().appended).toBe(0);

    const row = await adminClient.facultyTeachingHistory.findFirst({
      where: { institutionId: instA, facultyId: facultyProfileA },
      select: { id: true },
    });
    expect(row).not.toBeNull();

    // UPDATE rejected at the DB even via the owner client
    await expect(
      adminClient.$executeRawUnsafe(
        `UPDATE "faculty_teaching_history" SET "role" = 'ASSISTANT' WHERE "id" = $1`,
        row!.id,
      ),
    ).rejects.toThrow();

    // DELETE rejected at the DB even via the owner client
    await expect(
      adminClient.$executeRawUnsafe(`DELETE FROM "faculty_teaching_history" WHERE "id" = $1`, row!.id),
    ).rejects.toThrow();
  });

  it("self-service: GET /me/profile resolves the caller's own faculty; 403 when not a faculty member", async () => {
    const mine = await app.inject({
      method: "GET",
      url: `/api/faculty/me/profile`,
      headers: authHeader(facultyToken()),
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().identity.id).toBe(facultyProfileA);
    expect(mine.json()).toHaveProperty("qualifications");
    expect(mine.json()).toHaveProperty("workloads");
    expect(mine.json()).toHaveProperty("teachingHistory");

    const notFaculty = await app.inject({
      method: "GET",
      url: `/api/faculty/me/profile`,
      headers: authHeader(nonFacultyToken()),
    });
    expect(notFaculty.statusCode).toBe(403);
    expect(notFaculty.json().error).toBe("not a faculty member");
  });
});

describe("Faculty directory list + lookups + name projections (frontend reads; real DB, real RLS)", () => {
  const adminBToken = () => tokenFor(adminUserB, "ADMIN", instB);

  it("GET /api/faculty lists ONLY the caller's tenant with department names; tenant B never sees tenant A", async () => {
    const a = await app.inject({ method: "GET", url: `/api/faculty?pageSize=100`, headers: authHeader(adminToken()) });
    expect(a.statusCode).toBe(200);
    const aIds = (a.json().faculty as Array<{ id: string }>).map((f) => f.id);
    expect(aIds).toContain(facultyProfileA);
    expect(aIds).not.toContain(facultyProfileB);
    const rowA = (a.json().faculty as Array<{ id: string; department: { id: string; name: string } | null }>).find(
      (f) => f.id === facultyProfileA,
    );
    expect(rowA!.department).toEqual({ id: deptA, name: `${PFX}Dept` });

    const b = await app.inject({ method: "GET", url: `/api/faculty?pageSize=100`, headers: authHeader(adminBToken()) });
    expect(b.statusCode).toBe(200);
    const bIds = (b.json().faculty as Array<{ id: string }>).map((f) => f.id);
    expect(bIds).toEqual([facultyProfileB]);
    expect(b.json().total).toBe(1);
  });

  it("GET /api/faculty supports q and department filters", async () => {
    const hit = await app.inject({ method: "GET", url: `/api/faculty?q=facultyb`, headers: authHeader(adminBToken()) });
    expect(hit.json().faculty).toHaveLength(1);
    const miss = await app.inject({ method: "GET", url: `/api/faculty?q=zzz-none`, headers: authHeader(adminToken()) });
    expect(miss.json().faculty).toHaveLength(0);
    expect(miss.json().total).toBe(0);
    // A foreign department id filters to nothing inside tenant A (no cross-tenant leak).
    const foreign = await app.inject({ method: "GET", url: `/api/faculty?departmentId=${deptB}`, headers: authHeader(adminToken()) });
    expect(foreign.json().faculty).toHaveLength(0);
  });

  it("GET /api/faculty is 403 for FACULTY (self-scope only) and for a user with no staff key", async () => {
    expect((await app.inject({ method: "GET", url: `/api/faculty`, headers: authHeader(facultyToken()) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/faculty`, headers: authHeader(nonFacultyToken()) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/faculty/lookups`, headers: authHeader(facultyToken()) })).statusCode).toBe(403);
  });

  it("GET /api/faculty/lookups returns only the caller's terms and departments", async () => {
    const a = await app.inject({ method: "GET", url: `/api/faculty/lookups`, headers: authHeader(adminToken()) });
    expect(a.statusCode).toBe(200);
    const termIds = (a.json().terms as Array<{ id: string }>).map((t) => t.id);
    expect(termIds).toEqual([termA]);
    expect(a.json().terms[0].session).toEqual({ id: sessionA, name: `${PFX}Session` });
    expect((a.json().departments as Array<{ id: string }>).map((d) => d.id)).toEqual([deptA]);

    const b = await app.inject({ method: "GET", url: `/api/faculty/lookups`, headers: authHeader(adminBToken()) });
    expect((b.json().terms as Array<{ id: string }>).map((t) => t.id)).toEqual([termB]);
  });

  it("another tenant's faculty id is 404 on the profile read (names never leak across tenants)", async () => {
    const res = await app.inject({ method: "GET", url: `/api/faculty/${facultyProfileB}/profile`, headers: authHeader(adminToken()) });
    expect(res.statusCode).toBe(404);
  });

  it("teaching-history and profile reads carry term/subject/section names after reconcile", async () => {
    const rec = await app.inject({
      method: "POST",
      url: `/api/faculty/${facultyProfileA}/teaching-history/reconcile`,
      headers: authHeader(adminToken()),
    });
    expect(rec.statusCode).toBe(200);

    const hist = await app.inject({ method: "GET", url: `/api/faculty/${facultyProfileA}/teaching-history`, headers: authHeader(adminToken()) });
    expect(hist.statusCode).toBe(200);
    const rows = hist.json().teachingHistory as Array<{
      subject: { name: string } | null;
      academicTerm: { id: string; name: string } | null;
      classSection: { label: string | null } | null;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.academicTerm).toEqual({ id: termA, name: `${PFX}Term` });
      expect(r.subject!.name.startsWith(PFX)).toBe(true);
      expect(r.classSection!.label!.startsWith(PFX)).toBe(true);
    }

    const prof = await app.inject({ method: "GET", url: `/api/faculty/me/profile`, headers: authHeader(facultyToken()) });
    expect(prof.statusCode).toBe(200);
    expect(prof.json().identity.department).toEqual({ id: deptA, name: `${PFX}Dept` });
    expect(prof.json().teachingHistory[0].subject.name.startsWith(PFX)).toBe(true);
  });
});
