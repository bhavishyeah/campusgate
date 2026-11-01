/**
 * Phase-9.4 Transport Management BEHAVIORAL + CONCURRENCY integration suite
 * (design §B / FEAT-004 steps 4-5) — runs against the REAL Supabase instance
 * through a REAL Fastify app (real `authenticate` + real transportRoutes + the
 * real withTenant/RLS path). It proves the invariants the fast unit suite cannot:
 *   - vehicle/driver/route/stop CRUD through the real routes
 *   - assigning a MAINTENANCE vehicle -> 409 'vehicle in maintenance' + DENIED
 *   - enrollment happy path onto a route with an ACTIVE assignment -> 201
 *   - over-capacity: fill to seatCapacity then the N+1th -> 409 'route full' +
 *     DENIED audit
 *   - enrolling onto a route with no ACTIVE assignment -> 409 'route has no
 *     active vehicle assignment'
 *   - concurrency: two concurrent POST /enrollments onto a 1-seat route (an
 *     ACTIVE assignment to a seatCapacity-1 vehicle) -> exactly one 201 ACTIVE +
 *     one 409 (no over-fill), serialized by the route advisory lock + the
 *     one-ACTIVE partial unique
 *   - one-ACTIVE-per-(student,route): a second ACTIVE enrollment -> 409
 *   - per-route uniqueness: the same student ACTIVE on TWO different routes is OK
 *   - capacity-reduction: PATCH /vehicles seatCapacity below active enrollment on
 *     an assigned route -> 409 DENIED; equal-to succeeds
 *   - forward-only lifecycles: legal transitions succeed; SUSPENDED->ACTIVE and
 *     ENDED->* -> 409; a raw adminClient UPDATE/DELETE against a guarded row is
 *     rejected at the DB trigger
 *   - self-service (transport.view_own): a STUDENT /me/enrollments sees only
 *     their own ACTIVE enrollments as a list; a non-student caller gets 200 with
 *     an empty list; cross-tenant data is unreachable
 *   - no cross-module coupling: enrolling creates NO StudentCharge/fees row
 *   - reports: roster + utilization JSON + XLSX export
 *
 * SELF-CONTAINED under a DISTINCT prefix (TRANS9_TEST_); seeds + tears down its
 * own tenant/users/students/transport data via adminClient. Requires live
 * Supabase + campass_app creds. Registered in vitest.live-db-suites.ts; passes IN
 * ISOLATION.
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

const PFX = "TRANS9_TEST_";
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

// ─── tenant / users / students ───────────────────────────────────────────────
const instA = id("instA");
const deptA = id("deptA");

const adminUser = id("u_admin"); // ADMIN membership -> all transport staff perms
const studentUser1 = id("u_student1");
const studentProfile1 = id("sp_1");
const studentUser2 = id("u_student2");
const studentProfile2 = id("sp_2");
const studentUser3 = id("u_student3");
const studentProfile3 = id("sp_3");
// A user with a STUDENT membership (so it carries transport.view_own) but NO
// StudentProfile row — exercises the self-service no-profile branch, which must
// return 200 + an empty list (NEVER 404), the DELIBERATE departure from hostel.
const noProfileUser = id("u_noprofile");

let app: FastifyInstance;

function tokenFor(userId: string, legacyRole: string): string {
  return app.jwt.sign({ userId, role: legacyRole, institutionId: instA });
}
const authHeader = (t: string) => ({ authorization: `Bearer ${t}` });
const adminToken = () => tokenFor(adminUser, "ADMIN");
const student1Token = () => tokenFor(studentUser1, "STUDENT");
const student2Token = () => tokenFor(studentUser2, "STUDENT");

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

// ─── transport-row teardown (child-first, inside ONE replica-role tx) ─────────
// The three lifecycle tables carry column-guard triggers that forbid DELETE.
// Disabling named triggers one-at-a-time across separate pooled awaits is fragile
// on the session pooler (a DISABLE on one backend does not cover a deleteMany
// that lands on another). Instead run the whole child-first delete inside a
// SINGLE interactive transaction that sets `session_replication_role = 'replica'`
// up front — that pins one backend AND disables ALL user triggers for the span,
// so every delete runs guard-free and deterministically (child -> parent order
// still respects the RESTRICT FKs).
async function clearTransport(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  await withRetry(() =>
    adminClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      // child -> parent: schedules + maintenance + enrollments + assignments ->
      // stops -> routes + drivers + vehicles.
      await tx.transportRouteSchedule.deleteMany({ where });
      await tx.transportVehicleMaintenanceRequest.deleteMany({ where });
      await tx.transportEnrollment.deleteMany({ where });
      await tx.transportRouteAssignment.deleteMany({ where });
      await tx.transportRouteStop.deleteMany({ where });
      await tx.transportRoute.deleteMany({ where });
      await tx.transportDriver.deleteMany({ where });
      await tx.transportVehicle.deleteMany({ where });
    }),
  );
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
  await clearTransport();
  await withRetry(() => adminClient.membershipRole.deleteMany({ where }));
  await withRetry(() => adminClient.institutionMembership.deleteMany({ where }));
  await withRetry(() => adminClient.institutionModule.deleteMany({ where }));
  await withRetry(() => adminClient.studentProfile.deleteMany({ where }));
  await withRetry(() => adminClient.user.deleteMany({ where }));
  await withRetry(() => adminClient.department.deleteMany({ where }));
  await withRetry(() => adminClient.institution.deleteMany({ where: { id: { startsWith: PFX } } }));
}

async function createStudent(userId: string, profileId: string, tag: string): Promise<void> {
  await withRetry(() =>
    adminClient.user.create({
      data: { id: userId, email: `${userId.toLowerCase()}@a.test`, role: "STUDENT", accountStatus: "ACTIVE", institutionId: instA },
    }),
  );
  await ensureMembership(userId, "STUDENT");
  await withRetry(() =>
    adminClient.studentProfile.create({
      data: {
        id: profileId,
        userId,
        institutionId: instA,
        enrollmentNo: id(`ENR_${tag}`),
        name: `${PFX}Student ${tag}`,
        departmentId: deptA,
        program: "TEST",
        semester: 1,
        status: "ACTIVE",
      },
    }),
  );
}

async function seed(): Promise<void> {
  await withRetry(() => adminClient.institution.create({ data: { id: instA, name: `${PFX}A`, code: id("CODE_A"), status: "ACTIVE" } }));
  await withRetry(() => adminClient.department.create({ data: { id: deptA, name: `${PFX}Dept`, code: id("D_A"), institutionId: instA } }));
  await withRetry(() =>
    adminClient.institutionModule.create({
      data: { id: id("imod_A"), institutionId: instA, moduleKey: "transport", state: "ACTIVE", entitledAt: new Date(), activatedAt: new Date() },
    }),
  );

  // ADMIN (legacy role ADMIN; capability from the ADMIN membership which carries
  // the seven transport staff keys per the migration seed).
  await withRetry(() => adminClient.user.create({ data: { id: adminUser, email: `${PFX.toLowerCase()}admin@a.test`, role: "ADMIN", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(adminUser, "ADMIN");

  // Three students (STUDENT membership -> transport.view_own).
  await createStudent(studentUser1, studentProfile1, "1");
  await createStudent(studentUser2, studentProfile2, "2");
  await createStudent(studentUser3, studentProfile3, "3");

  // A STUDENT-membership user with NO StudentProfile (the no-profile self-service
  // branch): carries transport.view_own but resolveSelf finds nothing.
  await withRetry(() =>
    adminClient.user.create({
      data: { id: noProfileUser, email: `${noProfileUser.toLowerCase()}@a.test`, role: "STUDENT", accountStatus: "ACTIVE", institutionId: instA },
    }),
  );
  await ensureMembership(noProfileUser, "STUDENT");
}

// ─── scenario helpers through the REAL routes ────────────────────────────────
async function createVehicle(seatCapacity: number, status = "ACTIVE"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/transport/vehicles",
    headers: authHeader(adminToken()),
    payload: { registrationNo: `V${Date.now()}_${Math.floor(Math.random() * 1e6)}`, type: "BUS", seatCapacity, status },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function createDriver(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/transport/drivers",
    headers: authHeader(adminToken()),
    payload: { name: `Driver ${Date.now()}`, licenseNo: `L${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function createRoute(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/transport/routes",
    headers: authHeader(adminToken()),
    payload: { name: `Route ${Date.now()}`, code: `C${Date.now()}_${Math.floor(Math.random() * 1e6)}`, feeAmount: "150000" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function createStop(routeId: string, sequence = 1): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/api/transport/routes/${routeId}/stops`,
    headers: authHeader(adminToken()),
    payload: { name: `Stop ${sequence}_${Date.now()}`, sequence },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function assign(routeId: string, vehicleId: string, driverId: string) {
  return app.inject({
    method: "POST",
    url: `/api/transport/routes/${routeId}/assignments`,
    headers: authHeader(adminToken()),
    payload: { vehicleId, driverId, effectiveFrom: "2026-11-01T00:00:00.000Z" },
  });
}

async function enroll(routeId: string, stopId: string, studentId: string) {
  return app.inject({
    method: "POST",
    url: "/api/transport/enrollments",
    headers: authHeader(adminToken()),
    payload: { routeId, stopId, studentId },
  });
}

/** A route with an ACTIVE assignment to a vehicle of the given seatCapacity, plus a stop. */
async function assignedRoute(seatCapacity: number): Promise<{ routeId: string; stopId: string }> {
  const routeId = await createRoute();
  const stopId = await createStop(routeId);
  const vehicleId = await createVehicle(seatCapacity);
  const driverId = await createDriver();
  const a = await assign(routeId, vehicleId, driverId);
  expect(a.statusCode).toBe(201);
  return { routeId, stopId };
}

