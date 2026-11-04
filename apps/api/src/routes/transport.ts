import type { FastifyInstance, FastifyRequest } from "fastify";
import ExcelJS from "exceljs";
import { withTenant, Prisma } from "@campusgate/db";
import {
  createVehicleSchema,
  patchVehicleSchema,
  createDriverSchema,
  patchDriverSchema,
  createRouteSchema,
  patchRouteSchema,
  createStopSchema,
  patchStopSchema,
  createAssignmentSchema,
  createEnrollmentSchema,
  createScheduleSchema,
  patchScheduleSchema,
  createTransportMaintenanceSchema,
  transportMaintenanceTransitionSchema,
  transportListQuerySchema,
  transportStudentLookupQuerySchema,
} from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission, requireModuleActive } from "../services/authz-engine.js";
import { recordAuditEvent } from "../services/audit.js";

const MODULE_KEY = "transport" as const;

/**
 * Transport Management routes (design §C.1), registered at `/api/transport`
 * (see server.ts). Transport is a GATED "booster" module — every operational
 * route carries `requireModuleActive("transport")` IN ADDITION to
 * `requirePermission("transport.*")` (the hostel/library/exams precedent).
 *
 * House pattern (mirrors hostel.ts verbatim):
 *  - a single top-level `authenticate` preHandler;
 *  - per-route `[requirePermission(key), requireModuleActive("transport")]`;
 *  - every handler body runs inside `withTenant(institutionId, tx => ...)` with
 *    `institutionId` from the verified token (`request.user`), never from input;
 *  - every mutation (and every DENIED capacity/lifecycle decision) writes a
 *    `transport.*` AuditEvent via `recordAuditEvent` in the SAME transaction;
 *  - deny branches record a DENIED audit then RETURN the 4xx from a
 *    normally-returning `withTenant` callback (never `throw`) so the audit
 *    commits (design §B.3 / §C.7);
 *  - enrollment concurrency: a transaction-scoped advisory lock on the
 *    tenant-qualified ROUTE (`transportenroll:${institutionId}:${routeId}`) +
 *    a conditional ACTIVE count under the lock with effective capacity read
 *    from the ACTIVE assignment's vehicle seatCapacity, backstopped by the
 *    partial unique transport_enrollments_one_active_per_student_route.
 *
 * Money boundary: feeAmount / cost are int paise in the DB but cross the JSON
 * boundary as a decimal-digit STRING (money-as-string, design §D.1).
 */
