import type { FastifyInstance, FastifyRequest } from "fastify";
import ExcelJS from "exceljs";
import { withTenant, Prisma } from "@campusgate/db";
import {
  createServiceRequestTypeSchema,
  patchServiceRequestTypeSchema,
  createServiceRequestFieldSchema,
  patchServiceRequestFieldSchema,
  raiseServiceRequestSchema,
  assignServiceRequestSchema,
  serviceRequestStatusPatchSchema,
  resolveServiceRequestSchema,
  rejectServiceRequestSchema,
  serviceRequestCommentSchema,
  serviceRequestFeedbackSchema,
  serviceRequestListQuerySchema,
} from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission, requireModuleActive, can } from "../services/authz-engine.js";
import { recordAuditEvent } from "../services/audit.js";

const MODULE_KEY = "service_requests" as const;

// ─── The FIXED enumerated lifecycle (design §5) ──────────────────────────────
// Mirrors the DB column guard service_request_status_guard. Terminal states
// {CLOSED, REJECTED, CANCELLED} have no outgoing edge. The in-handler map gives a
// clean 409 on an illegal edge; the DB guard is the backstop (caught via
// isRestrictViolation). The requiresApproval gate (IN_PROGRESS->PENDING_APPROVAL
// vs IN_PROGRESS->RESOLVED) is a handler-level per-type choice within these legal
// structural edges. Exported pure for unit testing.
export const STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  OPEN: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["IN_PROGRESS", "ASSIGNED", "CANCELLED"],
  IN_PROGRESS: ["PENDING_APPROVAL", "RESOLVED", "CANCELLED"],
  PENDING_APPROVAL: ["RESOLVED", "REJECTED"],
  RESOLVED: ["CLOSED"],
  CLOSED: [],
  REJECTED: [],
  CANCELLED: [],
};

// Lifecycle-terminal states: no outgoing legal edge (design §5).
export const TERMINAL_STATUSES: readonly string[] = ["CLOSED", "REJECTED", "CANCELLED"];

// Statuses excluded from the derived SLA breach (design FR-11): once a request is
// RESOLVED/CLOSED/REJECTED/CANCELLED the SLA clock no longer runs. RESOLVED is
// NOT lifecycle-terminal (it still has the ->CLOSED edge) but IS SLA-terminal.
export const SLA_SETTLED_STATUSES: readonly string[] = [
  "RESOLVED",
  "CLOSED",
  "REJECTED",
  "CANCELLED",
];

/** Legal structural edge test (self transition is a no-op, always legal). */
export function isLegalTransition(from: string, to: string): boolean {
  if (from === to) return true;
  return (STATUS_TRANSITIONS[from] ?? []).includes(to);
}

/** dueAt = raisedAt + slaTargetHours (design §5/FR-6). Pure, unit-testable. */
export function computeDueAt(raisedAt: Date, slaTargetHours: number): Date {
  return new Date(raisedAt.getTime() + slaTargetHours * 60 * 60 * 1000);
}

/**
 * Derived SLA breach (design FR-11): now > dueAt AND status not terminal. dueAt
 * is NOT NULL so no null branch. Pure, unit-testable.
 */
export function isBreached(status: string, dueAt: Date, now: Date = new Date()): boolean {
  if (SLA_SETTLED_STATUSES.includes(status)) return false;
  return now.getTime() > dueAt.getTime();
}

// ─── Field-value validation against a type's dynamic definitions (design §6) ──
// Pure function → unit testable in isolation. Returns a per-field error map
// (empty => valid). Rules: required present + non-empty; TEXT => string;
// NUMBER => finite number (coerced from numeric string); DATE => ISO-8601 parse;
// SELECT => member of options; no unknown keys.
export interface FieldDefForValidation {
  fieldKey: string;
  dataType: "TEXT" | "NUMBER" | "DATE" | "SELECT";
  required: boolean;
  options: string[];
}

function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

export function validateFieldValues(
  defs: readonly FieldDefForValidation[],
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const defByKey = new Map(defs.map((d) => [d.fieldKey, d]));

  // Unknown keys (not in the definition set).
  for (const key of Object.keys(values ?? {})) {
    if (!defByKey.has(key)) errors[key] = "unknown";
  }

  for (const def of defs) {
    const raw = values?.[def.fieldKey];
    if (isEmptyValue(raw)) {
      if (def.required) errors[def.fieldKey] = "required";
      continue; // optional + empty => skip type check
    }
    switch (def.dataType) {
      case "TEXT": {
        if (typeof raw !== "string") errors[def.fieldKey] = "invalid_type";
        break;
      }
      case "NUMBER": {
        const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
        if (!Number.isFinite(n)) errors[def.fieldKey] = "invalid_type";
        break;
      }
      case "DATE": {
        const s = typeof raw === "string" ? raw : null;
        const t = s === null ? NaN : Date.parse(s);
        if (!Number.isFinite(t)) errors[def.fieldKey] = "invalid_type";
        break;
      }
      case "SELECT": {
        if (typeof raw !== "string" || !def.options.includes(raw)) {
          errors[def.fieldKey] = "invalid_option";
        }
        break;
      }
    }
  }
  return errors;
}

