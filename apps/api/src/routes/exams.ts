import type { FastifyInstance, FastifyRequest } from "fastify";
import ExcelJS from "exceljs";
import { withTenant, Prisma } from "@campusgate/db";
import {
  createExaminationSchema,
  patchExaminationSchema,
  advanceExamStatusSchema,
  createExamScheduleSchema,
  allocateCandidatesSchema,
  registerCandidatesSchema,
  createAssessmentSchema,
  patchAssessmentSchema,
  putMarksSchema,
  correctMarkSchema,
  createGradingSchemeSchema,
  patchGradingSchemeSchema,
  createReevalRequestSchema,
  transitionReevalSchema,
  remarkReevalSchema,
  listReevalQuerySchema,
  registerSupplementaryCandidatesSchema,
} from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission, requireModuleActive } from "../services/authz-engine.js";
import { requireStepUp } from "../middleware/step-up.js";
import { recordAuditEvent } from "../services/audit.js";
import {
  resolveMarkingFaculty,
  assertFacultyAssigned,
} from "../services/attendance-authz.js";
import {
  reevalTransitionLegal,
  assertSupplementaryLinkage,
  computeSupplementaryEligible,
} from "../services/exams/reeval.js";
import {
  gradeSubject,
  GradingError,
  type GradingAssessment,
  type GradingBand,
  type GradingMark,
} from "../services/exams/grading.js";

// The module registry key is `examinations`; the permission/audit prefix is
// `exams.*`. Every route carries requireModuleActive("examinations") IN ADDITION
// to requirePermission(...). The forward-only exam status machine is DB-enforced
// by the examinations_guard column-guard trigger; the service advances it with
// an optimistic where:{status:from} and maps the trigger's restrict_violation
// backstop to a 409.
const MODULE_KEY = "examinations" as const;

// Legal forward-only transition table (mirrors the examinations_guard trigger).
const LEGAL_TRANSITIONS: Record<string, string> = {
  DRAFT: "SCHEDULED",
  SCHEDULED: "MARKS_OPEN",
  MARKS_OPEN: "MARKS_LOCKED",
  MARKS_LOCKED: "MODERATION",
  MODERATION: "APPROVED",
  APPROVED: "PUBLISHED",
};

// Which permission a given status transition requires. Setup steps up to
// scheduling are `exams.manage`; locking/moderation/approval are `exams.moderate`.
// PUBLISHED is reached only via the step-up-gated publish route, never here.
const TRANSITION_PERMISSION: Record<string, "exams.manage" | "exams.moderate"> = {
  SCHEDULED: "exams.manage",
  MARKS_OPEN: "exams.manage",
  MARKS_LOCKED: "exams.moderate",
  MODERATION: "exams.moderate",
  APPROVED: "exams.moderate",
};

/**
 * Examinations operational routes (design §15), registered at `/api/exams`
 * (see server.ts). `examinations` is a GATED module — every route carries
 * `requireModuleActive("examinations")` IN ADDITION to `requirePermission(...)`.
 *
 * House pattern (mirrors fees.ts / library.ts):
 *  - a single top-level `authenticate` preHandler;
 *  - per-route `requirePermission(key)` AND `requireModuleActive("examinations")`;
 *  - publish adds `requireStepUp("exams.results.publish")` in the exact
 *    fees-refund ordering [requirePermission, requireStepUp, requireModuleActive];
 *  - every handler runs inside `withTenant(institutionId, tx => ...)` with
 *    `institutionId` from the verified token (`request.user`), never from input;
 *  - every mutation writes an `exams.*` AuditEvent via `recordAuditEvent` in the
 *    SAME transaction; deny branches record a DENIED audit then RETURN the 4xx
 *    from a normally-returning `withTenant` callback (never `throw`);
 *  - Zod validates every external input; JSON is deterministic and well-typed.
 */
