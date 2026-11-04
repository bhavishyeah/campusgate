import type { FastifyInstance, FastifyRequest } from "fastify";
import { withTenant, Prisma } from "@campusgate/db";
import {
  createFacultyQualificationSchema,
  patchFacultyQualificationSchema,
  putWorkloadPolicySchema,
  patchFacultyWorkloadSchema,
  facultyListQuerySchema,
} from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission, requireModuleActive } from "../services/authz-engine.js";
import { recordAuditEvent } from "../services/audit.js";
import { resolveMarkingFaculty } from "../services/attendance-authz.js";
import { computeWorkload, type WorkloadAssignment } from "../services/faculty/workload.js";
import {
  planReconcile,
  appendTeachingHistory,
  type LedgerKey,
  type ReconcileAssignment,
} from "../services/faculty/teaching-history.js";

// The module registry key is `faculty_management`; the permission/audit prefix is
// `faculty.*`. Every route carries requireModuleActive("faculty_management") IN
// ADDITION to requirePermission(...). Faculty Management adds ACADEMIC domain
// records that REFERENCE the authoritative FacultyProfile + FacultyAssignment —
// never duplicating them (design §B). Routes are registered at `/api/faculty`.
const MODULE_KEY = "faculty_management" as const;

/**
 * Faculty Management operational routes (design §B.9), registered at
 * `/api/faculty` (see server.ts). `faculty_management` is a GATED module — every
 * route carries `requireModuleActive("faculty_management")` IN ADDITION to
 * `requirePermission(...)`.
 *
 * House pattern (mirrors exams.ts / fees.ts):
 *  - a single top-level `authenticate` preHandler;
 *  - per-route `[requirePermission(key), requireModuleActive(gate)]`;
 *  - every handler runs inside `withTenant(institutionId, tx => ...)` with
 *    `institutionId` from the verified token (`request.user`), never from input;
 *  - every mutation writes a `faculty.*` AuditEvent via `recordAuditEvent` in the
 *    SAME transaction; deny branches record a DENIED audit then RETURN the 4xx
 *    from a normally-returning `withTenant` callback (never `throw`);
 *  - Zod validates every external input; JSON is deterministic and well-typed.
 */