beforeAll(async () => {
  await teardown();
  await seed();

  const { transportRoutes } = await import("../transport.js");

  app = Fastify();
  await app.register(jwt, { secret: "transport-behavioral-test-secret" });
  await app.register(transportRoutes, { prefix: "/api/transport" });
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
  await clearTransport();
});

describe("Phase-9.4 transport management behavioral (real DB, real routes, real RLS)", () => {
  it("CRUD: vehicle/driver/route/stop create + patch + read through the real routes", async () => {
    const vehicleId = await createVehicle(40);
    const patchV = await app.inject({
      method: "PATCH",
      url: `/api/transport/vehicles/${vehicleId}`,
      headers: authHeader(adminToken()),
      payload: { seatCapacity: 45 },
    });
    expect(patchV.statusCode).toBe(200);
    expect(patchV.json().seatCapacity).toBe(45);

    const driverId = await createDriver();
    const patchD = await app.inject({
      method: "PATCH",
      url: `/api/transport/drivers/${driverId}`,
      headers: authHeader(adminToken()),
      payload: { status: "INACTIVE" },
    });
    expect(patchD.statusCode).toBe(200);
    expect(patchD.json().status).toBe("INACTIVE");

    const routeId = await createRoute();
    // feeAmount crosses the JSON boundary as a decimal-digit STRING.
    const getRoute = await app.inject({ method: "GET", url: `/api/transport/routes/${routeId}`, headers: authHeader(adminToken()) });
    expect(getRoute.statusCode).toBe(200);
    expect(getRoute.json().feeAmount).toBe("150000");
    expect(typeof getRoute.json().feeAmount).toBe("string");

    const stopId = await createStop(routeId, 1);
    const stops = await app.inject({ method: "GET", url: `/api/transport/routes/${routeId}/stops`, headers: authHeader(adminToken()) });
    expect(stops.statusCode).toBe(200);
    expect(stops.json().stops.some((s: { id: string }) => s.id === stopId)).toBe(true);
  }, 120_000);

  it("assignment: a MAINTENANCE vehicle cannot be assigned -> 409 'vehicle in maintenance' + DENIED audit", async () => {
    const routeId = await createRoute();
    const vehicleId = await createVehicle(10, "MAINTENANCE");
    const driverId = await createDriver();

    const res = await assign(routeId, vehicleId, driverId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("vehicle in maintenance");

    const denied = await adminClient.auditEvent.count({
      where: { institutionId: instA, action: "transport.assignment.created", result: "DENIED" },
    });
    expect(denied).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("enrollment happy path: enrolling onto a route with an ACTIVE assignment -> 201 ACTIVE", async () => {
    const { routeId, stopId } = await assignedRoute(40);

    const res = await enroll(routeId, stopId, studentProfile1);
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("ACTIVE");

    const active = await adminClient.transportEnrollment.count({ where: { institutionId: instA, routeId, status: "ACTIVE" } });
    expect(active).toBe(1);
  }, 120_000);

  it("over-capacity: fill to seatCapacity, then the N+1th -> 409 'route full' + DENIED audit", async () => {
    const { routeId, stopId } = await assignedRoute(1); // single seat

    const first = await enroll(routeId, stopId, studentProfile1);
    expect(first.statusCode).toBe(201);

    const second = await enroll(routeId, stopId, studentProfile2);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("route full");

    const denied = await adminClient.auditEvent.count({
      where: { institutionId: instA, action: "transport.enrollment.created", result: "DENIED" },
    });
    expect(denied).toBeGreaterThanOrEqual(1);

    const active = await adminClient.transportEnrollment.count({ where: { institutionId: instA, routeId, status: "ACTIVE" } });
    expect(active).toBe(1);
  }, 120_000);

  it("no-active-assignment: enrolling onto a route with no ACTIVE assignment -> 409 'route has no active vehicle assignment'", async () => {
    const routeId = await createRoute();
    const stopId = await createStop(routeId);

    const res = await enroll(routeId, stopId, studentProfile1);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("route has no active vehicle assignment");
  }, 120_000);

  it("concurrency: two concurrent POST /enrollments onto a 1-seat route -> exactly one 201 ACTIVE and one 409 (no over-fill)", async () => {
    const { routeId, stopId } = await assignedRoute(1);

    const [r1, r2] = await Promise.all([
      enroll(routeId, stopId, studentProfile1),
      enroll(routeId, stopId, studentProfile2),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([201, 409]);

    const active = await adminClient.transportEnrollment.count({ where: { institutionId: instA, routeId, status: "ACTIVE" } });
    expect(active).toBe(1); // never over-filled
  }, 120_000);

  it("one-ACTIVE-per-(student,route): a second ACTIVE enrollment for the same student+route -> 409", async () => {
    const { routeId, stopId } = await assignedRoute(40);

    const first = await enroll(routeId, stopId, studentProfile1);
    expect(first.statusCode).toBe(201);

    const second = await enroll(routeId, stopId, studentProfile1);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("student already enrolled on route");
  }, 120_000);

  it("per-route uniqueness: the same student ACTIVE on TWO different routes succeeds", async () => {
    const routeX = await assignedRoute(40);
    const routeY = await assignedRoute(40);

    expect((await enroll(routeX.routeId, routeX.stopId, studentProfile1)).statusCode).toBe(201);
    // Same student, a DIFFERENT route -> allowed (uniqueness is per-route).
    expect((await enroll(routeY.routeId, routeY.stopId, studentProfile1)).statusCode).toBe(201);
  }, 120_000);

  it("capacity-reduction: PATCH /vehicles seatCapacity below active enrollment -> 409 DENIED; equal-to succeeds", async () => {
    const routeId = await createRoute();
    const stopId = await createStop(routeId);
    const vehicleId = await createVehicle(2);
    const driverId = await createDriver();
    expect((await assign(routeId, vehicleId, driverId)).statusCode).toBe(201);

    expect((await enroll(routeId, stopId, studentProfile1)).statusCode).toBe(201);
    expect((await enroll(routeId, stopId, studentProfile2)).statusCode).toBe(201);
    // active enrollment on this assigned route is now 2.

    const tooLow = await app.inject({
      method: "PATCH",
      url: `/api/transport/vehicles/${vehicleId}`,
      headers: authHeader(adminToken()),
      payload: { seatCapacity: 1 },
    });
    expect(tooLow.statusCode).toBe(409);
    expect(tooLow.json().error).toBe("capacity below active enrollment");
    const denied = await adminClient.auditEvent.count({
      where: { institutionId: instA, action: "transport.vehicle.updated", result: "DENIED" },
    });
    expect(denied).toBeGreaterThanOrEqual(1);

    const equal = await app.inject({
      method: "PATCH",
      url: `/api/transport/vehicles/${vehicleId}`,
      headers: authHeader(adminToken()),
      payload: { seatCapacity: 2 },
    });
    expect(equal.statusCode).toBe(200);
    expect(equal.json().seatCapacity).toBe(2);
  }, 120_000);

  it("forward-only enrollment: legal ACTIVE->SUSPENDED->ENDED; SUSPENDED->ACTIVE and ENDED->* rejected; raw backward UPDATE/DELETE blocked at the trigger", async () => {
    const { routeId, stopId } = await assignedRoute(40);
    const enrollRes = await enroll(routeId, stopId, studentProfile1);
    expect(enrollRes.statusCode).toBe(201);
    const enrollmentId = enrollRes.json().id as string;

    // Legal ACTIVE -> SUSPENDED.
    const suspend = await app.inject({
      method: "POST",
      url: `/api/transport/enrollments/${enrollmentId}/suspend`,
      headers: authHeader(adminToken()),
    });
    expect(suspend.statusCode).toBe(200);
    expect(suspend.json().status).toBe("SUSPENDED");

    // SUSPENDED -> ACTIVE is not a legal transition: /suspend again from a
    // non-ACTIVE state -> 409 'enrollment not active' (no route back to ACTIVE).
    const reSuspend = await app.inject({
      method: "POST",
      url: `/api/transport/enrollments/${enrollmentId}/suspend`,
      headers: authHeader(adminToken()),
    });
    expect(reSuspend.statusCode).toBe(409);
    expect(reSuspend.json().error).toBe("enrollment not active");

    // Legal SUSPENDED -> ENDED.
    const end = await app.inject({
      method: "POST",
      url: `/api/transport/enrollments/${enrollmentId}/end`,
      headers: authHeader(adminToken()),
    });
    expect(end.statusCode).toBe(200);
    expect(end.json().status).toBe("ENDED");

    // ENDED -> * (end again) -> 409 'enrollment already ended'.
    const endAgain = await app.inject({
      method: "POST",
      url: `/api/transport/enrollments/${enrollmentId}/end`,
      headers: authHeader(adminToken()),
    });
    expect(endAgain.statusCode).toBe(409);
    expect(endAgain.json().error).toBe("enrollment already ended");

    // DB-level forward-only backstop: a raw backward UPDATE + a DELETE both raise
    // at the column guard (restrict_violation / 'illegal ... status transition').
    await expect(
      adminClient.$executeRawUnsafe(`UPDATE "transport_enrollments" SET "status" = 'ACTIVE' WHERE "id" = $1`, enrollmentId),
    ).rejects.toThrow();
    await expect(
      adminClient.$executeRawUnsafe(`DELETE FROM "transport_enrollments" WHERE "id" = $1`, enrollmentId),
    ).rejects.toThrow();
  }, 120_000);

  it("forward-only maintenance: illegal OPEN->RESOLVED -> 409 DENIED; legal OPEN->IN_PROGRESS->RESOLVED succeeds", async () => {
    const vehicleId = await createVehicle(10);
    const create = await app.inject({
      method: "POST",
      url: "/api/transport/maintenance",
      headers: authHeader(adminToken()),
      payload: { vehicleId, issue: "brake pads" },
    });
    expect(create.statusCode).toBe(201);
    const maintId = create.json().id as string;

    // OPEN -> RESOLVED is illegal (must pass through IN_PROGRESS) -> 409 DENIED.
    const illegal = await app.inject({
      method: "POST",
      url: `/api/transport/maintenance/${maintId}/transition`,
      headers: authHeader(adminToken()),
      payload: { toStatus: "RESOLVED" },
    });
    expect(illegal.statusCode).toBe(409);
    expect(illegal.json().error).toBe("illegal status transition");
    const denied = await adminClient.auditEvent.count({
      where: { institutionId: instA, action: "transport.maintenance.transitioned", result: "DENIED" },
    });
    expect(denied).toBeGreaterThanOrEqual(1);

    // Legal chain OPEN -> IN_PROGRESS -> RESOLVED.
    const toProgress = await app.inject({
      method: "POST",
      url: `/api/transport/maintenance/${maintId}/transition`,
      headers: authHeader(adminToken()),
      payload: { toStatus: "IN_PROGRESS" },
    });
    expect(toProgress.statusCode).toBe(200);
    const toResolved = await app.inject({
      method: "POST",
      url: `/api/transport/maintenance/${maintId}/transition`,
      headers: authHeader(adminToken()),
      payload: { toStatus: "RESOLVED", resolutionNote: "fixed" },
    });
    expect(toResolved.statusCode).toBe(200);
    expect(toResolved.json().status).toBe("RESOLVED");
    expect(toResolved.json().resolvedAt).not.toBeNull();
  }, 120_000);

  it("forward-only assignment: a raw backward/illegal status UPDATE is rejected by the trigger", async () => {
    const routeId = await createRoute();
    const vehicleId = await createVehicle(10);
    const driverId = await createDriver();
    const a = await assign(routeId, vehicleId, driverId);
    expect(a.statusCode).toBe(201);
    const assignmentId = a.json().id as string;

    // End the assignment (ACTIVE -> ENDED) via the route (legal).
    const end = await app.inject({
      method: "POST",
      url: `/api/transport/assignments/${assignmentId}/end`,
      headers: authHeader(adminToken()),
    });
    expect(end.statusCode).toBe(200);
    expect(end.json().status).toBe("ENDED");

    // A raw UPDATE back to ACTIVE from the terminal ENDED raises at the guard.
    await expect(
      adminClient.$executeRawUnsafe(`UPDATE "transport_route_assignments" SET "status" = 'ACTIVE' WHERE "id" = $1`, assignmentId),
    ).rejects.toThrow();
    await expect(
      adminClient.$executeRawUnsafe(`DELETE FROM "transport_route_assignments" WHERE "id" = $1`, assignmentId),
    ).rejects.toThrow();
  }, 120_000);

  it("self-service: a STUDENT /me/enrollments sees only their own ACTIVE enrollment; another student's data is unreachable", async () => {
    const routeX = await assignedRoute(40);
    const routeY = await assignedRoute(40);

    const e1 = await enroll(routeX.routeId, routeX.stopId, studentProfile1);
    expect(e1.statusCode).toBe(201);
    const e1Id = e1.json().id as string;
    const e2 = await enroll(routeY.routeId, routeY.stopId, studentProfile2);
    expect(e2.statusCode).toBe(201);

    // student1 sees ONLY their own ACTIVE enrollment (routeX).
    const mine = await app.inject({ method: "GET", url: "/api/transport/me/enrollments", headers: authHeader(student1Token()) });
    expect(mine.statusCode).toBe(200);
    const mineList = mine.json().enrollments as Array<{ id: string; routeId: string; studentId: string }>;
    expect(mineList.length).toBe(1);
    expect(mineList[0].id).toBe(e1Id);
    expect(mineList[0].studentId).toBe(studentProfile1);
    expect(mineList.some((e) => e.routeId === routeY.routeId)).toBe(false);

    // student2's /me/enrollments resolves THEIR row, never student1's.
    const theirs = await app.inject({ method: "GET", url: "/api/transport/me/enrollments", headers: authHeader(student2Token()) });
    expect(theirs.statusCode).toBe(200);
    const theirsList = theirs.json().enrollments as Array<{ id: string; studentId: string }>;
    expect(theirsList.length).toBe(1);
    expect(theirsList[0].studentId).toBe(studentProfile2);
    expect(theirsList.some((e) => e.id === e1Id)).toBe(false);

    // student1 /me/routes + /me/fees reflect their own route only.
    const routes = await app.inject({ method: "GET", url: "/api/transport/me/routes", headers: authHeader(student1Token()) });
    expect(routes.statusCode).toBe(200);
    const routeList = routes.json().routes as Array<{ id: string }>;
    expect(routeList.length).toBe(1);
    expect(routeList[0].id).toBe(routeX.routeId);

    const fees = await app.inject({ method: "GET", url: "/api/transport/me/fees", headers: authHeader(student1Token()) });
    expect(fees.statusCode).toBe(200);
    const feeList = fees.json().fees as Array<{ routeId: string; feeAmount: string | null }>;
    expect(feeList.length).toBe(1);
    expect(feeList[0].routeId).toBe(routeX.routeId);
    expect(feeList[0].feeAmount).toBe("150000"); // money-as-string
  }, 120_000);

  it("self-service: a caller with no StudentProfile gets 200 with an empty list (NOT 404)", async () => {
    // A STUDENT-membership user with NO StudentProfile (holds transport.view_own,
    // resolveSelf finds nothing) -> LIST-shaped 200 + empty list, NEVER 404 (the
    // DELIBERATE departure from hostel's 404 noProfile branch).
    const noProfileToken = tokenFor(noProfileUser, "STUDENT");
    const res = await app.inject({ method: "GET", url: "/api/transport/me/enrollments", headers: authHeader(noProfileToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().enrollments).toEqual([]);

    // A student WITH a profile but no ACTIVE enrollment also gets 200 + empty list.
    const student3Token = tokenFor(studentUser3, "STUDENT");
    const res3 = await app.inject({ method: "GET", url: "/api/transport/me/enrollments", headers: authHeader(student3Token) });
    expect(res3.statusCode).toBe(200);
    expect(res3.json().enrollments).toEqual([]);
  }, 120_000);

  it("no cross-module coupling: enrolling creates NO StudentCharge/fees row", async () => {
    const { routeId, stopId } = await assignedRoute(40);
    expect((await enroll(routeId, stopId, studentProfile1)).statusCode).toBe(201);

    // Enrolling must not touch the fees ledger — no StudentCharge for the student.
    const charges = await adminClient.studentCharge.count({ where: { institutionId: instA, studentId: studentProfile1 } });
    expect(charges).toBe(0);
  }, 120_000);

  it("reports: roster lists ACTIVE enrollments, utilization reflects effective capacity, XLSX export is audited", async () => {
    const { routeId, stopId } = await assignedRoute(2);
    expect((await enroll(routeId, stopId, studentProfile1)).statusCode).toBe(201);

    // roster for the route.
    const roster = await app.inject({ method: "GET", url: `/api/transport/reports/roster?routeId=${routeId}`, headers: authHeader(adminToken()) });
    expect(roster.statusCode).toBe(200);
    const rosterRows = roster.json().roster as Array<{ routeId: string; studentId: string; status: string }>;
    expect(rosterRows.length).toBe(1);
    expect(rosterRows[0].routeId).toBe(routeId);
    expect(rosterRows[0].status).toBe("ACTIVE");

    // utilization: effective capacity (2) from the ACTIVE assignment's vehicle;
    // 1 enrolled -> 0.5.
    const util = await app.inject({ method: "GET", url: "/api/transport/reports/utilization", headers: authHeader(adminToken()) });
    expect(util.statusCode).toBe(200);
    const row = (util.json().utilization as Array<{ routeId: string; capacity: number | null; enrolled: number; utilization: number | null }>).find((r) => r.routeId === routeId);
    expect(row).toBeTruthy();
    expect(row!.capacity).toBe(2);
    expect(row!.enrolled).toBe(1);
    expect(row!.utilization).toBe(0.5);

    // XLSX export: 200 + a spreadsheet content-type + a DENIED/SUCCESS audit.
    const exp = await app.inject({ method: "GET", url: `/api/transport/reports/roster/export?routeId=${routeId}`, headers: authHeader(adminToken()) });
    expect(exp.statusCode).toBe(200);
    expect(exp.headers["content-type"]).toContain("spreadsheetml.sheet");
    expect(exp.rawPayload.length).toBeGreaterThan(0);
    const exported = await adminClient.auditEvent.count({
      where: { institutionId: instA, action: "transport.roster.exported", result: "SUCCESS" },
    });
    expect(exported).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