/**
 * Service Requests Management routes (design §7.2), registered at
 * `/api/service-requests` (see server.ts). Service Requests is a GATED "booster"
 * module — every operational route carries `requireModuleActive("service_requests")`
 * IN ADDITION to `requirePermission("service_requests.*")` (the inventory/
 * transport precedent).
 *
 * House pattern (mirrors inventory.ts / transport.ts verbatim):
 *  - a single top-level `authenticate` preHandler;
 *  - per-route `[requirePermission(key), requireModuleActive("service_requests")]`
 *    (the single exception is GET /types/:id/fields, which uses an inline dual
 *    gate `view` OR `request_own` since requirePermission takes exactly one key —
 *    plan NIT-3);
 *  - every handler body runs inside `withTenant(institutionId, tx => ...)` with
 *    `institutionId` from the verified token (`request.user`), never from input;
 *  - every mutation (and every DENIED decision) writes a `service_requests.*`
 *    AuditEvent via `recordAuditEvent` in the SAME transaction;
 *  - deny branches record a DENIED audit then RETURN the 4xx from a
 *    normally-returning `withTenant` callback (never `throw`) so the audit
 *    commits.
 *
 * Two-surface split (design §7.2): requester self actions live under
 * `/me/requests/...` gated by `request_own` and hard-scoped by
 * `requesterUserId == token.userId`; staff actions live under bare `/:id/...`
 * gated by a staff key. A foreign id on a self route returns an owner-scoped 404.
 */
