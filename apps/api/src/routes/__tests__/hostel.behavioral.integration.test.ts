/**
 * Phase-9.3 Hostel Management BEHAVIORAL + SELF-SERVICE integration suite
 * (design §B.13 / FEAT-003 steps 4-5) — runs against the REAL Supabase instance
 * through a REAL Fastify app (real `authenticate` + real hostelRoutes + the real
 * withTenant/RLS path). It proves the invariants the fast unit suite cannot:
 *   - over-capacity: allocate to capacity then the N+1th returns 409 'room full'
 *   - concurrency: two concurrent allocations into a 1-seat room -> exactly one
 *     201 and one 409 (no over-fill), serialized by the advisory lock + backed by
 *     the one-ACTIVE partial unique
 *   - one-ACTIVE-per-student: a second ACTIVE allocation for a student -> 409
 *   - capacity-reduction: PATCH /rooms capacity below occupancy -> 409 DENIED;
 *     equal-to-occupancy succeeds
 *   - transfer atomicity: source TRANSFERRED + one ACTIVE in destination;
 *     dest-full -> 409 and source left ACTIVE
 *   - forward-only lifecycles (leave / allocation / maintenance) illegal
 *     transitions rejected (the trigger raise mapped to 409)
 *   - hostel_check_events append-only UPDATE rejected at the DB
 *   - occupancy equals COUNT(ACTIVE) and a vacate immediately frees a seat
 *   - self-service (AC-12): a STUDENT calling /me/allocation sees only their own
 *     row; another student's data is unreachable (never another student's row)
 *
 * SELF-CONTAINED under a DISTINCT prefix (HOST9_TEST_); seeds + tears down its own
 * tenant/users/students/hostel data via adminClient. Requires live Supabase +
 * campass_app creds. Registered in vitest.live-db-suites.ts; passes IN ISOLATION.
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

const PFX = "HOST9_TEST_";
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

const adminUser = id("u_admin"); // ADMIN membership -> all hostel staff perms
const studentUser1 = id("u_student1");
const studentProfile1 = id("sp_1");
const studentUser2 = id("u_student2");
const studentProfile2 = id("sp_2");
const studentUser3 = id("u_student3");
const studentProfile3 = id("sp_3");

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

// ─── hostel-row teardown (child-first, inside ONE replica-role tx) ───────────
// The three lifecycle tables carry column-guard triggers that forbid DELETE and
// hostel_check_events is strictly append-only (its trigger raises on any
// UPDATE/DELETE). Disabling named triggers one-at-a-time across separate pooled
// awaits is fragile on the session pooler (a DISABLE on one backend does not
// cover a deleteMany that lands on another). Instead run the whole child-first
// delete inside a SINGLE interactive transaction that sets
// `session_replication_role = 'replica'` up front — that pins one backend AND
// disables ALL user triggers for the span, so every delete runs guard-free and
// deterministically (child -> parent order still respects the RESTRICT FKs).
async function clearHostel(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  await withRetry(() =>
    adminClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      // child -> parent: check_events -> maintenance/leave/allocations -> rooms
      // -> buildings.
      await tx.hostelCheckEvent.deleteMany({ where });
      await tx.hostelMaintenanceRequest.deleteMany({ where });
      await tx.hostelLeaveApplication.deleteMany({ where });
      await tx.hostelRoomAllocation.deleteMany({ where });
      await tx.hostelRoom.deleteMany({ where });
      await tx.hostelBuilding.deleteMany({ where });
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
  await clearHostel();
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
      data: { id: id("imod_A"), institutionId: instA, moduleKey: "hostel", state: "ACTIVE", entitledAt: new Date(), activatedAt: new Date() },
    }),
  );

  // ADMIN (legacy role ADMIN; capability from the ADMIN membership which carries
  // the five hostel staff keys per the migration seed).
  await withRetry(() => adminClient.user.create({ data: { id: adminUser, email: `${PFX.toLowerCase()}admin@a.test`, role: "ADMIN", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(adminUser, "ADMIN");

  // Three students (STUDENT membership -> hostel.view_own).
  await createStudent(studentUser1, studentProfile1, "1");
  await createStudent(studentUser2, studentProfile2, "2");
  await createStudent(studentUser3, studentProfile3, "3");
}

// ─── scenario helpers through the REAL routes ────────────────────────────────
async function createBuilding(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/hostel/buildings",
    headers: authHeader(adminToken()),
    payload: { name: `Block ${Date.now()}_${Math.random()}`, type: "BOYS" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function createRoom(buildingId: string, capacity: number): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/api/hostel/buildings/${buildingId}/rooms`,
    headers: authHeader(adminToken()),
    payload: { roomNumber: `R${Date.now()}_${Math.floor(Math.random() * 1e6)}`, capacity },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function allocate(roomId: string, studentId: string) {
  return app.inject({
    method: "POST",
    url: "/api/hostel/allocations",
    headers: authHeader(adminToken()),
    payload: { roomId, studentId },
  });
}

beforeAll(async () => {
  await teardown();
  await seed();

  const { hostelRoutes } = await import("../hostel.js");

  app = Fastify();
  await app.register(jwt, { secret: "hostel-behavioral-test-secret" });
  await app.register(hostelRoutes, { prefix: "/api/hostel" });
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
  await clearHostel();
});

describe("Phase-9.3 hostel management behavioral (real DB, real routes, real RLS)", () => {
  it("over-capacity: allocate to capacity, then the N+1th returns 409 'room full' + DENIED audit", async () => {
    const building = await createBuilding();
    const room = await createRoom(building, 1); // single seat

    const first = await allocate(room, studentProfile1);
    expect(first.statusCode).toBe(201);

    // A different student into the same full 1-seat room -> 409 room full.
    const second = await allocate(room, studentProfile2);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("room full");

    const denied = await adminClient.auditEvent.count({
      where: { institutionId: instA, action: "hostel.allocation.created", result: "DENIED" },
    });
    expect(denied).toBeGreaterThanOrEqual(1);

    // occupancy equals COUNT(ACTIVE) = 1.
    const active = await adminClient.hostelRoomAllocation.count({ where: { institutionId: instA, roomId: room, status: "ACTIVE" } });
    expect(active).toBe(1);
  }, 120_000);

  it("concurrency: two concurrent allocations into a 1-seat room -> exactly one 201 and one 409 (no over-fill)", async () => {
    const building = await createBuilding();
    const room = await createRoom(building, 1);

    const [r1, r2] = await Promise.all([allocate(room, studentProfile1), allocate(room, studentProfile2)]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([201, 409]);

    const active = await adminClient.hostelRoomAllocation.count({ where: { institutionId: instA, roomId: room, status: "ACTIVE" } });
    expect(active).toBe(1); // never over-filled
  }, 120_000);

  it("one-ACTIVE-per-student: a second ACTIVE allocation for a student -> 409 (partial-unique backstop)", async () => {
    const building = await createBuilding();
    const roomX = await createRoom(building, 2);
    const roomY = await createRoom(building, 2);

    const first = await allocate(roomX, studentProfile1);
    expect(first.statusCode).toBe(201);

    // Same student into a DIFFERENT room with free capacity -> 409 already allocated.
    const second = await allocate(roomY, studentProfile1);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("student already allocated");
  }, 120_000);

  it("capacity-reduction: PATCH /rooms below occupancy -> 409 DENIED; equal-to-occupancy succeeds", async () => {
    const building = await createBuilding();
    const room = await createRoom(building, 2);

    expect((await allocate(room, studentProfile1)).statusCode).toBe(201);
    expect((await allocate(room, studentProfile2)).statusCode).toBe(201);
    // occupancy is now 2.

    // Reduce to 1 (below occupancy 2) -> 409 DENIED.
    const tooLow = await app.inject({
      method: "PATCH",
      url: `/api/hostel/rooms/${room}`,
      headers: authHeader(adminToken()),
      payload: { capacity: 1 },
    });
    expect(tooLow.statusCode).toBe(409);
    expect(tooLow.json().error).toBe("capacity below current occupancy");
    const denied = await adminClient.auditEvent.count({
      where: { institutionId: instA, action: "hostel.room.updated", result: "DENIED" },
    });
    expect(denied).toBeGreaterThanOrEqual(1);

    // Equal to occupancy (2) is allowed.
    const equal = await app.inject({
      method: "PATCH",
      url: `/api/hostel/rooms/${room}`,
      headers: authHeader(adminToken()),
      payload: { capacity: 2 },
    });
    expect(equal.statusCode).toBe(200);
    expect(equal.json().capacity).toBe(2);
  }, 120_000);

  it("transfer atomicity: source TRANSFERRED + one ACTIVE in destination; dest-full -> 409 and source left ACTIVE", async () => {
    const building = await createBuilding();
    const roomA = await createRoom(building, 1);
    const roomB = await createRoom(building, 1);

    const alloc = await allocate(roomA, studentProfile1);
    expect(alloc.statusCode).toBe(201);
    const allocId = alloc.json().id as string;

    // A successful transfer A -> B.
    const transfer = await app.inject({
      method: "POST",
      url: `/api/hostel/allocations/${allocId}/transfer`,
      headers: authHeader(adminToken()),
      payload: { toRoomId: roomB },
    });
    expect(transfer.statusCode).toBe(201);

    const source = await adminClient.hostelRoomAllocation.findUnique({ where: { id: allocId } });
    expect(source!.status).toBe("TRANSFERRED");
    expect(source!.vacatedAt).not.toBeNull();
    const destActive = await adminClient.hostelRoomAllocation.count({ where: { institutionId: instA, roomId: roomB, status: "ACTIVE" } });
    expect(destActive).toBe(1);
    expect(await adminClient.hostelRoomAllocation.count({ where: { institutionId: instA, roomId: roomA, status: "ACTIVE" } })).toBe(0);

    // Now fill roomA with student2, then try to transfer the student2 allocation
    // into roomB which is full -> 409, source (in roomA) left ACTIVE (rollback).
    const alloc2 = await allocate(roomA, studentProfile2);
    expect(alloc2.statusCode).toBe(201);
    const alloc2Id = alloc2.json().id as string;

    const destFull = await app.inject({
      method: "POST",
      url: `/api/hostel/allocations/${alloc2Id}/transfer`,
      headers: authHeader(adminToken()),
      payload: { toRoomId: roomB },
    });
    expect(destFull.statusCode).toBe(409);
    expect(destFull.json().error).toBe("room full");

    const source2 = await adminClient.hostelRoomAllocation.findUnique({ where: { id: alloc2Id } });
    expect(source2!.status).toBe("ACTIVE"); // untouched by the failed transfer
  }, 120_000);

  it("forward-only maintenance: illegal transition rejected 409 DENIED; legal chain succeeds", async () => {
    const building = await createBuilding();
    const room = await createRoom(building, 2);

    const create = await app.inject({
      method: "POST",
      url: "/api/hostel/maintenance",
      headers: authHeader(adminToken()),
      payload: { roomId: room, issue: "broken window" },
    });
    expect(create.statusCode).toBe(201);
    const maintId = create.json().id as string;

    // OPEN -> RESOLVED is illegal (must pass through IN_PROGRESS) -> 409 DENIED.
    const illegal = await app.inject({
      method: "POST",
      url: `/api/hostel/maintenance/${maintId}/transition`,
      headers: authHeader(adminToken()),
      payload: { toStatus: "RESOLVED" },
    });
    expect(illegal.statusCode).toBe(409);
    expect(illegal.json().error).toBe("illegal status transition");
    const denied = await adminClient.auditEvent.count({
      where: { institutionId: instA, action: "hostel.maintenance.transitioned", result: "DENIED" },
    });
    expect(denied).toBeGreaterThanOrEqual(1);

    // Legal: OPEN -> IN_PROGRESS -> RESOLVED.
    const toProgress = await app.inject({
      method: "POST",
      url: `/api/hostel/maintenance/${maintId}/transition`,
      headers: authHeader(adminToken()),
      payload: { toStatus: "IN_PROGRESS" },
    });
    expect(toProgress.statusCode).toBe(200);
    const toResolved = await app.inject({
      method: "POST",
      url: `/api/hostel/maintenance/${maintId}/transition`,
      headers: authHeader(adminToken()),
      payload: { toStatus: "RESOLVED", resolutionNote: "fixed" },
    });
    expect(toResolved.statusCode).toBe(200);
    expect(toResolved.json().status).toBe("RESOLVED");
    expect(toResolved.json().resolvedAt).not.toBeNull();
  }, 120_000);

  it("forward-only leave: a decided (APPROVED) leave cannot be re-decided -> 409; the guard backstops a raw backward UPDATE", async () => {
    const building = await createBuilding();
    const room = await createRoom(building, 2);
    expect((await allocate(room, studentProfile1)).statusCode).toBe(201);

    // Student applies for leave via /me/leave.
    const apply = await app.inject({
      method: "POST",
      url: "/api/hostel/me/leave",
      headers: authHeader(student1Token()),
      payload: { fromDate: "2027-01-10T00:00:00.000Z", toDate: "2027-01-12T00:00:00.000Z", reason: "home" },
    });
    expect(apply.statusCode).toBe(201);
    const leaveId = apply.json().id as string;

    // Warden/admin approves.
    const approve = await app.inject({
      method: "POST",
      url: `/api/hostel/leave/${leaveId}/approve`,
      headers: authHeader(adminToken()),
      payload: { decisionNote: "ok" },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe("APPROVED");

    // Re-deciding an already-APPROVED leave -> 409 'leave not pending'.
    const reject = await app.inject({
      method: "POST",
      url: `/api/hostel/leave/${leaveId}/reject`,
      headers: authHeader(adminToken()),
      payload: {},
    });
    expect(reject.statusCode).toBe(409);
    expect(reject.json().error).toBe("leave not pending");

    // DB-level forward-only backstop: a raw backward UPDATE raises at the guard.
    await expect(
      adminClient.$executeRawUnsafe(`UPDATE "hostel_leave_applications" SET "status" = 'REQUESTED' WHERE "id" = $1`, leaveId),
    ).rejects.toThrow();
  }, 120_000);

  it("forward-only allocation: the column guard rejects a raw backward/illegal status UPDATE", async () => {
    const building = await createBuilding();
    const room = await createRoom(building, 2);
    const alloc = await allocate(room, studentProfile1);
    expect(alloc.statusCode).toBe(201);
    const allocId = alloc.json().id as string;

    // Vacate ACTIVE -> VACATED (legal) via the route.
    const vacate = await app.inject({
      method: "POST",
      url: `/api/hostel/allocations/${allocId}/vacate`,
      headers: authHeader(adminToken()),
    });
    expect(vacate.statusCode).toBe(200);
    expect(vacate.json().status).toBe("VACATED");

    // A raw UPDATE back to ACTIVE from the terminal VACATED raises at the guard.
    await expect(
      adminClient.$executeRawUnsafe(`UPDATE "hostel_room_allocations" SET "status" = 'ACTIVE' WHERE "id" = $1`, allocId),
    ).rejects.toThrow();
  }, 120_000);

  it("append-only hostel_check_events: a check row is recorded; a raw UPDATE/DELETE is rejected at the DB", async () => {
    const building = await createBuilding();
    const room = await createRoom(building, 2);
    const alloc = await allocate(room, studentProfile1);
    expect(alloc.statusCode).toBe(201);
    const allocId = alloc.json().id as string;

    const check = await app.inject({
      method: "POST",
      url: `/api/hostel/allocations/${allocId}/check`,
      headers: authHeader(adminToken()),
      payload: { eventType: "CHECK_IN" },
    });
    expect(check.statusCode).toBe(201);
    const eventId = check.json().id as string;

    await expect(
      adminClient.$executeRawUnsafe(`UPDATE "hostel_check_events" SET "eventType" = 'CHECK_OUT' WHERE "id" = $1`, eventId),
    ).rejects.toThrow();
    await expect(
      adminClient.$executeRawUnsafe(`DELETE FROM "hostel_check_events" WHERE "id" = $1`, eventId),
    ).rejects.toThrow();
  }, 120_000);

  it("occupancy equals COUNT(ACTIVE) and a vacate immediately frees a seat with no drift", async () => {
    const building = await createBuilding();
    const room = await createRoom(building, 2);

    expect((await allocate(room, studentProfile1)).statusCode).toBe(201);
    const alloc2 = await allocate(room, studentProfile2);
    expect(alloc2.statusCode).toBe(201);
    const alloc2Id = alloc2.json().id as string;

    // GET /rooms/:id reports occupied 2, available 0.
    const full = await app.inject({ method: "GET", url: `/api/hostel/rooms/${room}`, headers: authHeader(adminToken()) });
    expect(full.statusCode).toBe(200);
    expect(full.json().occupancy).toEqual({ capacity: 2, occupied: 2, available: 0 });

    // Vacate one -> a seat frees immediately (computed read, no stored counter).
    expect((await app.inject({ method: "POST", url: `/api/hostel/allocations/${alloc2Id}/vacate`, headers: authHeader(adminToken()) })).statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: `/api/hostel/rooms/${room}`, headers: authHeader(adminToken()) });
    expect(after.json().occupancy).toEqual({ capacity: 2, occupied: 1, available: 1 });

    // The computed occupancy equals the raw COUNT(ACTIVE).
    const active = await adminClient.hostelRoomAllocation.count({ where: { institutionId: instA, roomId: room, status: "ACTIVE" } });
    expect(active).toBe(1);

    // Re-allocating now succeeds (the freed seat is real).
    expect((await allocate(room, studentProfile3)).statusCode).toBe(201);
  }, 120_000);

  // ─── Self-service / tenancy (AC-12) ──────────────────────────────────────────
  it("AC-12 self-service: a STUDENT /me/allocation sees only their own row; another student's data is unreachable", async () => {
    const building = await createBuilding();
    const roomA = await createRoom(building, 2);
    const roomB = await createRoom(building, 2);

    // Allocate student1 to roomA and student2 to roomB (staff action).
    const a1 = await allocate(roomA, studentProfile1);
    expect(a1.statusCode).toBe(201);
    const a1Id = a1.json().id as string;
    const a2 = await allocate(roomB, studentProfile2);
    expect(a2.statusCode).toBe(201);

    // student1 sees ONLY their own ACTIVE allocation (roomA).
    const mine = await app.inject({ method: "GET", url: "/api/hostel/me/allocation", headers: authHeader(student1Token()) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().allocation).not.toBeNull();
    expect(mine.json().allocation.id).toBe(a1Id);
    expect(mine.json().allocation.studentId).toBe(studentProfile1);
    expect(mine.json().allocation.roomId).toBe(roomA);

    // student2's /me/allocation resolves THEIR row, never student1's.
    const theirs = await app.inject({ method: "GET", url: "/api/hostel/me/allocation", headers: authHeader(student2Token()) });
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json().allocation.studentId).toBe(studentProfile2);
    expect(theirs.json().allocation.id).not.toBe(a1Id);

    // student1 /me/occupancy reflects their own room only.
    const occ = await app.inject({ method: "GET", url: "/api/hostel/me/occupancy", headers: authHeader(student1Token()) });
    expect(occ.statusCode).toBe(200);
    expect(occ.json().occupancy.roomId).toBe(roomA);
  }, 120_000);

  it("AC-12 self-service: a student can cancel ONLY their own REQUESTED leave; another student's leave id is unreachable (404)", async () => {
    // student1 applies for leave.
    const apply1 = await app.inject({
      method: "POST",
      url: "/api/hostel/me/leave",
      headers: authHeader(student1Token()),
      payload: { fromDate: "2027-02-01T00:00:00.000Z", toDate: "2027-02-03T00:00:00.000Z", reason: "trip" },
    });
    expect(apply1.statusCode).toBe(201);
    const leave1Id = apply1.json().id as string;

    // student2 tries to cancel student1's leave -> self-scoped find misses -> 404.
    const crossCancel = await app.inject({
      method: "POST",
      url: `/api/hostel/me/leave/${leave1Id}/cancel`,
      headers: authHeader(student2Token()),
    });
    expect(crossCancel.statusCode).toBe(404);

    // student1's leave is untouched (still REQUESTED).
    const stillReq = await adminClient.hostelLeaveApplication.findUnique({ where: { id: leave1Id } });
    expect(stillReq!.status).toBe("REQUESTED");

    // student1 cancels their OWN leave -> 200 CANCELLED.
    const ownCancel = await app.inject({
      method: "POST",
      url: `/api/hostel/me/leave/${leave1Id}/cancel`,
      headers: authHeader(student1Token()),
    });
    expect(ownCancel.statusCode).toBe(200);
    expect(ownCancel.json().status).toBe("CANCELLED");

    // student2's /me/leave list never shows student1's application.
    const student2List = await app.inject({ method: "GET", url: "/api/hostel/me/leave", headers: authHeader(student2Token()) });
    expect(student2List.statusCode).toBe(200);
    expect(student2List.json().applications.some((a: { id: string }) => a.id === leave1Id)).toBe(false);
  }, 120_000);
});