export async function transportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  const gate = MODULE_KEY;

  // ─── Shared helpers (verbatim from hostel.ts) ───────────────────────────────

  function actor(request: FastifyRequest) {
    return {
      actorUserId: request.user.userId,
      actorRoleKey: request.auth?.roles[0] ?? request.user.role,
      actorMembershipId: request.auth?.membershipId ?? null,
      requestRef: request.id,
    };
  }

  interface Deny {
    deny: string;
    status: number;
  }
  function deny(message: string, status: number): Deny {
    return { deny: message, status };
  }
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

  // Advisory xact lock on a tenant-qualified key (the hostel advisoryLock idiom).
  // Held until the tx commits/rolls back.
  async function advisoryLock(tx: Prisma.TransactionClient, key: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }

  // Tenant-qualified enrollment lock key so two tenants hashing the same routeId
  // do not contend. Enrollment capacity is checked under this lock (the hostel
  // allocLockKey idiom, keyed on the ROUTE).
  function enrollLockKey(institutionId: string, routeId: string): string {
    return `transportenroll:${institutionId}:${routeId}`;
  }

  // Count ACTIVE enrollments on a route (the single-source-of-truth occupancy).
  async function countActiveEnrollments(
    tx: Prisma.TransactionClient,
    institutionId: string,
    routeId: string,
  ): Promise<number> {
    return tx.transportEnrollment.count({
      where: { institutionId, routeId, status: "ACTIVE" },
    });
  }

  // Resolve the caller's StudentProfile for a /me/* self-service route. Never
  // reads a studentId from input.
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

  // Display projections for the staff reads (setup step G-TRN*): rows used to carry
  // only ids, so the screens could not show names. Minimal fields; tenant scoping
  // comes from the surrounding withTenant + institutionId filters.
  const studentDisplaySelect = {
    id: true,
    name: true,
    enrollmentNo: true,
    program: true,
  } as const;
  const enrollmentDisplayInclude = {
    student: { select: studentDisplaySelect },
    route: { select: { id: true, code: true, name: true } },
    stop: { select: { id: true, name: true, sequence: true } },
  } as const;
  // feeAmount is int paise in the DB; serialize it back as a decimal-digit
  // STRING on every response that returns a route (money-as-string, §D.1).
  function serializeRoute<T extends { feeAmount: number | null }>(route: T) {
    return { ...route, feeAmount: route.feeAmount === null ? null : String(route.feeAmount) };
  }

  // ─── 1. POST /vehicles — create a vehicle ────────────────────────────────────
  app.post(
    "/vehicles",
    { preHandler: [requirePermission("transport.vehicles.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createVehicleSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        let vehicle;
        try {
          vehicle = await tx.transportVehicle.create({
            data: {
              institutionId,
              registrationNo: data.registrationNo,
              type: data.type,
              seatCapacity: data.seatCapacity,
              ...(data.status !== undefined ? { status: data.status } : {}),
              createdByUserId: request.user.userId,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("registration number already exists", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "transport.vehicle.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "TransportVehicle",
            resourceId: vehicle.id,
          },
          tx,
        );
        return { vehicle };
      });

      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(outcome.vehicle);
    },
  );

  // ─── 2. PATCH /vehicles/:id — edit + §B.5 capacity-reduction guard ───────────
  app.patch(
    "/vehicles/:id",
    { preHandler: [requirePermission("transport.vehicles.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = patchVehicleSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const vehicle = await tx.transportVehicle.findFirst({
          where: { id, institutionId },
          select: { id: true, seatCapacity: true },
        });
        if (!vehicle) return { notFound: true as const };

        // §B.5 capacity-reduction guard: when seatCapacity is reduced, every
        // route with an ACTIVE assignment to this vehicle derives its effective
        // capacity from this vehicle. Lock each such route (sorted routeId order
        // to avoid a deadlock) on the SAME enrollment key, and reject if the new
        // capacity drops below any route's ACTIVE enrollment count.
        if (data.seatCapacity !== undefined && data.seatCapacity < vehicle.seatCapacity) {
          const assignments = await tx.transportRouteAssignment.findMany({
            where: { institutionId, vehicleId: vehicle.id, status: "ACTIVE" },
            select: { routeId: true },
          });
          const routeIds = [...new Set(assignments.map((a) => a.routeId))].sort();
          for (const routeId of routeIds) {
            await advisoryLock(tx, enrollLockKey(institutionId, routeId));
            const active = await countActiveEnrollments(tx, institutionId, routeId);
            if (data.seatCapacity < active) {
              await recordAuditEvent(
                {
                  action: "transport.vehicle.updated",
                  result: "DENIED",
                  ...actor(request),
                  institutionId,
                  resourceType: "TransportVehicle",
                  resourceId: vehicle.id,
                  metadata: {
                    reason: "capacity below active enrollment",
                    routeId,
                    active,
                    requested: data.seatCapacity,
                  },
                },
                tx,
              );
              return { deny: deny("capacity below active enrollment", 409) };
            }
          }
        }

        let updated;
        try {
          updated = await tx.transportVehicle.update({
            where: { id: vehicle.id },
            data: {
              ...(data.registrationNo !== undefined ? { registrationNo: data.registrationNo } : {}),
              ...(data.type !== undefined ? { type: data.type } : {}),
              ...(data.seatCapacity !== undefined ? { seatCapacity: data.seatCapacity } : {}),
              ...(data.status !== undefined ? { status: data.status } : {}),
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("registration number already exists", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "transport.vehicle.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "TransportVehicle",
            resourceId: vehicle.id,
          },
          tx,
        );
        return { vehicle: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "vehicle not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(outcome.vehicle);
    },
  );

  // ─── 3. GET /vehicles — staff list ───────────────────────────────────────────
  app.get(
    "/vehicles",
    { preHandler: [requirePermission("transport.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = transportListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { page, pageSize, status } = parsed.data;

      const result = await withTenant(institutionId, async (tx) => {
        const where: Prisma.TransportVehicleWhereInput = {
          institutionId,
          ...(status ? { status: status as Prisma.TransportVehicleWhereInput["status"] } : {}),
        };
        const [total, vehicles] = await Promise.all([
          tx.transportVehicle.count({ where }),
          tx.transportVehicle.findMany({
            where,
            orderBy: [{ registrationNo: "asc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
        ]);
        return { total, vehicles };
      });

      return reply.send({ vehicles: result.vehicles, total: result.total, page, pageSize });
    },
  );

  // ─── 4. GET /vehicles/:id — staff detail ─────────────────────────────────────
  app.get(
    "/vehicles/:id",
    { preHandler: [requirePermission("transport.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const vehicle = await withTenant(institutionId, async (tx) =>
        tx.transportVehicle.findFirst({ where: { id, institutionId } }),
      );
      if (!vehicle) return reply.status(404).send({ error: "vehicle not found" });
      return reply.send(vehicle);
    },
  );

  // ─── 5. POST /drivers — create a driver ──────────────────────────────────────
  app.post(
    "/drivers",
    { preHandler: [requirePermission("transport.drivers.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createDriverSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        let driver;
        try {
          driver = await tx.transportDriver.create({
            data: {
              institutionId,
              name: data.name,
              licenseNo: data.licenseNo,
              phone: data.phone ?? null,
              userId: data.userId ?? null,
              ...(data.status !== undefined ? { status: data.status } : {}),
              createdByUserId: request.user.userId,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("license number already exists", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "transport.driver.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "TransportDriver",
            resourceId: driver.id,
          },
          tx,
        );
        return { driver };
      });

      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(outcome.driver);
    },
  );

  // ─── 6. PATCH /drivers/:id — edit a driver ───────────────────────────────────
  app.patch(
    "/drivers/:id",
    { preHandler: [requirePermission("transport.drivers.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = patchDriverSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const driver = await tx.transportDriver.findFirst({
          where: { id, institutionId },
          select: { id: true },
        });
        if (!driver) return { notFound: true as const };

        let updated;
        try {
          updated = await tx.transportDriver.update({
            where: { id: driver.id },
            data: {
              ...(data.name !== undefined ? { name: data.name } : {}),
              ...(data.licenseNo !== undefined ? { licenseNo: data.licenseNo } : {}),
              ...("phone" in data ? { phone: data.phone ?? null } : {}),
              ...("userId" in data ? { userId: data.userId ?? null } : {}),
              ...(data.status !== undefined ? { status: data.status } : {}),
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("license number already exists", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "transport.driver.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "TransportDriver",
            resourceId: driver.id,
          },
          tx,
        );
        return { driver: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "driver not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(outcome.driver);
    },
  );

  // ─── 7. GET /drivers — staff list ────────────────────────────────────────────
  app.get(
    "/drivers",
    { preHandler: [requirePermission("transport.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = transportListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { page, pageSize, status } = parsed.data;

      const result = await withTenant(institutionId, async (tx) => {
        const where: Prisma.TransportDriverWhereInput = {
          institutionId,
          ...(status ? { status: status as Prisma.TransportDriverWhereInput["status"] } : {}),
        };
        const [total, drivers] = await Promise.all([
          tx.transportDriver.count({ where }),
          tx.transportDriver.findMany({
            where,
            orderBy: [{ name: "asc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
        ]);
        return { total, drivers };
      });

      return reply.send({ drivers: result.drivers, total: result.total, page, pageSize });
    },
  );

  // ─── 8. POST /routes — create a route ────────────────────────────────────────
  app.post(
    "/routes",
    { preHandler: [requirePermission("transport.routes.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createRouteSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        let route;
        try {
          route = await tx.transportRoute.create({
            data: {
              institutionId,
              name: data.name,
              code: data.code,
              ...(data.feeAmount !== undefined ? { feeAmount: Number(data.feeAmount) } : {}),
              ...(data.status !== undefined ? { status: data.status } : {}),
              createdByUserId: request.user.userId,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("route code already exists", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "transport.route.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "TransportRoute",
            resourceId: route.id,
          },
          tx,
        );
        return { route };
      });

      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(serializeRoute(outcome.route));
    },
  );

  // ─── 9. PATCH /routes/:id — edit a route ─────────────────────────────────────
  app.patch(
    "/routes/:id",
    { preHandler: [requirePermission("transport.routes.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = patchRouteSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const route = await tx.transportRoute.findFirst({
          where: { id, institutionId },
          select: { id: true },
        });
        if (!route) return { notFound: true as const };

        let updated;
        try {
          updated = await tx.transportRoute.update({
            where: { id: route.id },
            data: {
              ...(data.name !== undefined ? { name: data.name } : {}),
              ...(data.code !== undefined ? { code: data.code } : {}),
              ...("feeAmount" in data
                ? { feeAmount: data.feeAmount === null || data.feeAmount === undefined ? null : Number(data.feeAmount) }
                : {}),
              ...(data.status !== undefined ? { status: data.status } : {}),
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("route code already exists", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "transport.route.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "TransportRoute",
            resourceId: route.id,
          },
          tx,
        );
        return { route: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "route not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(serializeRoute(outcome.route));
    },
  );

  // ─── 10. GET /routes — staff list ────────────────────────────────────────────
  app.get(
    "/routes",
    { preHandler: [requirePermission("transport.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = transportListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { page, pageSize, status } = parsed.data;

      const result = await withTenant(institutionId, async (tx) => {
        const where: Prisma.TransportRouteWhereInput = {
          institutionId,
          ...(status ? { status: status as Prisma.TransportRouteWhereInput["status"] } : {}),
        };
        const [total, routes] = await Promise.all([
          tx.transportRoute.count({ where }),
          tx.transportRoute.findMany({
            where,
            orderBy: [{ code: "asc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
        ]);
        return { total, routes };
      });

      return reply.send({
        routes: result.routes.map(serializeRoute),
        total: result.total,
        page,
        pageSize,
      });
    },
  );

  // ─── 11. GET /routes/:id — staff detail ──────────────────────────────────────
  app.get(
    "/routes/:id",
    { preHandler: [requirePermission("transport.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const route = await withTenant(institutionId, async (tx) =>
        tx.transportRoute.findFirst({ where: { id, institutionId } }),
      );
      if (!route) return reply.status(404).send({ error: "route not found" });
      return reply.send(serializeRoute(route));
    },
  );

  // ─── 12. POST /routes/:id/stops — create a stop ──────────────────────────────
  app.post(
    "/routes/:id/stops",
    { preHandler: [requirePermission("transport.routes.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: routeId } = request.params as { id: string };
      const parsed = createStopSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const route = await tx.transportRoute.findFirst({
          where: { id: routeId, institutionId },
          select: { id: true },
        });
        if (!route) return { notFound: true as const };

        let stop;
        try {
          stop = await tx.transportRouteStop.create({
            data: {
              institutionId,
              routeId: route.id,
              name: data.name,
              sequence: data.sequence,
              landmark: data.landmark ?? null,
              latitude: data.latitude ?? null,
              longitude: data.longitude ?? null,
              pickupOffsetMinutes: data.pickupOffsetMinutes ?? null,
              createdByUserId: request.user.userId,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("stop sequence already exists on route", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "transport.stop.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "TransportRouteStop",
            resourceId: stop.id,
            metadata: { routeId: route.id },
          },
          tx,
        );
        return { stop };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "route not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(outcome.stop);
    },
  );

  // ─── 13. PATCH /stops/:id — edit a stop ──────────────────────────────────────
  app.patch(
    "/stops/:id",
    { preHandler: [requirePermission("transport.routes.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = patchStopSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const stop = await tx.transportRouteStop.findFirst({
          where: { id, institutionId },
          select: { id: true },
        });
        if (!stop) return { notFound: true as const };

        let updated;
        try {
          updated = await tx.transportRouteStop.update({
            where: { id: stop.id },
            data: {
              ...(data.name !== undefined ? { name: data.name } : {}),
              ...(data.sequence !== undefined ? { sequence: data.sequence } : {}),
              ...("landmark" in data ? { landmark: data.landmark ?? null } : {}),
              ...("latitude" in data ? { latitude: data.latitude ?? null } : {}),
              ...("longitude" in data ? { longitude: data.longitude ?? null } : {}),
              ...("pickupOffsetMinutes" in data
                ? { pickupOffsetMinutes: data.pickupOffsetMinutes ?? null }
                : {}),
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("stop sequence already exists on route", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "transport.stop.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "TransportRouteStop",
            resourceId: stop.id,
          },
          tx,
        );
        return { stop: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "stop not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(outcome.stop);
    },
  );

  // ─── 14. GET /routes/:id/stops — stops on a route ────────────────────────────
  app.get(
    "/routes/:id/stops",
    { preHandler: [requirePermission("transport.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: routeId } = request.params as { id: string };

      const outcome = await withTenant(institutionId, async (tx) => {
        const route = await tx.transportRoute.findFirst({
          where: { id: routeId, institutionId },
          select: { id: true },
        });
        if (!route) return { notFound: true as const };
        const stops = await tx.transportRouteStop.findMany({
          where: { institutionId, routeId: route.id },
          orderBy: [{ sequence: "asc" }, { id: "asc" }],
        });
        return { stops };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "route not found" });
      return reply.send({ stops: outcome.stops });
    },
  );

  // ─── 15. POST /routes/:id/assignments — assign vehicle+driver (§B.7) ─────────
  app.post(
    "/routes/:id/assignments",
    { preHandler: [requirePermission("transport.assignments.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: routeId } = request.params as { id: string };
      const parsed = createAssignmentSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { vehicleId, driverId, effectiveFrom, effectiveTo } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const route = await tx.transportRoute.findFirst({
          where: { id: routeId, institutionId },
          select: { id: true },
        });
        if (!route) return { notFound: "route not found" as const };

        const vehicle = await tx.transportVehicle.findFirst({
          where: { id: vehicleId, institutionId },
          select: { id: true, status: true },
        });
        if (!vehicle) return { notFound: "vehicle not found" as const };

        const driver = await tx.transportDriver.findFirst({
          where: { id: driverId, institutionId },
          select: { id: true },
        });
        if (!driver) return { notFound: "driver not found" as const };

        // §B.7 maintenance guard: a vehicle in MAINTENANCE cannot be assigned.
        if (vehicle.status === "MAINTENANCE") {
          await recordAuditEvent(
            {
              action: "transport.assignment.created",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "TransportRouteAssignment",
              metadata: { reason: "vehicle in maintenance", routeId: route.id, vehicleId: vehicle.id },
            },
            tx,
          );
          return { deny: deny("vehicle in maintenance", 409) };
        }

        let assignment;
        try {
          assignment = await tx.transportRouteAssignment.create({
            data: {
              institutionId,
              routeId: route.id,
              vehicleId: vehicle.id,
              driverId: driver.id,
              effectiveFrom,
              effectiveTo: effectiveTo ?? null,
              status: "ACTIVE",
              createdByUserId: request.user.userId,
            },
          });
        } catch (err) {
          // The one-ACTIVE-per-route partial unique backstops a concurrent assign.
          if (isUniqueViolation(err)) return { deny: deny("route already assigned", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "transport.assignment.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "TransportRouteAssignment",
            resourceId: assignment.id,
            metadata: { routeId: route.id, vehicleId: vehicle.id, driverId: driver.id },
          },
          tx,
        );
        return { assignment };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: outcome.notFound });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(outcome.assignment);
    },
  );

  // ─── 16. POST /assignments/:id/end — ACTIVE -> ENDED ─────────────────────────
  app.post(
    "/assignments/:id/end",
    { preHandler: [requirePermission("transport.assignments.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };

      const outcome = await withTenant(institutionId, async (tx) => {
        const assignment = await tx.transportRouteAssignment.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!assignment) return { notFound: true as const };
        if (assignment.status !== "ACTIVE") return { deny: deny("assignment not active", 409) };

        let updated;
        try {
          updated = await tx.transportRouteAssignment.update({
            where: { id: assignment.id },
            data: { status: "ENDED", effectiveTo: new Date() },
          });
        } catch (err) {
          if (isRestrictViolation(err)) return { deny: deny("illegal status transition", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "transport.assignment.ended",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "TransportRouteAssignment",
            resourceId: assignment.id,
          },
          tx,
        );
        return { assignment: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "assignment not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(outcome.assignment);
    },
  );

  // ─── 17. GET /routes/:id/assignments — assignments on a route ────────────────
  app.get(
    "/routes/:id/assignments",
    { preHandler: [requirePermission("transport.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: routeId } = request.params as { id: string };
      const parsed = transportListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { status } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const route = await tx.transportRoute.findFirst({
          where: { id: routeId, institutionId },
          select: { id: true },
        });
        if (!route) return { notFound: true as const };
        const assignments = await tx.transportRouteAssignment.findMany({
          where: {
            institutionId,
            routeId: route.id,
            ...(status
              ? { status: status as Prisma.TransportRouteAssignmentWhereInput["status"] }
              : {}),
          },
          orderBy: [{ effectiveFrom: "desc" }, { id: "asc" }],
          // G-TRN2: additive vehicle + driver display projections.
          include: {
            vehicle: {
              select: { id: true, registrationNo: true, type: true, seatCapacity: true, status: true },
            },
            driver: { select: { id: true, name: true, licenseNo: true, phone: true, status: true } },
          },
        });
        return { assignments };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "route not found" });
      return reply.send({ assignments: outcome.assignments });
    },
  );

  // ─── 18. POST /enrollments — capacity-safe enrollment (§B.3) ─────────────────
  app.post(
    "/enrollments",
    { preHandler: [requirePermission("transport.enrollments.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createEnrollmentSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { studentId, routeId, stopId } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        // 1. Advisory lock on the route; held to commit.
        await advisoryLock(tx, enrollLockKey(institutionId, routeId));

        // 2. Load the route (tenant-filtered).
        const route = await tx.transportRoute.findFirst({
          where: { id: routeId, institutionId },
          select: { id: true },
        });
        if (!route) return { notFound: "route not found" as const };

        // Load the ACTIVE assignment — capacity is derived from its vehicle.
        const assignment = await tx.transportRouteAssignment.findFirst({
          where: { institutionId, routeId: route.id, status: "ACTIVE" },
          select: { vehicleId: true },
        });
        if (!assignment) {
          await recordAuditEvent(
            {
              action: "transport.enrollment.created",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "TransportEnrollment",
              metadata: { reason: "route has no active vehicle assignment", routeId: route.id },
            },
            tx,
          );
          return { deny: deny("route has no active vehicle assignment", 409) };
        }

        // 3. Read seatCapacity from the assignment's vehicle (same tenant).
        const vehicle = await tx.transportVehicle.findFirst({
          where: { id: assignment.vehicleId, institutionId },
          select: { seatCapacity: true },
        });
        if (!vehicle) {
          await recordAuditEvent(
            {
              action: "transport.enrollment.created",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "TransportEnrollment",
              metadata: { reason: "route has no active vehicle assignment", routeId: route.id },
            },
            tx,
          );
          return { deny: deny("route has no active vehicle assignment", 409) };
        }

        // 4. Validate the student and that the stop belongs to the route.
        const student = await tx.studentProfile.findFirst({
          where: { id: studentId, institutionId },
          select: { id: true },
        });
        if (!student) return { notFound: "student not found" as const };

        const stop = await tx.transportRouteStop.findFirst({
          where: { id: stopId, institutionId, routeId: route.id },
          select: { id: true },
        });
        if (!stop) return { notFound: "stop not found on route" as const };

        // 5. One-active-per-(student,route) check (deny early, audited).
        const existingActive = await tx.transportEnrollment.count({
          where: { institutionId, studentId: student.id, routeId: route.id, status: "ACTIVE" },
        });
        if (existingActive >= 1) {
          await recordAuditEvent(
            {
              action: "transport.enrollment.created",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "TransportEnrollment",
              metadata: { reason: "student already enrolled on route", routeId: route.id, studentId: student.id },
            },
            tx,
          );
          return { deny: deny("student already enrolled on route", 409) };
        }

        // 6. Capacity check under the lock.
        const active = await countActiveEnrollments(tx, institutionId, route.id);
        if (active + 1 > vehicle.seatCapacity) {
          await recordAuditEvent(
            {
              action: "transport.enrollment.created",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "TransportEnrollment",
              metadata: { reason: "route full", routeId: route.id, active, capacity: vehicle.seatCapacity },
            },
            tx,
          );
          return { deny: deny("route full", 409) };
        }

        // 7. Insert; the partial unique backstops a lost race.
        let enrollment;
        try {
          enrollment = await tx.transportEnrollment.create({
            data: {
              institutionId,
              studentId: student.id,
              routeId: route.id,
              stopId: stop.id,
              status: "ACTIVE",
              enrolledAt: new Date(),
              createdByUserId: request.user.userId,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            await recordAuditEvent(
              {
                action: "transport.enrollment.created",
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "TransportEnrollment",
                metadata: { reason: "student already enrolled on route", routeId: route.id, studentId: student.id },
              },
              tx,
            );
            return { deny: deny("student already enrolled on route", 409) };
          }
          throw err;
        }

        await recordAuditEvent(
          {
            action: "transport.enrollment.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "TransportEnrollment",
            resourceId: enrollment.id,
            metadata: { routeId: route.id, studentId: student.id, stopId: stop.id },
          },
          tx,
        );
        return { enrollment };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: outcome.notFound });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(outcome.enrollment);
    },
  );

  // ─── 19. POST /enrollments/:id/suspend — ACTIVE -> SUSPENDED ─────────────────
  app.post(
    "/enrollments/:id/suspend",
    { preHandler: [requirePermission("transport.enrollments.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };

      const outcome = await withTenant(institutionId, async (tx) => {
        const enrollment = await tx.transportEnrollment.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!enrollment) return { notFound: true as const };
        // In-handler legality (DB guard backstops). Non-transition deny message
        // MUST NOT contain the word 'illegal'.
        if (enrollment.status !== "ACTIVE") {
          await recordAuditEvent(
            {
              action: "transport.enrollment.suspended",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "TransportEnrollment",
              resourceId: enrollment.id,
              metadata: { reason: "enrollment not active", from: enrollment.status },
            },
            tx,
          );
          return { deny: deny("enrollment not active", 409) };
        }

        let updated;
        try {
          updated = await tx.transportEnrollment.update({
            where: { id: enrollment.id },
            data: { status: "SUSPENDED" },
          });
        } catch (err) {
          if (isRestrictViolation(err)) return { deny: deny("illegal status transition", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "transport.enrollment.suspended",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "TransportEnrollment",
            resourceId: enrollment.id,
          },
          tx,
        );
        return { enrollment: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "enrollment not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(outcome.enrollment);
    },
  );

  // ─── 20. POST /enrollments/:id/end — ACTIVE/SUSPENDED -> ENDED ───────────────
  app.post(
    "/enrollments/:id/end",
    { preHandler: [requirePermission("transport.enrollments.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };

      const outcome = await withTenant(institutionId, async (tx) => {
        const enrollment = await tx.transportEnrollment.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!enrollment) return { notFound: true as const };
        if (enrollment.status !== "ACTIVE" && enrollment.status !== "SUSPENDED") {
          await recordAuditEvent(
            {
              action: "transport.enrollment.ended",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "TransportEnrollment",
              resourceId: enrollment.id,
              metadata: { reason: "enrollment already ended", from: enrollment.status },
            },
            tx,
          );
          return { deny: deny("enrollment already ended", 409) };
        }

        let updated;
        try {
          updated = await tx.transportEnrollment.update({
            where: { id: enrollment.id },
            data: { status: "ENDED", endedAt: new Date() },
          });
        } catch (err) {
          if (isRestrictViolation(err)) return { deny: deny("illegal status transition", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "transport.enrollment.ended",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "TransportEnrollment",
            resourceId: enrollment.id,
          },
          tx,
        );
        return { enrollment: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "enrollment not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(outcome.enrollment);
    },
  );

  // ─── 21. GET /enrollments — staff list (filter routeId/status) ───────────────
  app.get(
    "/enrollments",
    { preHandler: [requirePermission("transport.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = transportListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { page, pageSize, status, routeId } = parsed.data;

      const result = await withTenant(institutionId, async (tx) => {
        const where: Prisma.TransportEnrollmentWhereInput = {
          institutionId,
          ...(status ? { status: status as Prisma.TransportEnrollmentWhereInput["status"] } : {}),
          ...(routeId ? { routeId } : {}),
        };
        const [total, enrollments] = await Promise.all([
          tx.transportEnrollment.count({ where }),
          tx.transportEnrollment.findMany({
            where,
            orderBy: [{ enrolledAt: "desc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
            // G-TRN3: additive student/route/stop display projections.
            include: enrollmentDisplayInclude,
          }),
        ]);
        return { total, enrollments };
      });

      return reply.send({ enrollments: result.enrollments, total: result.total, page, pageSize });
    },
  );

  // ─── 22. POST /routes/:id/schedules — create a schedule ──────────────────────
  app.post(
    "/routes/:id/schedules",
    { preHandler: [requirePermission("transport.routes.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: routeId } = request.params as { id: string };
      const parsed = createScheduleSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const route = await tx.transportRoute.findFirst({
          where: { id: routeId, institutionId },
          select: { id: true },
        });
        if (!route) return { notFound: "route not found" as const };

        // If a stop is named it must belong to this route (composite FK backstop).
        if (data.stopId !== undefined) {
          const stop = await tx.transportRouteStop.findFirst({
            where: { id: data.stopId, institutionId, routeId: route.id },
            select: { id: true },
          });
          if (!stop) return { notFound: "stop not found on route" as const };
        }

        const schedule = await tx.transportRouteSchedule.create({
          data: {
            institutionId,
            routeId: route.id,
            stopId: data.stopId ?? null,
            dayOfWeek: data.dayOfWeek ?? null,
            date: data.date ?? null,
            departureTime: data.departureTime,
            arrivalTime: data.arrivalTime ?? null,
            createdByUserId: request.user.userId,
          },
        });
        await recordAuditEvent(
          {
            action: "transport.schedule.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "TransportRouteSchedule",
            resourceId: schedule.id,
            metadata: { routeId: route.id },
          },
          tx,
        );
        return { schedule };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: outcome.notFound });
      return reply.status(201).send(outcome.schedule);
    },
  );

  // ─── 23. PATCH /schedules/:id — edit a schedule ──────────────────────────────
  app.patch(
    "/schedules/:id",
    { preHandler: [requirePermission("transport.routes.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = patchScheduleSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const schedule = await tx.transportRouteSchedule.findFirst({
          where: { id, institutionId },
          select: { id: true, routeId: true },
        });
        if (!schedule) return { notFound: "schedule not found" as const };

        if (data.stopId !== undefined && data.stopId !== null) {
          const stop = await tx.transportRouteStop.findFirst({
            where: { id: data.stopId, institutionId, routeId: schedule.routeId },
            select: { id: true },
          });
          if (!stop) return { notFound: "stop not found on route" as const };
        }

        const updated = await tx.transportRouteSchedule.update({
          where: { id: schedule.id },
          data: {
            ...("stopId" in data ? { stopId: data.stopId ?? null } : {}),
            ...("dayOfWeek" in data ? { dayOfWeek: data.dayOfWeek ?? null } : {}),
            ...("date" in data ? { date: data.date ?? null } : {}),
            ...(data.departureTime !== undefined ? { departureTime: data.departureTime } : {}),
            ...("arrivalTime" in data ? { arrivalTime: data.arrivalTime ?? null } : {}),
          },
        });
        await recordAuditEvent(
          {
            action: "transport.schedule.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "TransportRouteSchedule",
            resourceId: schedule.id,
          },
          tx,
        );
        return { schedule: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: outcome.notFound });
      return reply.send(outcome.schedule);
    },
  );

  // ─── 24. GET /routes/:id/schedules — schedules on a route ────────────────────
  app.get(
    "/routes/:id/schedules",
    { preHandler: [requirePermission("transport.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: routeId } = request.params as { id: string };

      const outcome = await withTenant(institutionId, async (tx) => {
        const route = await tx.transportRoute.findFirst({
          where: { id: routeId, institutionId },
          select: { id: true },
        });
        if (!route) return { notFound: true as const };
        const schedules = await tx.transportRouteSchedule.findMany({
          where: { institutionId, routeId: route.id },
          orderBy: [
            { date: { sort: "asc", nulls: "last" } },
            { dayOfWeek: "asc" },
            { departureTime: "asc" },
            { id: "asc" },
          ],
        });
        return { schedules };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "route not found" });
      return reply.send({ schedules: outcome.schedules });
    },
  );

  // ─── 25. POST /maintenance — create a request (OPEN) ─────────────────────────
  app.post(
    "/maintenance",
    { preHandler: [requirePermission("transport.maintenance.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createTransportMaintenanceSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const vehicle = await tx.transportVehicle.findFirst({
          where: { id: data.vehicleId, institutionId },
          select: { id: true },
        });
        if (!vehicle) return { notFound: true as const };

        const created = await tx.transportVehicleMaintenanceRequest.create({
          data: {
            institutionId,
            vehicleId: vehicle.id,
            issue: data.issue,
            status: "OPEN",
            assigneeUserId: data.assigneeUserId ?? null,
            ...(data.cost !== undefined ? { cost: Number(data.cost) } : {}),
            reportedByUserId: request.user.userId,
          },
        });
        await recordAuditEvent(
          {
            action: "transport.maintenance.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "TransportVehicleMaintenanceRequest",
            resourceId: created.id,
            metadata: { vehicleId: vehicle.id },
          },
          tx,
        );
        return { request: created };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "vehicle not found" });
      return reply.status(201).send(outcome.request);
    },
  );

  // ─── 26. POST /maintenance/:id/transition — forward-only ─────────────────────
  // Legal transitions mirror the DB guard transport_vehicle_maintenance_requests_guard:
  // OPEN->IN_PROGRESS, IN_PROGRESS->RESOLVED, OPEN->CANCELLED, IN_PROGRESS->CANCELLED.
  const MAINTENANCE_TRANSITIONS: Record<string, readonly string[]> = {
    OPEN: ["IN_PROGRESS", "CANCELLED"],
    IN_PROGRESS: ["RESOLVED", "CANCELLED"],
    RESOLVED: [],
    CANCELLED: [],
  };
  app.post(
    "/maintenance/:id/transition",
    { preHandler: [requirePermission("transport.maintenance.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = transportMaintenanceTransitionSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { toStatus, cost, resolutionNote } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const req = await tx.transportVehicleMaintenanceRequest.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!req) return { notFound: true as const };

        const legal = MAINTENANCE_TRANSITIONS[req.status] ?? [];
        if (!legal.includes(toStatus)) {
          await recordAuditEvent(
            {
              action: "transport.maintenance.transitioned",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "TransportVehicleMaintenanceRequest",
              resourceId: req.id,
              metadata: { reason: "illegal status transition", from: req.status, to: toStatus },
            },
            tx,
          );
          return { deny: deny("illegal status transition", 409) };
        }

        let updated;
        try {
          updated = await tx.transportVehicleMaintenanceRequest.update({
            where: { id: req.id },
            data: {
              status: toStatus,
              ...(toStatus === "RESOLVED" ? { resolvedAt: new Date() } : {}),
              ...(cost !== undefined ? { cost: Number(cost) } : {}),
              ...(resolutionNote !== undefined ? { resolutionNote } : {}),
            },
          });
        } catch (err) {
          if (isRestrictViolation(err)) return { deny: deny("illegal status transition", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "transport.maintenance.transitioned",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "TransportVehicleMaintenanceRequest",
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

  // ─── 27. GET /maintenance — staff list (filter vehicleId/status) ─────────────
  app.get(
    "/maintenance",
    { preHandler: [requirePermission("transport.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = transportListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { page, pageSize, status, vehicleId } = parsed.data;

      const result = await withTenant(institutionId, async (tx) => {
        const where: Prisma.TransportVehicleMaintenanceRequestWhereInput = {
          institutionId,
          ...(status
            ? { status: status as Prisma.TransportVehicleMaintenanceRequestWhereInput["status"] }
            : {}),
          ...(vehicleId ? { vehicleId } : {}),
        };
        const [total, requests] = await Promise.all([
          tx.transportVehicleMaintenanceRequest.count({ where }),
          tx.transportVehicleMaintenanceRequest.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
            // G-TRN4: additive vehicle display projection.
            include: { vehicle: { select: { id: true, registrationNo: true, type: true } } },
          }),
        ]);
        return { total, requests };
      });

      return reply.send({ requests: result.requests, total: result.total, page, pageSize });
    },
  );

  // ─── G-TRN1. GET /students/lookup — transport-scoped student picker ─────────────
  // Gated by transport.enrollments.manage (TRANSPORT_MANAGER holds no students.view).
  // Returns only id/name/enrollmentNo/program, excludes un-enrolled APPLICANTs (the
  // library G3 precedent).
  app.get(
    "/students/lookup",
    { preHandler: [requirePermission("transport.enrollments.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = transportStudentLookupQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { q, limit } = parsed.data;
      const students = await withTenant(institutionId, (tx) =>
        tx.studentProfile.findMany({
          where: {
            institutionId,
            status: { not: "APPLICANT" },
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { enrollmentNo: { contains: q, mode: "insensitive" } },
            ],
          },
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take: limit,
          select: studentDisplaySelect,
        }),
      );
      return reply.send({ students });
    },
  );
  // ─── 28. GET /reports/roster — enrolled students per route ───────────────────
  app.get(
    "/reports/roster",
    { preHandler: [requirePermission("transport.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = transportListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { routeId } = parsed.data;

      const roster = await withTenant(institutionId, async (tx) =>
        tx.transportEnrollment.findMany({
          where: {
            institutionId,
            status: "ACTIVE",
            ...(routeId ? { routeId } : {}),
          },
          orderBy: [{ routeId: "asc" }, { enrolledAt: "asc" }, { id: "asc" }],
          // G-TRN3: additive student/route/stop display projections.
          include: enrollmentDisplayInclude,
        }),
      );

      return reply.send({ roster });
    },
  );

  // ─── 29. GET /reports/utilization — effective capacity vs enrollment (§B.6) ──
  app.get(
    "/reports/utilization",
    { preHandler: [requirePermission("transport.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;

      const result = await withTenant(institutionId, async (tx) => {
        const routes = await tx.transportRoute.findMany({
          where: { institutionId },
          select: { id: true, name: true, code: true },
          orderBy: [{ code: "asc" }, { id: "asc" }],
        });

        // ACTIVE assignment per route -> vehicle seatCapacity = effective capacity.
        const assignments = await tx.transportRouteAssignment.findMany({
          where: { institutionId, status: "ACTIVE" },
          select: { routeId: true, vehicle: { select: { seatCapacity: true } } },
        });
        const capacityByRoute = new Map<string, number>(
          assignments.map((a) => [a.routeId, a.vehicle.seatCapacity]),
        );

        // ACTIVE enrollment count per route.
        const grouped = await tx.transportEnrollment.groupBy({
          by: ["routeId"],
          where: { institutionId, status: "ACTIVE" },
          _count: { _all: true },
        });
        const enrolledByRoute = new Map<string, number>(
          grouped.map((g) => [g.routeId, g._count._all]),
        );

        const rows = routes.map((r) => {
          const capacity = capacityByRoute.has(r.id) ? capacityByRoute.get(r.id)! : null;
          const enrolled = enrolledByRoute.get(r.id) ?? 0;
          // Capacity null + utilization null when no ACTIVE assignment (§B.6).
          const utilization =
            capacity === null ? null : capacity === 0 ? 0 : Math.round((enrolled / capacity) * 100) / 100;
          return {
            routeId: r.id,
            name: r.name,
            code: r.code,
            capacity,
            enrolled,
            utilization,
          };
        });
        return rows;
      });

      return reply.send({ utilization: result });
    },
  );

  // ─── 30. GET /reports/roster/export — XLSX export (audited) ──────────────────
  app.get(
    "/reports/roster/export",
    { preHandler: [requirePermission("transport.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { routeId } = request.query as { routeId?: string };

      const roster = await withTenant(institutionId, async (tx) => {
        const rows = await tx.transportEnrollment.findMany({
          where: {
            institutionId,
            status: "ACTIVE",
            ...(routeId ? { routeId } : {}),
          },
          orderBy: [{ routeId: "asc" }, { enrolledAt: "asc" }, { id: "asc" }],
        });
        await recordAuditEvent(
          {
            action: "transport.roster.exported",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "TransportEnrollment",
            metadata: { count: rows.length, ...(routeId ? { routeId } : {}) },
          },
          tx,
        );
        return rows;
      });

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Roster");
      sheet.columns = [
        { header: "Enrollment ID", key: "id", width: 26 },
        { header: "Route ID", key: "routeId", width: 26 },
        { header: "Student ID", key: "studentId", width: 26 },
        { header: "Stop ID", key: "stopId", width: 26 },
        { header: "Status", key: "status", width: 14 },
        { header: "Enrolled At", key: "enrolledAt", width: 24 },
        { header: "Ended At", key: "endedAt", width: 24 },
      ];
      for (const e of roster) {
        sheet.addRow({
          id: e.id,
          routeId: e.routeId,
          studentId: e.studentId,
          stopId: e.stopId,
          status: e.status,
          enrolledAt: e.enrolledAt.toISOString(),
          endedAt: e.endedAt ? e.endedAt.toISOString() : "",
        });
      }
      sheet.getRow(1).font = { bold: true };

      const filename = `transport-roster-${new Date().toISOString().slice(0, 10)}.xlsx`;
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

  // ─── Self-service /me/* (rows 31-34, transport.view_own) ─────────────────────
  // Each resolves the caller's StudentProfile by userId within withTenant and
  // self-scopes by that studentId; never accepts a studentId from input.
  // LIST-shaped: 200 + an EMPTY list both when there is no StudentProfile AND
  // when the profile has no ACTIVE enrollment — NEVER 404, NEVER a null scalar
  // (a DELIBERATE departure from hostel's 404 noProfile branch). Reads write no
  // audit. A student may be on >1 route, so every ACTIVE enrollment is returned.

  // 31. GET /me/enrollments — own ACTIVE enrollments.
  app.get(
    "/me/enrollments",
    { preHandler: [requirePermission("transport.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const enrollments = await withTenant(institutionId, async (tx) => {
        const self = await resolveSelf(tx, institutionId, userId);
        if (!self) return [];
        // G-TRN5: additive route + stop display (a student holds no transport.view,
        // so they could not otherwise resolve routeId/stopId to names).
        return tx.transportEnrollment.findMany({
          where: { institutionId, studentId: self.id, status: "ACTIVE" },
          orderBy: [{ enrolledAt: "asc" }, { id: "asc" }],
          include: {
            route: { select: { id: true, code: true, name: true } },
            stop: {
              select: { id: true, name: true, sequence: true, landmark: true, pickupOffsetMinutes: true },
            },
          },
        });
      });
      return reply.send({ enrollments });
    },
  );

  // 32. GET /me/routes — the routes of the caller's ACTIVE enrollments.
  app.get(
    "/me/routes",
    { preHandler: [requirePermission("transport.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const routes = await withTenant(institutionId, async (tx) => {
        const self = await resolveSelf(tx, institutionId, userId);
        if (!self) return [];
        const enrollments = await tx.transportEnrollment.findMany({
          where: { institutionId, studentId: self.id, status: "ACTIVE" },
          select: { routeId: true },
          orderBy: [{ enrolledAt: "asc" }, { id: "asc" }],
        });
        if (enrollments.length === 0) return [];
        // Preserve enrolledAt ASC, id ASC ordering, de-duplicated by routeId.
        const orderedRouteIds: string[] = [];
        const seen = new Set<string>();
        for (const e of enrollments) {
          if (!seen.has(e.routeId)) {
            seen.add(e.routeId);
            orderedRouteIds.push(e.routeId);
          }
        }
        const routeRows = await tx.transportRoute.findMany({
          where: { institutionId, id: { in: orderedRouteIds } },
        });
        const byId = new Map(routeRows.map((r) => [r.id, r]));
        return orderedRouteIds
          .map((rid) => byId.get(rid))
          .filter((r): r is NonNullable<typeof r> => r !== undefined)
          .map(serializeRoute);
      });
      return reply.send({ routes });
    },
  );

  // 33. GET /me/schedules — schedules of the caller's enrolled routes.
  app.get(
    "/me/schedules",
    { preHandler: [requirePermission("transport.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const schedules = await withTenant(institutionId, async (tx) => {
        const self = await resolveSelf(tx, institutionId, userId);
        if (!self) return [];
        const enrollments = await tx.transportEnrollment.findMany({
          where: { institutionId, studentId: self.id, status: "ACTIVE" },
          select: { routeId: true },
          orderBy: [{ enrolledAt: "asc" }, { id: "asc" }],
        });
        if (enrollments.length === 0) return [];
        // Owning-route enrollment order (enrolledAt ASC), de-duplicated.
        const orderedRouteIds: string[] = [];
        const rank = new Map<string, number>();
        for (const e of enrollments) {
          if (!rank.has(e.routeId)) {
            rank.set(e.routeId, orderedRouteIds.length);
            orderedRouteIds.push(e.routeId);
          }
        }
        const rows = await tx.transportRouteSchedule.findMany({
          where: { institutionId, routeId: { in: orderedRouteIds } },
          orderBy: [
            { date: { sort: "asc", nulls: "last" } },
            { dayOfWeek: "asc" },
            { departureTime: "asc" },
            { id: "asc" },
          ],
        });
        // Order by owning-route enrollment order, then the per-row ordering.
        return rows.sort((a, b) => (rank.get(a.routeId)! - rank.get(b.routeId)!));
      });
      return reply.send({ schedules });
    },
  );

  // 34. GET /me/fees — the fee (feeAmount-as-string) per enrolled route.
  app.get(
    "/me/fees",
    { preHandler: [requirePermission("transport.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const fees = await withTenant(institutionId, async (tx) => {
        const self = await resolveSelf(tx, institutionId, userId);
        if (!self) return [];
        const enrollments = await tx.transportEnrollment.findMany({
          where: { institutionId, studentId: self.id, status: "ACTIVE" },
          select: { routeId: true },
          orderBy: [{ enrolledAt: "asc" }, { id: "asc" }],
        });
        if (enrollments.length === 0) return [];
        const orderedRouteIds: string[] = [];
        const seen = new Set<string>();
        for (const e of enrollments) {
          if (!seen.has(e.routeId)) {
            seen.add(e.routeId);
            orderedRouteIds.push(e.routeId);
          }
        }
        const routeRows = await tx.transportRoute.findMany({
          where: { institutionId, id: { in: orderedRouteIds } },
          select: { id: true, name: true, code: true, feeAmount: true },
        });
        const byId = new Map(routeRows.map((r) => [r.id, r]));
        return orderedRouteIds
          .map((rid) => byId.get(rid))
          .filter((r): r is NonNullable<typeof r> => r !== undefined)
          .map((r) => ({
            routeId: r.id,
            name: r.name,
            code: r.code,
            feeAmount: r.feeAmount === null ? null : String(r.feeAmount),
          }));
      });
      return reply.send({ fees });
    },
  );
}
