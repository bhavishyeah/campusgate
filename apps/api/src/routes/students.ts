import type { FastifyInstance, FastifyRequest } from "fastify";
import { withTenant, type Prisma, type StudentStatus } from "@campusgate/db";
import {
  createStudentSchema,
  updateStudentSchema,
  assignProgramSchema,
  enrollStudentSchema,
  promoteStudentSchema,
  transferStudentSchema,
  deactivateStudentSchema,
  listStudentsQuerySchema,
} from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../services/authz-engine.js";
import { recordAuditEvent } from "../services/audit.js";
import {
  createdPayload,
  updatedPayload,
  programAssignedPayload,
  enrolledPayload,
  promotedPayload,
  transferredPayload,
  deactivatedPayload,
  type StudentSnapshot,
  type HistorySnapshotPayload,
} from "../services/student-sis.js";

/**
 * Admin SIS routes (design §5), registered at `/api/students` (see server.ts).
 * Decision A: these are foundational institution-layer data — gated by
 * `requirePermission("students.<x>")` ONLY, NEVER `requireModuleActive`.
 *
 * House pattern (mirrors admin.ts / student.ts):
 *  - a single top-level `authenticate` preHandler (auth runs once per request);
 *  - every handler runs inside `withTenant(institutionId, tx => ...)` with
 *    `institutionId` from the verified token (`request.user`), never from input;
 *  - every lifecycle mutation writes a StudentProfileHistory row (payload built
 *    by student-sis.ts) AND a `students.*` audit event in the SAME transaction.
 */