export async function serviceRequestsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  const gate = MODULE_KEY;

  // ─── Shared helpers (verbatim from inventory.ts / transport.ts) ─────────────

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
    const msg = String((err as Error)?.message ?? err);
    return (
      msg.includes("restrict_violation") ||
      msg.includes("illegal") ||
      msg.includes("append-only") ||
      msg.includes("immutable")
    );
  }

  // Shape a field definition row for the pure validator.
  function toValidationDef(d: {
    fieldKey: string;
    dataType: string;
    required: boolean;
    options: string[];
  }): FieldDefForValidation {
    return {
      fieldKey: d.fieldKey,
      dataType: d.dataType as FieldDefForValidation["dataType"],
      required: d.required,
      options: d.options ?? [],
    };
  }

  // ─── 1. POST /types — create a request type ─────────────────────────────────
  app.post(
    "/types",
    { preHandler: [requirePermission("service_requests.types.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createServiceRequestTypeSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        let type;
        try {
          type = await tx.serviceRequestType.create({
            data: {
              institutionId,
              name: data.name,
              code: data.code,
              category: data.category,
              description: data.description ?? null,
              defaultAssigneeRole: data.defaultAssigneeRole ?? null,
              defaultAssigneeDepartmentId: data.defaultAssigneeDepartmentId ?? null,
              slaTargetHours: data.slaTargetHours,
              requiresApproval: data.requiresApproval ?? false,
              isActive: data.isActive ?? true,
              createdByUserId: request.user.userId,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("request type code already exists", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "service_requests.type.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ServiceRequestType",
            resourceId: type.id,
          },
          tx,
        );
        return { type };
      });

      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(outcome.type);
    },
  );

  // ─── 2. PATCH /types/:id — edit a request type ──────────────────────────────
  app.patch(
    "/types/:id",
    { preHandler: [requirePermission("service_requests.types.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = patchServiceRequestTypeSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const type = await tx.serviceRequestType.findFirst({
          where: { id, institutionId },
          select: { id: true },
        });
        if (!type) return { notFound: true as const };

        let updated;
        try {
          updated = await tx.serviceRequestType.update({
            where: { id: type.id },
            data: {
              ...(data.name !== undefined ? { name: data.name } : {}),
              ...(data.code !== undefined ? { code: data.code } : {}),
              ...(data.category !== undefined ? { category: data.category } : {}),
              ...("description" in data ? { description: data.description ?? null } : {}),
              ...("defaultAssigneeRole" in data
                ? { defaultAssigneeRole: data.defaultAssigneeRole ?? null }
                : {}),
              ...("defaultAssigneeDepartmentId" in data
                ? { defaultAssigneeDepartmentId: data.defaultAssigneeDepartmentId ?? null }
                : {}),
              ...(data.slaTargetHours !== undefined ? { slaTargetHours: data.slaTargetHours } : {}),
              ...(data.requiresApproval !== undefined ? { requiresApproval: data.requiresApproval } : {}),
              ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("request type code already exists", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "service_requests.type.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ServiceRequestType",
            resourceId: type.id,
          },
          tx,
        );
        return { type: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "request type not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(outcome.type);
    },
  );

  // ─── 3. GET /types — staff list of request types ────────────────────────────
  app.get(
    "/types",
    { preHandler: [requirePermission("service_requests.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const types = await withTenant(institutionId, (tx) =>
        tx.serviceRequestType.findMany({
          where: { institutionId },
          orderBy: [{ category: "asc" }, { name: "asc" }, { id: "asc" }],
        }),
      );
      return reply.send(types);
    },
  );

  // ─── 4. POST /types/:id/fields — add a field definition ─────────────────────
  app.post(
    "/types/:id/fields",
    { preHandler: [requirePermission("service_requests.types.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = createServiceRequestFieldSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const type = await tx.serviceRequestType.findFirst({
          where: { id, institutionId },
          select: { id: true },
        });
        if (!type) return { notFound: true as const };

        // Frozen once the type has >= 1 request (design §6/§9).
        const requestCount = await tx.serviceRequest.count({
          where: { institutionId, requestTypeId: type.id },
        });
        if (requestCount > 0) {
          await recordAuditEvent(
            {
              action: "service_requests.field.created",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "ServiceRequestType",
              resourceId: type.id,
              metadata: { reason: "type_frozen_has_requests" },
            },
            tx,
          );
          return { deny: deny("field definitions are frozen once the type has requests", 409) };
        }

        let field;
        try {
          field = await tx.serviceRequestFieldDefinition.create({
            data: {
              institutionId,
              serviceRequestTypeId: type.id,
              fieldKey: data.fieldKey,
              label: data.label,
              dataType: data.dataType,
              required: data.required ?? false,
              options: data.dataType === "SELECT" ? (data.options ?? []) : [],
              sortOrder: data.sortOrder ?? 0,
              createdByUserId: request.user.userId,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("field key already exists for this type", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "service_requests.field.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ServiceRequestFieldDefinition",
            resourceId: field.id,
          },
          tx,
        );
        return { field };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "request type not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(outcome.field);
    },
  );

  // ─── 5. PATCH /types/:id/fields/:fid — edit a field definition ──────────────
  app.patch(
    "/types/:id/fields/:fid",
    { preHandler: [requirePermission("service_requests.types.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id, fid } = request.params as { id: string; fid: string };
      const parsed = patchServiceRequestFieldSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const field = await tx.serviceRequestFieldDefinition.findFirst({
          where: { id: fid, institutionId, serviceRequestTypeId: id },
          select: { id: true, dataType: true, options: true },
        });
        if (!field) return { notFound: true as const };

        const requestCount = await tx.serviceRequest.count({
          where: { institutionId, requestTypeId: id },
        });
        if (requestCount > 0) {
          await recordAuditEvent(
            {
              action: "service_requests.field.updated",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "ServiceRequestFieldDefinition",
              resourceId: field.id,
              metadata: { reason: "type_frozen_has_requests" },
            },
            tx,
          );
          return { deny: deny("field definitions are frozen once the type has requests", 409) };
        }

        // Resolve the effective dataType + options to enforce the SELECT shape.
        const nextDataType = data.dataType ?? field.dataType;
        const nextOptions =
          "options" in data ? (data.options ?? []) : field.options;
        if (nextDataType === "SELECT" && nextOptions.length === 0) {
          return { deny: deny("SELECT fields require non-empty options", 422) };
        }
        if (nextDataType !== "SELECT" && nextOptions.length > 0) {
          return { deny: deny("non-SELECT fields must omit options", 422) };
        }

        let updated;
        try {
          updated = await tx.serviceRequestFieldDefinition.update({
            where: { id: field.id },
            data: {
              ...(data.fieldKey !== undefined ? { fieldKey: data.fieldKey } : {}),
              ...(data.label !== undefined ? { label: data.label } : {}),
              ...(data.dataType !== undefined ? { dataType: data.dataType } : {}),
              ...(data.required !== undefined ? { required: data.required } : {}),
              ...("options" in data || data.dataType !== undefined
                ? { options: nextDataType === "SELECT" ? nextOptions : [] }
                : {}),
              ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("field key already exists for this type", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "service_requests.field.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ServiceRequestFieldDefinition",
            resourceId: field.id,
          },
          tx,
        );
        return { field: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "field definition not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(outcome.field);
    },
  );

  // ─── 6. GET /types/:id/fields — read a type's field schema (dual gate) ──────
  // NIT-3/NIT-5: inline dual gate (view OR request_own) because requirePermission
  // takes exactly one key. Tenant-scoped by RLS only — NO owner predicate (it
  // exposes a type's public field schema to render the raise form, not a request).
  app.get(
    "/types/:id/fields",
    { preHandler: [requireModuleActive(gate)] },
    async (request, reply) => {
      if (!request.auth) return reply.status(401).send({ error: "Unauthorized" });
      if (
        !can(request.auth, "service_requests.view") &&
        !can(request.auth, "service_requests.request_own")
      ) {
        return reply.status(403).send({ error: "Forbidden: missing permission" });
      }
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const fields = await withTenant(institutionId, (tx) =>
        tx.serviceRequestFieldDefinition.findMany({
          where: { institutionId, serviceRequestTypeId: id },
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        }),
      );
      return reply.send(fields);
    },
  );

  // ─── 7. POST / — raise a request (self-service, request_own) ────────────────
  app.post(
    "/",
    { preHandler: [requirePermission("service_requests.request_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const parsed = raiseServiceRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const type = await tx.serviceRequestType.findFirst({
          where: { id: data.requestTypeId, institutionId },
          select: { id: true, isActive: true, slaTargetHours: true },
        });
        if (!type) return { notFound: true as const };
        if (!type.isActive) {
          await recordAuditEvent(
            {
              action: "service_requests.request.raised",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "ServiceRequestType",
              resourceId: type.id,
              metadata: { reason: "type_inactive" },
            },
            tx,
          );
          return { deny: deny("request type is inactive", 409) };
        }

        const defs = await tx.serviceRequestFieldDefinition.findMany({
          where: { institutionId, serviceRequestTypeId: type.id },
          select: { fieldKey: true, dataType: true, required: true, options: true },
        });
        const errors = validateFieldValues(defs.map(toValidationDef), data.fieldValues);
        if (Object.keys(errors).length > 0) {
          // Validation failure: nothing persisted, not audited as a mutation (§9).
          return { validation: errors };
        }

        const raisedAt = new Date();
        const dueAt = computeDueAt(raisedAt, type.slaTargetHours);
        const created = await tx.serviceRequest.create({
          data: {
            institutionId,
            requestTypeId: type.id,
            requesterUserId: userId,
            title: data.title,
            description: data.description ?? null,
            priority: data.priority,
            fieldValues: data.fieldValues as Prisma.InputJsonValue,
            status: "OPEN",
            dueAt,
            raisedAt,
          },
        });
        await tx.serviceRequestActivity.create({
          data: {
            institutionId,
            serviceRequestId: created.id,
            kind: "STATUS_CHANGE",
            actorUserId: userId,
            fromStatus: null,
            toStatus: "OPEN",
            body: null,
          },
        });
        await recordAuditEvent(
          {
            action: "service_requests.request.raised",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ServiceRequest",
            resourceId: created.id,
          },
          tx,
        );
        return { request: created };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "request type not found" });
      if ("validation" in outcome) return reply.status(422).send({ errors: outcome.validation });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(outcome.request);
    },
  );

  // ─── 8. GET / — staff list of all requests (view) ───────────────────────────
  app.get(
    "/",
    { preHandler: [requirePermission("service_requests.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = serviceRequestListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const q = parsed.data;

      const where: Prisma.ServiceRequestWhereInput = {
        institutionId,
        ...(q.status ? { status: q.status as Prisma.EnumServiceRequestStatusFilter["equals"] } : {}),
        ...(q.requestTypeId ? { requestTypeId: q.requestTypeId } : {}),
        ...(q.assigneeUserId ? { assigneeUserId: q.assigneeUserId } : {}),
      };

      const result = await withTenant(institutionId, async (tx) => {
        const [total, rows] = await Promise.all([
          tx.serviceRequest.count({ where }),
          tx.serviceRequest.findMany({
            where,
            orderBy: [{ raisedAt: "desc" }, { id: "desc" }],
            skip: (q.page - 1) * q.pageSize,
            take: q.pageSize,
          }),
        ]);
        return { total, rows };
      });

      const now = new Date();
      const data = result.rows
        .filter((r) => (q.overdue ? isBreached(r.status, r.dueAt, now) : true))
        .map((r) => ({ ...r, isOverdue: isBreached(r.status, r.dueAt, now) }));
      return reply.send({ page: q.page, pageSize: q.pageSize, total: result.total, data });
    },
  );

  // ─── 9. GET /:id — staff detail (view) ──────────────────────────────────────
  app.get(
    "/:id",
    { preHandler: [requirePermission("service_requests.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const found = await withTenant(institutionId, async (tx) => {
        const sr = await tx.serviceRequest.findFirst({ where: { id, institutionId } });
        if (!sr) return null;
        const [activities, feedback] = await Promise.all([
          tx.serviceRequestActivity.findMany({
            where: { institutionId, serviceRequestId: sr.id },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          }),
          tx.serviceRequestFeedback.findFirst({ where: { institutionId, serviceRequestId: sr.id } }),
        ]);
        return { ...sr, isOverdue: isBreached(sr.status, sr.dueAt), activities, feedback };
      });
      if (!found) return reply.status(404).send({ error: "request not found" });
      return reply.send(found);
    },
  );

  // ─── 10. POST /:id/assign — assign/reassign (assign.manage) ─────────────────
  app.post(
    "/:id/assign",
    { preHandler: [requirePermission("service_requests.assign.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = assignServiceRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const sr = await tx.serviceRequest.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!sr) return { notFound: true as const };

        // Assignee must exist in-tenant (clean 404 before the FK backstop).
        const assignee = await tx.user.findFirst({
          where: { id: data.assigneeUserId, institutionId },
          select: { id: true },
        });
        if (!assignee) return { deny: deny("assignee not found", 404) };

        // Legal: OPEN->ASSIGNED, ASSIGNED->ASSIGNED (reassign). Not from terminal
        // / PENDING_APPROVAL / IN_PROGRESS / RESOLVED.
        const target = "ASSIGNED";
        if (!isLegalTransition(sr.status, target)) {
          await recordAuditEvent(
            {
              action: "service_requests.request.assigned",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "ServiceRequest",
              resourceId: sr.id,
              metadata: { from: sr.status, to: target, reason: "illegal_transition" },
            },
            tx,
          );
          return { deny: deny(`illegal transition ${sr.status} -> ${target}`, 409) };
        }

        try {
          await tx.serviceRequest.update({
            where: { id: sr.id },
            data: { status: "ASSIGNED", assigneeUserId: assignee.id },
          });
        } catch (err) {
          if (isRestrictViolation(err)) return { deny: deny("illegal transition", 409) };
          throw err;
        }
        await tx.serviceRequestActivity.create({
          data: {
            institutionId,
            serviceRequestId: sr.id,
            kind: "ASSIGNMENT",
            actorUserId: request.user.userId,
            fromStatus: sr.status as Prisma.ServiceRequestActivityCreateInput["fromStatus"],
            toStatus: "ASSIGNED",
            body: `assigned to ${assignee.id}`,
          },
        });
        await recordAuditEvent(
          {
            action: "service_requests.request.assigned",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ServiceRequest",
            resourceId: sr.id,
            metadata: { assigneeUserId: assignee.id },
          },
          tx,
        );
        return { ok: true as const };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "request not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send({ status: "ASSIGNED" });
    },
  );

  // ─── 11. PATCH /:id/status — drive lifecycle (requests.handle) ──────────────
  app.patch(
    "/:id/status",
    { preHandler: [requirePermission("service_requests.requests.handle"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = serviceRequestStatusPatchSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { toStatus } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const sr = await tx.serviceRequest.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true, requestType: { select: { requiresApproval: true } } },
        });
        if (!sr) return { notFound: true as const };

        const denyTransition = async (reason: string) => {
          await recordAuditEvent(
            {
              action: "service_requests.request.transitioned",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "ServiceRequest",
              resourceId: sr.id,
              metadata: { from: sr.status, to: toStatus, reason },
            },
            tx,
          );
        };

        if (!isLegalTransition(sr.status, toStatus)) {
          await denyTransition("illegal_transition");
          return { deny: deny(`illegal transition ${sr.status} -> ${toStatus}`, 409) };
        }
        // Approval-type gate: only requiresApproval types may enter
        // PENDING_APPROVAL; a non-approval type never reaches it.
        if (toStatus === "PENDING_APPROVAL" && !sr.requestType.requiresApproval) {
          await denyTransition("approval_type_mismatch");
          return { deny: deny("this request type does not require approval", 409) };
        }

        try {
          await tx.serviceRequest.update({ where: { id: sr.id }, data: { status: toStatus } });
        } catch (err) {
          if (isRestrictViolation(err)) return { deny: deny("illegal transition", 409) };
          throw err;
        }
        await tx.serviceRequestActivity.create({
          data: {
            institutionId,
            serviceRequestId: sr.id,
            kind: "STATUS_CHANGE",
            actorUserId: request.user.userId,
            fromStatus: sr.status as Prisma.ServiceRequestActivityCreateInput["fromStatus"],
            toStatus,
            body: null,
          },
        });
        await recordAuditEvent(
          {
            action: "service_requests.request.transitioned",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ServiceRequest",
            resourceId: sr.id,
            metadata: { from: sr.status, to: toStatus },
          },
          tx,
        );
        return { ok: true as const };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "request not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send({ status: toStatus });
    },
  );

  // ─── 12. POST /:id/resolve — resolve (requests.handle, non-approval types) ──
  app.post(
    "/:id/resolve",
    { preHandler: [requirePermission("service_requests.requests.handle"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = resolveServiceRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { resolutionNote } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const sr = await tx.serviceRequest.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true, requestType: { select: { requiresApproval: true } } },
        });
        if (!sr) return { notFound: true as const };

        const denyResolve = async (reason: string) => {
          await recordAuditEvent(
            {
              action: "service_requests.request.resolved",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "ServiceRequest",
              resourceId: sr.id,
              metadata: { from: sr.status, reason },
            },
            tx,
          );
        };

        // Resolve is the IN_PROGRESS -> RESOLVED edge for non-approval types.
        if (sr.status !== "IN_PROGRESS" || !isLegalTransition(sr.status, "RESOLVED")) {
          await denyResolve("illegal_transition");
          return { deny: deny(`cannot resolve from ${sr.status}`, 409) };
        }
        if (sr.requestType.requiresApproval) {
          await denyResolve("requires_approval");
          return { deny: deny("this request type must be resolved via approval", 409) };
        }

        try {
          await tx.serviceRequest.update({
            where: { id: sr.id },
            data: { status: "RESOLVED", resolutionNote, resolvedAt: new Date() },
          });
        } catch (err) {
          if (isRestrictViolation(err)) return { deny: deny("illegal transition", 409) };
          throw err;
        }
        await tx.serviceRequestActivity.create({
          data: {
            institutionId,
            serviceRequestId: sr.id,
            kind: "STATUS_CHANGE",
            actorUserId: request.user.userId,
            fromStatus: "IN_PROGRESS",
            toStatus: "RESOLVED",
            body: resolutionNote,
          },
        });
        await recordAuditEvent(
          {
            action: "service_requests.request.resolved",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ServiceRequest",
            resourceId: sr.id,
          },
          tx,
        );
        return { ok: true as const };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "request not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send({ status: "RESOLVED" });
    },
  );

  // ─── 13. POST /:id/approve — approve (requests.approve) ─────────────────────
  app.post(
    "/:id/approve",
    { preHandler: [requirePermission("service_requests.requests.approve"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const outcome = await withTenant(institutionId, async (tx) => {
        const sr = await tx.serviceRequest.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!sr) return { notFound: true as const };
        if (sr.status !== "PENDING_APPROVAL") {
          await recordAuditEvent(
            {
              action: "service_requests.request.approved",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "ServiceRequest",
              resourceId: sr.id,
              metadata: { from: sr.status, reason: "not_pending_approval" },
            },
            tx,
          );
          return { deny: deny(`cannot approve from ${sr.status}`, 409) };
        }
        try {
          await tx.serviceRequest.update({
            where: { id: sr.id },
            data: { status: "RESOLVED", resolvedAt: new Date() },
          });
        } catch (err) {
          if (isRestrictViolation(err)) return { deny: deny("illegal transition", 409) };
          throw err;
        }
        await tx.serviceRequestActivity.create({
          data: {
            institutionId,
            serviceRequestId: sr.id,
            kind: "APPROVAL",
            actorUserId: request.user.userId,
            fromStatus: "PENDING_APPROVAL",
            toStatus: "RESOLVED",
            body: "approved",
          },
        });
        await recordAuditEvent(
          {
            action: "service_requests.request.approved",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ServiceRequest",
            resourceId: sr.id,
          },
          tx,
        );
        return { ok: true as const };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "request not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send({ status: "RESOLVED" });
    },
  );

  // ─── 14. POST /:id/reject — reject (requests.approve) ───────────────────────
  app.post(
    "/:id/reject",
    { preHandler: [requirePermission("service_requests.requests.approve"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = rejectServiceRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { reason } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const sr = await tx.serviceRequest.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!sr) return { notFound: true as const };
        if (sr.status !== "PENDING_APPROVAL") {
          await recordAuditEvent(
            {
              action: "service_requests.request.rejected",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "ServiceRequest",
              resourceId: sr.id,
              metadata: { from: sr.status, reason: "not_pending_approval" },
            },
            tx,
          );
          return { deny: deny(`cannot reject from ${sr.status}`, 409) };
        }
        try {
          await tx.serviceRequest.update({ where: { id: sr.id }, data: { status: "REJECTED" } });
        } catch (err) {
          if (isRestrictViolation(err)) return { deny: deny("illegal transition", 409) };
          throw err;
        }
        await tx.serviceRequestActivity.create({
          data: {
            institutionId,
            serviceRequestId: sr.id,
            kind: "APPROVAL",
            actorUserId: request.user.userId,
            fromStatus: "PENDING_APPROVAL",
            toStatus: "REJECTED",
            body: reason ?? "rejected",
          },
        });
        await recordAuditEvent(
          {
            action: "service_requests.request.rejected",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ServiceRequest",
            resourceId: sr.id,
          },
          tx,
        );
        return { ok: true as const };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "request not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send({ status: "REJECTED" });
    },
  );

  // ─── 15. POST /:id/close — staff close (requests.handle) ────────────────────
  app.post(
    "/:id/close",
    { preHandler: [requirePermission("service_requests.requests.handle"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const outcome = await withTenant(institutionId, async (tx) =>
        closeRequestTx(tx, request, institutionId, id, null),
      );
      if ("notFound" in outcome) return reply.status(404).send({ error: "request not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send({ status: "CLOSED" });
    },
  );

  // ─── 16. POST /:id/cancel — staff cancel (requests.handle) ──────────────────
  app.post(
    "/:id/cancel",
    { preHandler: [requirePermission("service_requests.requests.handle"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const outcome = await withTenant(institutionId, async (tx) =>
        cancelRequestTx(tx, request, institutionId, id, null),
      );
      if ("notFound" in outcome) return reply.status(404).send({ error: "request not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send({ status: "CANCELLED" });
    },
  );

  // ─── 17. POST /:id/comments — staff comment (requests.handle) ───────────────
  app.post(
    "/:id/comments",
    { preHandler: [requirePermission("service_requests.requests.handle"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = serviceRequestCommentSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { body } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const sr = await tx.serviceRequest.findFirst({
          where: { id, institutionId },
          select: { id: true },
        });
        if (!sr) return { notFound: true as const };
        const comment = await tx.serviceRequestActivity.create({
          data: {
            institutionId,
            serviceRequestId: sr.id,
            kind: "COMMENT",
            actorUserId: request.user.userId,
            body,
          },
        });
        await recordAuditEvent(
          {
            action: "service_requests.comment.added",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ServiceRequestActivity",
            resourceId: comment.id,
          },
          tx,
        );
        return { comment };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "request not found" });
      return reply.status(201).send(outcome.comment);
    },
  );

  // ─── Self-service /me/requests/* (request_own, owner-scoped) ─────────────────
  // Every self route hard-scopes by requesterUserId == token.userId; a foreign
  // id returns an owner-scoped 404 (the request is invisible to the caller).

  // 18. GET /me/requests — own requests only.
  app.get(
    "/me/requests",
    { preHandler: [requirePermission("service_requests.request_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const parsed = serviceRequestListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const q = parsed.data;

      const where: Prisma.ServiceRequestWhereInput = {
        institutionId,
        requesterUserId: userId,
        ...(q.status ? { status: q.status as Prisma.EnumServiceRequestStatusFilter["equals"] } : {}),
        ...(q.requestTypeId ? { requestTypeId: q.requestTypeId } : {}),
      };
      const result = await withTenant(institutionId, async (tx) => {
        const [total, rows] = await Promise.all([
          tx.serviceRequest.count({ where }),
          tx.serviceRequest.findMany({
            where,
            orderBy: [{ raisedAt: "desc" }, { id: "desc" }],
            skip: (q.page - 1) * q.pageSize,
            take: q.pageSize,
          }),
        ]);
        return { total, rows };
      });
      const now = new Date();
      const data = result.rows.map((r) => ({ ...r, isOverdue: isBreached(r.status, r.dueAt, now) }));
      return reply.send({ page: q.page, pageSize: q.pageSize, total: result.total, data });
    },
  );

  // 19. GET /me/requests/:id — own detail (owner-scoped 404).
  app.get(
    "/me/requests/:id",
    { preHandler: [requirePermission("service_requests.request_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const { id } = request.params as { id: string };
      const found = await withTenant(institutionId, async (tx) => {
        const sr = await tx.serviceRequest.findFirst({
          where: { id, institutionId, requesterUserId: userId },
        });
        if (!sr) return null;
        const [activities, feedback] = await Promise.all([
          tx.serviceRequestActivity.findMany({
            where: { institutionId, serviceRequestId: sr.id },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          }),
          tx.serviceRequestFeedback.findFirst({ where: { institutionId, serviceRequestId: sr.id } }),
        ]);
        return { ...sr, isOverdue: isBreached(sr.status, sr.dueAt), activities, feedback };
      });
      if (!found) return reply.status(404).send({ error: "request not found" });
      return reply.send(found);
    },
  );

  // 20. POST /me/requests/:id/comments — own comment (not after CLOSED).
  app.post(
    "/me/requests/:id/comments",
    { preHandler: [requirePermission("service_requests.request_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = serviceRequestCommentSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { body } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const sr = await tx.serviceRequest.findFirst({
          where: { id, institutionId, requesterUserId: userId },
          select: { id: true, status: true },
        });
        if (!sr) return { notFound: true as const };
        if (sr.status === "CLOSED") {
          await recordAuditEvent(
            {
              action: "service_requests.comment.added",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "ServiceRequest",
              resourceId: sr.id,
              metadata: { reason: "closed" },
            },
            tx,
          );
          return { deny: deny("cannot comment on a closed request", 409) };
        }
        const comment = await tx.serviceRequestActivity.create({
          data: {
            institutionId,
            serviceRequestId: sr.id,
            kind: "COMMENT",
            actorUserId: userId,
            body,
          },
        });
        await recordAuditEvent(
          {
            action: "service_requests.comment.added",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ServiceRequestActivity",
            resourceId: comment.id,
          },
          tx,
        );
        return { comment };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "request not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(outcome.comment);
    },
  );

  // 21. POST /me/requests/:id/cancel — own cancel (OPEN only).
  app.post(
    "/me/requests/:id/cancel",
    { preHandler: [requirePermission("service_requests.request_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const { id } = request.params as { id: string };
      const outcome = await withTenant(institutionId, async (tx) =>
        cancelRequestTx(tx, request, institutionId, id, userId, { openOnly: true }),
      );
      if ("notFound" in outcome) return reply.status(404).send({ error: "request not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send({ status: "CANCELLED" });
    },
  );

  // 22. POST /me/requests/:id/close — own close (RESOLVED only).
  app.post(
    "/me/requests/:id/close",
    { preHandler: [requirePermission("service_requests.request_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const { id } = request.params as { id: string };
      const outcome = await withTenant(institutionId, async (tx) =>
        closeRequestTx(tx, request, institutionId, id, userId),
      );
      if ("notFound" in outcome) return reply.status(404).send({ error: "request not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send({ status: "CLOSED" });
    },
  );

  // 23. POST /me/requests/:id/feedback — own feedback (RESOLVED/CLOSED, one-per).
  app.post(
    "/me/requests/:id/feedback",
    { preHandler: [requirePermission("service_requests.request_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = serviceRequestFeedbackSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { rating, comment } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const sr = await tx.serviceRequest.findFirst({
          where: { id, institutionId, requesterUserId: userId },
          select: { id: true, status: true },
        });
        if (!sr) return { notFound: true as const };
        if (sr.status !== "RESOLVED" && sr.status !== "CLOSED") {
          await recordAuditEvent(
            {
              action: "service_requests.feedback.submitted",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "ServiceRequest",
              resourceId: sr.id,
              metadata: { from: sr.status, reason: "not_terminal" },
            },
            tx,
          );
          return { deny: deny("feedback is only allowed on a resolved or closed request", 409) };
        }

        // Pre-check the one-per-request invariant BEFORE the insert. A failed
        // INSERT (P2002) aborts the Postgres transaction, which would then abort
        // the in-tx DENIED audit write (25P02); the unique index is kept only as
        // the concurrency backstop (a concurrent double-submit P2002 returns a
        // clean 409 with no in-tx audit, since the aborted tx can't write one).
        const existing = await tx.serviceRequestFeedback.findFirst({
          where: { institutionId, serviceRequestId: sr.id },
          select: { id: true },
        });
        if (existing) {
          await recordAuditEvent(
            {
              action: "service_requests.feedback.submitted",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "ServiceRequest",
              resourceId: sr.id,
              metadata: { reason: "duplicate" },
            },
            tx,
          );
          return { deny: deny("feedback already submitted for this request", 409) };
        }

        let fb;
        try {
          fb = await tx.serviceRequestFeedback.create({
            data: {
              institutionId,
              serviceRequestId: sr.id,
              requesterUserId: userId,
              rating,
              comment: comment ?? null,
            },
          });
        } catch (err) {
          // Concurrency backstop: a racing double-submit hit the unique index.
          // The tx is now aborted, so we cannot write an audit here — return a
          // clean 409 (the pre-check covers the audited common case).
          if (isUniqueViolation(err)) {
            return { deny: deny("feedback already submitted for this request", 409) };
          }
          throw err;
        }
        await recordAuditEvent(
          {
            action: "service_requests.feedback.submitted",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ServiceRequestFeedback",
            resourceId: fb.id,
          },
          tx,
        );
        return { feedback: fb };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "request not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(outcome.feedback);
    },
  );

  // ─── Reports (staff, view) ───────────────────────────────────────────────────

  // 24. GET /reports/overdue — overdue + at-risk non-terminal requests.
  app.get(
    "/reports/overdue",
    { preHandler: [requirePermission("service_requests.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = serviceRequestListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const q = parsed.data;

      const rows = await withTenant(institutionId, (tx) =>
        tx.serviceRequest.findMany({
          where: { institutionId, status: { notIn: ["RESOLVED", "CLOSED", "REJECTED", "CANCELLED"] } },
          orderBy: [{ dueAt: "asc" }, { id: "asc" }],
        }),
      );
      const now = new Date();
      const atRiskCutoff = new Date(now.getTime() + q.atRiskHours * 60 * 60 * 1000);
      const overdue = rows
        .filter((r) => isBreached(r.status, r.dueAt, now))
        .map((r) => ({ ...r, isOverdue: true }));
      const atRisk = rows
        .filter((r) => !isBreached(r.status, r.dueAt, now) && r.dueAt.getTime() <= atRiskCutoff.getTime())
        .map((r) => ({ ...r, isOverdue: false }));
      return reply.send({ atRiskHours: q.atRiskHours, overdue, atRisk });
    },
  );

  // 25. GET /reports/volume — request count by type.
  app.get(
    "/reports/volume",
    { preHandler: [requirePermission("service_requests.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const grouped = await withTenant(institutionId, (tx) =>
        tx.serviceRequest.groupBy({
          by: ["requestTypeId"],
          where: { institutionId },
          _count: { _all: true },
        }),
      );
      const data = grouped.map((g) => ({ requestTypeId: g.requestTypeId, count: g._count._all }));
      return reply.send({ data });
    },
  );

  // 26. GET /reports/sla — SLA compliance (% resolved within SLA).
  app.get(
    "/reports/sla",
    { preHandler: [requirePermission("service_requests.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const rows = await withTenant(institutionId, (tx) =>
        tx.serviceRequest.findMany({
          where: { institutionId, status: { in: ["RESOLVED", "CLOSED"] } },
          select: { id: true, dueAt: true, resolvedAt: true },
        }),
      );
      const total = rows.length;
      const withinSla = rows.filter(
        (r) => r.resolvedAt !== null && r.resolvedAt.getTime() <= r.dueAt.getTime(),
      ).length;
      const compliancePct = total === 0 ? null : Math.round((withinSla / total) * 10000) / 100;
      return reply.send({ totalResolved: total, withinSla, compliancePct });
    },
  );

  // 27. GET /reports/feedback — feedback summary (avg rating + count).
  app.get(
    "/reports/feedback",
    { preHandler: [requirePermission("service_requests.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const agg = await withTenant(institutionId, (tx) =>
        tx.serviceRequestFeedback.aggregate({
          where: { institutionId },
          _count: { _all: true },
          _avg: { rating: true },
        }),
      );
      return reply.send({
        count: agg._count._all,
        averageRating: agg._avg.rating === null ? null : Math.round(agg._avg.rating * 100) / 100,
      });
    },
  );

  // 28. GET /reports/export — XLSX register (audited).
  app.get(
    "/reports/export",
    { preHandler: [requirePermission("service_requests.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const rows = await withTenant(institutionId, async (tx) => {
        const requests = await tx.serviceRequest.findMany({
          where: { institutionId },
          orderBy: [{ raisedAt: "desc" }, { id: "desc" }],
        });
        await recordAuditEvent(
          {
            action: "service_requests.register.exported",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ServiceRequest",
            metadata: { count: requests.length },
          },
          tx,
        );
        return requests;
      });

      const now = new Date();
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Service Requests");
      sheet.columns = [
        { header: "Request ID", key: "id", width: 26 },
        { header: "Type ID", key: "requestTypeId", width: 26 },
        { header: "Requester ID", key: "requesterUserId", width: 26 },
        { header: "Title", key: "title", width: 30 },
        { header: "Priority", key: "priority", width: 12 },
        { header: "Status", key: "status", width: 18 },
        { header: "Assignee ID", key: "assigneeUserId", width: 26 },
        { header: "Raised At", key: "raisedAt", width: 24 },
        { header: "Due At", key: "dueAt", width: 24 },
        { header: "Resolved At", key: "resolvedAt", width: 24 },
        { header: "Closed At", key: "closedAt", width: 24 },
        { header: "Overdue", key: "isOverdue", width: 10 },
      ];
      for (const r of rows) {
        sheet.addRow({
          id: r.id,
          requestTypeId: r.requestTypeId,
          requesterUserId: r.requesterUserId,
          title: r.title,
          priority: r.priority,
          status: r.status,
          assigneeUserId: r.assigneeUserId ?? "",
          raisedAt: r.raisedAt.toISOString(),
          dueAt: r.dueAt.toISOString(),
          resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : "",
          closedAt: r.closedAt ? r.closedAt.toISOString() : "",
          isOverdue: isBreached(r.status, r.dueAt, now) ? "YES" : "NO",
        });
      }
      sheet.getRow(1).font = { bold: true };

      const filename = `service-requests-${new Date().toISOString().slice(0, 10)}.xlsx`;
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

  // ─── Shared lifecycle tx helpers (close / cancel: self + staff share these) ──

  type TxOutcome =
    | { notFound: true }
    | { deny: Deny }
    | { ok: true };

  async function closeRequestTx(
    tx: Prisma.TransactionClient,
    request: FastifyRequest,
    institutionId: string,
    id: string,
    ownerUserId: string | null,
  ): Promise<TxOutcome> {
    const sr = await tx.serviceRequest.findFirst({
      where: { id, institutionId, ...(ownerUserId ? { requesterUserId: ownerUserId } : {}) },
      select: { id: true, status: true },
    });
    if (!sr) return { notFound: true };

    const denyClose = async (reason: string) => {
      await recordAuditEvent(
        {
          action: "service_requests.request.closed",
          result: "DENIED",
          ...actor(request),
          institutionId,
          resourceType: "ServiceRequest",
          resourceId: sr.id,
          metadata: { from: sr.status, reason },
        },
        tx,
      );
    };

    if (sr.status !== "RESOLVED") {
      await denyClose("not_resolved");
      return { deny: deny(`cannot close from ${sr.status}`, 409) };
    }
    try {
      await tx.serviceRequest.update({
        where: { id: sr.id },
        data: { status: "CLOSED", closedAt: new Date() },
      });
    } catch (err) {
      if (isRestrictViolation(err)) return { deny: deny("illegal transition", 409) };
      throw err;
    }
    await tx.serviceRequestActivity.create({
      data: {
        institutionId,
        serviceRequestId: sr.id,
        kind: "STATUS_CHANGE",
        actorUserId: request.user.userId,
        fromStatus: "RESOLVED",
        toStatus: "CLOSED",
        body: null,
      },
    });
    await recordAuditEvent(
      {
        action: "service_requests.request.closed",
        result: "SUCCESS",
        ...actor(request),
        institutionId,
        resourceType: "ServiceRequest",
        resourceId: sr.id,
      },
      tx,
    );
    return { ok: true };
  }

  async function cancelRequestTx(
    tx: Prisma.TransactionClient,
    request: FastifyRequest,
    institutionId: string,
    id: string,
    ownerUserId: string | null,
    opts: { openOnly?: boolean } = {},
  ): Promise<TxOutcome> {
    const sr = await tx.serviceRequest.findFirst({
      where: { id, institutionId, ...(ownerUserId ? { requesterUserId: ownerUserId } : {}) },
      select: { id: true, status: true },
    });
    if (!sr) return { notFound: true };

    const denyCancel = async (reason: string) => {
      await recordAuditEvent(
        {
          action: "service_requests.request.cancelled",
          result: "DENIED",
          ...actor(request),
          institutionId,
          resourceType: "ServiceRequest",
          resourceId: sr.id,
          metadata: { from: sr.status, reason },
        },
        tx,
      );
    };

    // Requester self-cancel is OPEN-only; staff cancel from OPEN/ASSIGNED/IN_PROGRESS.
    const allowedSources = opts.openOnly ? ["OPEN"] : ["OPEN", "ASSIGNED", "IN_PROGRESS"];
    if (!allowedSources.includes(sr.status) || !isLegalTransition(sr.status, "CANCELLED")) {
      await denyCancel("illegal_transition");
      return { deny: deny(`cannot cancel from ${sr.status}`, 409) };
    }
    try {
      await tx.serviceRequest.update({ where: { id: sr.id }, data: { status: "CANCELLED" } });
    } catch (err) {
      if (isRestrictViolation(err)) return { deny: deny("illegal transition", 409) };
      throw err;
    }
    await tx.serviceRequestActivity.create({
      data: {
        institutionId,
        serviceRequestId: sr.id,
        kind: "STATUS_CHANGE",
        actorUserId: request.user.userId,
        fromStatus: sr.status as Prisma.ServiceRequestActivityCreateInput["fromStatus"],
        toStatus: "CANCELLED",
        body: null,
      },
    });
    await recordAuditEvent(
      {
        action: "service_requests.request.cancelled",
        result: "SUCCESS",
        ...actor(request),
        institutionId,
        resourceType: "ServiceRequest",
        resourceId: sr.id,
      },
      tx,
    );
    return { ok: true };
  }
}
