import type { FastifyInstance, FastifyRequest } from "fastify";
import ExcelJS from "exceljs";
import { withTenant, Prisma } from "@campusgate/db";
import {
  createBuildingSchema,
  patchBuildingSchema,
  createRoomSchema,
  patchRoomSchema,
  allocateSchema,
  transferSchema,
  checkEventSchema,
  applyLeaveSchema,
  leaveDecisionSchema,
  createMaintenanceSchema,
  maintenanceTransitionSchema,
  hostelListQuerySchema,
} from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission, requireModuleActive } from "../services/authz-engine.js";
import { recordAuditEvent } from "../services/audit.js";

const MODULE_KEY = "hostel" as const;

/**
 * Hostel Management routes (design §B.9), registered at `/api/hostel`
 * (see server.ts). Hostel is a GATED "booster" module — every operational
 * route carries `requireModuleActive("hostel")` IN ADDITION to
 * `requirePermission("hostel.*")` (the library/exams precedent).
 *
 * House pattern (mirrors library.ts / exams.ts):
 *  - a single top-level `authenticate` preHandler;
 *  - per-route `[requirePermission(key), requireModuleActive("hostel")]`;
 *  - every handler body runs inside `withTenant(institutionId, tx => ...)` with
 *    `institutionId` from the verified token (`request.user`), never from input;
 *  - every mutation (and every DENIED capacity/lifecycle decision) writes a
 *    `hostel.*` AuditEvent via `recordAuditEvent` in the SAME transaction;
 *  - deny branches record a DENIED audit then RETURN the 4xx from a
 *    normally-returning `withTenant` callback (never `throw`) so the audit
 *    commits (design §B.3 / §C.7);
 *  - allocation concurrency: a transaction-scoped advisory lock on the
 *    tenant-qualified room (`hostelalloc:${institutionId}:${roomId}`) + a
 *    conditional ACTIVE count under the lock, backstopped by the partial unique
 *    `hostel_room_allocations_one_active_per_student` (design §B.3).
 */