export async function examsRoutes(app: FastifyInstance) {
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

  function isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
  }
  function isRestrictViolation(err: unknown): boolean {
    // Postgres restrict_violation (23001) surfaces as a raw query error through
    // Prisma; the message carries the trigger text. The column guards raise it.
    const msg = String((err as Error)?.message ?? err);
    return msg.includes("restrict_violation") || msg.includes("illegal") || msg.includes("append-only");
  }

  // Advisory xact lock on a tenant-qualified key (the library lockStudent idiom).
  async function advisoryLock(tx: Prisma.TransactionClient, key: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }

  // Optimistic forward-only status advance; relies on the examinations_guard
  // trigger as the hard backstop. Returns the count of rows updated.
  async function advanceExamStatus(
    tx: Prisma.TransactionClient,
    institutionId: string,
    examId: string,
    from: string,
    to: string,
  ): Promise<number> {
    const res = await tx.examination.updateMany({
      where: { id: examId, institutionId, status: from as never },
      data: { status: to as never },
    });
    return res.count;
  }

  function serializeExam(e: {
    id: string;
    academicSessionId: string;
    academicTermId: string;
    programId: string;
    name: string;
    type: string;
    status: string;
    createdByUserId: string;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: e.id,
      academicSessionId: e.academicSessionId,
      academicTermId: e.academicTermId,
      programId: e.programId,
      name: e.name,
      type: e.type,
      status: e.status,
      createdByUserId: e.createdByUserId,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    };
  }

  // ─── Examination setup (exams.manage / exams.results.view) ──────────────────

  app.post(
    "/",
    { preHandler: [requirePermission("exams.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createExaminationSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        // Validate same-tenant parents for a clean message (the composite FK is
        // the hard backstop).
        const [session, term, program] = await Promise.all([
          tx.academicSession.findFirst({ where: { id: data.academicSessionId, institutionId }, select: { id: true } }),
          tx.academicTerm.findFirst({ where: { id: data.academicTermId, institutionId }, select: { id: true } }),
          tx.program.findFirst({ where: { id: data.programId, institutionId }, select: { id: true } }),
        ]);
        if (!session) return deny("academic session not found", 404);
        if (!term) return deny("academic term not found", 404);
        if (!program) return deny("program not found", 404);

        // Slice 8.2: SUPPLEMENTARY ⇔ parentExaminationId pairing + same-tenant
        // parent existence (service-owned; the composite FK is the hard backstop).
        const linkage = await assertSupplementaryLinkage(tx, institutionId, {
          type: data.type,
          parentExaminationId: data.parentExaminationId,
        });
        if (linkage) {
          await recordAuditEvent(
            {
              action: "exams.examination.created",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "Examination",
              resourceId: data.parentExaminationId ?? "",
              metadata: { reason: linkage.message, type: data.type },
            },
            tx,
          );
          return deny(linkage.message, 400);
        }

        const exam = await tx.examination.create({
          data: {
            institutionId,
            academicSessionId: data.academicSessionId,
            academicTermId: data.academicTermId,
            programId: data.programId,
            name: data.name,
            type: data.type,
            status: "DRAFT",
            createdByUserId: request.user.userId,
            parentExaminationId: data.parentExaminationId ?? null,
          },
        });
        await recordAuditEvent(
          {
            action: "exams.examination.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "Examination",
            resourceId: exam.id,
            metadata: { type: exam.type },
          },
          tx,
        );
        return { exam };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.status(201).send(serializeExam(outcome.exam));
    },
  );

  app.patch(
    "/:id",
    { preHandler: [requirePermission("exams.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = patchExaminationSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const existing = await tx.examination.findFirst({ where: { id, institutionId } });
        if (!existing) return deny("examination not found", 404);
        const updated = await tx.examination.update({
          where: { id },
          data: { ...(data.name !== undefined ? { name: data.name } : {}) },
        });
        await recordAuditEvent(
          {
            action: "exams.examination.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "Examination",
            resourceId: id,
          },
          tx,
        );
        return { updated };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send(serializeExam(outcome.updated));
    },
  );

  app.get(
    "/",
    { preHandler: [requirePermission("exams.results.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const rows = await withTenant(institutionId, (tx) =>
        tx.examination.findMany({ where: { institutionId }, orderBy: [{ createdAt: "desc" }] }),
      );
      return reply.send({ examinations: rows.map(serializeExam) });
    },
  );

  app.get(
    "/:id",
    { preHandler: [requirePermission("exams.results.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const exam = await withTenant(institutionId, (tx) =>
        tx.examination.findFirst({ where: { id, institutionId } }),
      );
      if (!exam) return reply.status(404).send({ error: "examination not found" });
      return reply.send(serializeExam(exam));
    },
  );

  // ─── Status advance (exams.manage ≤ scheduling; exams.moderate for the rest) ─
  // The permission is checked INSIDE the handler because it depends on the target
  // status; a top-level preHandler cannot know `to` before the body is parsed.
  app.post(
    "/:id/status",
    { preHandler: [requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = advanceExamStatusSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { to } = parsed.data;

      const neededPerm = TRANSITION_PERMISSION[to];
      // PUBLISHED is not reachable via this route (publish is step-up-gated).
      if (!neededPerm) {
        return reply.status(400).send({ error: "unsupported status transition target" });
      }
      if (!request.auth || !request.auth.permissions.includes(neededPerm)) {
        return reply.status(403).send({ error: `Forbidden: missing permission ${neededPerm}` });
      }

      const outcome = await withTenant(institutionId, async (tx) => {
        const exam = await tx.examination.findFirst({ where: { id, institutionId }, select: { status: true } });
        if (!exam) return deny("examination not found", 404);
        if (LEGAL_TRANSITIONS[exam.status] !== to) {
          return deny("illegal status transition", 409);
        }
        try {
          const n = await advanceExamStatus(tx, institutionId, id, exam.status, to);
          if (n === 0) return deny("illegal status transition", 409);
        } catch (err) {
          if (isRestrictViolation(err)) return deny("illegal status transition", 409);
          throw err;
        }
        await recordAuditEvent(
          {
            action: "exams.examination.status_changed",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "Examination",
            resourceId: id,
            metadata: { from: exam.status, to },
          },
          tx,
        );
        return { from: exam.status, to };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send({ id, status: outcome.to });
    },
  );

  // ─── Schedules (exams.manage / exams.results.view) ──────────────────────────

  app.post(
    "/:id/schedules",
    { preHandler: [requirePermission("exams.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: examId } = request.params as { id: string };
      const parsed = createExamScheduleSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const exam = await tx.examination.findFirst({ where: { id: examId, institutionId }, select: { id: true } });
        if (!exam) return deny("examination not found", 404);
        const subject = await tx.subject.findFirst({ where: { id: data.subjectId, institutionId }, select: { id: true } });
        if (!subject) return deny("subject not found", 404);

        let schedule;
        try {
          schedule = await tx.examSchedule.create({
            data: {
              institutionId,
              examId,
              subjectId: data.subjectId,
              room: data.room,
              roomCapacity: data.roomCapacity,
              startsAt: new Date(data.startsAt),
              endsAt: new Date(data.endsAt),
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return deny("a schedule for this exam+subject already exists", 409);
          throw err;
        }
        await recordAuditEvent(
          {
            action: "exams.schedule.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ExamSchedule",
            resourceId: schedule.id,
          },
          tx,
        );
        return { schedule };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.status(201).send(outcome.schedule);
    },
  );

  app.get(
    "/:id/schedules",
    { preHandler: [requirePermission("exams.results.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: examId } = request.params as { id: string };
      const rows = await withTenant(institutionId, (tx) =>
        tx.examSchedule.findMany({ where: { institutionId, examId }, orderBy: [{ startsAt: "asc" }] }),
      );
      return reply.send({ schedules: rows });
    },
  );

  // ─── Capacity-aware room allocation (exams.candidates.manage, §13) ──────────

  app.post(
    "/:id/schedules/:scheduleId/allocate",
    { preHandler: [requirePermission("exams.candidates.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: examId, scheduleId } = request.params as { id: string; scheduleId: string };
      const parsed = allocateCandidatesSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { candidateIds } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const schedule = await tx.examSchedule.findFirst({
          where: { id: scheduleId, institutionId, examId },
          select: { id: true, roomCapacity: true },
        });
        if (!schedule) return deny("schedule not found", 404);

        // Serialize concurrent allocations into this room (the library idiom).
        await advisoryLock(tx, `examalloc:${institutionId}:${scheduleId}`);

        // Load the requested candidates; all must belong to this exam + tenant.
        const candidates = await tx.candidate.findMany({
          where: { id: { in: candidateIds }, institutionId, examId },
          select: { id: true, examScheduleId: true },
        });
        if (candidates.length !== candidateIds.length) {
          return deny("one or more candidates not found for this exam", 404);
        }
        // Already on a DIFFERENT schedule ⇒ 409 (re-allocation is out of 8.1 scope).
        for (const c of candidates) {
          if (c.examScheduleId && c.examScheduleId !== scheduleId) {
            return deny("candidate already allocated to another schedule", 409);
          }
        }
        // Already on THIS schedule ⇒ no-op (idempotent re-send); only NEW ones count.
        const toAllocate = candidates.filter((c) => c.examScheduleId !== scheduleId);

        const occupied = await tx.candidate.count({
          where: { institutionId, examScheduleId: scheduleId },
        });
        if (occupied + toAllocate.length > schedule.roomCapacity) {
          await recordAuditEvent(
            {
              action: "exams.candidate.allocated",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "ExamSchedule",
              resourceId: scheduleId,
              metadata: { reason: "room full", occupied, requested: toAllocate.length, capacity: schedule.roomCapacity },
            },
            tx,
          );
          return deny("room full", 409);
        }

        // Assign contiguous integer-ordinal seats under the lock (gap-free since
        // 8.1 allocation is purely additive — no de-allocation). seatNo = the
        // decimal string of the integer ordinal (never a lexical MAX(seatNo)+1).
        let nextOrdinal = occupied;
        for (const c of toAllocate) {
          nextOrdinal += 1;
          try {
            await tx.candidate.update({
              where: { id: c.id },
              data: { examScheduleId: scheduleId, seatNo: String(nextOrdinal) },
            });
          } catch (err) {
            if (isUniqueViolation(err)) return deny("seat taken", 409);
            throw err;
          }
        }
        await recordAuditEvent(
          {
            action: "exams.candidate.allocated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ExamSchedule",
            resourceId: scheduleId,
            metadata: { allocated: toAllocate.length, occupied: occupied + toAllocate.length },
          },
          tx,
        );
        return { allocated: toAllocate.length, occupied: occupied + toAllocate.length };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send(outcome);
    },
  );

  // ─── Candidates (exams.candidates.manage / exams.results.view) ──────────────

  app.post(
    "/:id/candidates",
    { preHandler: [requirePermission("exams.candidates.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: examId } = request.params as { id: string };
      const parsed = registerCandidatesSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { studentIds } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const exam = await tx.examination.findFirst({ where: { id: examId, institutionId }, select: { id: true } });
        if (!exam) return deny("examination not found", 404);

        // All students must belong to this tenant (composite FK is the backstop).
        const students = await tx.studentProfile.findMany({
          where: { id: { in: studentIds }, institutionId },
          select: { id: true },
        });
        if (students.length !== studentIds.length) {
          return deny("one or more students not found", 404);
        }

        const created: string[] = [];
        for (const studentId of studentIds) {
          try {
            const c = await tx.candidate.create({
              data: { institutionId, examId, studentId },
            });
            created.push(c.id);
            await recordAuditEvent(
              {
                action: "exams.candidate.registered",
                result: "SUCCESS",
                ...actor(request),
                institutionId,
                resourceType: "Candidate",
                resourceId: c.id,
              },
              tx,
            );
          } catch (err) {
            if (isUniqueViolation(err)) continue; // already a candidate ⇒ idempotent skip
            throw err;
          }
        }
        return { created };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.status(201).send({ registered: outcome.created.length, candidateIds: outcome.created });
    },
  );

  app.get(
    "/:id/candidates",
    { preHandler: [requirePermission("exams.results.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: examId } = request.params as { id: string };
      const rows = await withTenant(institutionId, (tx) =>
        tx.candidate.findMany({ where: { institutionId, examId }, orderBy: [{ createdAt: "asc" }] }),
      );
      return reply.send({ candidates: rows });
    },
  );

  // ─── Assessments (exams.manage; weight-sum=100 service invariant) ───────────

  app.post(
    "/:id/assessments",
    { preHandler: [requirePermission("exams.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: examId } = request.params as { id: string };
      const parsed = createAssessmentSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const exam = await tx.examination.findFirst({ where: { id: examId, institutionId }, select: { id: true } });
        if (!exam) return deny("examination not found", 404);
        const subject = await tx.subject.findFirst({ where: { id: data.subjectId, institutionId }, select: { id: true } });
        if (!subject) return deny("subject not found", 404);

        // Weight-sum=100 invariant (multi-row, service-owned): the ACTIVE set for
        // this (exam, subject) plus the new component must equal exactly 100.
        const existing = await tx.assessment.findMany({
          where: { institutionId, examId, subjectId: data.subjectId },
          select: { weight: true },
        });
        const sum = existing.reduce((acc, a) => acc + a.weight, 0) + data.weight;
        if (sum > 100) {
          return deny("weights must sum to 100", 400);
        }

        let assessment;
        try {
          assessment = await tx.assessment.create({
            data: {
              institutionId,
              examId,
              subjectId: data.subjectId,
              name: data.name,
              maxMarks: data.maxMarks,
              weight: data.weight,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return deny("an assessment with this name already exists for this subject", 409);
          throw err;
        }
        await recordAuditEvent(
          {
            action: "exams.assessment.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "Assessment",
            resourceId: assessment.id,
          },
          tx,
        );
        return { assessment };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.status(201).send(outcome.assessment);
    },
  );

  app.patch(
    "/:id/assessments/:assessmentId",
    { preHandler: [requirePermission("exams.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { assessmentId } = request.params as { id: string; assessmentId: string };
      const parsed = patchAssessmentSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const existing = await tx.assessment.findFirst({
          where: { id: assessmentId, institutionId },
          select: { id: true, examId: true, subjectId: true, weight: true },
        });
        if (!existing) return deny("assessment not found", 404);

        if (data.weight !== undefined) {
          const siblings = await tx.assessment.findMany({
            where: { institutionId, examId: existing.examId, subjectId: existing.subjectId, id: { not: assessmentId } },
            select: { weight: true },
          });
          const sum = siblings.reduce((acc, a) => acc + a.weight, 0) + data.weight;
          if (sum > 100) return deny("weights must sum to 100", 400);
        }

        const updated = await tx.assessment.update({
          where: { id: assessmentId },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.maxMarks !== undefined ? { maxMarks: data.maxMarks } : {}),
            ...(data.weight !== undefined ? { weight: data.weight } : {}),
          },
        });
        await recordAuditEvent(
          {
            action: "exams.assessment.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "Assessment",
            resourceId: assessmentId,
          },
          tx,
        );
        return { updated };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send(outcome.updated);
    },
  );

  app.get(
    "/:id/assessments",
    { preHandler: [requirePermission("exams.results.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: examId } = request.params as { id: string };
      const rows = await withTenant(institutionId, (tx) =>
        tx.assessment.findMany({ where: { institutionId, examId }, orderBy: [{ createdAt: "asc" }] }),
      );
      return reply.send({ assessments: rows });
    },
  );

  // ─── Scoped marks entry (exams.marks.enter, FACULTY, §12) ───────────────────
  // Accepted ONLY while MARKS_OPEN. First write of a record ⇒ entered/MARKED;
  // later edit ⇒ corrected/CORRECTED. FacultyAssignment scope reused verbatim
  // from attendance-authz.ts; an out-of-scope or deactivated-faculty write ⇒
  // DENIED audit + 403.
  app.put(
    "/:id/marks",
    { preHandler: [requirePermission("exams.marks.enter"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const { id: examId } = request.params as { id: string };
      const parsed = putMarksSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { marks } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const exam = await tx.examination.findFirst({
          where: { id: examId, institutionId },
          select: { id: true, status: true, academicTermId: true },
        });
        if (!exam) return deny("examination not found", 404);
        if (exam.status !== "MARKS_OPEN") return deny("marks locked", 409);

        // Step 1: resolve the caller's ACTIVE FacultyProfile (the deactivation
        // gate — a deactivated teacher with a stale ACTIVE assignment is rejected).
        const marking = await resolveMarkingFaculty(tx, institutionId, userId);
        if (!marking) {
          await recordAuditEvent(
            {
              action: "exams.marks.entered",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "Examination",
              resourceId: examId,
              metadata: { reason: "not_faculty" },
            },
            tx,
          );
          return deny("not a faculty member", 403);
        }

        const results: Array<{ marksRecordId: string; changeType: "MARKED" | "CORRECTED" }> = [];
        for (const row of marks) {
          const assessment = await tx.assessment.findFirst({
            where: { id: row.assessmentId, institutionId, examId },
            select: { id: true, subjectId: true, maxMarks: true },
          });
          if (!assessment) return deny("assessment not found for this exam", 404);

          const candidate = await tx.candidate.findFirst({
            where: { id: row.candidateId, institutionId, examId },
            select: { id: true, studentId: true },
          });
          if (!candidate) return deny("candidate not found for this exam", 404);

          if (row.marks < 0 || row.marks > assessment.maxMarks) {
            return deny("marks out of range", 400);
          }

          // Step 2: FacultyAssignment scope. Resolve the candidate's section(s)
          // for the exam's term via ClassEnrollment -> ClassSection WHERE
          // ClassSection.academicTermId = exam.academicTermId (ClassEnrollment has
          // no term column). Pass if the faculty is assigned to ANY of them (or
          // holds a subject-wide assignment with classSectionId IS NULL).
          const enrollments = await tx.classEnrollment.findMany({
            where: {
              institutionId,
              studentId: candidate.studentId,
              classSection: { academicTermId: exam.academicTermId },
            },
            select: { classSectionId: true },
          });
          const sectionIds = enrollments.map((e) => e.classSectionId);
          // Try each candidate section; the facultyId:"" sentinel forces the
          // general (non-ScheduledClass) assignment path in the helper.
          let allowed = false;
          if (sectionIds.length === 0) {
            // No section for the term: only a subject-wide assignment can authorize.
            allowed = await assertFacultyAssigned(tx, institutionId, marking.facultyId, {
              classSectionId: "__none__",
              subjectId: assessment.subjectId,
              academicTermId: exam.academicTermId,
              facultyId: "",
            });
          } else {
            for (const classSectionId of sectionIds) {
              if (
                await assertFacultyAssigned(tx, institutionId, marking.facultyId, {
                  classSectionId,
                  subjectId: assessment.subjectId,
                  academicTermId: exam.academicTermId,
                  facultyId: "",
                })
              ) {
                allowed = true;
                break;
              }
            }
          }
          if (!allowed) {
            await recordAuditEvent(
              {
                action: "exams.marks.entered",
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "Assessment",
                resourceId: assessment.id,
                metadata: { reason: "out_of_scope", subjectId: assessment.subjectId, candidateId: candidate.id },
              },
              tx,
            );
            return deny("out of scope for this subject/section", 403);
          }

          // First write vs later edit: by whether a row exists for the hard
          // (assessmentId, candidateId) key.
          const prior = await tx.marksRecord.findFirst({
            where: { assessmentId: assessment.id, candidateId: candidate.id, institutionId },
            select: { id: true, marks: true },
          });

          if (!prior) {
            const rec = await tx.marksRecord.create({
              data: {
                institutionId,
                examId,
                assessmentId: assessment.id,
                candidateId: candidate.id,
                studentId: candidate.studentId,
                marks: row.marks,
                enteredByUserId: userId,
              },
            });
            await tx.marksRecordHistory.create({
              data: {
                institutionId,
                marksRecordId: rec.id,
                changeType: "MARKED",
                previousMarks: null,
                newMarks: row.marks,
                actorUserId: userId,
                actorMembershipId: request.auth?.membershipId ?? null,
              },
            });
            await recordAuditEvent(
              {
                action: "exams.marks.entered",
                result: "SUCCESS",
                ...actor(request),
                institutionId,
                resourceType: "MarksRecord",
                resourceId: rec.id,
              },
              tx,
            );
            results.push({ marksRecordId: rec.id, changeType: "MARKED" });
          } else {
            await tx.marksRecord.update({
              where: { id: prior.id },
              data: { marks: row.marks, enteredByUserId: userId },
            });
            await tx.marksRecordHistory.create({
              data: {
                institutionId,
                marksRecordId: prior.id,
                changeType: "CORRECTED",
                previousMarks: prior.marks,
                newMarks: row.marks,
                actorUserId: userId,
                actorMembershipId: request.auth?.membershipId ?? null,
              },
            });
            await recordAuditEvent(
              {
                action: "exams.marks.corrected",
                result: "SUCCESS",
                ...actor(request),
                institutionId,
                resourceType: "MarksRecord",
                resourceId: prior.id,
              },
              tx,
            );
            results.push({ marksRecordId: prior.id, changeType: "CORRECTED" });
          }
        }
        return { results };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send({ written: outcome.results.length, records: outcome.results });
    },
  );

  app.get(
    "/:id/marks",
    { preHandler: [requirePermission("exams.results.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: examId } = request.params as { id: string };
      const rows = await withTenant(institutionId, (tx) =>
        tx.marksRecord.findMany({ where: { institutionId, examId }, orderBy: [{ createdAt: "asc" }] }),
      );
      return reply.send({ marks: rows });
    },
  );

  // ─── Moderation correction (exams.moderate, ADMIN/HOD, §12) ─────────────────
  // Accepted ONLY while MODERATION; reason required; audited CORRECTED + history.
  app.post(
    "/:id/marks/:recordId/correct",
    { preHandler: [requirePermission("exams.moderate"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const { id: examId, recordId } = request.params as { id: string; recordId: string };
      const parsed = correctMarkSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { marks: newMarks, reason } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const exam = await tx.examination.findFirst({
          where: { id: examId, institutionId },
          select: { id: true, status: true },
        });
        if (!exam) return deny("examination not found", 404);
        if (exam.status !== "MODERATION") return deny("marks locked", 409);

        const rec = await tx.marksRecord.findFirst({
          where: { id: recordId, institutionId, examId },
          select: { id: true, marks: true, assessmentId: true },
        });
        if (!rec) return deny("marks record not found", 404);

        const assessment = await tx.assessment.findFirst({
          where: { id: rec.assessmentId, institutionId },
          select: { maxMarks: true },
        });
        if (!assessment) return deny("assessment not found", 404);
        if (newMarks < 0 || newMarks > assessment.maxMarks) return deny("marks out of range", 400);

        await tx.marksRecord.update({
          where: { id: rec.id },
          data: { marks: newMarks, enteredByUserId: userId },
        });
        await tx.marksRecordHistory.create({
          data: {
            institutionId,
            marksRecordId: rec.id,
            changeType: "CORRECTED",
            previousMarks: rec.marks,
            newMarks,
            actorUserId: userId,
            actorMembershipId: request.auth?.membershipId ?? null,
            reason,
          },
        });
        await recordAuditEvent(
          {
            action: "exams.marks.corrected",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "MarksRecord",
            resourceId: rec.id,
            metadata: { reason },
          },
          tx,
        );
        return { marksRecordId: rec.id };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send({ marksRecordId: outcome.marksRecordId });
    },
  );

  // ─── Grading schemes + bands (exams.grading.manage / exams.results.view) ────

  app.post(
    "/grading-schemes",
    { preHandler: [requirePermission("exams.grading.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createGradingSchemeSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const bandError = validateBands(data.bands);
      if (bandError) return reply.status(400).send({ error: bandError });

      const outcome = await withTenant(institutionId, async (tx) => {
        if (data.isActive) {
          // Only one ACTIVE scheme at a time: deactivate the others.
          await tx.gradingScheme.updateMany({
            where: { institutionId, isActive: true },
            data: { isActive: false },
          });
        }
        let scheme;
        try {
          scheme = await tx.gradingScheme.create({
            data: {
              institutionId,
              name: data.name,
              isActive: data.isActive ?? false,
              createdByUserId: request.user.userId,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return deny("a grading scheme with this name already exists", 409);
          throw err;
        }
        for (let i = 0; i < data.bands.length; i++) {
          const b = data.bands[i];
          await tx.gradeBand.create({
            data: {
              institutionId,
              gradingSchemeId: scheme.id,
              minPercentBps: b.minPercentBps,
              maxPercentBps: b.maxPercentBps,
              gradeLabel: b.gradeLabel,
              gradePoints: b.gradePoints,
              isPassing: b.isPassing,
              ordinal: i,
            },
          });
        }
        await recordAuditEvent(
          {
            action: "exams.grading_scheme.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "GradingScheme",
            resourceId: scheme.id,
          },
          tx,
        );
        return { scheme };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.status(201).send(outcome.scheme);
    },
  );

  app.patch(
    "/grading-schemes/:id",
    { preHandler: [requirePermission("exams.grading.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = patchGradingSchemeSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      if (data.bands) {
        const bandError = validateBands(data.bands);
        if (bandError) return reply.status(400).send({ error: bandError });
      }

      const outcome = await withTenant(institutionId, async (tx) => {
        const existing = await tx.gradingScheme.findFirst({ where: { id, institutionId }, select: { id: true } });
        if (!existing) return deny("grading scheme not found", 404);

        if (data.isActive === true) {
          await tx.gradingScheme.updateMany({
            where: { institutionId, isActive: true, id: { not: id } },
            data: { isActive: false },
          });
        }
        await tx.gradingScheme.update({
          where: { id },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          },
        });

        if (data.bands) {
          // Replace the band set wholesale (schemes are mutable until used).
          await tx.gradeBand.deleteMany({ where: { institutionId, gradingSchemeId: id } });
          for (let i = 0; i < data.bands.length; i++) {
            const b = data.bands[i];
            await tx.gradeBand.create({
              data: {
                institutionId,
                gradingSchemeId: id,
                minPercentBps: b.minPercentBps,
                maxPercentBps: b.maxPercentBps,
                gradeLabel: b.gradeLabel,
                gradePoints: b.gradePoints,
                isPassing: b.isPassing,
                ordinal: i,
              },
            });
          }
        }
        await recordAuditEvent(
          {
            action: "exams.grading_scheme.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "GradingScheme",
            resourceId: id,
          },
          tx,
        );
        return { id };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send({ id: outcome.id });
    },
  );

  app.get(
    "/grading-schemes",
    { preHandler: [requirePermission("exams.results.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const rows = await withTenant(institutionId, (tx) =>
        tx.gradingScheme.findMany({
          where: { institutionId },
          orderBy: [{ createdAt: "desc" }],
          include: { bands: { orderBy: { ordinal: "asc" } } },
        }),
      );
      return reply.send({ gradingSchemes: rows });
    },
  );

  // ─── Controlled publication (exams.results.publish + step-up, §9/§10) ───────
  // The exact fees-refund preHandler ordering: permission → step-up → module.
  app.post(
    "/:id/publish",
    {
      preHandler: [
        requirePermission("exams.results.publish"),
        requireStepUp("exams.results.publish"),
        requireModuleActive(gate),
      ],
    },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: examId } = request.params as { id: string };
      const reason =
        typeof (request.body as { reason?: unknown } | null)?.reason === "string"
          ? (request.body as { reason: string }).reason
          : undefined;

      const outcome = await withTenant(institutionId, async (tx) => {
        await advisoryLock(tx, `exampub:${institutionId}:${examId}`);

        const exam = await tx.examination.findFirst({
          where: { id: examId, institutionId },
          select: { id: true, status: true },
        });
        if (!exam) return deny("examination not found", 404);
        if (exam.status !== "APPROVED" && exam.status !== "PUBLISHED") {
          return deny("exam not approved", 409);
        }

        const scheme = await tx.gradingScheme.findFirst({
          where: { institutionId, isActive: true },
          select: { id: true },
        });
        if (!scheme) return deny("no active grading scheme", 409);

        const bandRows = await tx.gradeBand.findMany({
          where: { institutionId, gradingSchemeId: scheme.id },
          orderBy: { ordinal: "asc" },
        });
        const bands: GradingBand[] = bandRows.map((b) => ({
          minPercentBps: b.minPercentBps,
          maxPercentBps: b.maxPercentBps,
          gradeLabel: b.gradeLabel,
          gradePoints: b.gradePoints,
          isPassing: b.isPassing,
        }));

        // Next version for the scope.
        const latest = await tx.resultPublication.findFirst({
          where: { institutionId, examId },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        const nextVersion = (latest?.version ?? 0) + 1;
        if (nextVersion > 1 && (reason === undefined || reason.length === 0)) {
          return deny("reason required for a re-publication", 400);
        }

        // Create the publication header first (its id anchors the snapshots).
        const publication = await tx.resultPublication.create({
          data: {
            institutionId,
            examId,
            version: nextVersion,
            status: "PUBLISHED",
            gradingSchemeId: scheme.id,
            publishedByUserId: request.user.userId,
            reason: reason ?? null,
          },
        });

        // Compute per (candidate, subject) and snapshot. A subject's assessments
        // + the candidate's marks feed the pure engine.
        const candidates = await tx.candidate.findMany({
          where: { institutionId, examId },
          select: { id: true, studentId: true },
        });
        const assessments = await tx.assessment.findMany({
          where: { institutionId, examId },
          select: { id: true, subjectId: true, maxMarks: true, weight: true },
        });
        // Group assessments by subject.
        const bySubject = new Map<string, GradingAssessment[]>();
        for (const a of assessments) {
          const list = bySubject.get(a.subjectId) ?? [];
          list.push({ assessmentId: a.id, maxMarks: a.maxMarks, weight: a.weight });
          bySubject.set(a.subjectId, list);
        }

        let snapshotCount = 0;
        try {
          for (const candidate of candidates) {
            const marksRows = await tx.marksRecord.findMany({
              where: { institutionId, examId, candidateId: candidate.id },
              select: { assessmentId: true, marks: true },
            });
            const marksByAssessment = new Map<string, number>();
            for (const mr of marksRows) marksByAssessment.set(mr.assessmentId, mr.marks);

            for (const [subjectId, subjAssessments] of bySubject) {
              const gradingMarks: GradingMark[] = subjAssessments
                .filter((a) => marksByAssessment.has(a.assessmentId))
                .map((a) => ({ assessmentId: a.assessmentId, marks: marksByAssessment.get(a.assessmentId)! }));
              const result = gradeSubject(subjAssessments, gradingMarks, bands);
              await tx.resultSnapshot.create({
                data: {
                  institutionId,
                  resultPublicationId: publication.id,
                  examId,
                  candidateId: candidate.id,
                  studentId: candidate.studentId,
                  subjectId,
                  percentBps: result.percentBps,
                  gradeLabel: result.gradeLabel,
                  gradePoints: result.gradePoints,
                  passed: result.passed,
                },
              });
              snapshotCount += 1;
            }
          }
        } catch (err) {
          if (err instanceof GradingError) return deny("grading misconfigured", 409);
          throw err;
        }

        // Slice 8.2 (design §8.3): on a re-publication, flip the immediately-prior
        // PUBLISHED version to SUPERSEDED within the SAME tx, under the advisory
        // lock the route already holds. Post-backfill (migration §m / finding 2),
        // the prior (= then-max) version is the SOLE PUBLISHED row for the scope,
        // so exactly one row flips; count !== 1 ⇒ a concurrent/illegal state → 409.
        // The column guard permits exactly this PUBLISHED->SUPERSEDED write and
        // rejects every other mutation (surfaces as a 409 via isRestrictViolation).
        if (nextVersion > 1) {
          const priorVersion = nextVersion - 1;
          let flipped;
          try {
            flipped = await tx.resultPublication.updateMany({
              where: { institutionId, examId, version: priorVersion, status: "PUBLISHED" },
              data: { status: "SUPERSEDED" },
            });
          } catch (err) {
            if (isRestrictViolation(err)) return deny("prior version not in PUBLISHED state", 409);
            throw err;
          }
          if (flipped.count !== 1) return deny("prior version not in PUBLISHED state", 409);
          await recordAuditEvent(
            {
              action: "exams.results.superseded",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "ResultPublication",
              resourceId: publication.id,
              metadata: { supersededVersion: priorVersion, byVersion: nextVersion },
            },
            tx,
          );
        }

        // First publish advances APPROVED -> PUBLISHED; a correction stays PUBLISHED.
        if (exam.status === "APPROVED") {
          const n = await advanceExamStatus(tx, institutionId, examId, "APPROVED", "PUBLISHED");
          if (n === 0) return deny("exam not approved", 409);
        }

        await recordAuditEvent(
          {
            action: "exams.results.published",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ResultPublication",
            resourceId: publication.id,
            metadata: { version: nextVersion, snapshotCount },
          },
          tx,
        );
        return { publicationId: publication.id, version: nextVersion, snapshotCount };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.status(201).send(outcome);
    },
  );

  // ─── Staff result reports (exams.results.view) ──────────────────────────────

  // Resolve the latest publication (by version, NO status filter) for a scope.
  // Staff/internal reads where status tagging is explicit.
  async function latestPublication(
    tx: Prisma.TransactionClient,
    institutionId: string,
    examId: string,
  ) {
    return tx.resultPublication.findFirst({
      where: { institutionId, examId },
      orderBy: { version: "desc" },
    });
  }

  // Slice 8.2 (finding 3): the latest PUBLISHED publication for a scope —
  // status = 'PUBLISHED' AND version desc. Used for ALL student-facing reads so a
  // stray superseded row at max version can never leak; NEVER returns a SUPERSEDED
  // version. Do NOT substitute latestPublication (max-version-only) on a student path.
  async function latestPublishedPublication(
    tx: Prisma.TransactionClient,
    institutionId: string,
    examId: string,
  ) {
    return tx.resultPublication.findFirst({
      where: { institutionId, examId, status: "PUBLISHED" },
      orderBy: { version: "desc" },
    });
  }

  app.get(
    "/:id/results",
    { preHandler: [requirePermission("exams.results.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: examId } = request.params as { id: string };
      const data = await withTenant(institutionId, async (tx) => {
        const publications = await tx.resultPublication.findMany({
          where: { institutionId, examId },
          orderBy: { version: "desc" },
        });
        const latest = publications[0] ?? null;
        const snapshots = latest
          ? await tx.resultSnapshot.findMany({
              where: { institutionId, resultPublicationId: latest.id },
              orderBy: [{ studentId: "asc" }, { subjectId: "asc" }],
            })
          : [];
        return { publications, latestVersion: latest?.version ?? null, snapshots };
      });
      return reply.send(data);
    },
  );

  app.get(
    "/:id/results/distribution",
    { preHandler: [requirePermission("exams.results.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: examId } = request.params as { id: string };
      const data = await withTenant(institutionId, async (tx) => {
        const latest = await latestPublication(tx, institutionId, examId);
        if (!latest) return { latestVersion: null, gradeDistribution: {}, passed: 0, failed: 0 };
        const snapshots = await tx.resultSnapshot.findMany({
          where: { institutionId, resultPublicationId: latest.id },
          select: { gradeLabel: true, passed: true },
        });
        const gradeDistribution: Record<string, number> = {};
        let passed = 0;
        let failed = 0;
        for (const s of snapshots) {
          gradeDistribution[s.gradeLabel] = (gradeDistribution[s.gradeLabel] ?? 0) + 1;
          if (s.passed) passed += 1;
          else failed += 1;
        }
        return { latestVersion: latest.version, gradeDistribution, passed, failed };
      });
      return reply.send(data);
    },
  );

  app.get(
    "/:id/results/rollups",
    { preHandler: [requirePermission("exams.results.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: examId } = request.params as { id: string };
      const data = await withTenant(institutionId, async (tx) => {
        const latest = await latestPublication(tx, institutionId, examId);
        if (!latest) return { latestVersion: null, perSubject: [] };
        const snapshots = await tx.resultSnapshot.findMany({
          where: { institutionId, resultPublicationId: latest.id },
          select: { subjectId: true, percentBps: true, passed: true },
        });
        const bySubject = new Map<string, { count: number; passed: number; sumBps: number }>();
        for (const s of snapshots) {
          const agg = bySubject.get(s.subjectId) ?? { count: 0, passed: 0, sumBps: 0 };
          agg.count += 1;
          agg.sumBps += s.percentBps;
          if (s.passed) agg.passed += 1;
          bySubject.set(s.subjectId, agg);
        }
        const perSubject = [...bySubject.entries()].map(([subjectId, agg]) => ({
          subjectId,
          count: agg.count,
          passed: agg.passed,
          failed: agg.count - agg.passed,
          avgPercentBps: agg.count > 0 ? Math.round(agg.sumBps / agg.count) : 0,
        }));
        return { latestVersion: latest.version, perSubject };
      });
      return reply.send(data);
    },
  );

  app.get(
    "/:id/results.xlsx",
    { preHandler: [requirePermission("exams.results.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: examId } = request.params as { id: string };
      const data = await withTenant(institutionId, async (tx) => {
        const latest = await latestPublication(tx, institutionId, examId);
        const snapshots = latest
          ? await tx.resultSnapshot.findMany({
              where: { institutionId, resultPublicationId: latest.id },
              orderBy: [{ studentId: "asc" }, { subjectId: "asc" }],
            })
          : [];
        return { latest, snapshots };
      });

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Results");
      sheet.columns = [
        { header: "Student ID", key: "studentId", width: 28 },
        { header: "Candidate ID", key: "candidateId", width: 28 },
        { header: "Subject ID", key: "subjectId", width: 28 },
        { header: "Percent", key: "percent", width: 12 },
        { header: "Grade", key: "gradeLabel", width: 10 },
        { header: "Grade Points", key: "gradePoints", width: 14 },
        { header: "Passed", key: "passed", width: 10 },
      ];
      for (const s of data.snapshots) {
        sheet.addRow({
          studentId: s.studentId,
          candidateId: s.candidateId,
          subjectId: s.subjectId,
          percent: (s.percentBps / 100).toFixed(2),
          gradeLabel: s.gradeLabel,
          gradePoints: (s.gradePoints / 100).toFixed(2),
          passed: s.passed ? "YES" : "NO",
        });
      }

      await withTenant(institutionId, (tx) =>
        recordAuditEvent(
          {
            action: "exams.results.exported",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "Examination",
            resourceId: examId,
            metadata: { version: data.latest?.version ?? null },
          },
          tx,
        ),
      );

      const buffer = await workbook.xlsx.writeBuffer();
      reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      reply.header("Content-Disposition", `attachment; filename="exam-${examId}-results.xlsx"`);
      return reply.send(Buffer.from(buffer));
    },
  );

  // ─── Student reads (exams.results.view_own) — latest PUBLISHED only ─────────

  app.get(
    "/me/results",
    { preHandler: [requirePermission("exams.results.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const data = await withTenant(institutionId, async (tx) => {
        const student = await tx.studentProfile.findFirst({
          where: { userId, institutionId },
          select: { id: true },
        });
        if (!student) return { results: [] };

        // The student's candidate rows name their exams; for each exam return
        // ONLY the latest PUBLISHED version's own snapshots.
        const candidateRows = await tx.candidate.findMany({
          where: { institutionId, studentId: student.id },
          select: { examId: true },
        });
        const examIds = [...new Set(candidateRows.map((c) => c.examId))];
        const results: Array<{ examId: string; version: number; snapshots: unknown[] }> = [];
        for (const examId of examIds) {
          const latest = await latestPublication(tx, institutionId, examId);
          if (!latest) continue; // unpublished ⇒ invisible to students
          const snapshots = await tx.resultSnapshot.findMany({
            where: { institutionId, resultPublicationId: latest.id, studentId: student.id },
            orderBy: { subjectId: "asc" },
          });
          if (snapshots.length > 0) results.push({ examId, version: latest.version, snapshots });
        }
        return { results };
      });
      return reply.send(data);
    },
  );

  app.get(
    "/me/results/:examId",
    { preHandler: [requirePermission("exams.results.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const { examId } = request.params as { examId: string };
      const data = await withTenant(institutionId, async (tx) => {
        const student = await tx.studentProfile.findFirst({
          where: { userId, institutionId },
          select: { id: true },
        });
        if (!student) return { published: false as const };
        const latest = await latestPublication(tx, institutionId, examId);
        if (!latest) return { published: false as const }; // unpublished ⇒ invisible
        const snapshots = await tx.resultSnapshot.findMany({
          where: { institutionId, resultPublicationId: latest.id, studentId: student.id },
          orderBy: { subjectId: "asc" },
        });
        return { published: true as const, version: latest.version, snapshots };
      });
      if (!data.published) return reply.status(404).send({ error: "no published result" });
      return reply.send(data);
    },
  );

  // ─── Slice 8.2: Re-evaluation — student self-service (§8.1) ─────────────────

  app.post(
    "/me/reeval",
    { preHandler: [requirePermission("exams.reeval.request_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const parsed = createReevalRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { examId, subjectId, reason } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const student = await tx.studentProfile.findFirst({
          where: { userId, institutionId },
          select: { id: true },
        });
        if (!student) return deny("no student profile", 404);

        // Latest PUBLISHED only (status-filtered, finding 3) — a superseded /
        // unpublished version is invisible to the student.
        const latest = await latestPublishedPublication(tx, institutionId, examId);
        if (!latest) return deny("no published result", 404);

        const candidate = await tx.candidate.findFirst({
          where: { institutionId, examId, studentId: student.id },
          select: { id: true },
        });
        if (!candidate) return deny("no published result", 404);

        // The caller must own a snapshot for (latest publication, self, subject);
        // a missing snapshot is a 404 that never reveals another student's data.
        const snapshot = await tx.resultSnapshot.findFirst({
          where: {
            institutionId,
            resultPublicationId: latest.id,
            studentId: student.id,
            subjectId,
          },
          select: { id: true },
        });
        if (!snapshot) return deny("no published result", 404);

        let created;
        try {
          created = await tx.reevalRequest.create({
            data: {
              institutionId,
              examId,
              candidateId: candidate.id,
              studentId: student.id,
              subjectId,
              sourcePublicationId: latest.id,
              status: "REQUESTED",
              studentReason: reason,
              requestedByUserId: userId,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            return deny("a re-evaluation request is already open", 409);
          }
          throw err;
        }
        await recordAuditEvent(
          {
            action: "exams.reeval.requested",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ReevalRequest",
            resourceId: created.id,
            metadata: { examId, subjectId },
          },
          tx,
        );
        return { request: created };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.status(201).send(serializeReeval(outcome.request));
    },
  );

  app.get(
    "/me/reeval",
    { preHandler: [requirePermission("exams.reeval.request_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const data = await withTenant(institutionId, async (tx) => {
        const student = await tx.studentProfile.findFirst({
          where: { userId, institutionId },
          select: { id: true },
        });
        if (!student) return { requests: [] as unknown[] };
        const rows = await tx.reevalRequest.findMany({
          where: { institutionId, studentId: student.id },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        });
        return { requests: rows.map(serializeReeval) };
      });
      return reply.send(data);
    },
  );

  // ─── Slice 8.2: Re-evaluation — staff processing (§8.2) ─────────────────────

  app.get(
    "/reeval",
    { preHandler: [requirePermission("exams.reeval.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = listReevalQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { status, examId } = parsed.data;
      const rows = await withTenant(institutionId, (tx) =>
        tx.reevalRequest.findMany({
          where: {
            institutionId,
            ...(status !== undefined ? { status } : {}),
            ...(examId !== undefined ? { examId } : {}),
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
      );
      return reply.send({ requests: rows.map(serializeReeval) });
    },
  );

  app.post(
    "/reeval/:id/transition",
    { preHandler: [requirePermission("exams.reeval.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = transitionReevalSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { to, note, outcomePublicationId } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const current = await tx.reevalRequest.findFirst({
          where: { id, institutionId },
          select: { status: true, examId: true },
        });
        if (!current) return deny("re-evaluation request not found", 404);

        // Legality decided in the service BEFORE any write (finding 6); the
        // trigger remains the hard DB backstop.
        if (!reevalTransitionLegal(current.status, to)) {
          return deny("illegal re-evaluation transition", 409);
        }

        // outcomePublicationId (only valid for REMARKED — Zod-enforced) must name a
        // same-tenant publication for THIS exam.
        if (outcomePublicationId !== undefined) {
          const pub = await tx.resultPublication.findFirst({
            where: { id: outcomePublicationId, institutionId, examId: current.examId },
            select: { id: true },
          });
          if (!pub) return deny("outcome publication not found", 404);
        }

        let res;
        try {
          res = await tx.reevalRequest.updateMany({
            where: { id, institutionId, status: current.status },
            data: {
              status: to,
              processedByUserId: userId,
              ...(note !== undefined ? { staffNote: note } : {}),
              ...(outcomePublicationId !== undefined ? { outcomePublicationId } : {}),
            },
          });
        } catch (err) {
          if (isRestrictViolation(err)) return deny("illegal re-evaluation transition", 409);
          throw err;
        }
        if (res.count === 0) return deny("re-evaluation request changed concurrently", 409);

        await recordAuditEvent(
          {
            action: "exams.reeval.transitioned",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ReevalRequest",
            resourceId: id,
            metadata: { from: current.status, to },
          },
          tx,
        );
        return { from: current.status, to };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send({ id, status: outcome.to });
    },
  );

  // Re-mark on a PUBLISHED exam (§8.2a) — the ONE place a re-eval is permitted to
  // mutate a mark, only while UNDER_REVIEW and within its own (examId, candidateId)
  // scope. marks_records_guard permits a `marks` UPDATE (freezes only identity),
  // so no trigger change is needed; the exam's status is NEVER touched.
  app.post(
    "/reeval/:id/remark",
    { preHandler: [requirePermission("exams.reeval.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = remarkReevalSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { marksRecordId, marks: newMarks, reason } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const req = await tx.reevalRequest.findFirst({
          where: { id, institutionId },
          select: { status: true, examId: true, candidateId: true },
        });
        if (!req) return deny("re-evaluation request not found", 404);
        if (req.status !== "UNDER_REVIEW") return deny("request not under review", 409);

        const rec = await tx.marksRecord.findFirst({
          where: {
            id: marksRecordId,
            institutionId,
            examId: req.examId,
            candidateId: req.candidateId,
          },
          select: { id: true, marks: true, assessmentId: true },
        });
        if (!rec) return deny("marks record not found for this request", 404);

        const assessment = await tx.assessment.findFirst({
          where: { id: rec.assessmentId, institutionId },
          select: { maxMarks: true },
        });
        if (!assessment) return deny("assessment not found", 404);
        if (newMarks < 0 || newMarks > assessment.maxMarks) {
          await recordAuditEvent(
            {
              action: "exams.reeval.remarked",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "MarksRecord",
              resourceId: rec.id,
              metadata: { reason: "marks out of range" },
            },
            tx,
          );
          return deny("marks out of range", 400);
        }

        await tx.marksRecord.update({
          where: { id: rec.id },
          data: { marks: newMarks, enteredByUserId: userId },
        });
        await tx.marksRecordHistory.create({
          data: {
            institutionId,
            marksRecordId: rec.id,
            changeType: "CORRECTED",
            previousMarks: rec.marks,
            newMarks,
            actorUserId: userId,
            actorMembershipId: request.auth?.membershipId ?? null,
            reason,
          },
        });
        await recordAuditEvent(
          {
            action: "exams.reeval.remarked",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "MarksRecord",
            resourceId: rec.id,
            metadata: { marksRecordId: rec.id, previousMarks: rec.marks, newMarks },
          },
          tx,
        );
        return { marksRecordId: rec.id, previousMarks: rec.marks, newMarks };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send(outcome);
    },
  );

  // ─── Slice 8.2: Supplementary candidate registration (§8.4) ─────────────────

  app.post(
    "/:id/candidates/supplementary",
    { preHandler: [requirePermission("exams.candidates.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: examId } = request.params as { id: string };
      const parsed = registerSupplementaryCandidatesSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { subjectIds, studentIds } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const exam = await tx.examination.findFirst({
          where: { id: examId, institutionId },
          select: { id: true, type: true, parentExaminationId: true },
        });
        if (!exam) return deny("examination not found", 404);
        if (exam.type !== "SUPPLEMENTARY" || !exam.parentExaminationId) {
          return deny("not a supplementary examination", 409);
        }

        const parentLatest = await latestPublishedPublication(
          tx,
          institutionId,
          exam.parentExaminationId,
        );
        if (!parentLatest) return deny("parent results not published", 409);

        const parentSnaps = await tx.resultSnapshot.findMany({
          where: {
            institutionId,
            resultPublicationId: parentLatest.id,
            subjectId: { in: subjectIds },
            passed: false,
          },
          select: { studentId: true, passed: true },
        });
        const eligible = computeSupplementaryEligible(parentSnaps);

        let target: string[];
        if (studentIds !== undefined) {
          // Atomic allowlist: every named id must be eligible, else reject the
          // WHOLE request (never partially register).
          const ineligible = studentIds.filter((s) => !eligible.has(s));
          if (ineligible.length > 0) {
            await recordAuditEvent(
              {
                action: "exams.candidate.registered",
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "Examination",
                resourceId: examId,
                metadata: {
                  reason: "one or more students are not eligible",
                  supplementaryOf: exam.parentExaminationId,
                  ineligibleCount: ineligible.length,
                },
              },
              tx,
            );
            return deny("one or more students are not eligible", 409);
          }
          target = [...new Set(studentIds)];
        } else {
          target = [...eligible];
        }

        const created: string[] = [];
        for (const studentId of target) {
          try {
            const c = await tx.candidate.create({
              data: { institutionId, examId, studentId },
            });
            created.push(c.id);
          } catch (err) {
            if (isUniqueViolation(err)) continue; // already a candidate ⇒ idempotent skip
            throw err;
          }
        }
        await recordAuditEvent(
          {
            action: "exams.candidate.registered",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "Examination",
            resourceId: examId,
            metadata: {
              supplementaryOf: exam.parentExaminationId,
              eligibleCount: eligible.size,
              registeredCount: created.length,
            },
          },
          tx,
        );
        return { eligibleCount: eligible.size, registered: created.length, candidateIds: created };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.status(201).send(outcome);
    },
  );

  // ─── Slice 8.2: Student result history (§8.5) ───────────────────────────────

  app.get(
    "/me/results/history",
    { preHandler: [requirePermission("exams.results.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const data = await withTenant(institutionId, async (tx) => {
        const student = await tx.studentProfile.findFirst({
          where: { userId, institutionId },
          select: { id: true },
        });
        if (!student) return { history: [] as unknown[] };

        const candidateRows = await tx.candidate.findMany({
          where: { institutionId, studentId: student.id },
          select: { examId: true },
        });
        const examIds = [...new Set(candidateRows.map((c) => c.examId))];

        const history: Array<Record<string, unknown>> = [];
        for (const examId of examIds) {
          const latest = await latestPublishedPublication(tx, institutionId, examId);
          if (!latest) continue; // unpublished/superseded ⇒ invisible
          const snapshots = await tx.resultSnapshot.findMany({
            where: {
              institutionId,
              resultPublicationId: latest.id,
              studentId: student.id,
            },
            orderBy: { subjectId: "asc" },
          });
          if (snapshots.length === 0) continue;
          const exam = await tx.examination.findFirst({
            where: { id: examId, institutionId },
            select: {
              name: true,
              type: true,
              academicSessionId: true,
              academicTermId: true,
              parentExaminationId: true,
            },
          });
          history.push({
            examId,
            examName: exam?.name ?? null,
            examType: exam?.type ?? null,
            academicSessionId: exam?.academicSessionId ?? null,
            academicTermId: exam?.academicTermId ?? null,
            parentExaminationId: exam?.parentExaminationId ?? null,
            version: latest.version,
            publishedAt: latest.publishedAt.toISOString(),
            subjects: snapshots.map((s) => ({
              subjectId: s.subjectId,
              percentBps: s.percentBps,
              gradeLabel: s.gradeLabel,
              gradePoints: s.gradePoints,
              passed: s.passed,
            })),
          });
        }
        history.sort((a, b) => {
          const pa = String(a.publishedAt);
          const pb = String(b.publishedAt);
          if (pa !== pb) return pa < pb ? 1 : -1; // publishedAt desc
          return String(a.examId) < String(b.examId) ? -1 : 1; // examId asc
        });
        return { history };
      });
      return reply.send(data);
    },
  );

  // Staff full history (incl. superseded), deterministically ordered.
  async function staffHistory(
    tx: Prisma.TransactionClient,
    institutionId: string,
    studentId: string,
  ) {
    const publications = await tx.resultPublication.findMany({
      where: { institutionId, snapshots: { some: { studentId } } },
      orderBy: [{ examId: "asc" }, { version: "desc" }],
    });
    const rows: Array<Record<string, unknown>> = [];
    for (const pub of publications) {
      const snapshots = await tx.resultSnapshot.findMany({
        where: { institutionId, resultPublicationId: pub.id, studentId },
        orderBy: { subjectId: "asc" },
      });
      if (snapshots.length === 0) continue;
      const exam = await tx.examination.findFirst({
        where: { id: pub.examId, institutionId },
        select: {
          name: true,
          type: true,
          academicSessionId: true,
          academicTermId: true,
          parentExaminationId: true,
        },
      });
      rows.push({
        examId: pub.examId,
        examName: exam?.name ?? null,
        examType: exam?.type ?? null,
        academicSessionId: exam?.academicSessionId ?? null,
        academicTermId: exam?.academicTermId ?? null,
        parentExaminationId: exam?.parentExaminationId ?? null,
        version: pub.version,
        status: pub.status,
        publishedAt: pub.publishedAt.toISOString(),
        subjects: snapshots.map((s) => ({
          subjectId: s.subjectId,
          percentBps: s.percentBps,
          gradeLabel: s.gradeLabel,
          gradePoints: s.gradePoints,
          passed: s.passed,
        })),
      });
    }
    return rows;
  }

  app.get(
    "/students/:studentId/results/history",
    { preHandler: [requirePermission("exams.results.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { studentId } = request.params as { studentId: string };
      const outcome = await withTenant(institutionId, async (tx) => {
        const student = await tx.studentProfile.findFirst({
          where: { id: studentId, institutionId },
          select: { id: true },
        });
        if (!student) return deny("student not found", 404);
        const history = await staffHistory(tx, institutionId, studentId);
        return { history };
      });
      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send(outcome);
    },
  );

  app.get(
    "/students/:studentId/results/history.xlsx",
    { preHandler: [requirePermission("exams.results.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { studentId } = request.params as { studentId: string };
      const outcome = await withTenant(institutionId, async (tx) => {
        const student = await tx.studentProfile.findFirst({
          where: { id: studentId, institutionId },
          select: { id: true },
        });
        if (!student) return deny("student not found", 404);
        const history = await staffHistory(tx, institutionId, studentId);
        return { history };
      });
      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Transcript");
      sheet.columns = [
        { header: "Exam", key: "exam", width: 28 },
        { header: "Type", key: "type", width: 16 },
        { header: "Session", key: "session", width: 28 },
        { header: "Term", key: "term", width: 28 },
        { header: "Subject", key: "subject", width: 28 },
        { header: "Percent", key: "percent", width: 12 },
        { header: "Grade", key: "gradeLabel", width: 10 },
        { header: "Grade Points", key: "gradePoints", width: 14 },
        { header: "Passed", key: "passed", width: 10 },
        { header: "Version", key: "version", width: 10 },
        { header: "Status", key: "status", width: 14 },
      ];
      for (const row of outcome.history as Array<Record<string, unknown>>) {
        const subjects = row.subjects as Array<Record<string, unknown>>;
        for (const s of subjects) {
          sheet.addRow({
            exam: row.examName ?? row.examId,
            type: row.examType,
            session: row.academicSessionId,
            term: row.academicTermId,
            subject: s.subjectId,
            percent: (Number(s.percentBps) / 100).toFixed(2),
            gradeLabel: s.gradeLabel,
            gradePoints: (Number(s.gradePoints) / 100).toFixed(2),
            passed: s.passed ? "YES" : "NO",
            version: row.version,
            status: row.status,
          });
        }
      }

      await withTenant(institutionId, (tx) =>
        recordAuditEvent(
          {
            action: "exams.results.exported",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "StudentProfile",
            resourceId: studentId,
            metadata: { report: "results-history" },
          },
          tx,
        ),
      );

      const buffer = await workbook.xlsx.writeBuffer();
      reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      reply.header("Content-Disposition", `attachment; filename="student-${studentId}-results-history.xlsx"`);
      return reply.send(Buffer.from(buffer));
    },
  );
}

// Serialize a reeval_requests row to a stable JSON shape.
function serializeReeval(r: {
  id: string;
  examId: string;
  candidateId: string;
  studentId: string;
  subjectId: string;
  sourcePublicationId: string;
  status: string;
  studentReason: string;
  requestedByUserId: string;
  processedByUserId: string | null;
  staffNote: string | null;
  outcomePublicationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: r.id,
    examId: r.examId,
    candidateId: r.candidateId,
    studentId: r.studentId,
    subjectId: r.subjectId,
    sourcePublicationId: r.sourcePublicationId,
    status: r.status,
    studentReason: r.studentReason,
    requestedByUserId: r.requestedByUserId,
    processedByUserId: r.processedByUserId,
    staffNote: r.staffNote,
    outcomePublicationId: r.outcomePublicationId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ─── Grading-scheme band validation (contiguity + monotonic isPassing, §11) ───
function validateBands(
  bands: Array<{
    minPercentBps: number;
    maxPercentBps: number;
    gradeLabel: string;
    gradePoints: number;
    isPassing: boolean;
  }>,
): string | null {
  if (bands.length === 0) return "at least one grade band is required";
  // Sort a COPY by minPercentBps; the stored ordinal follows input order, but
  // contiguity/coverage is defined on the sorted edges.
  const sorted = [...bands].sort((a, b) => a.minPercentBps - b.minPercentBps);
  if (sorted[0].minPercentBps !== 0) return "bands must start at 0";
  if (sorted[sorted.length - 1].maxPercentBps !== 10000) return "bands must end at 10000";
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    if (b.minPercentBps > b.maxPercentBps) return "band minPercentBps must be <= maxPercentBps";
    if (i > 0 && b.minPercentBps !== sorted[i - 1].maxPercentBps + 1) {
      return "bands must be contiguous and non-overlapping";
    }
  }
  // isPassing must be monotonic non-decreasing up the band order (no passing
  // band strictly below a failing band).
  let seenPassing = false;
  for (const b of sorted) {
    if (b.isPassing) seenPassing = true;
    else if (seenPassing) return "isPassing must be monotonic up the band order";
  }
  return null;
}