export async function facultyRoutes(app: FastifyInstance) {
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
    extra?: Record<string, unknown>;
  }
  function deny(message: string, status: number, extra?: Record<string, unknown>): Deny {
    return { deny: message, status, extra };
  }
  function isDeny(x: unknown): x is Deny {
    return typeof x === "object" && x !== null && "deny" in x;
  }

  function isRestrictViolation(err: unknown): boolean {
    // Postgres restrict_violation (23001) surfaces as a raw query error through
    // Prisma; the message carries the trigger text. The append-only trigger on
    // faculty_teaching_history raises it. Unlike exams (409 for a reachable
    // illegal transition) this backstop is a 500: NO legal UPDATE/DELETE path to
    // the ledger exists, so hitting it is a code defect (design §B.5 / §B.10).
    const msg = String((err as Error)?.message ?? err);
    return (
      msg.includes("restrict_violation") || msg.includes("illegal") || msg.includes("append-only")
    );
  }

  // ─── Serializers ────────────────────────────────────────────────────────────
  function serializeQualification(q: {
    id: string;
    facultyId: string;
    kind: string;
    title: string;
    issuingBody: string | null;
    field: string | null;
    year: number | null;
    documentRef: string | null;
    createdByUserId: string;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: q.id,
      facultyId: q.facultyId,
      kind: q.kind,
      title: q.title,
      issuingBody: q.issuingBody,
      field: q.field,
      year: q.year,
      documentRef: q.documentRef,
      createdByUserId: q.createdByUserId,
      createdAt: q.createdAt.toISOString(),
      updatedAt: q.updatedAt.toISOString(),
    };
  }

  // Display-name lookups for the ids carried by workload / history rows so the
  // UI never has to render raw ids. Tenant-scoped (institutionId in every where,
  // plus RLS via the surrounding withTenant tx); read-only; additive projections.
  interface NameMaps {
    terms: Map<string, { id: string; name: string }>;
    subjects: Map<string, { id: string; name: string; code: string }>;
    sections: Map<string, { id: string; label: string | null }>;
    departments: Map<string, { id: string; name: string }>;
  }
  async function loadNameMaps(
    tx: Prisma.TransactionClient,
    institutionId: string,
    ids: {
      termIds?: Array<string | null>;
      subjectIds?: Array<string | null>;
      sectionIds?: Array<string | null>;
      departmentIds?: Array<string | null>;
    },
  ): Promise<NameMaps> {
    const uniq = (a: Array<string | null | undefined> | undefined) =>
      Array.from(new Set((a ?? []).filter((x): x is string => !!x)));
    const termIds = uniq(ids.termIds);
    const subjectIds = uniq(ids.subjectIds);
    const sectionIds = uniq(ids.sectionIds);
    const departmentIds = uniq(ids.departmentIds);
    const [terms, subjects, sections, departments] = await Promise.all([
      termIds.length
        ? tx.academicTerm.findMany({
            where: { institutionId, id: { in: termIds } },
            select: { id: true, name: true },
          })
        : [],
      subjectIds.length
        ? tx.subject.findMany({
            where: { institutionId, id: { in: subjectIds } },
            select: { id: true, name: true, code: true },
          })
        : [],
      sectionIds.length
        ? tx.classSection.findMany({
            where: { institutionId, id: { in: sectionIds } },
            select: { id: true, label: true },
          })
        : [],
      departmentIds.length
        ? tx.department.findMany({
            where: { institutionId, id: { in: departmentIds } },
            select: { id: true, name: true },
          })
        : [],
    ]);
    return {
      terms: new Map(terms.map((t) => [t.id, t])),
      subjects: new Map(subjects.map((s) => [s.id, s])),
      sections: new Map(sections.map((s) => [s.id, s])),
      departments: new Map(departments.map((d) => [d.id, d])),
    };
  }

  function serializeWorkload(
    w: {
      id: string;
      facultyId: string;
      academicTermId: string;
      teachingHours: number;
      nonTeachingHours: number;
      totalHours: number;
      overAllocated: boolean;
      overrideReason: string | null;
      lastReconciledAt: Date | null;
      updatedByUserId: string;
      createdAt: Date;
      updatedAt: Date;
    },
    policyMaxWeeklyHours: number | null,
  ) {
    return {
      id: w.id,
      facultyId: w.facultyId,
      academicTermId: w.academicTermId,
      teachingHours: w.teachingHours,
      nonTeachingHours: w.nonTeachingHours,
      totalHours: w.totalHours,
      overAllocated: w.overAllocated,
      overrideReason: w.overrideReason,
      lastReconciledAt: w.lastReconciledAt ? w.lastReconciledAt.toISOString() : null,
      // Read-only projection so overAllocated is interpretable by every reader
      // (design §B.9 F2); NOT the editable policy view. null = uncapped.
      policyMaxWeeklyHours,
      updatedByUserId: w.updatedByUserId,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    };
  }

  // Additive display projections (names for the ids a workload / history row
  // carries). Existing fields are unchanged.
  function withTermName<T extends { academicTermId: string }>(row: T, names: NameMaps) {
    return { ...row, academicTerm: names.terms.get(row.academicTermId) ?? null };
  }
  function withHistoryNames<
    T extends { academicTermId: string; subjectId: string; classSectionId: string | null },
  >(row: T, names: NameMaps) {
    return {
      ...withTermName(row, names),
      subject: names.subjects.get(row.subjectId) ?? null,
      classSection: row.classSectionId ? (names.sections.get(row.classSectionId) ?? null) : null,
    };
  }

  function serializeHistory(h: {
    id: string;
    facultyId: string;
    subjectId: string;
    classSectionId: string | null;
    academicTermId: string;
    sourceAssignmentId: string | null;
    role: string;
    changeType: string;
    effectiveAt: Date;
    recordedByUserId: string;
    createdAt: Date;
  }) {
    return {
      id: h.id,
      facultyId: h.facultyId,
      subjectId: h.subjectId,
      classSectionId: h.classSectionId,
      academicTermId: h.academicTermId,
      sourceAssignmentId: h.sourceAssignmentId,
      role: h.role,
      changeType: h.changeType,
      effectiveAt: h.effectiveAt.toISOString(),
      recordedByUserId: h.recordedByUserId,
      createdAt: h.createdAt.toISOString(),
    };
  }

  // In-handler policy lookup. Returns the effective cap or null (uncapped).
  async function readPolicyMax(
    tx: Prisma.TransactionClient,
    institutionId: string,
  ): Promise<number | null> {
    const policy = await tx.facultyWorkloadPolicy.findFirst({
      where: { institutionId },
      select: { maxWeeklyHours: true },
    });
    return policy?.maxWeeklyHours ?? null;
  }

  // ─── 1. Create a qualification (faculty.qualifications.manage) ──────────────
  app.post(
    "/:facultyId/qualifications",
    { preHandler: [requirePermission("faculty.qualifications.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { facultyId } = request.params as { facultyId: string };
      const parsed = createFacultyQualificationSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const faculty = await tx.facultyProfile.findFirst({
          where: { id: facultyId, institutionId },
          select: { id: true },
        });
        if (!faculty) {
          await recordAuditEvent(
            {
              action: "faculty.qualification.created",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "FacultyProfile",
              resourceId: facultyId,
              metadata: { reason: "faculty not found" },
            },
            tx,
          );
          return deny("faculty not found", 404);
        }

        const qualification = await tx.facultyQualification.create({
          data: {
            institutionId,
            facultyId,
            kind: data.kind ?? "DEGREE",
            title: data.title,
            issuingBody: data.issuingBody ?? null,
            field: data.field ?? null,
            year: data.year ?? null,
            documentRef: data.documentRef ?? null,
            createdByUserId: request.user.userId,
          },
        });
        await recordAuditEvent(
          {
            action: "faculty.qualification.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "FacultyQualification",
            resourceId: qualification.id,
            metadata: { facultyId, kind: qualification.kind },
          },
          tx,
        );
        return { qualification };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.status(201).send(serializeQualification(outcome.qualification));
    },
  );

  // ─── 2. Update a qualification (faculty.qualifications.manage) ──────────────
  app.patch(
    "/:facultyId/qualifications/:id",
    { preHandler: [requirePermission("faculty.qualifications.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { facultyId, id } = request.params as { facultyId: string; id: string };
      const parsed = patchFacultyQualificationSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const existing = await tx.facultyQualification.findFirst({
          where: { id, institutionId, facultyId },
          select: { id: true },
        });
        if (!existing) {
          await recordAuditEvent(
            {
              action: "faculty.qualification.updated",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "FacultyQualification",
              resourceId: id,
              metadata: { reason: "qualification not found", facultyId },
            },
            tx,
          );
          return deny("qualification not found", 404);
        }

        // A successful PATCH ALWAYS audits (even a semantic no-op) — design §B.11 F8.
        const updated = await tx.facultyQualification.update({
          where: { id },
          data: {
            ...(data.title !== undefined ? { title: data.title } : {}),
            ...(data.kind !== undefined ? { kind: data.kind } : {}),
            ...(data.issuingBody !== undefined ? { issuingBody: data.issuingBody } : {}),
            ...(data.field !== undefined ? { field: data.field } : {}),
            ...(data.year !== undefined ? { year: data.year } : {}),
            ...(data.documentRef !== undefined ? { documentRef: data.documentRef } : {}),
          },
        });
        await recordAuditEvent(
          {
            action: "faculty.qualification.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "FacultyQualification",
            resourceId: id,
            metadata: { facultyId },
          },
          tx,
        );
        return { updated };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send(serializeQualification(outcome.updated));
    },
  );

  // ─── 3. Delete a qualification (faculty.qualifications.manage) ──────────────
  app.delete(
    "/:facultyId/qualifications/:id",
    { preHandler: [requirePermission("faculty.qualifications.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { facultyId, id } = request.params as { facultyId: string; id: string };

      const outcome = await withTenant(institutionId, async (tx) => {
        // deleteMany scoped triply so a foreign-tenant / wrong-faculty id matches
        // 0 rows under RLS (count, not a P2025 throw) — design §B.10.
        const res = await tx.facultyQualification.deleteMany({
          where: { id, institutionId, facultyId },
        });
        if (res.count === 0) {
          await recordAuditEvent(
            {
              action: "faculty.qualification.deleted",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "FacultyQualification",
              resourceId: id,
              metadata: { reason: "qualification not found", facultyId },
            },
            tx,
          );
          return deny("qualification not found", 404);
        }
        await recordAuditEvent(
          {
            action: "faculty.qualification.deleted",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "FacultyQualification",
            resourceId: id,
            metadata: { facultyId },
          },
          tx,
        );
        return { ok: true };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.status(204).send();
    },
  );

  // ─── 4. List a faculty's qualifications (faculty.directory.view) ────────────
  app.get(
    "/:facultyId/qualifications",
    { preHandler: [requirePermission("faculty.directory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { facultyId } = request.params as { facultyId: string };
      const outcome = await withTenant(institutionId, async (tx) => {
        const faculty = await tx.facultyProfile.findFirst({
          where: { id: facultyId, institutionId },
          select: { id: true },
        });
        if (!faculty) return deny("faculty not found", 404);
        const rows = await tx.facultyQualification.findMany({
          where: { institutionId, facultyId },
          orderBy: [{ createdAt: "desc" }],
        });
        return { rows };
      });
      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send({ qualifications: outcome.rows.map(serializeQualification) });
    },
  );

  // ─── 5. Upsert the per-institution workload policy (faculty.workload.manage) ─
  app.put(
    "/workload-policy",
    { preHandler: [requirePermission("faculty.workload.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = putWorkloadPolicySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { maxWeeklyHours } = parsed.data;

      const policy = await withTenant(institutionId, async (tx) => {
        const existing = await tx.facultyWorkloadPolicy.findFirst({
          where: { institutionId },
          select: { id: true },
        });
        const saved = existing
          ? await tx.facultyWorkloadPolicy.update({
              where: { id: existing.id },
              data: { maxWeeklyHours, updatedByUserId: request.user.userId },
            })
          : await tx.facultyWorkloadPolicy.create({
              data: { institutionId, maxWeeklyHours, updatedByUserId: request.user.userId },
            });
        await recordAuditEvent(
          {
            action: "faculty.workload_policy.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "FacultyWorkloadPolicy",
            resourceId: saved.id,
            metadata: { maxWeeklyHours },
          },
          tx,
        );
        return saved;
      });

      return reply.send({
        id: policy.id,
        maxWeeklyHours: policy.maxWeeklyHours,
        updatedByUserId: policy.updatedByUserId,
        createdAt: policy.createdAt.toISOString(),
        updatedAt: policy.updatedAt.toISOString(),
      });
    },
  );

  // ─── 6. Read the workload policy (faculty.workload.manage) ──────────────────
  app.get(
    "/workload-policy",
    { preHandler: [requirePermission("faculty.workload.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const policy = await withTenant(institutionId, (tx) =>
        tx.facultyWorkloadPolicy.findFirst({ where: { institutionId } }),
      );
      if (!policy) return reply.send({ policy: null });
      return reply.send({
        policy: {
          id: policy.id,
          maxWeeklyHours: policy.maxWeeklyHours,
          updatedByUserId: policy.updatedByUserId,
          createdAt: policy.createdAt.toISOString(),
          updatedAt: policy.updatedAt.toISOString(),
        },
      });
    },
  );

  // Shared: derive teachingHours for (faculty, term) from ACTIVE assignments +
  // Subject.contactHoursPerWeek, and compute the over-allocation decision.
  async function deriveWorkload(
    tx: Prisma.TransactionClient,
    institutionId: string,
    facultyId: string,
    academicTermId: string,
    nonTeachingHours: number,
    policyMax: number | null,
  ) {
    const assignments = await tx.facultyAssignment.findMany({
      where: { institutionId, facultyId, academicTermId },
      select: { id: true, subjectId: true, classSectionId: true, role: true, status: true },
    });
    const subjectIds = Array.from(new Set(assignments.map((a) => a.subjectId)));
    const subjects = subjectIds.length
      ? await tx.subject.findMany({
          where: { institutionId, id: { in: subjectIds } },
          select: { id: true, contactHoursPerWeek: true },
        })
      : [];
    const contactHoursBySubject = new Map<string, number | null>(
      subjects.map((s) => [s.id, s.contactHoursPerWeek]),
    );
    const input: WorkloadAssignment[] = assignments.map((a) => ({
      id: a.id,
      subjectId: a.subjectId,
      classSectionId: a.classSectionId,
      role: a.role as WorkloadAssignment["role"],
      status: a.status as WorkloadAssignment["status"],
    }));
    return computeWorkload(input, contactHoursBySubject, nonTeachingHours, policyMax);
  }

  // ─── 7. Recompute a faculty's workload for a term (faculty.workload.manage) ─
  app.post(
    "/:facultyId/workload/:academicTermId/recompute",
    { preHandler: [requirePermission("faculty.workload.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { facultyId, academicTermId } = request.params as {
        facultyId: string;
        academicTermId: string;
      };

      const outcome = await withTenant(institutionId, async (tx) => {
        const [faculty, term] = await Promise.all([
          tx.facultyProfile.findFirst({ where: { id: facultyId, institutionId }, select: { id: true } }),
          tx.academicTerm.findFirst({ where: { id: academicTermId, institutionId }, select: { id: true } }),
        ]);
        if (!faculty) return deny("faculty not found", 404);
        if (!term) return deny("academic term not found", 404);

        const policyMax = await readPolicyMax(tx, institutionId);
        const existing = await tx.facultyWorkload.findFirst({
          where: { institutionId, facultyId, academicTermId },
        });
        const nonTeachingHours = existing?.nonTeachingHours ?? 0;

        const computed = await deriveWorkload(
          tx,
          institutionId,
          facultyId,
          academicTermId,
          nonTeachingHours,
          policyMax,
        );

        const saved = existing
          ? await tx.facultyWorkload.update({
              where: { id: existing.id },
              data: {
                teachingHours: computed.teachingHours,
                totalHours: computed.totalHours,
                overAllocated: computed.overAllocated,
                lastReconciledAt: new Date(),
                updatedByUserId: request.user.userId,
              },
            })
          : await tx.facultyWorkload.create({
              data: {
                institutionId,
                facultyId,
                academicTermId,
                teachingHours: computed.teachingHours,
                nonTeachingHours,
                totalHours: computed.totalHours,
                overAllocated: computed.overAllocated,
                lastReconciledAt: new Date(),
                updatedByUserId: request.user.userId,
              },
            });

        await recordAuditEvent(
          {
            action: "faculty.workload.recomputed",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "FacultyWorkload",
            resourceId: saved.id,
            metadata: {
              facultyId,
              academicTermId,
              teachingHours: computed.teachingHours,
              totalHours: computed.totalHours,
              overAllocated: computed.overAllocated,
            },
          },
          tx,
        );
        if (computed.overAllocated) {
          await recordAuditEvent(
            {
              action: "faculty.workload.overallocated",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "FacultyWorkload",
              resourceId: saved.id,
              metadata: { facultyId, academicTermId, totalHours: computed.totalHours, policyMax },
            },
            tx,
          );
        }
        return { saved, policyMax, computed };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send({
        ...serializeWorkload(outcome.saved, outcome.policyMax),
        unestimatedSubjectIds: outcome.computed.unestimatedSubjectIds,
        excludedAssignmentIds: outcome.computed.excludedAssignmentIds,
      });
    },
  );

  // ─── 8. Patch a faculty's workload (nonTeachingHours / override) ────────────
  app.patch(
    "/:facultyId/workload/:academicTermId",
    { preHandler: [requirePermission("faculty.workload.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { facultyId, academicTermId } = request.params as {
        facultyId: string;
        academicTermId: string;
      };
      const parsed = patchFacultyWorkloadSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const [faculty, term] = await Promise.all([
          tx.facultyProfile.findFirst({ where: { id: facultyId, institutionId }, select: { id: true } }),
          tx.academicTerm.findFirst({ where: { id: academicTermId, institutionId }, select: { id: true } }),
        ]);
        if (!faculty) return deny("faculty not found", 404);
        if (!term) return deny("academic term not found", 404);

        const policyMax = await readPolicyMax(tx, institutionId);
        const existing = await tx.facultyWorkload.findFirst({
          where: { institutionId, facultyId, academicTermId },
        });
        const nonTeachingHours = data.nonTeachingHours ?? existing?.nonTeachingHours ?? 0;

        const computed = await deriveWorkload(
          tx,
          institutionId,
          facultyId,
          academicTermId,
          nonTeachingHours,
          policyMax,
        );

        const override = data.override === true;
        // Over-allocation: reject 422 unless explicitly overridden with a reason.
        if (computed.overAllocated && !override) {
          await recordAuditEvent(
            {
              action: "faculty.workload.updated",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "FacultyWorkload",
              resourceId: existing?.id ?? "",
              metadata: {
                reason: "workload exceeds policy max",
                facultyId,
                academicTermId,
                totalHours: computed.totalHours,
                policyMax,
              },
            },
            tx,
          );
          return deny("workload exceeds policy max", 422, {
            maxWeeklyHours: policyMax,
            totalHours: computed.totalHours,
          });
        }

        const overrideReason = override ? (data.overrideReason ?? null) : null;

        const saved = existing
          ? await tx.facultyWorkload.update({
              where: { id: existing.id },
              data: {
                nonTeachingHours,
                teachingHours: computed.teachingHours,
                totalHours: computed.totalHours,
                overAllocated: computed.overAllocated,
                overrideReason,
                updatedByUserId: request.user.userId,
              },
            })
          : await tx.facultyWorkload.create({
              data: {
                institutionId,
                facultyId,
                academicTermId,
                teachingHours: computed.teachingHours,
                nonTeachingHours,
                totalHours: computed.totalHours,
                overAllocated: computed.overAllocated,
                overrideReason,
                updatedByUserId: request.user.userId,
              },
            });

        await recordAuditEvent(
          {
            action: "faculty.workload.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "FacultyWorkload",
            resourceId: saved.id,
            metadata: { facultyId, academicTermId, totalHours: computed.totalHours },
          },
          tx,
        );
        if (computed.overAllocated) {
          await recordAuditEvent(
            {
              action: "faculty.workload.overallocated",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "FacultyWorkload",
              resourceId: saved.id,
              metadata: {
                facultyId,
                academicTermId,
                totalHours: computed.totalHours,
                policyMax,
                overridden: true,
              },
            },
            tx,
          );
        }
        return { saved, policyMax, computed };
      });

      if (isDeny(outcome)) {
        return reply.status(outcome.status).send({ error: outcome.deny, ...(outcome.extra ?? {}) });
      }
      return reply.send({
        ...serializeWorkload(outcome.saved, outcome.policyMax),
        unestimatedSubjectIds: outcome.computed.unestimatedSubjectIds,
        excludedAssignmentIds: outcome.computed.excludedAssignmentIds,
      });
    },
  );

  // ─── 9. List a faculty's workloads (faculty.directory.view) ─────────────────
  app.get(
    "/:facultyId/workload",
    { preHandler: [requirePermission("faculty.directory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { facultyId } = request.params as { facultyId: string };
      const outcome = await withTenant(institutionId, async (tx) => {
        const faculty = await tx.facultyProfile.findFirst({
          where: { id: facultyId, institutionId },
          select: { id: true },
        });
        if (!faculty) return deny("faculty not found", 404);
        const policyMax = await readPolicyMax(tx, institutionId);
        const rows = await tx.facultyWorkload.findMany({
          where: { institutionId, facultyId },
          orderBy: [{ createdAt: "desc" }],
        });
        const names = await loadNameMaps(tx, institutionId, {
          termIds: rows.map((r) => r.academicTermId),
        });
        return { rows, policyMax, names };
      });
      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send({
        workloads: outcome.rows.map((w) =>
          withTermName(serializeWorkload(w, outcome.policyMax), outcome.names),
        ),
      });
    },
  );

  // ─── 10. Reconcile teaching history (faculty.teaching_history.manage) ───────
  app.post(
    "/:facultyId/teaching-history/reconcile",
    {
      preHandler: [
        requirePermission("faculty.teaching_history.manage"),
        requireModuleActive(gate),
      ],
    },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { facultyId } = request.params as { facultyId: string };

      try {
        const outcome = await withTenant(institutionId, async (tx) => {
          const faculty = await tx.facultyProfile.findFirst({
            where: { id: facultyId, institutionId },
            select: { id: true },
          });
          if (!faculty) return deny("faculty not found", 404);

          const assignments = await tx.facultyAssignment.findMany({
            where: { institutionId, facultyId },
            select: {
              id: true,
              subjectId: true,
              classSectionId: true,
              academicTermId: true,
              role: true,
              status: true,
              assignedAt: true,
              endedAt: true,
            },
          });
          const existing = await tx.facultyTeachingHistory.findMany({
            where: { institutionId, facultyId },
            select: { sourceAssignmentId: true, changeType: true },
          });

          const plan = planReconcile(
            existing as LedgerKey[],
            assignments as ReconcileAssignment[],
          );
          const appended = await appendTeachingHistory(tx, {
            institutionId,
            facultyId,
            recordedByUserId: request.user.userId,
            rows: plan,
          });

          await recordAuditEvent(
            {
              action: "faculty.teaching_history.reconciled",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "FacultyProfile",
              resourceId: facultyId,
              metadata: { appended },
            },
            tx,
          );
          return { appended };
        });

        if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
        return reply.send({ appended: outcome.appended });
      } catch (err) {
        if (isRestrictViolation(err)) {
          request.log.error({ err }, "faculty_teaching_history append-only violation");
          return reply.status(500).send({ error: "append-only violation" });
        }
        throw err;
      }
    },
  );

  // ─── 11. List a faculty's teaching history (faculty.directory.view) ─────────
  app.get(
    "/:facultyId/teaching-history",
    { preHandler: [requirePermission("faculty.directory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { facultyId } = request.params as { facultyId: string };
      const outcome = await withTenant(institutionId, async (tx) => {
        const faculty = await tx.facultyProfile.findFirst({
          where: { id: facultyId, institutionId },
          select: { id: true },
        });
        if (!faculty) return deny("faculty not found", 404);
        const rows = await tx.facultyTeachingHistory.findMany({
          where: { institutionId, facultyId },
          orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }],
        });
        const names = await loadNameMaps(tx, institutionId, {
          termIds: rows.map((r) => r.academicTermId),
          subjectIds: rows.map((r) => r.subjectId),
          sectionIds: rows.map((r) => r.classSectionId),
        });
        return { rows, names };
      });
      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send({
        teachingHistory: outcome.rows.map((h) => withHistoryNames(serializeHistory(h), outcome.names)),
      });
    },
  );

  // Build the consolidated profile payload for a resolved faculty id.
  async function buildProfile(
    tx: Prisma.TransactionClient,
    institutionId: string,
    facultyId: string,
  ) {
    const faculty = await tx.facultyProfile.findFirst({
      where: { id: facultyId, institutionId },
      select: {
        id: true,
        userId: true,
        name: true,
        departmentId: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!faculty) return null;

    const policyMax = await readPolicyMax(tx, institutionId);
    const [qualifications, workloads, teachingHistory] = await Promise.all([
      tx.facultyQualification.findMany({
        where: { institutionId, facultyId },
        orderBy: [{ createdAt: "desc" }],
      }),
      tx.facultyWorkload.findMany({
        where: { institutionId, facultyId },
        orderBy: [{ createdAt: "desc" }],
      }),
      tx.facultyTeachingHistory.findMany({
        where: { institutionId, facultyId },
        orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }],
      }),
    ]);

    const names = await loadNameMaps(tx, institutionId, {
      termIds: [...workloads.map((w) => w.academicTermId), ...teachingHistory.map((h) => h.academicTermId)],
      subjectIds: teachingHistory.map((h) => h.subjectId),
      sectionIds: teachingHistory.map((h) => h.classSectionId),
      departmentIds: [faculty.departmentId],
    });

    return {
      identity: {
        id: faculty.id,
        userId: faculty.userId,
        name: faculty.name,
        departmentId: faculty.departmentId,
        department: faculty.departmentId ? (names.departments.get(faculty.departmentId) ?? null) : null,
        status: faculty.status,
        createdAt: faculty.createdAt.toISOString(),
        updatedAt: faculty.updatedAt.toISOString(),
      },
      qualifications: qualifications.map(serializeQualification),
      workloads: workloads.map((w) => withTermName(serializeWorkload(w, policyMax), names)),
      teachingHistory: teachingHistory.map((h) => withHistoryNames(serializeHistory(h), names)),
    };
  }

  // ─── 12. Consolidated profile read (faculty.directory.view) ─────────────────
  app.get(
    "/:facultyId/profile",
    { preHandler: [requirePermission("faculty.directory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { facultyId } = request.params as { facultyId: string };
      const profile = await withTenant(institutionId, (tx) =>
        buildProfile(tx, institutionId, facultyId),
      );
      if (!profile) return reply.status(404).send({ error: "faculty not found" });
      return reply.send(profile);
    },
  );

  // ─── G1. List faculty directory (faculty.directory.view) ────────────────────
  // There was no list endpoint at all — every other route takes a :facultyId the
  // UI has no way to discover. Staff-only (not view_own); tenant-scoped; search
  // by name, filter by department/status, paginated (the library/admissions
  // list idiom). Returns identity only (no qualifications/workload/history —
  // those stay on the consolidated profile read, route #12).
  app.get(
    "/",
    { preHandler: [requirePermission("faculty.directory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = facultyListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { q, departmentId, status, page, pageSize } = parsed.data;

      const where: Prisma.FacultyProfileWhereInput = {
        institutionId,
        ...(departmentId ? { departmentId } : {}),
        ...(status ? { status } : {}),
        ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
      };

      const { rows, total, departments } = await withTenant(institutionId, async (tx) => {
        const [rows, total] = await Promise.all([
          tx.facultyProfile.findMany({
            where,
            orderBy: [{ name: "asc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
            select: {
              id: true,
              userId: true,
              name: true,
              departmentId: true,
              status: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
          tx.facultyProfile.count({ where }),
        ]);
        const { departments } = await loadNameMaps(tx, institutionId, {
          departmentIds: rows.map((r) => r.departmentId),
        });
        return { rows, total, departments };
      });

      return reply.send({
        faculty: rows.map((r) => ({
          id: r.id,
          userId: r.userId,
          name: r.name,
          departmentId: r.departmentId,
          department: r.departmentId ? (departments.get(r.departmentId) ?? null) : null,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
        total,
        page,
        pageSize,
      });
    },
  );

  // ─── G2. Lookups for the faculty screens (faculty.directory.view) ───────────
  // The workload screens need an academic-term picker and the directory a
  // department filter. HOD holds NO academics.* key (terms live behind
  // academics.sessions.manage, ADMIN-only) and no admin.departments.manage, so a
  // narrowly gated read-only lookup is added instead of granting a broad key.
  app.get(
    "/lookups",
    { preHandler: [requirePermission("faculty.directory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const result = await withTenant(institutionId, async (tx) => {
        const [terms, departments] = await Promise.all([
          tx.academicTerm.findMany({
            where: { institutionId },
            orderBy: [{ startDate: "desc" }, { id: "asc" }],
            select: {
              id: true,
              name: true,
              status: true,
              startDate: true,
              endDate: true,
              academicSession: { select: { id: true, name: true } },
            },
          }),
          tx.department.findMany({
            where: { institutionId },
            orderBy: [{ name: "asc" }],
            select: { id: true, name: true, code: true },
          }),
        ]);
        return { terms, departments };
      });
      return reply.send({
        terms: result.terms.map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          startDate: t.startDate.toISOString(),
          endDate: t.endDate.toISOString(),
          session: t.academicSession ? { id: t.academicSession.id, name: t.academicSession.name } : null,
        })),
        departments: result.departments,
      });
    },
  );

  // ─── 13. Self-service profile read (faculty.view_own) ───────────────────────
  // SELF scope: resolves the caller's OWN ACTIVE FacultyProfile via the
  // attendance-authz resolveMarkingFaculty idiom; NEVER accepts a :facultyId.
  app.get(
    "/me/profile",
    { preHandler: [requirePermission("faculty.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const outcome = await withTenant(institutionId, async (tx) => {
        const resolved = await resolveMarkingFaculty(tx, institutionId, userId);
        if (!resolved) return deny("not a faculty member", 403);
        const profile = await buildProfile(tx, institutionId, resolved.facultyId);
        if (!profile) return deny("not a faculty member", 403);
        return { profile };
      });
      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send(outcome.profile);
    },
  );
}