export async function hostelRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  const gate = MODULE_KEY;

  // ─── Shared helpers ────────────────────────────────────────────────────────

  function actor(request: FastifyRequest) {
    return {
      actorUserId: request.user.userId,
      actorRoleKey: request.auth?.roles[0] ?? request.user.role,
      actorMembershipId: request.auth?.membershipId ?? null,
      requestRef: request.id,
    };
  }

  // Deny result shape returned from a withTenant callback so a deny branch can
  // RETURN a 4xx (never throw) after recording a DENIED audit in the same tx.
  interface Deny {
    deny: string;
    status: number;
  }
  function deny(message: string, status: number): Deny {
    return { deny: message, status };
  }
  // Type guard that narrows a withTenant outcome to its deny branch so the
  // `outcome.deny` access below is fully typed (not `Deny | undefined`).
  function isDeny(x: unknown): x is { deny: Deny } {
    return (
      typeof x === "object" &&
      x !== null &&
      "deny" in x &&
      typeof (x as { deny: unknown }).deny === "object"
    );
  }

  function isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
  }
  function isRestrictViolation(err: unknown): boolean {
    // Postgres restrict_violation (23001) raised by the column-guard triggers
    // surfaces through Prisma carrying the trigger message text.
    const msg = String((err as Error)?.message ?? err);
    return msg.includes("restrict_violation") || msg.includes("illegal") || msg.includes("append-only");
  }

  // Advisory xact lock on a tenant-qualified key (the library lockStudent /
  // exams advisoryLock idiom). Held until the tx commits/rolls back.
  async function advisoryLock(tx: Prisma.TransactionClient, key: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }

  // Tenant-qualified allocation lock key so two tenants hashing the same roomId
  // do not contend (design §B.3 step 1 / §B.5).
  function allocLockKey(institutionId: string, roomId: string): string {
    return `hostelalloc:${institutionId}:${roomId}`;
  }

  // Count ACTIVE allocations in a room (the single-source-of-truth occupancy,
  // design §B.6). The only writer of an ACTIVE row is the capacity-checked
  // allocate/transfer path; the only remover is the forward-only guard.
  async function countActive(
    tx: Prisma.TransactionClient,
    institutionId: string,
    roomId: string,
  ): Promise<number> {
    return tx.hostelRoomAllocation.count({
      where: { institutionId, roomId, status: "ACTIVE" },
    });
  }

  // Resolve the caller's StudentProfile for a /me/* self-service route
  // (assumption A2). Never reads a studentId from input.
  async function resolveSelf(
    tx: Prisma.TransactionClient,
    institutionId: string,
    userId: string,
  ): Promise<{ id: string } | null> {
    return tx.studentProfile.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });
  }

  // ─── 1. POST /buildings — create a building (matrix row 1) ───────────────────
  app.post(
    "/buildings",
    { preHandler: [requirePermission("hostel.buildings.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createBuildingSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const building = await withTenant(institutionId, async (tx) => {
        const created = await tx.hostelBuilding.create({
          data: {
            institutionId,
            name: data.name,
            type: data.type,
            wardenUserId: data.wardenUserId ?? null,
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
            createdByUserId: request.user.userId,
          },
        });
        await recordAuditEvent(
          {
            action: "hostel.building.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HostelBuilding",
            resourceId: created.id,
          },
          tx,
        );
        return created;
      });

      return reply.status(201).send(building);
    },
  );

  // ─── 2. PATCH /buildings/:id — edit a building (matrix row 2) ────────────────
  app.patch(
    "/buildings/:id",
    { preHandler: [requirePermission("hostel.buildings.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = patchBuildingSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const building = await tx.hostelBuilding.findFirst({
          where: { id, institutionId },
          select: { id: true },
        });
        if (!building) return { notFound: true as const };

        const updated = await tx.hostelBuilding.update({
          where: { id: building.id },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.type !== undefined ? { type: data.type } : {}),
            ...("wardenUserId" in data ? { wardenUserId: data.wardenUserId ?? null } : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          },
        });
        await recordAuditEvent(
          {
            action: "hostel.building.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HostelBuilding",
            resourceId: building.id,
          },
          tx,
        );
        return { building: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "building not found" });
      return reply.send(outcome.building);
    },
  );

  // ─── 3. GET /buildings — staff list (matrix row 3) ───────────────────────────
  app.get(
    "/buildings",
    { preHandler: [requirePermission("hostel.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = hostelListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { page, pageSize } = parsed.data;

      const result = await withTenant(institutionId, async (tx) => {
        const where: Prisma.HostelBuildingWhereInput = { institutionId };
        const [total, buildings] = await Promise.all([
          tx.hostelBuilding.count({ where }),
          tx.hostelBuilding.findMany({
            where,
            orderBy: [{ name: "asc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
        ]);
        return { total, buildings };
      });

      return reply.send({ buildings: result.buildings, total: result.total, page, pageSize });
    },
  );

  // ─── 4. POST /buildings/:id/rooms — create a room (matrix row 4) ─────────────
  app.post(
    "/buildings/:id/rooms",
    { preHandler: [requirePermission("hostel.buildings.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: buildingId } = request.params as { id: string };
      const parsed = createRoomSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const building = await tx.hostelBuilding.findFirst({
          where: { id: buildingId, institutionId },
          select: { id: true },
        });
        if (!building) return { notFound: true as const };

        let room;
        try {
          room = await tx.hostelRoom.create({
            data: {
              institutionId,
              buildingId: building.id,
              roomNumber: data.roomNumber,
              capacity: data.capacity,
              floor: data.floor ?? null,
              createdByUserId: request.user.userId,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("room number already exists in building", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "hostel.room.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HostelRoom",
            resourceId: room.id,
            metadata: { buildingId: building.id, roomNumber: data.roomNumber },
          },
          tx,
        );
        return { room };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "building not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(outcome.room);
    },
  );

  // ─── 5. PATCH /rooms/:id — edit a room + FR-1.4 capacity guard (row 5) ───────
  app.patch(
    "/rooms/:id",
    { preHandler: [requirePermission("hostel.buildings.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = patchRoomSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const room = await tx.hostelRoom.findFirst({
          where: { id, institutionId },
          select: { id: true },
        });
        if (!room) return { notFound: true as const };

        // FR-1.4 capacity-reduction guard (design §B.5): lock the room on the
        // SAME key as allocation so a concurrent allocate cannot slip a seat in
        // between the count and the update; reject newCapacity < occupied.
        if (data.capacity !== undefined) {
          await advisoryLock(tx, allocLockKey(institutionId, room.id));
          const occupied = await countActive(tx, institutionId, room.id);
          if (data.capacity < occupied) {
            await recordAuditEvent(
              {
                action: "hostel.room.updated",
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "HostelRoom",
                resourceId: room.id,
                metadata: { reason: "capacity below occupancy", occupied, requested: data.capacity },
              },
              tx,
            );
            return { deny: deny("capacity below current occupancy", 409) };
          }
        }

        const updated = await tx.hostelRoom.update({
          where: { id: room.id },
          data: {
            ...(data.roomNumber !== undefined ? { roomNumber: data.roomNumber } : {}),
            ...(data.capacity !== undefined ? { capacity: data.capacity } : {}),
            ...("floor" in data ? { floor: data.floor ?? null } : {}),
            ...(data.status !== undefined ? { status: data.status } : {}),
          },
        });
        await recordAuditEvent(
          {
            action: "hostel.room.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HostelRoom",
            resourceId: room.id,
          },
          tx,
        );
        return { room: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "room not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(outcome.room);
    },
  );

  // ─── 6. GET /rooms/:id — staff detail + computed occupancy (row 6) ───────────
  app.get(
    "/rooms/:id",
    { preHandler: [requirePermission("hostel.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const outcome = await withTenant(institutionId, async (tx) => {
        const room = await tx.hostelRoom.findFirst({ where: { id, institutionId } });
        if (!room) return { notFound: true as const };
        const occupied = await countActive(tx, institutionId, room.id);
        return { room, occupied };
      });
      if ("notFound" in outcome) return reply.status(404).send({ error: "room not found" });
      return reply.send({
        ...outcome.room,
        occupancy: {
          capacity: outcome.room.capacity,
          occupied: outcome.occupied,
          available: outcome.room.capacity - outcome.occupied,
        },
      });
    },
  );

  // ─── 7. POST /allocations — allocate a student (row 7, design §B.3) ──────────
  app.post(
    "/allocations",
    { preHandler: [requirePermission("hostel.allocations.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = allocateSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { roomId, studentId } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        // 1. Advisory lock on the room; held to commit.
        await advisoryLock(tx, allocLockKey(institutionId, roomId));

        // 2. Load + validate the room (tenant-filtered) and the student.
        const room = await tx.hostelRoom.findFirst({
          where: { id: roomId, institutionId },
          select: { id: true, capacity: true, status: true },
        });
        if (!room) return { notFound: "room not found" as const };

        if (room.status !== "AVAILABLE") {
          await recordAuditEvent(
            {
              action: "hostel.allocation.created",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "HostelRoomAllocation",
              metadata: { reason: "room not accepting allocations", roomId, studentId, status: room.status },
            },
            tx,
          );
          return { deny: deny("room not accepting allocations", 409) };
        }

        const student = await tx.studentProfile.findFirst({
          where: { id: studentId, institutionId },
          select: { id: true },
        });
        if (!student) return { notFound: "student not found" as const };

        // 3. One-active check (deny early, audited).
        const existingActive = await tx.hostelRoomAllocation.count({
          where: { institutionId, studentId, status: "ACTIVE" },
        });
        if (existingActive >= 1) {
          await recordAuditEvent(
            {
              action: "hostel.allocation.created",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "HostelRoomAllocation",
              metadata: { reason: "student already allocated", roomId, studentId },
            },
            tx,
          );
          return { deny: deny("student already allocated", 409) };
        }

        // 4. Capacity check under the lock.
        const occupied = await countActive(tx, institutionId, room.id);
        if (occupied + 1 > room.capacity) {
          await recordAuditEvent(
            {
              action: "hostel.allocation.created",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "HostelRoomAllocation",
              metadata: { reason: "room full", roomId, studentId, occupied, capacity: room.capacity },
            },
            tx,
          );
          return { deny: deny("room full", 409) };
        }

        // 5. Insert the allocation; the partial unique backstops a lost race.
        let allocation;
        try {
          allocation = await tx.hostelRoomAllocation.create({
            data: {
              institutionId,
              roomId: room.id,
              studentId: student.id,
              status: "ACTIVE",
              allocatedAt: new Date(),
              allocatedByUserId: request.user.userId,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("student already allocated", 409) };
          throw err;
        }

        // 6. SUCCESS audit in the same tx.
        await recordAuditEvent(
          {
            action: "hostel.allocation.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HostelRoomAllocation",
            resourceId: allocation.id,
            metadata: { roomId: room.id, studentId: student.id },
          },
          tx,
        );
        return { allocation };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: outcome.notFound });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(outcome.allocation);
    },
  );

  // ─── 8. POST /allocations/:id/transfer — atomic transfer (row 8) ─────────────
  app.post(
    "/allocations/:id/transfer",
    { preHandler: [requirePermission("hostel.allocations.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = transferSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { toRoomId } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        // Validate the source allocation is ACTIVE in tenant.
        const source = await tx.hostelRoomAllocation.findFirst({
          where: { id, institutionId },
          select: { id: true, roomId: true, studentId: true, status: true },
        });
        if (!source) return { notFound: "allocation not found" as const };
        if (source.status !== "ACTIVE") return { deny: deny("allocation not active", 409) };

        if (source.roomId === toRoomId) return { deny: deny("already in destination room", 409) };

        // Lock ONLY the destination room (the source only closes; the one-active
        // partial unique already protects it) — avoids a deadlock (design §B.3).
        await advisoryLock(tx, allocLockKey(institutionId, toRoomId));

        const dest = await tx.hostelRoom.findFirst({
          where: { id: toRoomId, institutionId },
          select: { id: true, capacity: true, status: true },
        });
        if (!dest) return { notFound: "destination room not found" as const };

        if (dest.status !== "AVAILABLE") {
          await recordAuditEvent(
            {
              action: "hostel.allocation.transferred",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "HostelRoomAllocation",
              resourceId: source.id,
              metadata: { reason: "room not accepting allocations", toRoomId, status: dest.status },
            },
            tx,
          );
          return { deny: deny("room not accepting allocations", 409) };
        }

        // Capacity check on the destination.
        const occupied = await countActive(tx, institutionId, dest.id);
        if (occupied + 1 > dest.capacity) {
          await recordAuditEvent(
            {
              action: "hostel.allocation.transferred",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "HostelRoomAllocation",
              resourceId: source.id,
              metadata: { reason: "room full", toRoomId, occupied, capacity: dest.capacity },
            },
            tx,
          );
          return { deny: deny("room full", 409) };
        }

        const now = new Date();
        // Close the source (ACTIVE -> TRANSFERRED), allowed by the column guard.
        await tx.hostelRoomAllocation.update({
          where: { id: source.id },
          data: { status: "TRANSFERRED", vacatedAt: now },
        });
        // Open the new ACTIVE allocation in the destination.
        let created;
        try {
          created = await tx.hostelRoomAllocation.create({
            data: {
              institutionId,
              roomId: dest.id,
              studentId: source.studentId,
              status: "ACTIVE",
              allocatedAt: now,
              allocatedByUserId: request.user.userId,
              transferFromAllocationId: source.id,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("student already allocated", 409) };
          throw err;
        }

        await recordAuditEvent(
          {
            action: "hostel.allocation.transferred",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HostelRoomAllocation",
            resourceId: created.id,
            metadata: { fromAllocationId: source.id, toRoomId: dest.id, studentId: source.studentId },
          },
          tx,
        );
        return { allocation: created };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: outcome.notFound });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(outcome.allocation);
    },
  );

  // ─── 9. POST /allocations/:id/vacate — body-less (row 9) ─────────────────────
  app.post(
    "/allocations/:id/vacate",
    { preHandler: [requirePermission("hostel.allocations.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };

      const outcome = await withTenant(institutionId, async (tx) => {
        const allocation = await tx.hostelRoomAllocation.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!allocation) return { notFound: true as const };
        if (allocation.status !== "ACTIVE") return { deny: deny("allocation not active", 409) };

        const updated = await tx.hostelRoomAllocation.update({
          where: { id: allocation.id },
          data: { status: "VACATED", vacatedAt: new Date() },
        });
        await recordAuditEvent(
          {
            action: "hostel.allocation.vacated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HostelRoomAllocation",
            resourceId: allocation.id,
          },
          tx,
        );
        return { allocation: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "allocation not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(outcome.allocation);
    },
  );

  // ─── 10. POST /allocations/:id/check — append-only check-in/out (row 10) ─────
  app.post(
    "/allocations/:id/check",
    { preHandler: [requirePermission("hostel.allocations.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = checkEventSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { eventType, occurredAt } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const allocation = await tx.hostelRoomAllocation.findFirst({
          where: { id, institutionId },
          select: { id: true, studentId: true },
        });
        if (!allocation) return { notFound: true as const };

        const event = await tx.hostelCheckEvent.create({
          data: {
            institutionId,
            allocationId: allocation.id,
            studentId: allocation.studentId,
            eventType,
            occurredAt: occurredAt ?? new Date(),
            recordedByUserId: request.user.userId,
          },
        });
        await recordAuditEvent(
          {
            action: "hostel.checkevent.recorded",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HostelCheckEvent",
            resourceId: event.id,
            metadata: { allocationId: allocation.id, eventType },
          },
          tx,
        );
        return { event };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "allocation not found" });
      return reply.status(201).send(outcome.event);
    },
  );

  // ─── 11. GET /allocations — filterable staff list (row 11) ───────────────────
  app.get(
    "/allocations",
    { preHandler: [requirePermission("hostel.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = hostelListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { page, pageSize, status } = parsed.data;
      const { roomId } = request.query as { roomId?: string };

      const result = await withTenant(institutionId, async (tx) => {
        const where: Prisma.HostelRoomAllocationWhereInput = {
          institutionId,
          ...(status ? { status: status as Prisma.HostelRoomAllocationWhereInput["status"] } : {}),
          ...(roomId ? { roomId } : {}),
        };
        const [total, allocations] = await Promise.all([
          tx.hostelRoomAllocation.count({ where }),
          tx.hostelRoomAllocation.findMany({
            where,
            orderBy: [{ allocatedAt: "desc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
        ]);
        return { total, allocations };
      });

      return reply.send({ allocations: result.allocations, total: result.total, page, pageSize });
    },
  );

  // ─── 12. GET /occupancy — per-building computed occupancy (row 12, §B.6) ─────
  app.get(
    "/occupancy",
    { preHandler: [requirePermission("hostel.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = hostelListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { buildingId } = parsed.data;

      const result = await withTenant(institutionId, async (tx) => {
        const rooms = await tx.hostelRoom.findMany({
          where: { institutionId, ...(buildingId ? { buildingId } : {}) },
          select: { id: true, buildingId: true, roomNumber: true, capacity: true },
          orderBy: [{ buildingId: "asc" }, { roomNumber: "asc" }],
        });

        // Single groupBy on ACTIVE allocations → occupied per room (no counter).
        const grouped = await tx.hostelRoomAllocation.groupBy({
          by: ["roomId"],
          where: {
            institutionId,
            status: "ACTIVE",
            ...(buildingId ? { room: { buildingId } } : {}),
          },
          _count: { _all: true },
        });
        const occupiedByRoom = new Map<string, number>(
          grouped.map((g) => [g.roomId, g._count._all]),
        );

        const perRoom = rooms.map((r) => {
          const occupied = occupiedByRoom.get(r.id) ?? 0;
          return {
            roomId: r.id,
            buildingId: r.buildingId,
            roomNumber: r.roomNumber,
            capacity: r.capacity,
            occupied,
            available: r.capacity - occupied,
          };
        });

        // Aggregate per building (sum of capacity, sum of occupied).
        const byBuilding = new Map<string, { capacity: number; occupied: number }>();
        for (const row of perRoom) {
          const agg = byBuilding.get(row.buildingId) ?? { capacity: 0, occupied: 0 };
          agg.capacity += row.capacity;
          agg.occupied += row.occupied;
          byBuilding.set(row.buildingId, agg);
        }
        const buildings = [...byBuilding.entries()].map(([bId, agg]) => ({
          buildingId: bId,
          capacity: agg.capacity,
          occupied: agg.occupied,
          available: agg.capacity - agg.occupied,
        }));

        return { buildings, rooms: perRoom };
      });

      return reply.send(result);
    },
  );

  // ─── 13. POST /maintenance — create a request (OPEN) (row 13) ────────────────
  app.post(
    "/maintenance",
    { preHandler: [requirePermission("hostel.maintenance.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createMaintenanceSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const room = await tx.hostelRoom.findFirst({
          where: { id: data.roomId, institutionId },
          select: { id: true },
        });
        if (!room) return { notFound: true as const };

        const created = await tx.hostelMaintenanceRequest.create({
          data: {
            institutionId,
            roomId: room.id,
            issue: data.issue,
            status: "OPEN",
            assigneeUserId: data.assigneeUserId ?? null,
            reportedByUserId: request.user.userId,
          },
        });
        await recordAuditEvent(
          {
            action: "hostel.maintenance.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HostelMaintenanceRequest",
            resourceId: created.id,
            metadata: { roomId: room.id },
          },
          tx,
        );
        return { request: created };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "room not found" });
      return reply.status(201).send(outcome.request);
    },
  );

  // ─── 14. POST /maintenance/:id/transition — forward-only (row 14, NIT 6) ─────
  // Legal transitions mirror the DB guard hostel_maintenance_requests_guard:
  // OPEN->IN_PROGRESS, IN_PROGRESS->RESOLVED, OPEN->CANCELLED, IN_PROGRESS->CANCELLED.
  const MAINTENANCE_TRANSITIONS: Record<string, readonly string[]> = {
    OPEN: ["IN_PROGRESS", "CANCELLED"],
    IN_PROGRESS: ["RESOLVED", "CANCELLED"],
    RESOLVED: [],
    CANCELLED: [],
  };
  app.post(
    "/maintenance/:id/transition",
    { preHandler: [requirePermission("hostel.maintenance.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = maintenanceTransitionSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { toStatus, resolutionNote } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const req = await tx.hostelMaintenanceRequest.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!req) return { notFound: true as const };

        // In-handler legality check (design-review NIT 6); the DB guard backstops.
        const legal = MAINTENANCE_TRANSITIONS[req.status] ?? [];
        if (!legal.includes(toStatus)) {
          await recordAuditEvent(
            {
              action: "hostel.maintenance.transitioned",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "HostelMaintenanceRequest",
              resourceId: req.id,
              metadata: { reason: "illegal status transition", from: req.status, to: toStatus },
            },
            tx,
          );
          return { deny: deny("illegal status transition", 409) };
        }

        let updated;
        try {
          updated = await tx.hostelMaintenanceRequest.update({
            where: { id: req.id },
            data: {
              status: toStatus,
              ...(toStatus === "RESOLVED" ? { resolvedAt: new Date() } : {}),
              ...(resolutionNote !== undefined ? { resolutionNote } : {}),
            },
          });
        } catch (err) {
          if (isRestrictViolation(err)) return { deny: deny("illegal status transition", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "hostel.maintenance.transitioned",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HostelMaintenanceRequest",
            resourceId: req.id,
            metadata: { from: req.status, to: toStatus },
          },
          tx,
        );
        return { request: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "maintenance request not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(outcome.request);
    },
  );

  // ─── 15. GET /maintenance — staff list (row 15) ──────────────────────────────
  app.get(
    "/maintenance",
    { preHandler: [requirePermission("hostel.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = hostelListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { page, pageSize, status } = parsed.data;
      const { roomId } = request.query as { roomId?: string };

      const result = await withTenant(institutionId, async (tx) => {
        const where: Prisma.HostelMaintenanceRequestWhereInput = {
          institutionId,
          ...(status ? { status: status as Prisma.HostelMaintenanceRequestWhereInput["status"] } : {}),
          ...(roomId ? { roomId } : {}),
        };
        const [total, requests] = await Promise.all([
          tx.hostelMaintenanceRequest.count({ where }),
          tx.hostelMaintenanceRequest.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
        ]);
        return { total, requests };
      });

      return reply.send({ requests: result.requests, total: result.total, page, pageSize });
    },
  );

  // ─── 16. POST /leave/:id/approve — warden decision (row 16) ──────────────────
  // ─── 17. POST /leave/:id/reject (row 17) — shared handler factory ────────────
  function leaveDecisionHandler(
    decision: "APPROVED" | "REJECTED",
    auditAction: "hostel.leave.approved" | "hostel.leave.rejected",
  ) {
    return async (request: FastifyRequest, reply: import("fastify").FastifyReply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = leaveDecisionSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { decisionNote } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const leave = await tx.hostelLeaveApplication.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!leave) return { notFound: true as const };
        if (leave.status !== "REQUESTED") return { deny: deny("leave not pending", 409) };

        let updated;
        try {
          updated = await tx.hostelLeaveApplication.update({
            where: { id: leave.id },
            data: {
              status: decision,
              decidedByUserId: request.user.userId,
              decidedAt: new Date(),
              ...(decisionNote !== undefined ? { decisionNote } : {}),
            },
          });
        } catch (err) {
          if (isRestrictViolation(err)) return { deny: deny("illegal status transition", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: auditAction,
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HostelLeaveApplication",
            resourceId: leave.id,
          },
          tx,
        );
        return { leave: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "leave application not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(outcome.leave);
    };
  }

  app.post(
    "/leave/:id/approve",
    { preHandler: [requirePermission("hostel.leave.manage"), requireModuleActive(gate)] },
    leaveDecisionHandler("APPROVED", "hostel.leave.approved"),
  );

  app.post(
    "/leave/:id/reject",
    { preHandler: [requirePermission("hostel.leave.manage"), requireModuleActive(gate)] },
    leaveDecisionHandler("REJECTED", "hostel.leave.rejected"),
  );

  // ─── 18. GET /leave — tenant-wide staff list (row 18) ────────────────────────
  app.get(
    "/leave",
    { preHandler: [requirePermission("hostel.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = hostelListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { page, pageSize, status } = parsed.data;

      const result = await withTenant(institutionId, async (tx) => {
        const where: Prisma.HostelLeaveApplicationWhereInput = {
          institutionId,
          ...(status ? { status: status as Prisma.HostelLeaveApplicationWhereInput["status"] } : {}),
        };
        const [total, applications] = await Promise.all([
          tx.hostelLeaveApplication.count({ where }),
          tx.hostelLeaveApplication.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
        ]);
        return { total, applications };
      });

      return reply.send({ applications: result.applications, total: result.total, page, pageSize });
    },
  );

  // ─── 19. GET /allocations/export — XLSX export (row 19, §C.8) ────────────────
  app.get(
    "/allocations/export",
    { preHandler: [requirePermission("hostel.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;

      const allocations = await withTenant(institutionId, async (tx) => {
        const rows = await tx.hostelRoomAllocation.findMany({
          where: { institutionId },
          orderBy: [{ allocatedAt: "desc" }, { id: "asc" }],
        });
        await recordAuditEvent(
          {
            action: "hostel.allocation.exported",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HostelRoomAllocation",
            metadata: { count: rows.length },
          },
          tx,
        );
        return rows;
      });

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Allocations");
      sheet.columns = [
        { header: "Allocation ID", key: "id", width: 26 },
        { header: "Room ID", key: "roomId", width: 26 },
        { header: "Student ID", key: "studentId", width: 26 },
        { header: "Status", key: "status", width: 14 },
        { header: "Allocated At", key: "allocatedAt", width: 24 },
        { header: "Vacated At", key: "vacatedAt", width: 24 },
        { header: "Allocated By", key: "allocatedByUserId", width: 26 },
      ];
      for (const a of allocations) {
        sheet.addRow({
          id: a.id,
          roomId: a.roomId,
          studentId: a.studentId,
          status: a.status,
          allocatedAt: a.allocatedAt.toISOString(),
          vacatedAt: a.vacatedAt ? a.vacatedAt.toISOString() : "",
          allocatedByUserId: a.allocatedByUserId,
        });
      }
      sheet.getRow(1).font = { bold: true };

      const filename = `hostel-allocations-${new Date().toISOString().slice(0, 10)}.xlsx`;
      const buffer = await workbook.xlsx.writeBuffer();
      return reply
        .header(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(Buffer.from(buffer));
    },
  );

  // ─── Self-service /me/* (rows 20-24, FR-6 / AC-12) ───────────────────────────
  // Every handler resolves the caller's StudentProfile by userId within
  // withTenant and self-scopes by that studentId; never accepts a studentId
  // from input. All five carry hostel.view_own + requireModuleActive("hostel").

  // 20. GET /me/allocation — own ACTIVE allocation.
  app.get(
    "/me/allocation",
    { preHandler: [requirePermission("hostel.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const outcome = await withTenant(institutionId, async (tx) => {
        const self = await resolveSelf(tx, institutionId, userId);
        if (!self) return { noProfile: true as const };
        const allocation = await tx.hostelRoomAllocation.findFirst({
          where: { institutionId, studentId: self.id, status: "ACTIVE" },
        });
        return { allocation };
      });
      if ("noProfile" in outcome) return reply.status(404).send({ error: "no student profile" });
      return reply.send({ allocation: outcome.allocation });
    },
  );

  // 21. GET /me/occupancy — own room's occupancy.
  app.get(
    "/me/occupancy",
    { preHandler: [requirePermission("hostel.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const outcome = await withTenant(institutionId, async (tx) => {
        const self = await resolveSelf(tx, institutionId, userId);
        if (!self) return { noProfile: true as const };
        const allocation = await tx.hostelRoomAllocation.findFirst({
          where: { institutionId, studentId: self.id, status: "ACTIVE" },
          select: { roomId: true },
        });
        if (!allocation) return { occupancy: null };
        const room = await tx.hostelRoom.findFirst({
          where: { id: allocation.roomId, institutionId },
          select: { id: true, capacity: true },
        });
        if (!room) return { occupancy: null };
        const occupied = await countActive(tx, institutionId, room.id);
        return {
          occupancy: {
            roomId: room.id,
            capacity: room.capacity,
            occupied,
            available: room.capacity - occupied,
          },
        };
      });
      if ("noProfile" in outcome) return reply.status(404).send({ error: "no student profile" });
      return reply.send({ occupancy: outcome.occupancy });
    },
  );

  // 22. POST /me/leave — apply for leave (own).
  app.post(
    "/me/leave",
    { preHandler: [requirePermission("hostel.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const parsed = applyLeaveSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { fromDate, toDate, reason } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const self = await resolveSelf(tx, institutionId, userId);
        if (!self) return { noProfile: true as const };
        const leave = await tx.hostelLeaveApplication.create({
          data: {
            institutionId,
            studentId: self.id,
            fromDate,
            toDate,
            reason,
            status: "REQUESTED",
            appliedByUserId: userId,
          },
        });
        await recordAuditEvent(
          {
            action: "hostel.leave.applied",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HostelLeaveApplication",
            resourceId: leave.id,
          },
          tx,
        );
        return { leave };
      });

      if ("noProfile" in outcome) return reply.status(404).send({ error: "no student profile" });
      return reply.status(201).send(outcome.leave);
    },
  );

  // 23. GET /me/leave — own leave applications.
  app.get(
    "/me/leave",
    { preHandler: [requirePermission("hostel.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const parsed = hostelListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { page, pageSize, status } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const self = await resolveSelf(tx, institutionId, userId);
        if (!self) return { noProfile: true as const };
        const where: Prisma.HostelLeaveApplicationWhereInput = {
          institutionId,
          studentId: self.id,
          ...(status ? { status: status as Prisma.HostelLeaveApplicationWhereInput["status"] } : {}),
        };
        const [total, applications] = await Promise.all([
          tx.hostelLeaveApplication.count({ where }),
          tx.hostelLeaveApplication.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
        ]);
        return { total, applications };
      });

      if ("noProfile" in outcome) return reply.status(404).send({ error: "no student profile" });
      return reply.send({
        applications: outcome.applications,
        total: outcome.total,
        page,
        pageSize,
      });
    },
  );

  // 24. POST /me/leave/:id/cancel — body-less; own REQUESTED->CANCELLED only.
  app.post(
    "/me/leave/:id/cancel",
    { preHandler: [requirePermission("hostel.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const { id } = request.params as { id: string };

      const outcome = await withTenant(institutionId, async (tx) => {
        const self = await resolveSelf(tx, institutionId, userId);
        if (!self) return { noProfile: true as const };
        // Self-scoped: a leave not owned by the caller is simply not found.
        const leave = await tx.hostelLeaveApplication.findFirst({
          where: { id, institutionId, studentId: self.id },
          select: { id: true, status: true },
        });
        if (!leave) return { notFound: true as const };
        if (leave.status !== "REQUESTED") return { deny: deny("leave not pending", 409) };

        let updated;
        try {
          updated = await tx.hostelLeaveApplication.update({
            where: { id: leave.id },
            data: { status: "CANCELLED", decidedAt: new Date() },
          });
        } catch (err) {
          if (isRestrictViolation(err)) return { deny: deny("illegal status transition", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "hostel.leave.cancelled",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HostelLeaveApplication",
            resourceId: leave.id,
          },
          tx,
        );
        return { leave: updated };
      });

      if ("noProfile" in outcome) return reply.status(404).send({ error: "no student profile" });
      if ("notFound" in outcome) return reply.status(404).send({ error: "leave application not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(outcome.leave);
    },
  );
}
