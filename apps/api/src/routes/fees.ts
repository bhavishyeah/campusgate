import type { FastifyInstance, FastifyRequest } from "fastify";
import ExcelJS from "exceljs";
import { withTenant, Prisma } from "@campusgate/db";
import {
  createFeeStructureSchema,
  patchFeeStructureSchema,
  addFeeComponentSchema,
  postChargeSchema,
  bulkChargeSchema,
  createPaymentSchema,
  verifyPaymentSchema,
  reconciliationQuerySchema,
  runReconciliationSchema,
  createConcessionDefinitionSchema,
  patchConcessionDefinitionSchema,
  postConcessionSchema,
  createRefundSchema,
  createAdjustmentSchema,
  collectionReportQuerySchema,
  outstandingReportQuerySchema,
  reconciliationReportQuerySchema,
  rollupReportQuerySchema,
} from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission, requireModuleActive } from "../services/authz-engine.js";
import { requireStepUp } from "../middleware/step-up.js";
import { recordAuditEvent } from "../services/audit.js";
import { getRazorpayGateway } from "../services/fees/razorpay.js";
import { computeOutstanding, chargeOutstanding } from "../services/fees/allocation.js";
import { computeChargeOutstanding } from "../services/fees/ledger.js";
import { findStuck } from "../services/fees/reconciliation.js";
import { reconcileOne } from "../services/fees/reconciliation.js";
import { postConcession } from "../services/fees/concessions.js";
import { postAdjustment } from "../services/fees/adjustments.js";
import {
  acquireRefundLock,
  computeNetRefundable,
  settleRefund,
} from "../services/fees/refunds.js";

const MODULE_KEY = "fees" as const;

/**
 * Fees operational routes (design §D.10), registered at `/api/fees`
 * (see server.ts). `fees` is a GATED module — every route carries
 * `requireModuleActive("fees")` IN ADDITION to `requirePermission(...)`.
 * The PUBLIC webhook lives in a SEPARATE encapsulation (razorpay-webhook.ts),
 * NOT here.
 *
 * House pattern (mirrors library.ts / admissions.ts):
 *  - a single top-level `authenticate` preHandler;
 *  - per-route `requirePermission(key)` AND `requireModuleActive("fees")`;
 *  - every handler runs inside `withTenant(institutionId, tx => ...)` with
 *    `institutionId` from the verified token (`request.user`), never from input;
 *  - every mutation writes a `fees.*` AuditEvent via `recordAuditEvent` in the
 *    SAME transaction; deny branches record a DENIED audit then RETURN the 4xx
 *    from a normally-returning `withTenant` callback (never `throw`);
 *  - money is BigInt in-process and is emitted on every JSON boundary as a
 *    decimal STRING of paise, never a JSON number (§D.1).
 *
 * MFA step-up seam (slice-7.1, §D.12 / superadmin-security §5.2): the
 * forward-declared `fees.refund` / `fees.adjust` permission keys are UNBOUND and
 * NO route consumes them in slice 1. When their refund/adjust routes are built
 * in slice 7.1 they MUST be gated by `requireStepUp` + the permission (refunds
 * and fee adjustments are step-up actions). This file is where those routes land.
 */