export async function studentAdminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  // ─── Shared helpers ────────────────────────────────────────────────────────

  // The actor fields every audit/history write needs, from the verified request.
  function actor(request: FastifyRequest) {
    return {
      actorUserId: request.user.userId,
      actorRoleKey: request.auth?.roles[0] ?? request.user.role,
      actorMembershipId: request.auth?.membershipId ?? null,
      requestRef: request.id,
    };
  }

  // HOD callers are narrowed to their own department scope (design §5.7); every
  // other role sees the whole tenant. Returns a where-fragment to merge in.
  function departmentScopeFilter(request: FastifyRequest): { departmentId?: string } {
    const roles = request.auth?.roles ?? [];
    const scope = request.auth?.departmentScope ?? null;
    if (roles.includes("HOD") && !roles.includes("ADMIN") && scope) {
      return { departmentId: scope };
    }
    return {};
  }

  // Build a StudentSnapshot (the subset student-sis.ts reasons over) from a row.
  function snapshot(row: {
    status: StudentStatus;
    programId: string | null;
    program: string;
    semester: number;
    departmentId: string;
    academicSessionId: string | null;
    currentTermId: string | null;
  }): StudentSnapshot {
    return {
      status: row.status,
      programId: row.programId,
      program: row.program,
      semester: row.semester,
      departmentId: row.departmentId,
      academicSessionId: row.academicSessionId,
      currentTermId: row.currentTermId,
    };
  }

  // Persist a StudentProfileHistory row from a transition payload, in-tx.
  async function writeHistory(
    tx: Prisma.TransactionClient,
    institutionId: string,
    studentProfileId: string,
    payload: HistorySnapshotPayload,
    request: FastifyRequest,
    reason?: string | null,
  ) {
    await tx.studentProfileHistory.create({
      data: {
        institutionId,
        studentProfileId,
        changeType: payload.changeType,
        previousStatus: payload.previousStatus,
        newStatus: payload.newStatus,
        previousProgramId: payload.previousProgramId,
        newProgramId: payload.newProgramId,
        previousProgramText: payload.previousProgramText,
        newProgramText: payload.newProgramText,
        previousSemester: payload.previousSemester,
        newSemester: payload.newSemester,
        previousDepartmentId: payload.previousDepartmentId,
        newDepartmentId: payload.newDepartmentId,
        previousSessionId: payload.previousSessionId,
        newSessionId: payload.newSessionId,
        previousTermId: payload.previousTermId,
        newTermId: payload.newTermId,
        actorUserId: request.user.userId,
        actorMembershipId: request.auth?.membershipId ?? null,
        reason: reason ?? null,
      },
    });
  }

  // ─── CREATE STUDENT ─────────────────────────────────────────────────────────
  app.post("/", { preHandler: [requirePermission("students.create")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const parsed = createStudentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    const outcome = await withTenant(institutionId, async (tx) => {
      // (a) enrollmentNo collision — friendly 409 (enrollmentNo UNIQUE is the backstop)
      const existingEnrollment = await tx.studentProfile.findFirst({
        where: { enrollmentNo: data.enrollmentNo, institutionId },
        select: { id: true },
      });
      if (existingEnrollment) {
        return { error: { status: 409 as const, body: { error: "Enrollment number already registered" } } };
      }

      // (b) email collision — friendly 409
      const existingEmail = await tx.user.findFirst({ where: { email: data.email }, select: { id: true } });
      if (existingEmail) {
        return { error: { status: 409 as const, body: { error: "Email already registered" } } };
      }

      // (d) best-effort structured program resolution (§3.4 — never fatal)
      let programId: string | null = data.programId ?? null;
      if (programId) {
        const program = await tx.program.findFirst({ where: { id: programId, institutionId }, select: { id: true } });
        if (!program) programId = null; // unresolved link is a legal null state
      }
      if (!programId) {
        const match = await tx.program.findFirst({
          where: { institutionId, OR: [{ code: data.program }, { name: data.program }] },
          select: { id: true },
        });
        programId = match?.id ?? null;
      }

      // (c) create User (STUDENT, ACTIVE) + StudentProfile in one tx
      const created = await tx.user.create({
        data: {
          email: data.email,
          passwordHash: null,
          role: "STUDENT",
          accountStatus: "ACTIVE",
          institutionId,
          studentProfile: {
            create: {
              name: data.name,
              enrollmentNo: data.enrollmentNo,
              rollNumber: data.rollNumber,
              departmentId: data.departmentId,
              institutionId,
              program: data.program,
              semester: data.semester,
              section: data.section,
              dob: data.dob,
              phone: data.phone,
              address: data.address,
              admissionDate: data.admissionDate ? new Date(data.admissionDate) : null,
              status: "ACTIVE",
              programId,
            },
          },
        },
        include: { studentProfile: true },
      });

      const profile = created.studentProfile!;

      // (e) history CREATED
      await writeHistory(tx, institutionId, profile.id, createdPayload(snapshot(profile)), request);

      // (f) audit students.student.created
      await recordAuditEvent(
        {
          action: "students.student.created",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "StudentProfile",
          resourceId: profile.id,
          metadata: { enrollmentNo: profile.enrollmentNo },
        },
        tx,
      );

      return { profile };
    });

    if ("error" in outcome && outcome.error) {
      await recordAuditEvent({
        action: "students.student.created",
        result: "DENIED",
        ...actor(request),
        institutionId,
        resourceType: "StudentProfile",
        metadata: { enrollmentNo: data.enrollmentNo },
      });
      return reply.status(outcome.error.status).send(outcome.error.body);
    }

    return reply.status(201).send(outcome.profile);
  });

  // ─── UPDATE STUDENT (permitted mutable fields only) ──────────────────────────
  app.patch("/:id", { preHandler: [requirePermission("students.update")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { id } = request.params as { id: string };

    // .strict() => an unknown/forbidden key is a 400 "field not editable" (§5.2)
    const parsed = updateStudentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "field not editable", details: parsed.error.flatten() });
    }
    const data = parsed.data;

    const result = await withTenant(institutionId, async (tx) => {
      const profile = await tx.studentProfile.findFirst({
        where: { id, institutionId, ...departmentScopeFilter(request) },
      });
      if (!profile) return { notFound: true as const };

      const updated = await tx.studentProfile.update({
        where: { id: profile.id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.rollNumber !== undefined ? { rollNumber: data.rollNumber } : {}),
          ...(data.section !== undefined ? { section: data.section } : {}),
          ...(data.dob !== undefined ? { dob: data.dob } : {}),
          ...(data.phone !== undefined ? { phone: data.phone } : {}),
          ...(data.address !== undefined ? { address: data.address } : {}),
          ...(data.admissionDate !== undefined
            ? { admissionDate: data.admissionDate ? new Date(data.admissionDate) : null }
            : {}),
        },
      });

      await writeHistory(tx, institutionId, profile.id, updatedPayload(snapshot(profile)), request);

      await recordAuditEvent(
        {
          action: "students.student.updated",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "StudentProfile",
          resourceId: profile.id,
        },
        tx,
      );

      return { updated };
    });

    if ("notFound" in result) {
      return reply.status(404).send({ error: "student not found" });
    }
    return reply.send(result.updated);
  });

  // ─── ASSIGN PROGRAM ───────────────────────────────────────────────────────
  app.post("/:id/assign-program", { preHandler: [requirePermission("students.update")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { id } = request.params as { id: string };

    const parsed = assignProgramSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    const result = await withTenant(institutionId, async (tx) => {
      const profile = await tx.studentProfile.findFirst({
        where: { id, institutionId, ...departmentScopeFilter(request) },
      });
      if (!profile) return { notFound: true as const };

      const program = await tx.program.findFirst({
        where: { id: data.programId, institutionId },
        select: { id: true, name: true, status: true },
      });
      if (!program || program.status !== "ACTIVE") {
        return { badProgram: true as const };
      }

      const newProgramText = data.refreshProgramText ? program.name : profile.program;

      const updated = await tx.studentProfile.update({
        where: { id: profile.id },
        data: { programId: program.id, program: newProgramText },
      });

      await writeHistory(
        tx,
        institutionId,
        profile.id,
        programAssignedPayload(snapshot(profile), program.id, newProgramText),
        request,
      );

      await recordAuditEvent(
        {
          action: "students.student.program_assigned",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "StudentProfile",
          resourceId: profile.id,
          metadata: { programId: program.id },
        },
        tx,
      );

      return { updated };
    });

    if ("notFound" in result) {
      return reply.status(404).send({ error: "student not found" });
    }
    if ("badProgram" in result) {
      await recordAuditEvent({
        action: "students.student.program_assigned",
        result: "DENIED",
        ...actor(request),
        institutionId,
        resourceType: "StudentProfile",
        resourceId: id,
      });
      return reply.status(400).send({ error: "unknown or inactive program" });
    }
    return reply.send(result.updated);
  });

  // ─── ENROLL ───────────────────────────────────────────────────────────────
  app.post("/:id/enroll", { preHandler: [requirePermission("students.enroll")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { id } = request.params as { id: string };

    const parsed = enrollStudentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    const result = await withTenant(institutionId, async (tx) => {
      const profile = await tx.studentProfile.findFirst({
        where: { id, institutionId, ...departmentScopeFilter(request) },
      });
      if (!profile) return { notFound: true as const };

      const session = await tx.academicSession.findFirst({
        where: { id: data.academicSessionId, institutionId },
        select: { id: true },
      });
      if (!session) return { badSessionOrTerm: true as const };

      const term = await tx.academicTerm.findFirst({
        where: { id: data.currentTermId, institutionId, academicSessionId: data.academicSessionId },
        select: { id: true, ordinal: true },
      });
      if (!term) return { badSessionOrTerm: true as const };

      const newStatus: StudentStatus = data.activate ? "ACTIVE" : "ENROLLED";
      // optional semester: explicit body value wins, else derive from term ordinal
      const newSemester = data.semester ?? term.ordinal;

      const updated = await tx.studentProfile.update({
        where: { id: profile.id },
        data: {
          academicSessionId: session.id,
          currentTermId: term.id,
          status: newStatus,
          semester: newSemester,
        },
      });

      await writeHistory(
        tx,
        institutionId,
        profile.id,
        enrolledPayload(snapshot(profile), {
          status: newStatus,
          academicSessionId: session.id,
          currentTermId: term.id,
          semester: newSemester,
        }),
        request,
      );

      await recordAuditEvent(
        {
          action: "students.student.enrolled",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "StudentProfile",
          resourceId: profile.id,
          metadata: { academicSessionId: session.id, currentTermId: term.id },
        },
        tx,
      );

      return { updated };
    });

    if ("notFound" in result) {
      return reply.status(404).send({ error: "student not found" });
    }
    if ("badSessionOrTerm" in result) {
      await recordAuditEvent({
        action: "students.student.enrolled",
        result: "DENIED",
        ...actor(request),
        institutionId,
        resourceType: "StudentProfile",
        resourceId: id,
      });
      return reply.status(400).send({ error: "invalid session or term" });
    }
    return reply.send(result.updated);
  });

  // ─── PROMOTE ────────────────────────────────────────────────────────────────
  app.post("/:id/promote", { preHandler: [requirePermission("students.promote")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { id } = request.params as { id: string };

    const parsed = promoteStudentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    const result = await withTenant(institutionId, async (tx) => {
      const profile = await tx.studentProfile.findFirst({
        where: { id, institutionId, ...departmentScopeFilter(request) },
      });
      if (!profile) return { notFound: true as const };

      // Validate the target term in-tenant when supplied; else keep the current.
      let nextTermId: string | null = profile.currentTermId;
      if (data.currentTermId) {
        const term = await tx.academicTerm.findFirst({
          where: { id: data.currentTermId, institutionId },
          select: { id: true },
        });
        if (!term) return { badTerm: true as const };
        nextTermId = term.id;
      }

      const nextSemester = data.semester ?? profile.semester;

      const updated = await tx.studentProfile.update({
        where: { id: profile.id },
        data: { currentTermId: nextTermId, semester: nextSemester, status: "ACTIVE" },
      });

      await writeHistory(
        tx,
        institutionId,
        profile.id,
        promotedPayload(snapshot(profile), { currentTermId: nextTermId, semester: nextSemester }),
        request,
      );

      await recordAuditEvent(
        {
          action: "students.student.promoted",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "StudentProfile",
          resourceId: profile.id,
        },
        tx,
      );

      return { updated };
    });

    if ("notFound" in result) {
      return reply.status(404).send({ error: "student not found" });
    }
    if ("badTerm" in result) {
      await recordAuditEvent({
        action: "students.student.promoted",
        result: "DENIED",
        ...actor(request),
        institutionId,
        resourceType: "StudentProfile",
        resourceId: id,
      });
      return reply.status(400).send({ error: "invalid target term" });
    }
    return reply.send(result.updated);
  });

  // ─── TRANSFER ────────────────────────────────────────────────────────────────
  app.post("/:id/transfer", { preHandler: [requirePermission("students.update")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { id } = request.params as { id: string };

    const parsed = transferStudentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    const result = await withTenant(institutionId, async (tx) => {
      const profile = await tx.studentProfile.findFirst({
        where: { id, institutionId, ...departmentScopeFilter(request) },
      });
      if (!profile) return { notFound: true as const };

      let nextDepartmentId = profile.departmentId;
      if (data.departmentId) {
        const dept = await tx.department.findFirst({
          where: { id: data.departmentId, institutionId },
          select: { id: true },
        });
        if (!dept) return { badTarget: true as const };
        nextDepartmentId = dept.id;
      }

      let nextProgramId: string | null = profile.programId;
      let nextProgramText = profile.program;
      if (data.programId) {
        const program = await tx.program.findFirst({
          where: { id: data.programId, institutionId },
          select: { id: true, name: true },
        });
        if (!program) return { badTarget: true as const };
        nextProgramId = program.id;
        nextProgramText = program.name;
      }

      const updated = await tx.studentProfile.update({
        where: { id: profile.id },
        data: { departmentId: nextDepartmentId, programId: nextProgramId, program: nextProgramText },
      });

      await writeHistory(
        tx,
        institutionId,
        profile.id,
        transferredPayload(snapshot(profile), {
          departmentId: nextDepartmentId,
          programId: nextProgramId,
          programText: nextProgramText,
        }),
        request,
      );

      await recordAuditEvent(
        {
          action: "students.student.transferred",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "StudentProfile",
          resourceId: profile.id,
        },
        tx,
      );

      return { updated };
    });

    if ("notFound" in result) {
      return reply.status(404).send({ error: "student not found" });
    }
    if ("badTarget" in result) {
      await recordAuditEvent({
        action: "students.student.transferred",
        result: "DENIED",
        ...actor(request),
        institutionId,
        resourceType: "StudentProfile",
        resourceId: id,
      });
      return reply.status(400).send({ error: "unknown department or program" });
    }
    return reply.send(result.updated);
  });

  // ─── DEACTIVATE / ARCHIVE (never hard delete) ────────────────────────────────
  app.post("/:id/deactivate", { preHandler: [requirePermission("students.deactivate")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { id } = request.params as { id: string };

    const parsed = deactivateStudentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid status", details: parsed.error.flatten() });
    }
    const data = parsed.data;

    const result = await withTenant(institutionId, async (tx) => {
      const profile = await tx.studentProfile.findFirst({
        where: { id, institutionId, ...departmentScopeFilter(request) },
      });
      if (!profile) return { notFound: true as const };

      const updated = await tx.studentProfile.update({
        where: { id: profile.id },
        data: { status: data.status },
      });

      await writeHistory(
        tx,
        institutionId,
        profile.id,
        deactivatedPayload(snapshot(profile), data.status),
        request,
        data.reason,
      );

      await recordAuditEvent(
        {
          action: "students.student.deactivated",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "StudentProfile",
          resourceId: profile.id,
          metadata: { status: data.status },
        },
        tx,
      );

      return { updated };
    });

    if ("notFound" in result) {
      return reply.status(404).send({ error: "student not found" });
    }
    return reply.send(result.updated);
  });

  // ─── LIST / SEARCH ────────────────────────────────────────────────────────
  app.get("/", { preHandler: [requirePermission("students.view")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const parsed = listStudentsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { status, programId, departmentId, q, page, pageSize } = parsed.data;

    const where: Prisma.StudentProfileWhereInput = {
      institutionId,
      ...departmentScopeFilter(request),
      ...(status ? { status } : {}),
      ...(programId ? { programId } : {}),
      ...(departmentId ? { departmentId } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { enrollmentNo: { contains: q, mode: "insensitive" } },
              { rollNumber: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const result = await withTenant(institutionId, async (tx) => {
      const [students, total] = await Promise.all([
        tx.studentProfile.findMany({
          where,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.studentProfile.count({ where }),
      ]);
      return { students, total };
    });

    return reply.send({
      students: result.students,
      pagination: { page, pageSize, total: result.total, totalPages: Math.ceil(result.total / pageSize) },
    });
  });

  // ─── DETAIL ──────────────────────────────────────────────────────────────
  app.get("/:id", { preHandler: [requirePermission("students.view")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { id } = request.params as { id: string };

    const profile = await withTenant(institutionId, (tx) =>
      tx.studentProfile.findFirst({
        where: { id, institutionId, ...departmentScopeFilter(request) },
        include: {
          department: true,
          structuredProgram: true,
          academicSession: true,
          currentTerm: true,
        },
      }),
    );

    if (!profile) {
      return reply.status(404).send({ error: "student not found" });
    }
    return reply.send(profile);
  });

  // ─── HISTORY (append-only, newest first, paginated) ──────────────────────────
  app.get("/:id/history", { preHandler: [requirePermission("students.view")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { id } = request.params as { id: string };
    const { page = "1", pageSize = "20" } = request.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sizeNum = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));

    const result = await withTenant(institutionId, async (tx) => {
      const profile = await tx.studentProfile.findFirst({
        where: { id, institutionId, ...departmentScopeFilter(request) },
        select: { id: true },
      });
      if (!profile) return { notFound: true as const };

      const [history, total] = await Promise.all([
        tx.studentProfileHistory.findMany({
          where: { institutionId, studentProfileId: profile.id },
          orderBy: { createdAt: "desc" },
          skip: (pageNum - 1) * sizeNum,
          take: sizeNum,
        }),
        tx.studentProfileHistory.count({ where: { institutionId, studentProfileId: profile.id } }),
      ]);
      return { history, total };
    });

    if ("notFound" in result) {
      return reply.status(404).send({ error: "student not found" });
    }

    return reply.send({
      history: result.history,
      pagination: {
        page: pageNum,
        pageSize: sizeNum,
        total: result.total,
        totalPages: Math.ceil(result.total / sizeNum),
      },
    });
  });
}