export async function feesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);
  const gate = MODULE_KEY;

  function actor(request: FastifyRequest) {
    return {
      actorUserId: request.user.userId,
      actorRoleKey: request.auth?.roles[0] ?? request.user.role,
      actorMembershipId: request.auth?.membershipId ?? null,
      requestRef: request.id,
    };
  }

  // Serialize money as a decimal string of paise (§D.1).
  function money(v: bigint): string {
    return v.toString();
  }

  // Resolve the caller's own StudentProfile id (self-service). Returns null if
  // the authenticated user has no student profile in this tenant.
  async function ownStudentId(
    tx: Prisma.TransactionClient,
    institutionId: string,
    userId: string,
  ): Promise<string | null> {
    const row = await tx.studentProfile.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  function isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
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
  function isDeny(x: unknown): x is Deny {
    return typeof x === "object" && x !== null && "deny" in x;
  }

  // ─── Fee structures (fees.structures.manage / fees.view) ─────────────────────

  app.post(
    "/structures",
    { preHandler: [requirePermission("fees.structures.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createFeeStructureSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        let structure;
        try {
          structure = await tx.feeStructure.create({
            data: {
              institutionId,
              name: data.name,
              status: data.status ?? "DRAFT",
              programId: data.programId ?? null,
              academicSessionId: data.academicSessionId ?? null,
              description: data.description ?? null,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { conflict: "a structure with this name already exists" as const };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "fees.structure.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "FeeStructure",
            resourceId: structure.id,
          },
          tx,
        );
        return { structure };
      });

      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.status(201).send(serializeStructure(outcome.structure));
    },
  );

  app.patch(
    "/structures/:id",
    { preHandler: [requirePermission("fees.structures.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = patchFeeStructureSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const existing = await tx.feeStructure.findFirst({
          where: { id, institutionId },
          select: { id: true },
        });
        if (!existing) return { notFound: true as const };

        let updated;
        try {
          updated = await tx.feeStructure.update({
            where: { id: existing.id },
            data: {
              ...(data.name !== undefined ? { name: data.name } : {}),
              ...(data.status !== undefined ? { status: data.status } : {}),
              ...("programId" in data ? { programId: data.programId ?? null } : {}),
              ...("academicSessionId" in data ? { academicSessionId: data.academicSessionId ?? null } : {}),
              ...("description" in data ? { description: data.description ?? null } : {}),
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { conflict: "a structure with this name already exists" as const };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "fees.structure.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "FeeStructure",
            resourceId: existing.id,
          },
          tx,
        );
        return { structure: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "structure not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send(serializeStructure(outcome.structure));
    },
  );

  app.get(
    "/structures",
    { preHandler: [requirePermission("fees.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const structures = await withTenant(institutionId, (tx) =>
        tx.feeStructure.findMany({
          where: { institutionId },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        }),
      );
      return reply.send({ structures: structures.map(serializeStructure) });
    },
  );

  app.get(
    "/structures/:id",
    { preHandler: [requirePermission("fees.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const outcome = await withTenant(institutionId, async (tx) => {
        const structure = await tx.feeStructure.findFirst({
          where: { id, institutionId },
          include: { components: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
        });
        if (!structure) return { notFound: true as const };
        return { structure };
      });
      if ("notFound" in outcome) return reply.status(404).send({ error: "structure not found" });
      return reply.send({
        ...serializeStructure(outcome.structure),
        components: outcome.structure.components.map(serializeComponent),
      });
    },
  );

  // ─── Fee components (fees.structures.manage / fees.view) ─────────────────────

  app.post(
    "/structures/:id/components",
    { preHandler: [requirePermission("fees.structures.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = addFeeComponentSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const structure = await tx.feeStructure.findFirst({
          where: { id, institutionId },
          select: { id: true },
        });
        if (!structure) return { notFound: true as const };

        const component = await tx.feeComponent.create({
          data: {
            institutionId,
            feeStructureId: structure.id,
            category: data.category,
            amountPaise: data.amountPaise,
            currency: "INR",
            dueDate: data.dueDate ? new Date(data.dueDate) : null,
            installmentLabel: data.installmentLabel ?? null,
            installmentNumber: data.installmentNumber ?? null,
          },
        });
        await recordAuditEvent(
          {
            action: "fees.component.added",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "FeeComponent",
            resourceId: component.id,
            metadata: { feeStructureId: structure.id, amountPaise: money(data.amountPaise) },
          },
          tx,
        );
        return { component };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "structure not found" });
      return reply.status(201).send(serializeComponent(outcome.component));
    },
  );

  app.get(
    "/structures/:id/components",
    { preHandler: [requirePermission("fees.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const outcome = await withTenant(institutionId, async (tx) => {
        const structure = await tx.feeStructure.findFirst({
          where: { id, institutionId },
          select: { id: true },
        });
        if (!structure) return { notFound: true as const };
        const components = await tx.feeComponent.findMany({
          where: { institutionId, feeStructureId: structure.id },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        return { components };
      });
      if ("notFound" in outcome) return reply.status(404).send({ error: "structure not found" });
      return reply.send({ components: outcome.components.map(serializeComponent) });
    },
  );

  // ─── Charges (fees.charges.manage) ───────────────────────────────────────────

  app.post(
    "/charges",
    { preHandler: [requirePermission("fees.charges.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = postChargeSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const student = await tx.studentProfile.findFirst({
          where: { id: data.studentId, institutionId },
          select: { id: true },
        });
        if (!student) {
          await recordAuditEvent(
            {
              action: "fees.charge.posted",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "StudentCharge",
              metadata: { reason: "student not found", studentId: data.studentId },
            },
            tx,
          );
          return deny("student not found", 404);
        }

        const charge = await tx.studentCharge.create({
          data: {
            institutionId,
            studentId: student.id,
            feeStructureId: data.feeStructureId ?? null,
            feeComponentId: data.feeComponentId ?? null,
            category: data.category,
            amountPaise: data.amountPaise,
            currency: "INR",
            dueDate: data.dueDate ? new Date(data.dueDate) : null,
            description: data.description,
            status: "PENDING",
            postedByUserId: request.user.userId,
          },
        });
        await recordAuditEvent(
          {
            action: "fees.charge.posted",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "StudentCharge",
            resourceId: charge.id,
            metadata: { studentId: student.id, amountPaise: money(data.amountPaise) },
          },
          tx,
        );
        return { charge };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.status(201).send(serializeCharge(outcome.charge));
    },
  );

  app.post(
    "/charges/bulk",
    { preHandler: [requirePermission("fees.charges.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = bulkChargeSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const structure = await tx.feeStructure.findFirst({
          where: { id: data.feeStructureId, institutionId },
          select: { id: true, programId: true, academicSessionId: true },
        });
        if (!structure) return deny("structure not found", 404);

        const components = await tx.feeComponent.findMany({
          where: { institutionId, feeStructureId: structure.id },
        });
        if (components.length === 0) {
          await recordAuditEvent(
            {
              action: "fees.charges.bulk_posted",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "StudentCharge",
              metadata: { reason: "structure has no components", feeStructureId: structure.id },
            },
            tx,
          );
          return deny("structure has no components", 409);
        }

        // Resolve the target students: an explicit list, else by the structure's
        // program/session link (foundational StudentProfile data).
        const studentWhere: Prisma.StudentProfileWhereInput = { institutionId };
        if (data.studentIds && data.studentIds.length > 0) {
          studentWhere.id = { in: data.studentIds };
        } else {
          const programId = data.programId ?? structure.programId ?? undefined;
          if (programId) studentWhere.programId = programId;
        }
        const students = await tx.studentProfile.findMany({
          where: studentWhere,
          select: { id: true },
        });
        if (students.length === 0) {
          await recordAuditEvent(
            {
              action: "fees.charges.bulk_posted",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "StudentCharge",
              metadata: { reason: "no target students", feeStructureId: structure.id },
            },
            tx,
          );
          return deny("no target students", 409);
        }

        let posted = 0;
        for (const student of students) {
          for (const component of components) {
            await tx.studentCharge.create({
              data: {
                institutionId,
                studentId: student.id,
                feeStructureId: structure.id,
                feeComponentId: component.id,
                category: component.category,
                amountPaise: component.amountPaise,
                currency: "INR",
                dueDate: component.dueDate,
                description: component.installmentLabel ?? `${component.category} fee`,
                status: "PENDING",
                postedByUserId: request.user.userId,
              },
            });
            posted += 1;
          }
        }

        await recordAuditEvent(
          {
            action: "fees.charges.bulk_posted",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "StudentCharge",
            resourceId: structure.id,
            metadata: { feeStructureId: structure.id, students: students.length, charges: posted },
          },
          tx,
        );
        return { posted, students: students.length };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.status(201).send({ charges: outcome.posted, students: outcome.students });
    },
  );

  // ─── Ledger + staff lists (fees.view) ────────────────────────────────────────

  app.get(
    "/students/:studentId/ledger",
    { preHandler: [requirePermission("fees.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { studentId } = request.params as { studentId: string };
      const outcome = await withTenant(institutionId, async (tx) => {
        const student = await tx.studentProfile.findFirst({
          where: { id: studentId, institutionId },
          select: { id: true },
        });
        if (!student) return { notFound: true as const };
        const ledger = await loadLedger(tx, institutionId, student.id);
        return { ledger };
      });
      if ("notFound" in outcome) return reply.status(404).send({ error: "student not found" });
      return reply.send(outcome.ledger);
    },
  );

  app.get(
    "/payments",
    { preHandler: [requirePermission("fees.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const payments = await withTenant(institutionId, (tx) =>
        tx.paymentTransaction.findMany({
          where: { institutionId },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          take: 200,
        }),
      );
      return reply.send({ payments: payments.map(serializeTransaction) });
    },
  );

  app.get(
    "/receipts",
    { preHandler: [requirePermission("fees.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const receipts = await withTenant(institutionId, (tx) =>
        tx.receipt.findMany({
          where: { institutionId },
          orderBy: [{ sequence: "desc" }],
          take: 200,
        }),
      );
      return reply.send({ receipts: receipts.map(serializeReceipt) });
    },
  );

  // ─── Reconciliation (fees.view read / fees.collect run) ──────────────────────

  app.get(
    "/reconciliation",
    { preHandler: [requirePermission("fees.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = reconciliationQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { thresholdMinutes, page, pageSize } = parsed.data;

      const result = await withTenant(institutionId, async (tx) => {
        const stuck = await findStuck(tx, institutionId, thresholdMinutes, pageSize * page);
        const slice = stuck.slice((page - 1) * pageSize, page * pageSize);
        return { total: stuck.length, items: slice };
      });
      return reply.send({
        thresholdMinutes,
        page,
        pageSize,
        total: result.total,
        stuck: result.items.map((t) => ({
          id: t.id,
          studentId: t.studentId,
          amountPaise: money(t.amountPaise),
          status: t.status,
          razorpayOrderId: t.razorpayOrderId,
          createdAt: t.createdAt.toISOString(),
        })),
      });
    },
  );

  app.post(
    "/reconciliation/run",
    { preHandler: [requirePermission("fees.collect"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = runReconciliationSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const thresholdMinutes = parsed.data.thresholdMinutes ?? 30;
      const limit = parsed.data.limit ?? 50;

      const gateway = getRazorpayGateway();
      const act = actor(request);

      // Each stuck transaction is reconciled in its OWN withTenant tx so a single
      // Razorpay fetch failure cannot roll back prior successful captures.
      const stuck = await withTenant(institutionId, (tx) =>
        findStuck(tx, institutionId, thresholdMinutes, limit),
      );

      const summary = { captured: 0, failed: 0, stillOpen: 0, alreadyCaptured: 0, errored: 0 };
      for (const t of stuck) {
        try {
          const outcome = await withTenant(institutionId, (tx) =>
            reconcileOne(tx, gateway, institutionId, t, act),
          );
          if (outcome.kind === "captured") summary.captured += 1;
          else if (outcome.kind === "failed") summary.failed += 1;
          else if (outcome.kind === "already_captured") summary.alreadyCaptured += 1;
          else summary.stillOpen += 1;
        } catch (err) {
          summary.errored += 1;
          request.log.error({ err, transactionId: t.id }, "reconcileOne failed");
        }
      }
      return reply.send({ thresholdMinutes, scanned: stuck.length, ...summary });
    },
  );

  // ─── STUDENT self-service (fees.view_own) ────────────────────────────────────

  app.get(
    "/me/charges",
    { preHandler: [requirePermission("fees.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const outcome = await withTenant(institutionId, async (tx) => {
        const studentId = await ownStudentId(tx, institutionId, userId);
        if (!studentId) return { noProfile: true as const };
        const ledger = await loadLedger(tx, institutionId, studentId);
        return { charges: ledger.charges };
      });
      if ("noProfile" in outcome) return reply.status(404).send({ error: "no student profile" });
      return reply.send({ charges: outcome.charges });
    },
  );

  app.get(
    "/me/receipts",
    { preHandler: [requirePermission("fees.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const outcome = await withTenant(institutionId, async (tx) => {
        const studentId = await ownStudentId(tx, institutionId, userId);
        if (!studentId) return { noProfile: true as const };
        const receipts = await tx.receipt.findMany({
          where: {
            institutionId,
            paymentTransaction: { is: { studentId } },
          },
          orderBy: [{ sequence: "desc" }],
        });
        return { receipts };
      });
      if ("noProfile" in outcome) return reply.status(404).send({ error: "no student profile" });
      return reply.send({ receipts: outcome.receipts.map(serializeReceipt) });
    },
  );

  app.get(
    "/me/outstanding",
    { preHandler: [requirePermission("fees.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const outcome = await withTenant(institutionId, async (tx) => {
        const studentId = await ownStudentId(tx, institutionId, userId);
        if (!studentId) return { noProfile: true as const };
        const ledger = await loadLedger(tx, institutionId, studentId);
        return { outstandingPaise: ledger.outstandingPaise, currency: "INR" as const };
      });
      if ("noProfile" in outcome) return reply.status(404).send({ error: "no student profile" });
      return reply.send({ outstandingPaise: outcome.outstandingPaise, currency: outcome.currency });
    },
  );

  // Stage 1 — create order (§D.5). Validate own charges, BigInt-sum the
  // outstanding, guard the money boundary, orders.create, INSERT CREATED with
  // targetChargeIds, audit fees.payment.order_created, return the order id +
  // amount STRING + public keyId.
  app.post(
    "/me/payments",
    { preHandler: [requirePermission("fees.view_own"), requireModuleActive(gate)] },
    (request, reply) => createOrderHandler(request, reply),
  );
  // Alias: the spec names POST /payments for the student self-service create.
  app.post(
    "/payments",
    { preHandler: [requirePermission("fees.view_own"), requireModuleActive(gate)] },
    (request, reply) => createOrderHandler(request, reply),
  );

  async function createOrderHandler(request: FastifyRequest, reply: import("fastify").FastifyReply) {
    const { institutionId, userId } = request.user;
    const parsed = createPaymentSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const { chargeIds } = parsed.data;

    // Validate ownership + sum the outstanding INSIDE a tenant tx first.
    const prep = await withTenant(institutionId, async (tx) => {
      const studentId = await ownStudentId(tx, institutionId, userId);
      if (!studentId) return deny("no student profile", 404);

      const charges = await tx.studentCharge.findMany({
        where: { id: { in: chargeIds }, institutionId, studentId },
        select: {
          id: true,
          amountPaise: true,
          status: true,
          allocations: { select: { amountPaise: true } },
        },
      });

      // Every requested id must resolve to an owned, not-PAID charge.
      const found = new Set(charges.map((c) => c.id));
      const missing = chargeIds.filter((id) => !found.has(id));
      const paid = charges.filter((c) => c.status === "PAID").map((c) => c.id);
      if (missing.length > 0 || paid.length > 0) {
        await recordAuditEvent(
          {
            action: "fees.payment.order_created",
            result: "DENIED",
            ...actor(request),
            institutionId,
            resourceType: "PaymentTransaction",
            metadata: { reason: "invalid charge selection", missing: missing.length, paid: paid.length },
          },
          tx,
        );
        return deny("one or more charges are not payable", 409);
      }

      let amountPaise = 0n;
      for (const c of charges) {
        const allocated = c.allocations.reduce((acc, a) => acc + a.amountPaise, 0n);
        amountPaise += chargeOutstanding({ amountPaise: c.amountPaise, allocatedPaise: allocated });
      }
      if (amountPaise <= 0n || amountPaise > BigInt(Number.MAX_SAFE_INTEGER)) {
        await recordAuditEvent(
          {
            action: "fees.payment.order_created",
            result: "DENIED",
            ...actor(request),
            institutionId,
            resourceType: "PaymentTransaction",
            metadata: { reason: "amount out of range", amountPaise: amountPaise.toString() },
          },
          tx,
        );
        return deny("payable amount out of range", 409);
      }
      return { studentId, amountPaise, targetChargeIds: charges.map((c) => c.id) };
    });

    if (isDeny(prep)) return reply.status(prep.status).send({ error: prep.deny });

    // Create the Razorpay order OUTSIDE the tenant tx (network call); on failure
    // nothing is committed.
    const gateway = getRazorpayGateway();
    let order;
    try {
      order = await gateway.createOrder({
        amountPaise: prep.amountPaise,
        currency: "INR",
        receipt: `rcpt_${prep.studentId.slice(-8)}_${Date.now()}`,
        notes: { institutionId, studentId: prep.studentId },
      });
    } catch (err) {
      request.log.error({ err }, "createOrder: Razorpay order create failed");
      return reply.status(502).send({ error: "payment gateway unavailable" });
    }

    const result = await withTenant(institutionId, async (tx) => {
      const transaction = await tx.paymentTransaction.create({
        data: {
          institutionId,
          studentId: prep.studentId,
          amountPaise: prep.amountPaise,
          currency: "INR",
          status: "CREATED",
          razorpayOrderId: order.id,
          targetChargeIds: prep.targetChargeIds,
          initiatedByUserId: userId,
        },
      });
      await recordAuditEvent(
        {
          action: "fees.payment.order_created",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "PaymentTransaction",
          resourceId: transaction.id,
          metadata: { razorpayOrderId: order.id, amountPaise: prep.amountPaise.toString() },
        },
        tx,
      );
      return transaction;
    });

    return reply.status(201).send({
      razorpayOrderId: order.id,
      amountPaise: money(prep.amountPaise),
      currency: "INR",
      keyId: gateway.keyId,
      paymentTransactionId: result.id,
    });
  }

  // Stage 2 — checkout callback verify (§D.5). Optimistic UX only: verify the
  // payment signature; on match persist payment id/signature + CREATED→AUTHORIZED
  // + audit signature_verified; on mismatch 400 + signature_rejected. NEVER
  // CAPTURED / allocate / receipt.
  app.post(
    "/payments/verify",
    { preHandler: [requirePermission("fees.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const parsed = verifyPaymentSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = parsed.data;

      const gateway = getRazorpayGateway();
      const valid = gateway.verifyPaymentSignature(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
      );

      const outcome = await withTenant(institutionId, async (tx) => {
        const studentId = await ownStudentId(tx, institutionId, userId);
        if (!studentId) return deny("no student profile", 404);

        const transaction = await tx.paymentTransaction.findFirst({
          where: { institutionId, razorpayOrderId: razorpay_order_id, studentId },
          select: { id: true, status: true, razorpayPaymentId: true },
        });
        if (!transaction) return deny("order not found", 404);

        if (!valid) {
          await recordAuditEvent(
            {
              action: "fees.payment.signature_rejected",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "PaymentTransaction",
              resourceId: transaction.id,
              metadata: { razorpayOrderId: razorpay_order_id },
            },
            tx,
          );
          return deny("invalid payment signature", 400);
        }

        // Optimistic: persist the references + CREATED→AUTHORIZED. A webhook that
        // already moved it to CAPTURED wins (forward-only trigger) — do not touch.
        if (transaction.status === "CREATED") {
          await tx.paymentTransaction.update({
            where: { id: transaction.id },
            data: {
              status: "AUTHORIZED",
              ...(transaction.razorpayPaymentId ? {} : { razorpayPaymentId: razorpay_payment_id }),
              razorpaySignature: razorpay_signature,
            },
          });
        }
        await recordAuditEvent(
          {
            action: "fees.payment.signature_verified",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "PaymentTransaction",
            resourceId: transaction.id,
            metadata: { razorpayOrderId: razorpay_order_id },
          },
          tx,
        );
        return { ok: true as const };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send({ ok: true, pending: true });
    },
  );

  // ─── Concessions / scholarships (fees.concession.manage / fees.view) ─────────

  app.post(
    "/concession-definitions",
    { preHandler: [requirePermission("fees.concession.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createConcessionDefinitionSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        let def;
        try {
          def = await tx.concessionDefinition.create({
            data: {
              institutionId,
              name: data.name,
              type: data.type,
              amountPaise: data.amountPaise ?? null,
              percentBps: data.percentBps ?? null,
              scope: data.scope,
              programId: data.programId ?? null,
              academicSessionId: data.academicSessionId ?? null,
              note: data.note ?? null,
              status: data.status ?? "DRAFT",
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { conflict: "a concession definition with this name already exists" as const };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "fees.concession.posted",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ConcessionDefinition",
            resourceId: def.id,
            metadata: { name: def.name, type: def.type, event: "definition_created" },
          },
          tx,
        );
        return { def };
      });

      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.status(201).send(serializeConcessionDefinition(outcome.def));
    },
  );

  app.patch(
    "/concession-definitions/:id",
    { preHandler: [requirePermission("fees.concession.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = patchConcessionDefinitionSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const existing = await tx.concessionDefinition.findFirst({
          where: { id, institutionId },
          select: { id: true },
        });
        if (!existing) return { notFound: true as const };
        let updated;
        try {
          updated = await tx.concessionDefinition.update({
            where: { id: existing.id },
            data: {
              ...(data.name !== undefined ? { name: data.name } : {}),
              ...(data.status !== undefined ? { status: data.status } : {}),
              ...("note" in data ? { note: data.note ?? null } : {}),
              ...("programId" in data ? { programId: data.programId ?? null } : {}),
              ...("academicSessionId" in data ? { academicSessionId: data.academicSessionId ?? null } : {}),
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { conflict: "a concession definition with this name already exists" as const };
          throw err;
        }
        return { def: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "concession definition not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send(serializeConcessionDefinition(outcome.def));
    },
  );

  app.get(
    "/concession-definitions",
    { preHandler: [requirePermission("fees.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const defs = await withTenant(institutionId, (tx) =>
        tx.concessionDefinition.findMany({ where: { institutionId }, orderBy: [{ createdAt: "desc" }] }),
      );
      return reply.send({ definitions: defs.map(serializeConcessionDefinition) });
    },
  );

  app.get(
    "/concession-definitions/:id",
    { preHandler: [requirePermission("fees.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const def = await withTenant(institutionId, (tx) =>
        tx.concessionDefinition.findFirst({ where: { id, institutionId } }),
      );
      if (!def) return reply.status(404).send({ error: "concession definition not found" });
      return reply.send(serializeConcessionDefinition(def));
    },
  );

  app.post(
    "/students/:studentId/concessions",
    { preHandler: [requirePermission("fees.concession.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { studentId } = request.params as { studentId: string };
      const parsed = postConcessionSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const res = await postConcession(tx, {
          institutionId,
          studentId,
          concessionDefinitionId: data.concessionDefinitionId,
          note: data.note ?? null,
          allocations: data.allocations.map((a) => ({ chargeId: a.chargeId, amountPaise: a.amountPaise })),
          actor: actor(request),
        });
        if (!res.ok) {
          await recordAuditEvent(
            {
              action: "fees.concession.posted",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "StudentConcession",
              metadata: { reason: res.error, studentId },
            },
            tx,
          );
          return deny(res.error, res.status);
        }
        return { studentConcessionId: res.studentConcessionId, totalPaise: res.totalPaise };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.status(201).send({
        id: outcome.studentConcessionId,
        totalPaise: money(outcome.totalPaise),
        currency: "INR",
      });
    },
  );

  // ─── Adjustments (fees.adjust + step-up / fees.view) ─────────────────────────

  app.post(
    "/students/:studentId/adjustments",
    {
      preHandler: [
        requirePermission("fees.adjust"),
        requireStepUp("fees.adjust"),
        requireModuleActive(gate),
      ],
    },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { studentId } = request.params as { studentId: string };
      const parsed = createAdjustmentSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const res = await postAdjustment(tx, {
          institutionId,
          studentId,
          chargeId: data.chargeId,
          type: data.type,
          direction: data.direction,
          amountPaise: data.amountPaise,
          reason: data.reason,
          actor: actor(request),
        });
        if (!res.ok) {
          await recordAuditEvent(
            {
              action: "fees.adjustment.posted",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "Adjustment",
              metadata: { reason: res.error, studentId, chargeId: data.chargeId },
            },
            tx,
          );
          return deny(res.error, res.status);
        }
        return { adjustmentId: res.adjustmentId };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.status(201).send({ id: outcome.adjustmentId });
    },
  );

  app.get(
    "/adjustments",
    { preHandler: [requirePermission("fees.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const rows = await withTenant(institutionId, (tx) =>
        tx.adjustment.findMany({ where: { institutionId }, orderBy: [{ postedAt: "desc" }] }),
      );
      return reply.send({ adjustments: rows.map(serializeAdjustment) });
    },
  );

  // ─── Refunds (fees.refund + step-up / fees.view) ─────────────────────────────

  app.post(
    "/payments/:paymentTransactionId/refunds",
    {
      preHandler: [
        requirePermission("fees.refund"),
        requireStepUp("fees.refund"),
        requireModuleActive(gate),
      ],
    },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { paymentTransactionId } = request.params as { paymentTransactionId: string };
      const parsed = createRefundSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      // (1) First tenant tx: advisory lock → validate CAPTURED → net-refundable
      //     under the lock → mint idempotencyKey → INSERT REQUESTED → audit.
      const step1 = await withTenant(institutionId, async (tx) => {
        await acquireRefundLock(tx, paymentTransactionId);

        const txn = await tx.paymentTransaction.findFirst({
          where: { id: paymentTransactionId, institutionId },
          select: { id: true, status: true, studentId: true, razorpayPaymentId: true },
        });
        if (!txn) return deny("transaction not found", 404);
        if (txn.status !== "CAPTURED") {
          await recordAuditEvent(
            {
              action: "fees.refund.requested",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "PaymentTransaction",
              resourceId: txn.id,
              metadata: { reason: "transaction not captured", status: txn.status },
            },
            tx,
          );
          return deny("transaction not captured", 409);
        }
        if (!txn.razorpayPaymentId) {
          await recordAuditEvent(
            {
              action: "fees.refund.requested",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "PaymentTransaction",
              resourceId: txn.id,
              metadata: { reason: "no razorpay payment id" },
            },
            tx,
          );
          return deny("transaction has no captured payment id", 409);
        }

        const nr = await computeNetRefundable(tx, institutionId, paymentTransactionId);
        if (!nr || data.amountPaise > nr.net) {
          await recordAuditEvent(
            {
              action: "fees.refund.requested",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "PaymentTransaction",
              resourceId: txn.id,
              metadata: {
                reason: "amount exceeds net-refundable",
                requested: data.amountPaise.toString(),
                net: (nr?.net ?? 0n).toString(),
              },
            },
            tx,
          );
          return deny("amount exceeds net-refundable", 409);
        }

        const idempotencyKey = cuidLike();
        const refund = await tx.refund.create({
          data: {
            institutionId,
            paymentTransactionId: txn.id,
            studentId: txn.studentId,
            amountPaise: data.amountPaise,
            currency: "INR",
            status: "REQUESTED",
            reason: data.reason,
            idempotencyKey,
            approvedByUserId: request.user.userId,
          },
        });
        await recordAuditEvent(
          {
            action: "fees.refund.requested",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "Refund",
            resourceId: refund.id,
            metadata: { amountPaise: data.amountPaise.toString() },
          },
          tx,
        );
        return {
          refundId: refund.id,
          idempotencyKey,
          razorpayPaymentId: txn.razorpayPaymentId,
        };
      });

      if (isDeny(step1)) return reply.status(step1.status).send({ error: step1.deny });

      // (2) OUTSIDE the tx: call the gateway.
      const gateway = getRazorpayGateway();
      let sdkResult;
      try {
        sdkResult = await gateway.refundPayment(step1.razorpayPaymentId, data.amountPaise, {
          receipt: step1.idempotencyKey,
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
        });
      } catch (err) {
        request.log.error({ err, paymentTransactionId }, "razorpay refund SDK failed");
        await withTenant(institutionId, async (tx) => {
          await tx.refund.update({
            where: { id: step1.refundId },
            data: { status: "FAILED", settledAt: new Date() },
          });
          await recordAuditEvent(
            {
              action: "fees.refund.failed",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "Refund",
              resourceId: step1.refundId,
              metadata: { reason: "gateway error" },
            },
            tx,
          );
        });
        return reply.status(502).send({ error: "refund gateway unavailable" });
      }

      // (3) New tx: persist razorpayRefundId; settle synchronously if processed.
      const final = await withTenant(institutionId, async (tx) => {
        await tx.refund.update({
          where: { id: step1.refundId },
          data: { razorpayRefundId: sdkResult.id },
        });
        if (sdkResult.status === "processed") {
          await settleRefund(tx, { institutionId, refundId: step1.refundId, actor: actor(request) });
        }
        const refund = await tx.refund.findFirst({ where: { id: step1.refundId, institutionId } });
        return { refund };
      });

      return reply.status(201).send(serializeRefund(final.refund!));
    },
  );

  app.get(
    "/refunds",
    { preHandler: [requirePermission("fees.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const rows = await withTenant(institutionId, (tx) =>
        tx.refund.findMany({ where: { institutionId }, orderBy: [{ requestedAt: "desc" }] }),
      );
      return reply.send({ refunds: rows.map(serializeRefund) });
    },
  );

  app.get(
    "/payments/:paymentTransactionId/refunds",
    { preHandler: [requirePermission("fees.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { paymentTransactionId } = request.params as { paymentTransactionId: string };
      const rows = await withTenant(institutionId, (tx) =>
        tx.refund.findMany({
          where: { institutionId, paymentTransactionId },
          orderBy: [{ requestedAt: "desc" }],
        }),
      );
      return reply.send({ refunds: rows.map(serializeRefund) });
    },
  );

  // ─── Financial reports (fees.view; read-only) ────────────────────────────────

  app.get(
    "/reports/collection",
    { preHandler: [requirePermission("fees.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const parsed = collectionReportQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { institutionId } = request.user;
      const report = await withTenant(institutionId, (tx) =>
        buildCollectionReport(tx, institutionId, parsed.data),
      );
      return reply.send(report);
    },
  );

  app.get(
    "/reports/outstanding",
    { preHandler: [requirePermission("fees.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const parsed = outstandingReportQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { institutionId } = request.user;
      const report = await withTenant(institutionId, (tx) =>
        buildOutstandingReport(tx, institutionId, parsed.data.asOf),
      );
      return reply.send(report);
    },
  );

  app.get(
    "/reports/reconciliation",
    { preHandler: [requirePermission("fees.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const parsed = reconciliationReportQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { institutionId } = request.user;
      const report = await withTenant(institutionId, async (tx) => {
        const stuck = await findStuck(tx, institutionId, parsed.data.thresholdMinutes, 1000);
        const byStatus: Record<string, number> = {};
        for (const s of stuck) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
        return {
          thresholdMinutes: parsed.data.thresholdMinutes,
          stuckCount: stuck.length,
          byStatus,
        };
      });
      return reply.send(report);
    },
  );

  app.get(
    "/reports/rollups",
    { preHandler: [requirePermission("fees.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const parsed = rollupReportQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { institutionId } = request.user;
      const report = await withTenant(institutionId, (tx) =>
        buildRollupReport(tx, institutionId, parsed.data.dimension),
      );
      return reply.send(report);
    },
  );

  app.get(
    "/reports/collection/export.xlsx",
    { preHandler: [requirePermission("fees.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const parsed = collectionReportQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { institutionId } = request.user;
      const report = await withTenant(institutionId, (tx) =>
        buildCollectionReport(tx, institutionId, parsed.data),
      );

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Collection");
      sheet.columns = [
        { header: "Group", key: "group", width: 24 },
        { header: "Captured (paise)", key: "captured", width: 20 },
        { header: "Refunded (paise)", key: "refunded", width: 20 },
        { header: "Net (paise)", key: "net", width: 20 },
        { header: "Captured (₹)", key: "capturedRupees", width: 18 },
        { header: "Net (₹)", key: "netRupees", width: 18 },
        { header: "Count", key: "count", width: 10 },
      ];
      for (const row of report.groups) {
        sheet.addRow({
          group: row.key,
          captured: Number(row.capturedPaise),
          refunded: Number(row.refundedPaise),
          net: Number(row.netPaise),
          capturedRupees: paiseToRupeeString(BigInt(row.capturedPaise)),
          netRupees: paiseToRupeeString(BigInt(row.netPaise)),
          count: row.count,
        });
      }
      sheet.getRow(1).font = { bold: true };

      const filename = `collection-${new Date().toISOString().slice(0, 10)}.xlsx`;
      const buffer = await workbook.xlsx.writeBuffer();
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(Buffer.from(buffer));
    },
  );

  app.get(
    "/reports/outstanding/export.xlsx",
    { preHandler: [requirePermission("fees.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = outstandingReportQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const report = await withTenant(institutionId, (tx) =>
        buildOutstandingReport(tx, institutionId, parsed.data.asOf),
      );

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Outstanding");
      sheet.columns = [
        { header: "Student ID", key: "studentId", width: 28 },
        { header: "Outstanding (paise)", key: "outstanding", width: 22 },
        { header: "Outstanding (₹)", key: "outstandingRupees", width: 20 },
        { header: "0-30", key: "b0", width: 14 },
        { header: "31-60", key: "b31", width: 14 },
        { header: "61-90", key: "b61", width: 14 },
        { header: "90+", key: "b90", width: 14 },
      ];
      for (const row of report.students) {
        sheet.addRow({
          studentId: row.studentId,
          outstanding: Number(row.outstandingPaise),
          outstandingRupees: paiseToRupeeString(BigInt(row.outstandingPaise)),
          b0: Number(row.aging["0-30"]),
          b31: Number(row.aging["31-60"]),
          b61: Number(row.aging["61-90"]),
          b90: Number(row.aging["90+"]),
        });
      }
      sheet.getRow(1).font = { bold: true };

      const filename = `outstanding-${new Date().toISOString().slice(0, 10)}.xlsx`;
      const buffer = await workbook.xlsx.writeBuffer();
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(Buffer.from(buffer));
    },
  );

  // ─── Serialization + ledger helpers (money as STRING everywhere) ─────────────

  function serializeStructure(s: {
    id: string;
    institutionId: string;
    name: string;
    status: string;
    programId: string | null;
    academicSessionId: string | null;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      programId: s.programId,
      academicSessionId: s.academicSessionId,
      description: s.description,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  function serializeComponent(c: {
    id: string;
    feeStructureId: string;
    category: string;
    amountPaise: bigint;
    currency: string;
    dueDate: Date | null;
    installmentLabel: string | null;
    installmentNumber: number | null;
  }) {
    return {
      id: c.id,
      feeStructureId: c.feeStructureId,
      category: c.category,
      amountPaise: money(c.amountPaise),
      currency: c.currency,
      dueDate: c.dueDate ? c.dueDate.toISOString() : null,
      installmentLabel: c.installmentLabel,
      installmentNumber: c.installmentNumber,
    };
  }

  function serializeCharge(c: {
    id: string;
    studentId: string;
    category: string;
    amountPaise: bigint;
    currency: string;
    dueDate: Date | null;
    description: string;
    status: string;
    postedAt: Date;
  }) {
    return {
      id: c.id,
      studentId: c.studentId,
      category: c.category,
      amountPaise: money(c.amountPaise),
      currency: c.currency,
      dueDate: c.dueDate ? c.dueDate.toISOString() : null,
      description: c.description,
      status: c.status,
      postedAt: c.postedAt.toISOString(),
    };
  }

  function serializeTransaction(t: {
    id: string;
    studentId: string;
    amountPaise: bigint;
    currency: string;
    status: string;
    razorpayOrderId: string;
    razorpayPaymentId: string | null;
    createdAt: Date;
    capturedAt: Date | null;
  }) {
    return {
      id: t.id,
      studentId: t.studentId,
      amountPaise: money(t.amountPaise),
      currency: t.currency,
      status: t.status,
      razorpayOrderId: t.razorpayOrderId,
      razorpayPaymentId: t.razorpayPaymentId,
      createdAt: t.createdAt.toISOString(),
      capturedAt: t.capturedAt ? t.capturedAt.toISOString() : null,
    };
  }

  function serializeReceipt(r: {
    id: string;
    paymentTransactionId: string;
    receiptNumber: string;
    sequence: number;
    amountPaise: bigint;
    currency: string;
    issuedAt: Date;
  }) {
    return {
      id: r.id,
      paymentTransactionId: r.paymentTransactionId,
      receiptNumber: r.receiptNumber,
      sequence: r.sequence,
      amountPaise: money(r.amountPaise),
      currency: r.currency,
      issuedAt: r.issuedAt.toISOString(),
    };
  }

  // Load a student's ledger: charges (with per-charge allocated + outstanding)
  // and the computed total outstanding. All money strings.
  async function loadLedger(
    tx: Prisma.TransactionClient,
    institutionId: string,
    studentId: string,
  ) {
    const charges = await tx.studentCharge.findMany({
      where: { institutionId, studentId },
      orderBy: [{ dueDate: "asc" }, { postedAt: "asc" }, { id: "asc" }],
      include: {
        allocations: { select: { id: true, amountPaise: true, paymentTransactionId: true } },
        concessionCredits: { select: { amountPaise: true } },
        refundReversals: { select: { amountPaise: true } },
        adjustments: { select: { amountPaise: true, direction: true } },
      },
    });

    let outstandingTotal = 0n;
    const chargeViews = charges.map((c) => {
      const allocated = c.allocations.reduce((acc, a) => acc + a.amountPaise, 0n);
      const concession = c.concessionCredits.reduce((acc, a) => acc + a.amountPaise, 0n);
      const adjCredits = c.adjustments.filter((a) => a.direction === "CREDIT");
      const adjDebits = c.adjustments.filter((a) => a.direction === "DEBIT");
      const adjustmentNet =
        adjDebits.reduce((acc, a) => acc + a.amountPaise, 0n) -
        adjCredits.reduce((acc, a) => acc + a.amountPaise, 0n);
      const refunded = c.refundReversals.reduce((acc, a) => acc + a.amountPaise, 0n);
      // Single source of truth: the slice-7.1 ledger clamp.
      const outstanding = computeChargeOutstanding({
        charge: { amountPaise: c.amountPaise },
        allocations: c.allocations,
        concessionCredits: c.concessionCredits,
        adjustmentCredits: adjCredits,
        adjustmentDebits: adjDebits,
        refundReversals: c.refundReversals,
      });
      outstandingTotal += outstanding;
      return {
        id: c.id,
        studentId: c.studentId,
        category: c.category,
        amountPaise: money(c.amountPaise),
        allocatedPaise: money(allocated),
        concessionPaise: money(concession),
        adjustmentPaise: adjustmentNet.toString(),
        refundedPaise: money(refunded),
        outstandingPaise: money(outstanding),
        currency: c.currency,
        dueDate: c.dueDate ? c.dueDate.toISOString() : null,
        description: c.description,
        status: c.status,
        postedAt: c.postedAt.toISOString(),
        allocations: c.allocations.map((a) => ({
          id: a.id,
          amountPaise: money(a.amountPaise),
          paymentTransactionId: a.paymentTransactionId,
        })),
      };
    });

    return {
      studentId,
      charges: chargeViews,
      outstandingPaise: money(outstandingTotal),
      currency: "INR" as const,
    };
  }

  // ─── Slice 7.1 serializers (money STRING) ────────────────────────────────────

  function serializeConcessionDefinition(d: {
    id: string;
    name: string;
    type: string;
    amountPaise: bigint | null;
    percentBps: number | null;
    scope: string;
    programId: string | null;
    academicSessionId: string | null;
    note: string | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: d.id,
      name: d.name,
      type: d.type,
      amountPaise: d.amountPaise !== null ? money(d.amountPaise) : null,
      percentBps: d.percentBps,
      scope: d.scope,
      programId: d.programId,
      academicSessionId: d.academicSessionId,
      note: d.note,
      status: d.status,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    };
  }

  function serializeAdjustment(a: {
    id: string;
    studentId: string;
    studentChargeId: string;
    type: string;
    direction: string;
    amountPaise: bigint;
    currency: string;
    reason: string;
    postedAt: Date;
  }) {
    return {
      id: a.id,
      studentId: a.studentId,
      studentChargeId: a.studentChargeId,
      type: a.type,
      direction: a.direction,
      amountPaise: money(a.amountPaise),
      currency: a.currency,
      reason: a.reason,
      postedAt: a.postedAt.toISOString(),
    };
  }

  function serializeRefund(r: {
    id: string;
    paymentTransactionId: string;
    studentId: string;
    amountPaise: bigint;
    currency: string;
    status: string;
    reason: string;
    razorpayRefundId: string | null;
    unreversiblePaise: bigint;
    requestedAt: Date;
    settledAt: Date | null;
  }) {
    return {
      id: r.id,
      paymentTransactionId: r.paymentTransactionId,
      studentId: r.studentId,
      amountPaise: money(r.amountPaise),
      currency: r.currency,
      status: r.status,
      reason: r.reason,
      razorpayRefundId: r.razorpayRefundId,
      unreversiblePaise: money(r.unreversiblePaise),
      requestedAt: r.requestedAt.toISOString(),
      settledAt: r.settledAt ? r.settledAt.toISOString() : null,
    };
  }

  // ─── Report builders (single withTenant read tx; money STRING) ───────────────

  async function buildCollectionReport(
    tx: Prisma.TransactionClient,
    institutionId: string,
    q: { from?: string; to?: string; groupBy: "day" | "program" | "session" },
  ) {
    const capturedAtFilter: Prisma.DateTimeNullableFilter = {};
    if (q.from) capturedAtFilter.gte = new Date(q.from);
    if (q.to) capturedAtFilter.lte = new Date(q.to);
    const hasRange = q.from !== undefined || q.to !== undefined;

    const txns = await tx.paymentTransaction.findMany({
      where: {
        institutionId,
        status: "CAPTURED",
        ...(hasRange ? { capturedAt: capturedAtFilter } : {}),
      },
      select: { id: true, amountPaise: true, capturedAt: true, studentId: true },
    });

    // Refunds (PROCESSED) in the same window, keyed by transaction.
    const refunds = await tx.refund.findMany({
      where: { institutionId, status: "PROCESSED" },
      select: { paymentTransactionId: true, amountPaise: true },
    });
    const refundByTxn = new Map<string, bigint>();
    for (const r of refunds) {
      refundByTxn.set(r.paymentTransactionId, (refundByTxn.get(r.paymentTransactionId) ?? 0n) + r.amountPaise);
    }

    // Resolve grouping dimension per transaction.
    const groupKeyOf = async (t: { capturedAt: Date | null; studentId: string }): Promise<string> => {
      if (q.groupBy === "day") {
        return t.capturedAt ? t.capturedAt.toISOString().slice(0, 10) : "unknown";
      }
      const profile = await tx.studentProfile.findFirst({
        where: { id: t.studentId, institutionId },
        select: { programId: true },
      });
      // program / session both roll up to the student's program here (sessions
      // are not directly linked to a payment); session falls back to program.
      return profile?.programId ?? "unassigned";
    };

    const groups = new Map<string, { capturedPaise: bigint; refundedPaise: bigint; count: number }>();
    for (const t of txns) {
      const key = await groupKeyOf(t);
      const g = groups.get(key) ?? { capturedPaise: 0n, refundedPaise: 0n, count: 0 };
      g.capturedPaise += t.amountPaise;
      g.refundedPaise += refundByTxn.get(t.id) ?? 0n;
      g.count += 1;
      groups.set(key, g);
    }

    let totalCaptured = 0n;
    let totalRefunded = 0n;
    const groupRows = [...groups.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([key, g]) => {
        totalCaptured += g.capturedPaise;
        totalRefunded += g.refundedPaise;
        const net = g.capturedPaise - g.refundedPaise;
        return {
          key,
          capturedPaise: g.capturedPaise.toString(),
          refundedPaise: g.refundedPaise.toString(),
          netPaise: (net > 0n ? net : net).toString(),
          count: g.count,
        };
      });

    return {
      groupBy: q.groupBy,
      from: q.from ?? null,
      to: q.to ?? null,
      currency: "INR" as const,
      totals: {
        capturedPaise: totalCaptured.toString(),
        refundedPaise: totalRefunded.toString(),
        netPaise: (totalCaptured - totalRefunded).toString(),
      },
      groups: groupRows,
    };
  }

  async function buildOutstandingReport(
    tx: Prisma.TransactionClient,
    institutionId: string,
    asOf?: string,
  ) {
    const now = asOf ? new Date(asOf) : new Date();
    const charges = await tx.studentCharge.findMany({
      where: { institutionId },
      select: {
        id: true,
        studentId: true,
        amountPaise: true,
        dueDate: true,
        allocations: { select: { amountPaise: true } },
        concessionCredits: { select: { amountPaise: true } },
        refundReversals: { select: { amountPaise: true } },
        adjustments: { select: { amountPaise: true, direction: true } },
      },
    });

    type Bucket = "0-30" | "31-60" | "61-90" | "90+";
    const bucketOf = (dueDate: Date | null): Bucket => {
      if (!dueDate) return "0-30";
      const days = Math.floor((now.getTime() - dueDate.getTime()) / 86_400_000);
      if (days <= 30) return "0-30";
      if (days <= 60) return "31-60";
      if (days <= 90) return "61-90";
      return "90+";
    };

    const perStudent = new Map<
      string,
      { outstanding: bigint; aging: Record<Bucket, bigint> }
    >();
    let grandTotal = 0n;
    const totalAging: Record<Bucket, bigint> = { "0-30": 0n, "31-60": 0n, "61-90": 0n, "90+": 0n };

    for (const c of charges) {
      const adjCredits = c.adjustments.filter((a) => a.direction === "CREDIT");
      const adjDebits = c.adjustments.filter((a) => a.direction === "DEBIT");
      const outstanding = computeChargeOutstanding({
        charge: { amountPaise: c.amountPaise },
        allocations: c.allocations,
        concessionCredits: c.concessionCredits,
        adjustmentCredits: adjCredits,
        adjustmentDebits: adjDebits,
        refundReversals: c.refundReversals,
      });
      if (outstanding <= 0n) continue;
      const bucket = bucketOf(c.dueDate);
      const entry =
        perStudent.get(c.studentId) ??
        { outstanding: 0n, aging: { "0-30": 0n, "31-60": 0n, "61-90": 0n, "90+": 0n } };
      entry.outstanding += outstanding;
      entry.aging[bucket] += outstanding;
      perStudent.set(c.studentId, entry);
      grandTotal += outstanding;
      totalAging[bucket] += outstanding;
    }

    const students = [...perStudent.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([studentId, v]) => ({
        studentId,
        outstandingPaise: v.outstanding.toString(),
        aging: {
          "0-30": v.aging["0-30"].toString(),
          "31-60": v.aging["31-60"].toString(),
          "61-90": v.aging["61-90"].toString(),
          "90+": v.aging["90+"].toString(),
        },
      }));

    return {
      asOf: now.toISOString(),
      currency: "INR" as const,
      totals: {
        outstandingPaise: grandTotal.toString(),
        aging: {
          "0-30": totalAging["0-30"].toString(),
          "31-60": totalAging["31-60"].toString(),
          "61-90": totalAging["61-90"].toString(),
          "90+": totalAging["90+"].toString(),
        },
      },
      students,
    };
  }

  async function buildRollupReport(
    tx: Prisma.TransactionClient,
    institutionId: string,
    dimension: "program" | "session",
  ) {
    // Billed / collected / concession / refund / outstanding per program. Session
    // rolls up to the student's program link (sessions are not directly bound to
    // a charge in slice 1), so the dimension chooses the label only.
    const charges = await tx.studentCharge.findMany({
      where: { institutionId },
      select: {
        studentId: true,
        amountPaise: true,
        allocations: { select: { amountPaise: true } },
        concessionCredits: { select: { amountPaise: true } },
        refundReversals: { select: { amountPaise: true } },
        adjustments: { select: { amountPaise: true, direction: true } },
      },
    });

    // Resolve each student's program once.
    const studentIds = [...new Set(charges.map((c) => c.studentId))];
    const profiles = await tx.studentProfile.findMany({
      where: { id: { in: studentIds }, institutionId },
      select: { id: true, programId: true },
    });
    const programOf = new Map(profiles.map((p) => [p.id, p.programId ?? "unassigned"]));

    const groups = new Map<
      string,
      { billed: bigint; collected: bigint; concession: bigint; refunded: bigint; outstanding: bigint }
    >();

    for (const c of charges) {
      const key = programOf.get(c.studentId) ?? "unassigned";
      const collected = c.allocations.reduce((a, x) => a + x.amountPaise, 0n);
      const concession = c.concessionCredits.reduce((a, x) => a + x.amountPaise, 0n);
      const refunded = c.refundReversals.reduce((a, x) => a + x.amountPaise, 0n);
      const adjCredits = c.adjustments.filter((a) => a.direction === "CREDIT");
      const adjDebits = c.adjustments.filter((a) => a.direction === "DEBIT");
      const outstanding = computeChargeOutstanding({
        charge: { amountPaise: c.amountPaise },
        allocations: c.allocations,
        concessionCredits: c.concessionCredits,
        adjustmentCredits: adjCredits,
        adjustmentDebits: adjDebits,
        refundReversals: c.refundReversals,
      });
      const g =
        groups.get(key) ??
        { billed: 0n, collected: 0n, concession: 0n, refunded: 0n, outstanding: 0n };
      g.billed += c.amountPaise;
      g.collected += collected;
      g.concession += concession;
      g.refunded += refunded;
      g.outstanding += outstanding;
      groups.set(key, g);
    }

    const rows = [...groups.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([key, g]) => ({
        key,
        billedPaise: g.billed.toString(),
        collectedPaise: g.collected.toString(),
        concessionPaise: g.concession.toString(),
        refundedPaise: g.refunded.toString(),
        outstandingPaise: g.outstanding.toString(),
      }));

    return { dimension, currency: "INR" as const, rows };
  }
}

/** Format integer paise as a plain "₹x.yy" string (Excel human column). */
function paiseToRupeeString(paise: bigint): string {
  const neg = paise < 0n;
  const abs = neg ? -paise : paise;
  const rupees = abs / 100n;
  const cents = abs % 100n;
  return `${neg ? "-" : ""}₹${rupees.toString()}.${cents.toString().padStart(2, "0")}`;
}

/** A collision-resistant server-minted key (idempotencyKey). */
function cuidLike(): string {
  return `rfnd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}
