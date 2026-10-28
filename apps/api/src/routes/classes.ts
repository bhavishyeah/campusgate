import type { FastifyInstance, FastifyRequest } from "fastify";
import { withTenant, type Prisma } from "@campusgate/db";
import {
  createCourseSchema,
  updateCourseSchema,
  createSubjectSchema,
  updateSubjectSchema,
  createClassSectionSchema,
  updateClassSectionSchema,
  enrollClassSchema,
  createFacultyProfileSchema,
  createFacultyAssignmentSchema,
  createScheduledClassSchema,
  updateScheduledClassSchema,
  createTimetableSchema,
  publishTimetableSchema,
} from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../services/authz-engine.js";
import { recordAuditEvent } from "../services/audit.js";
import { CalendarService } from "../services/calendar-service.js";
import {
  detectTimetableConflicts,
  type SlotInput,
  type ConflictContext,
  type ConflictReport,
} from "../services/timetable-conflict.js";
import { decideEnrollment } from "../services/class-enrollment.js";
import { decideAssign, decideReassignment } from "../services/faculty-assignment.js";

/**
 * Class & Course Management routes (design §3/§4), registered at `/api/classes`
 * (see server.ts). FOUNDATIONAL institution-layer data (design §3 — the Phase
 * 1/2 precedent): permission-gated with `requirePermission("classes.<x>")`
 * ONLY, NEVER `requireModuleActive`.
 *
 * House pattern (mirrors students.ts exactly):
 *  - a single top-level `authenticate` preHandler (auth runs once per request);
 *  - per-route `requirePermission(key)` as the coarse access decision;
 *  - every handler runs inside `withTenant(institutionId, tx => ...)` with
 *    `institutionId` from the verified token (`request.user`), never from input;
 *  - every mutation writes a `classes.*` AuditEvent via `recordAuditEvent(input,
 *    tx)` in the SAME transaction;
 *  - HOD callers are narrowed to their `departmentScope` via a per-table
 *    relation-filter helper (§7.1); an out-of-scope row is 404 (not-found),
 *    matching the students.ts shape, on both reads and writes.
 */
export async function classesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  // ─── Shared helpers ────────────────────────────────────────────────────────

  // The actor fields every audit write needs, from the verified request.
  function actor(request: FastifyRequest) {
    return {
      actorUserId: request.user.userId,
      actorRoleKey: request.auth?.roles[0] ?? request.user.role,
      actorMembershipId: request.auth?.membershipId ?? null,
      requestRef: request.id,
    };
  }

  // The `kind`-parameterized HOD department-scope relation-filter (design §7.1).
  // Returns a Prisma relation-filter fragment to merge into a query `where`.
  // `{}` for ADMIN / non-HOD / no-scope callers (whole tenant). Phase-3 tables
  // do NOT carry departmentId (except FacultyProfile), so scope resolves through
  // the relation graph rather than a direct column predicate.
  type ClassesScopeKind =
    | "course"
    | "subject"
    | "section"
    | "timetable"
    | "scheduledClass"
    | "facultyProfile";

  function classesDepartmentScopeFilter(
    request: FastifyRequest,
    kind: ClassesScopeKind,
  ): Record<string, unknown> {
    const roles = request.auth?.roles ?? [];
    const scope = request.auth?.departmentScope ?? null;
    if (!(roles.includes("HOD") && !roles.includes("ADMIN") && scope)) return {};
    switch (kind) {
      case "course":
        return { program: { departmentId: scope } };
      case "section":
        return { program: { departmentId: scope } };
      case "subject":
        return { course: { program: { departmentId: scope } } };
      case "scheduledClass":
        return { classSection: { program: { departmentId: scope } } };
      case "facultyProfile":
        return { departmentId: scope };
      case "timetable":
        return {
          scheduledClasses: {
            some: { classSection: { program: { departmentId: scope } } },
          },
        };
    }
  }

  // Build a SlotInput (the conflict function's shape) from a scheduled_classes row.
  function toSlotInput(row: {
    id: string;
    classSectionId: string;
    facultyId: string;
    room: string | null;
    dayOfWeek: SlotInput["dayOfWeek"];
    date: Date | null;
    startTime: number;
    endTime: number;
    status: "SCHEDULED" | "CANCELLED";
  }): SlotInput {
    return {
      id: row.id,
      classSectionId: row.classSectionId,
      facultyId: row.facultyId,
      room: row.room,
      dayOfWeek: row.dayOfWeek,
      date: row.date ? row.date.toISOString() : null,
      startTime: row.startTime,
      endTime: row.endTime,
      status: row.status,
    };
  }

  // Coerce InstitutionConfig.workingDaysOfWeek to a validated number[] with the
  // allowance-engine guard shape (design NIT-3): Array.isArray -> map(Number) ->
  // filter 0..6 -> fallback [1..6] (Mon..Sat) when empty/absent.
  function coerceWorkingDays(raw: unknown): number[] {
    const weekdays = Array.isArray(raw)
      ? raw.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : [];
    return weekdays.length > 0 ? weekdays : [1, 2, 3, 4, 5, 6];
  }

  // Build the ConflictContext for a candidate slot: fetch the term-scoped
  // SCHEDULED existing slots (same timetable's term), the candidate's effective
  // calendar day-type (one-off dated slots only), and the coerced working days.
  async function buildConflictContext(
    tx: Prisma.TransactionClient,
    institutionId: string,
    academicTermId: string,
    candidate: SlotInput,
    departmentScope: string | null,
    excludeScheduledClassId?: string,
  ): Promise<ConflictContext> {
    const existingRows = await tx.scheduledClass.findMany({
      where: {
        institutionId,
        academicTermId,
        status: "SCHEDULED",
        ...(excludeScheduledClassId ? { id: { not: excludeScheduledClassId } } : {}),
      },
      select: {
        id: true,
        classSectionId: true,
        facultyId: true,
        room: true,
        dayOfWeek: true,
        date: true,
        startTime: true,
        endTime: true,
        status: true,
      },
    });

    // One-off (dated) candidate: resolve the calendar day-type for its date.
    let dayType = null as Awaited<ReturnType<typeof CalendarService.effectiveDayType>>;
    if (candidate.dayOfWeek === null && candidate.date) {
      dayType = await CalendarService.effectiveDayType(
        institutionId,
        new Date(candidate.date),
        tx,
        departmentScope ? { departmentId: departmentScope } : undefined,
      );
    }

    const config = await tx.institutionConfig.findUnique({
      where: { institutionId },
      select: { workingDaysOfWeek: true },
    });

    return {
      candidate,
      existing: existingRows.map(toSlotInput),
      dayType,
      workingDaysOfWeek: coerceWorkingDays(config?.workingDaysOfWeek),
    };
  }
  // ═══════════════════════════════════════════════════════════════════════════
  // COURSES
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── CREATE COURSE ──────────────────────────────────────────────────────────
  app.post("/courses", { preHandler: [requirePermission("classes.courses.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const parsed = createCourseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    const outcome = await withTenant(institutionId, async (tx) => {
      // Program must be in the caller's tenant AND (for HOD) in their scope.
      const program = await tx.program.findFirst({
        where: {
          id: data.programId,
          institutionId,
          ...scopeToProgram(request),
        },
        select: { id: true },
      });
      if (!program) return { notFound: true as const };

      if (data.academicTermId) {
        const term = await tx.academicTerm.findFirst({
          where: { id: data.academicTermId, institutionId },
          select: { id: true },
        });
        if (!term) return { badTerm: true as const };
      }

      const dupCode = await tx.course.findFirst({
        where: { institutionId, code: data.code },
        select: { id: true },
      });
      if (dupCode) return { duplicate: true as const };

      const course = await tx.course.create({
        data: {
          institutionId,
          programId: program.id,
          academicTermId: data.academicTermId ?? null,
          name: data.name,
          code: data.code,
          description: data.description ?? null,
        },
      });

      await recordAuditEvent(
        {
          action: "classes.course.created",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "Course",
          resourceId: course.id,
          metadata: { code: course.code },
        },
        tx,
      );

      return { course };
    });

    if ("notFound" in outcome) return reply.status(404).send({ error: "program not found" });
    if ("badTerm" in outcome) return reply.status(404).send({ error: "term not found" });
    if ("duplicate" in outcome) return reply.status(409).send({ error: "course code already exists" });
    return reply.status(201).send(outcome.course);
  });

  // ─── UPDATE COURSE ──────────────────────────────────────────────────────────
  app.patch("/courses/:id", { preHandler: [requirePermission("classes.courses.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { id } = request.params as { id: string };

    const parsed = updateCourseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    const result = await withTenant(institutionId, async (tx) => {
      const course = await tx.course.findFirst({
        where: { id, institutionId, ...classesDepartmentScopeFilter(request, "course") },
        select: { id: true },
      });
      if (!course) return { notFound: true as const };

      if (data.academicTermId) {
        const term = await tx.academicTerm.findFirst({
          where: { id: data.academicTermId, institutionId },
          select: { id: true },
        });
        if (!term) return { badTerm: true as const };
      }

      const updated = await tx.course.update({
        where: { id: course.id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.academicTermId !== undefined ? { academicTermId: data.academicTermId } : {}),
          ...(data.status !== undefined ? { status: data.status } : {}),
        },
      });

      await recordAuditEvent(
        {
          action: "classes.course.updated",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "Course",
          resourceId: course.id,
        },
        tx,
      );

      return { updated };
    });

    if ("notFound" in result) return reply.status(404).send({ error: "course not found" });
    if ("badTerm" in result) return reply.status(404).send({ error: "term not found" });
    return reply.send(result.updated);
  });

  // ─── LIST COURSES ───────────────────────────────────────────────────────────
  app.get("/courses", { preHandler: [requirePermission("classes.view")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const courses = await withTenant(institutionId, (tx) =>
      tx.course.findMany({
        where: { institutionId, ...classesDepartmentScopeFilter(request, "course") },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    );

    return reply.send({ courses });
  });

  // ─── COURSE DETAIL (with subjects) ──────────────────────────────────────────
  app.get("/courses/:id", { preHandler: [requirePermission("classes.view")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { id } = request.params as { id: string };

    const course = await withTenant(institutionId, (tx) =>
      tx.course.findFirst({
        where: { id, institutionId, ...classesDepartmentScopeFilter(request, "course") },
        include: { subjects: { orderBy: { createdAt: "asc" } } },
      }),
    );

    if (!course) return reply.status(404).send({ error: "course not found" });
    return reply.send(course);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SUBJECTS
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── CREATE SUBJECT ─────────────────────────────────────────────────────────
  app.post("/subjects", { preHandler: [requirePermission("classes.courses.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const parsed = createSubjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    const outcome = await withTenant(institutionId, async (tx) => {
      const course = await tx.course.findFirst({
        where: { id: data.courseId, institutionId, ...classesDepartmentScopeFilter(request, "course") },
        select: { id: true },
      });
      if (!course) return { notFound: true as const };

      const dupCode = await tx.subject.findFirst({
        where: { institutionId, code: data.code },
        select: { id: true },
      });
      if (dupCode) return { duplicate: true as const };

      const subject = await tx.subject.create({
        data: {
          institutionId,
          courseId: course.id,
          name: data.name,
          code: data.code,
          credits: data.credits ?? null,
          contactHoursPerWeek: data.contactHoursPerWeek ?? null,
        },
      });

      await recordAuditEvent(
        {
          action: "classes.subject.created",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "Subject",
          resourceId: subject.id,
          metadata: { code: subject.code },
        },
        tx,
      );

      return { subject };
    });

    if ("notFound" in outcome) return reply.status(404).send({ error: "course not found" });
    if ("duplicate" in outcome) return reply.status(409).send({ error: "subject code already exists" });
    return reply.status(201).send(outcome.subject);
  });

  // ─── UPDATE SUBJECT ─────────────────────────────────────────────────────────
  app.patch("/subjects/:id", { preHandler: [requirePermission("classes.courses.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { id } = request.params as { id: string };

    const parsed = updateSubjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    const result = await withTenant(institutionId, async (tx) => {
      const subject = await tx.subject.findFirst({
        where: { id, institutionId, ...classesDepartmentScopeFilter(request, "subject") },
        select: { id: true },
      });
      if (!subject) return { notFound: true as const };

      const updated = await tx.subject.update({
        where: { id: subject.id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.credits !== undefined ? { credits: data.credits } : {}),
          ...(data.contactHoursPerWeek !== undefined ? { contactHoursPerWeek: data.contactHoursPerWeek } : {}),
          ...(data.status !== undefined ? { status: data.status } : {}),
        },
      });

      await recordAuditEvent(
        {
          action: "classes.subject.updated",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "Subject",
          resourceId: subject.id,
        },
        tx,
      );

      return { updated };
    });

    if ("notFound" in result) return reply.status(404).send({ error: "subject not found" });
    return reply.send(result.updated);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CLASS SECTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── CREATE SECTION ─────────────────────────────────────────────────────────
  app.post("/sections", { preHandler: [requirePermission("classes.sections.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const parsed = createClassSectionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    const outcome = await withTenant(institutionId, async (tx) => {
      const program = await tx.program.findFirst({
        where: { id: data.programId, institutionId, ...scopeToProgram(request) },
        select: { id: true },
      });
      if (!program) return { notFound: true as const };

      const session = await tx.academicSession.findFirst({
        where: { id: data.academicSessionId, institutionId },
        select: { id: true },
      });
      if (!session) return { badSessionOrTerm: true as const };

      const term = await tx.academicTerm.findFirst({
        where: { id: data.academicTermId, institutionId, academicSessionId: data.academicSessionId },
        select: { id: true },
      });
      if (!term) return { badSessionOrTerm: true as const };

      const dup = await tx.classSection.findFirst({
        where: {
          institutionId,
          programId: program.id,
          academicSessionId: session.id,
          academicTermId: term.id,
          label: data.label ?? null,
        },
        select: { id: true },
      });
      if (dup) return { duplicate: true as const };

      const section = await tx.classSection.create({
        data: {
          institutionId,
          programId: program.id,
          academicSessionId: session.id,
          academicTermId: term.id,
          label: data.label ?? null,
          capacity: data.capacity ?? null,
          ...(data.status ? { status: data.status } : {}),
        },
      });

      await recordAuditEvent(
        {
          action: "classes.section.created",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "ClassSection",
          resourceId: section.id,
        },
        tx,
      );

      return { section };
    });

    if ("notFound" in outcome) return reply.status(404).send({ error: "program not found" });
    if ("badSessionOrTerm" in outcome) return reply.status(404).send({ error: "invalid session or term" });
    if ("duplicate" in outcome) return reply.status(409).send({ error: "section already exists" });
    return reply.status(201).send(outcome.section);
  });

  // ─── UPDATE SECTION ─────────────────────────────────────────────────────────
  app.patch("/sections/:id", { preHandler: [requirePermission("classes.sections.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { id } = request.params as { id: string };

    const parsed = updateClassSectionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    const result = await withTenant(institutionId, async (tx) => {
      const section = await tx.classSection.findFirst({
        where: { id, institutionId, ...classesDepartmentScopeFilter(request, "section") },
        select: { id: true },
      });
      if (!section) return { notFound: true as const };

      const updated = await tx.classSection.update({
        where: { id: section.id },
        data: {
          ...(data.label !== undefined ? { label: data.label } : {}),
          ...(data.capacity !== undefined ? { capacity: data.capacity } : {}),
          ...(data.status !== undefined ? { status: data.status } : {}),
        },
      });

      await recordAuditEvent(
        {
          action: "classes.section.updated",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "ClassSection",
          resourceId: section.id,
        },
        tx,
      );

      return { updated };
    });

    if ("notFound" in result) return reply.status(404).send({ error: "section not found" });
    return reply.send(result.updated);
  });

  // ─── LIST SECTIONS ──────────────────────────────────────────────────────────
  app.get("/sections", { preHandler: [requirePermission("classes.view")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const sections = await withTenant(institutionId, (tx) =>
      tx.classSection.findMany({
        where: { institutionId, ...classesDepartmentScopeFilter(request, "section") },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    );

    return reply.send({ sections });
  });

  // ─── SECTION DETAIL (with enrollments) ──────────────────────────────────────
  app.get("/sections/:id", { preHandler: [requirePermission("classes.view")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { id } = request.params as { id: string };

    const section = await withTenant(institutionId, (tx) =>
      tx.classSection.findFirst({
        where: { id, institutionId, ...classesDepartmentScopeFilter(request, "section") },
        include: { enrollments: { orderBy: { enrolledAt: "asc" } } },
      }),
    );

    if (!section) return reply.status(404).send({ error: "section not found" });
    return reply.send(section);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ENROLLMENT (references the shared StudentProfile — never a second copy)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── ENROLL ─────────────────────────────────────────────────────────────────
  app.post("/enroll", { preHandler: [requirePermission("classes.enroll")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const parsed = enrollClassSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    const outcome = await withTenant(institutionId, async (tx) => {
      const section = await tx.classSection.findFirst({
        where: { id: data.classSectionId, institutionId, ...classesDepartmentScopeFilter(request, "section") },
        select: { id: true, capacity: true },
      });
      if (!section) return { notFoundSection: true as const };

      // The single student identity is the shared Phase-2 StudentProfile.
      const student = await tx.studentProfile.findFirst({
        where: { id: data.studentId, institutionId },
        select: { id: true, status: true },
      });
      if (!student) return { notFoundStudent: true as const };

      const existing = await tx.classEnrollment.findFirst({
        where: { classSectionId: section.id, studentId: student.id },
        select: { id: true, status: true },
      });

      const enrolledCount = await tx.classEnrollment.count({
        where: { classSectionId: section.id, status: "ENROLLED" },
      });

      const decision = decideEnrollment({
        classSectionId: section.id,
        studentId: student.id,
        existing: existing ? { id: existing.id, status: existing.status } : null,
        capacity: section.capacity,
        enrolledCount,
      });

      if (decision.action === "reject") {
        return { reject: decision.reason };
      }

      let enrollment;
      if (decision.action === "reenroll") {
        enrollment = await tx.classEnrollment.update({
          where: { id: decision.enrollmentId },
          data: { status: "ENROLLED", enrolledAt: new Date() },
        });
      } else {
        enrollment = await tx.classEnrollment.create({
          data: {
            institutionId,
            classSectionId: section.id,
            studentId: student.id,
            status: "ENROLLED",
          },
        });
      }

      await recordAuditEvent(
        {
          action: "classes.enrollment.enrolled",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "ClassEnrollment",
          resourceId: enrollment.id,
          metadata: { classSectionId: section.id, studentId: student.id },
        },
        tx,
      );

      return { enrollment };
    });

    if ("notFoundSection" in outcome) return reply.status(404).send({ error: "section not found" });
    if ("notFoundStudent" in outcome) return reply.status(404).send({ error: "student not found" });
    if ("reject" in outcome) {
      const message = outcome.reject === "duplicate" ? "student already enrolled" : "section is at capacity";
      return reply.status(409).send({ error: message });
    }
    return reply.status(201).send(outcome.enrollment);
  });

  // ─── UNENROLL (drop) ──────────────────────────────────────────────────────
  app.post("/unenroll", { preHandler: [requirePermission("classes.enroll")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const parsed = enrollClassSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    const result = await withTenant(institutionId, async (tx) => {
      const section = await tx.classSection.findFirst({
        where: { id: data.classSectionId, institutionId, ...classesDepartmentScopeFilter(request, "section") },
        select: { id: true },
      });
      if (!section) return { notFound: true as const };

      const enrollment = await tx.classEnrollment.findFirst({
        where: { classSectionId: section.id, studentId: data.studentId, status: "ENROLLED" },
        select: { id: true },
      });
      if (!enrollment) return { notFound: true as const };

      const updated = await tx.classEnrollment.update({
        where: { id: enrollment.id },
        data: { status: "DROPPED" },
      });

      await recordAuditEvent(
        {
          action: "classes.enrollment.dropped",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "ClassEnrollment",
          resourceId: enrollment.id,
          metadata: { classSectionId: section.id, studentId: data.studentId },
        },
        tx,
      );

      return { updated };
    });

    if ("notFound" in result) return reply.status(404).send({ error: "enrollment not found" });
    return reply.send(result.updated);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FACULTY (profiles + assignment / reassignment / substitution with history)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── CREATE FACULTY PROFILE ─────────────────────────────────────────────────
  app.post("/faculty", { preHandler: [requirePermission("classes.faculty.assign")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const parsed = createFacultyProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    const outcome = await withTenant(institutionId, async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: data.userId, institutionId },
        select: { id: true },
      });
      if (!user) return { notFoundUser: true as const };

      if (data.departmentId) {
        const dept = await tx.department.findFirst({
          where: { id: data.departmentId, institutionId },
          select: { id: true },
        });
        if (!dept) return { badDept: true as const };
      }

      const existing = await tx.facultyProfile.findFirst({
        where: { userId: data.userId },
        select: { id: true },
      });
      if (existing) return { duplicate: true as const };

      const faculty = await tx.facultyProfile.create({
        data: {
          institutionId,
          userId: user.id,
          name: data.name,
          departmentId: data.departmentId ?? null,
        },
      });

      await recordAuditEvent(
        {
          action: "classes.faculty.profile_created",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "FacultyProfile",
          resourceId: faculty.id,
        },
        tx,
      );

      return { faculty };
    });

    if ("notFoundUser" in outcome) return reply.status(404).send({ error: "user not found" });
    if ("badDept" in outcome) return reply.status(404).send({ error: "department not found" });
    if ("duplicate" in outcome) return reply.status(409).send({ error: "faculty profile already exists for user" });
    return reply.status(201).send(outcome.faculty);
  });

  // ─── ASSIGN / REASSIGN / SUBSTITUTE FACULTY ─────────────────────────────────
  // A plain assign inserts a new ACTIVE assignment. When `replacesAssignmentId`
  // is present, the current ACTIVE row is soft-ended (status ACTIVE->ENDED +
  // endedAt), a new ACTIVE row is inserted, and a FACULTY_REASSIGNED
  // ScheduleRevision is written — all in ONE withTenant tx (design §6.7).
  app.post("/faculty/assign", { preHandler: [requirePermission("classes.faculty.assign")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const parsed = createFacultyAssignmentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    const outcome = await withTenant(institutionId, async (tx) => {
      const faculty = await tx.facultyProfile.findFirst({
        where: { id: data.facultyId, institutionId },
        select: { id: true },
      });
      if (!faculty) return { notFound: "faculty" as const };

      const subject = await tx.subject.findFirst({
        where: { id: data.subjectId, institutionId, ...classesDepartmentScopeFilter(request, "subject") },
        select: { id: true },
      });
      if (!subject) return { notFound: "subject" as const };

      const term = await tx.academicTerm.findFirst({
        where: { id: data.academicTermId, institutionId },
        select: { id: true },
      });
      if (!term) return { notFound: "term" as const };

      if (data.classSectionId) {
        const section = await tx.classSection.findFirst({
          where: { id: data.classSectionId, institutionId, ...classesDepartmentScopeFilter(request, "section") },
          select: { id: true },
        });
        if (!section) return { notFound: "section" as const };
      }

      // ── Reassignment / substitution swap ──────────────────────────────────
      if (data.replacesAssignmentId) {
        const current = await tx.facultyAssignment.findFirst({
          where: { id: data.replacesAssignmentId, institutionId, status: "ACTIVE" },
        });
        if (!current) return { notFound: "assignment" as const };

        const decision = decideReassignment(
          {
            id: current.id,
            facultyId: current.facultyId,
            subjectId: current.subjectId,
            classSectionId: current.classSectionId,
            academicTermId: current.academicTermId,
            role: current.role,
            status: current.status,
          },
          { facultyId: data.facultyId, role: data.role },
          new Date(),
        );
        if (decision.action !== "reassign") return { notFound: "assignment" as const };

        // 1) soft-end the current row (the ONLY permitted in-place mutation).
        await tx.facultyAssignment.update({
          where: { id: decision.end.assignmentId },
          data: { status: decision.end.status, endedAt: decision.end.endedAt },
        });

        // 2) insert the new ACTIVE row (immutable identity after insert).
        const created = await tx.facultyAssignment.create({
          data: {
            institutionId,
            facultyId: decision.newAssignment.facultyId,
            subjectId: decision.newAssignment.subjectId,
            classSectionId: decision.newAssignment.classSectionId,
            academicTermId: decision.newAssignment.academicTermId,
            role: decision.newAssignment.role,
            status: decision.newAssignment.status,
          },
        });

        // 3) append-only FACULTY_REASSIGNED revision (design §6.9 contract).
        await tx.scheduleRevision.create({
          data: {
            institutionId,
            academicTermId: decision.newAssignment.academicTermId,
            changeType: decision.revision.changeType,
            previousFacultyId: decision.revision.previousFacultyId,
            newFacultyId: decision.revision.newFacultyId,
            actorUserId: request.user.userId,
            actorMembershipId: request.auth?.membershipId ?? null,
            metadata: {
              subjectId: decision.revision.metadata.subjectId,
              classSectionId: decision.revision.metadata.classSectionId,
              role: decision.revision.metadata.role,
              endedAssignmentId: decision.revision.metadata.endedAssignmentId,
              newAssignmentId: created.id,
            } as Prisma.InputJsonValue,
          },
        });

        await recordAuditEvent(
          {
            action: "classes.faculty.substituted",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "FacultyAssignment",
            resourceId: created.id,
            metadata: { endedAssignmentId: decision.end.assignmentId, subjectId: decision.newAssignment.subjectId },
          },
          tx,
        );

        return { assignment: created, ended: decision.end.assignmentId };
      }

      // ── Fresh assignment ──────────────────────────────────────────────────
      const decision = decideAssign({
        facultyId: data.facultyId,
        subjectId: data.subjectId,
        classSectionId: data.classSectionId ?? null,
        academicTermId: data.academicTermId,
        role: data.role,
      });

      const created = await tx.facultyAssignment.create({
        data: {
          institutionId,
          facultyId: decision.newAssignment.facultyId,
          subjectId: decision.newAssignment.subjectId,
          classSectionId: decision.newAssignment.classSectionId,
          academicTermId: decision.newAssignment.academicTermId,
          role: decision.newAssignment.role,
          status: decision.newAssignment.status,
        },
      });

      await recordAuditEvent(
        {
          action: "classes.faculty.assigned",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "FacultyAssignment",
          resourceId: created.id,
          metadata: { subjectId: decision.newAssignment.subjectId },
        },
        tx,
      );

      return { assignment: created };
    });

    if ("notFound" in outcome) return reply.status(404).send({ error: `${outcome.notFound} not found` });
    return reply.status(201).send(outcome.assignment);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TIMETABLE + SCHEDULED CLASSES (with conflict detection)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── CREATE TIMETABLE ───────────────────────────────────────────────────────
  app.post("/timetables", { preHandler: [requirePermission("classes.timetable.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const parsed = createTimetableSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    const outcome = await withTenant(institutionId, async (tx) => {
      const term = await tx.academicTerm.findFirst({
        where: { id: data.academicTermId, institutionId },
        select: { id: true },
      });
      if (!term) return { notFound: true as const };

      const timetable = await tx.timetable.create({
        data: { institutionId, academicTermId: term.id, name: data.name },
      });

      await tx.scheduleRevision.create({
        data: {
          institutionId,
          timetableId: timetable.id,
          academicTermId: term.id,
          changeType: "TIMETABLE_CREATED",
          newStatus: timetable.status,
          actorUserId: request.user.userId,
          actorMembershipId: request.auth?.membershipId ?? null,
          metadata: { timetableId: timetable.id } as Prisma.InputJsonValue,
        },
      });

      await recordAuditEvent(
        {
          action: "classes.timetable.created",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "Timetable",
          resourceId: timetable.id,
        },
        tx,
      );

      return { timetable };
    });

    if ("notFound" in outcome) return reply.status(404).send({ error: "term not found" });
    return reply.status(201).send(outcome.timetable);
  });

  // ─── LIST TIMETABLES ────────────────────────────────────────────────────────
  app.get("/timetables", { preHandler: [requirePermission("classes.view")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const timetables = await withTenant(institutionId, (tx) =>
      tx.timetable.findMany({
        where: { institutionId, ...classesDepartmentScopeFilter(request, "timetable") },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    );

    return reply.send({ timetables });
  });

  // ─── TIMETABLE DETAIL (with scheduled classes) ──────────────────────────────
  app.get("/timetables/:id", { preHandler: [requirePermission("classes.view")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { id } = request.params as { id: string };

    const timetable = await withTenant(institutionId, (tx) =>
      tx.timetable.findFirst({
        where: { id, institutionId, ...classesDepartmentScopeFilter(request, "timetable") },
        include: { scheduledClasses: { orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }] } },
      }),
    );

    if (!timetable) return reply.status(404).send({ error: "timetable not found" });
    return reply.send(timetable);
  });

  // ─── ADD SCHEDULED CLASS (conflict-checked) ─────────────────────────────────
  app.post("/scheduled-classes", { preHandler: [requirePermission("classes.timetable.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const departmentScope = request.auth?.departmentScope ?? null;

    const parsed = createScheduledClassSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    const outcome = await withTenant(institutionId, async (tx) => {
      // Timetable must be in scope; a published timetable edit writes a revision.
      const timetable = await tx.timetable.findFirst({
        where: { id: data.timetableId, institutionId },
        select: { id: true, status: true, academicTermId: true },
      });
      if (!timetable) return { notFound: "timetable" as const };

      // The section gates the HOD department scope on writes (§7.1).
      const section = await tx.classSection.findFirst({
        where: { id: data.classSectionId, institutionId, ...classesDepartmentScopeFilter(request, "section") },
        select: { id: true },
      });
      if (!section) return { notFound: "section" as const };

      const subject = await tx.subject.findFirst({
        where: { id: data.subjectId, institutionId },
        select: { id: true },
      });
      if (!subject) return { notFound: "subject" as const };

      const faculty = await tx.facultyProfile.findFirst({
        where: { id: data.facultyId, institutionId },
        select: { id: true },
      });
      if (!faculty) return { notFound: "faculty" as const };

      const candidate: SlotInput = {
        classSectionId: data.classSectionId,
        facultyId: data.facultyId,
        room: data.room ?? null,
        dayOfWeek: data.dayOfWeek ?? null,
        date: data.date ?? null,
        startTime: data.startTime,
        endTime: data.endTime,
        status: "SCHEDULED",
      };

      const ctx = await buildConflictContext(tx, institutionId, data.academicTermId, candidate, departmentScope);
      const report = detectTimetableConflicts(ctx);

      if (report.blocking.length > 0) {
        return { conflict: report };
      }

      const created = await tx.scheduledClass.create({
        data: {
          institutionId,
          timetableId: timetable.id,
          classSectionId: data.classSectionId,
          subjectId: data.subjectId,
          facultyId: data.facultyId,
          academicTermId: data.academicTermId,
          room: data.room ?? null,
          dayOfWeek: data.dayOfWeek ?? null,
          date: data.date ? new Date(data.date) : null,
          startTime: data.startTime,
          endTime: data.endTime,
          period: data.period ?? null,
          status: "SCHEDULED",
        },
      });

      // A published timetable records the add as an append-only revision (§6.9).
      if (timetable.status === "PUBLISHED") {
        await tx.scheduleRevision.create({
          data: {
            institutionId,
            timetableId: timetable.id,
            scheduledClassId: created.id,
            academicTermId: data.academicTermId,
            changeType: "SCHEDULED_CLASS_ADDED",
            newFacultyId: created.facultyId,
            newRoom: created.room,
            newStartTime: created.startTime,
            newEndTime: created.endTime,
            newStatus: created.status,
            actorUserId: request.user.userId,
            actorMembershipId: request.auth?.membershipId ?? null,
            metadata: { classSectionId: created.classSectionId, subjectId: created.subjectId } as Prisma.InputJsonValue,
          },
        });
      }

      await recordAuditEvent(
        {
          action: "classes.scheduled_class.added",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "ScheduledClass",
          resourceId: created.id,
        },
        tx,
      );

      return { scheduledClass: created, warnings: report.warnings };
    });

    if ("notFound" in outcome) return reply.status(404).send({ error: `${outcome.notFound} not found` });
    if ("conflict" in outcome) {
      return reply.status(409).send({ error: "Timetable conflict", conflicts: outcome.conflict });
    }
    return reply.status(201).send({ scheduledClass: outcome.scheduledClass, warnings: outcome.warnings });
  });

  // ─── UPDATE SCHEDULED CLASS (conflict-checked) ──────────────────────────────
  app.patch("/scheduled-classes/:id", { preHandler: [requirePermission("classes.timetable.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const departmentScope = request.auth?.departmentScope ?? null;
    const { id } = request.params as { id: string };

    const parsed = updateScheduledClassSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    const outcome = await withTenant(institutionId, async (tx) => {
      const existing = await tx.scheduledClass.findFirst({
        where: { id, institutionId, ...classesDepartmentScopeFilter(request, "scheduledClass") },
      });
      if (!existing) return { notFound: true as const };

      const timetable = await tx.timetable.findFirst({
        where: { id: existing.timetableId, institutionId },
        select: { id: true, status: true },
      });

      const merged = {
        classSectionId: data.classSectionId ?? existing.classSectionId,
        facultyId: data.facultyId ?? existing.facultyId,
        subjectId: data.subjectId ?? existing.subjectId,
        academicTermId: data.academicTermId ?? existing.academicTermId,
        room: data.room !== undefined ? data.room : existing.room,
        dayOfWeek: data.dayOfWeek !== undefined ? data.dayOfWeek : existing.dayOfWeek,
        date: data.date !== undefined ? data.date : existing.date ? existing.date.toISOString() : null,
        startTime: data.startTime ?? existing.startTime,
        endTime: data.endTime ?? existing.endTime,
        period: data.period !== undefined ? data.period : existing.period,
      };

      const candidate: SlotInput = {
        id: existing.id,
        classSectionId: merged.classSectionId,
        facultyId: merged.facultyId,
        room: merged.room,
        dayOfWeek: merged.dayOfWeek,
        date: merged.date,
        startTime: merged.startTime,
        endTime: merged.endTime,
        status: "SCHEDULED",
      };

      const ctx = await buildConflictContext(tx, institutionId, merged.academicTermId, candidate, departmentScope, existing.id);
      const report = detectTimetableConflicts(ctx);
      if (report.blocking.length > 0) {
        return { conflict: report };
      }

      const updated = await tx.scheduledClass.update({
        where: { id: existing.id },
        data: {
          classSectionId: merged.classSectionId,
          facultyId: merged.facultyId,
          subjectId: merged.subjectId,
          academicTermId: merged.academicTermId,
          room: merged.room,
          dayOfWeek: merged.dayOfWeek,
          date: merged.date ? new Date(merged.date) : null,
          startTime: merged.startTime,
          endTime: merged.endTime,
          period: merged.period,
        },
      });

      if (timetable?.status === "PUBLISHED") {
        await tx.scheduleRevision.create({
          data: {
            institutionId,
            timetableId: timetable.id,
            scheduledClassId: updated.id,
            academicTermId: updated.academicTermId,
            changeType: "SCHEDULED_CLASS_UPDATED",
            previousFacultyId: existing.facultyId,
            newFacultyId: updated.facultyId,
            previousRoom: existing.room,
            newRoom: updated.room,
            previousStartTime: existing.startTime,
            newStartTime: updated.startTime,
            previousEndTime: existing.endTime,
            newEndTime: updated.endTime,
            actorUserId: request.user.userId,
            actorMembershipId: request.auth?.membershipId ?? null,
            metadata: { classSectionId: updated.classSectionId, subjectId: updated.subjectId } as Prisma.InputJsonValue,
          },
        });
      }

      await recordAuditEvent(
        {
          action: "classes.scheduled_class.updated",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "ScheduledClass",
          resourceId: updated.id,
        },
        tx,
      );

      return { scheduledClass: updated, warnings: report.warnings };
    });

    if ("notFound" in outcome) return reply.status(404).send({ error: "scheduled class not found" });
    if ("conflict" in outcome) {
      return reply.status(409).send({ error: "Timetable conflict", conflicts: outcome.conflict });
    }
    return reply.send({ scheduledClass: outcome.scheduledClass, warnings: outcome.warnings });
  });

  // ─── CANCEL SCHEDULED CLASS ─────────────────────────────────────────────────
  app.post("/scheduled-classes/:id/cancel", { preHandler: [requirePermission("classes.timetable.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { id } = request.params as { id: string };

    const result = await withTenant(institutionId, async (tx) => {
      const existing = await tx.scheduledClass.findFirst({
        where: { id, institutionId, ...classesDepartmentScopeFilter(request, "scheduledClass") },
      });
      if (!existing) return { notFound: true as const };

      const timetable = await tx.timetable.findFirst({
        where: { id: existing.timetableId, institutionId },
        select: { id: true, status: true },
      });

      const updated = await tx.scheduledClass.update({
        where: { id: existing.id },
        data: { status: "CANCELLED" },
      });

      if (timetable?.status === "PUBLISHED") {
        await tx.scheduleRevision.create({
          data: {
            institutionId,
            timetableId: timetable.id,
            scheduledClassId: updated.id,
            academicTermId: updated.academicTermId,
            changeType: "SCHEDULED_CLASS_CANCELLED",
            previousStatus: existing.status,
            newStatus: "CANCELLED",
            actorUserId: request.user.userId,
            actorMembershipId: request.auth?.membershipId ?? null,
            metadata: { classSectionId: updated.classSectionId, subjectId: updated.subjectId } as Prisma.InputJsonValue,
          },
        });
      }

      await recordAuditEvent(
        {
          action: "classes.scheduled_class.cancelled",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "ScheduledClass",
          resourceId: updated.id,
        },
        tx,
      );

      return { updated };
    });

    if ("notFound" in result) return reply.status(404).send({ error: "scheduled class not found" });
    return reply.send(result.updated);
  });

  // ─── DRY-RUN CONFLICT CHECK ─────────────────────────────────────────────────
  // Returns the ConflictReport for the whole timetable (every SCHEDULED slot
  // checked against the others) WITHOUT writing. Gated by classes.timetable.manage
  // (design NIT-4). Used by the UI to surface conflicts before publish.
  app.post("/timetables/:id/check", { preHandler: [requirePermission("classes.timetable.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const departmentScope = request.auth?.departmentScope ?? null;
    const { id } = request.params as { id: string };

    const outcome = await withTenant(institutionId, async (tx) => {
      const timetable = await tx.timetable.findFirst({
        where: { id, institutionId },
        select: { id: true, academicTermId: true },
      });
      if (!timetable) return { notFound: true as const };

      const report = await evaluateTimetable(tx, institutionId, timetable.id, timetable.academicTermId, departmentScope);
      return { report };
    });

    if ("notFound" in outcome) return reply.status(404).send({ error: "timetable not found" });
    return reply.send({ conflicts: outcome.report });
  });

  // ─── PUBLISH TIMETABLE ──────────────────────────────────────────────────────
  // DRAFT->PUBLISHED transition. Re-runs conflict detection across every
  // SCHEDULED slot and hard-blocks (409) if ANY blocking conflict exists
  // (design A7); warnings never block. Writes a TIMETABLE_PUBLISHED revision.
  app.post("/timetables/:id/publish", { preHandler: [requirePermission("classes.timetable.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const departmentScope = request.auth?.departmentScope ?? null;
    const { id } = request.params as { id: string };

    const parsed = publishTimetableSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const outcome = await withTenant(institutionId, async (tx) => {
      const timetable = await tx.timetable.findFirst({
        where: { id, institutionId },
        select: { id: true, status: true, academicTermId: true },
      });
      if (!timetable) return { notFound: true as const };

      // Illegal transition: only DRAFT may be published.
      if (timetable.status !== "DRAFT") {
        return { illegalTransition: timetable.status };
      }

      const report = await evaluateTimetable(tx, institutionId, timetable.id, timetable.academicTermId, departmentScope);
      if (report.blocking.length > 0) {
        return { conflict: report };
      }

      const published = await tx.timetable.update({
        where: { id: timetable.id },
        data: { status: "PUBLISHED", publishedAt: new Date() },
      });

      await tx.scheduleRevision.create({
        data: {
          institutionId,
          timetableId: published.id,
          academicTermId: published.academicTermId,
          changeType: "TIMETABLE_PUBLISHED",
          newStatus: published.status,
          actorUserId: request.user.userId,
          actorMembershipId: request.auth?.membershipId ?? null,
          metadata: { timetableId: published.id } as Prisma.InputJsonValue,
        },
      });

      await recordAuditEvent(
        {
          action: "classes.timetable.published",
          result: "SUCCESS",
          ...actor(request),
          institutionId,
          resourceType: "Timetable",
          resourceId: published.id,
        },
        tx,
      );

      return { timetable: published, warnings: report.warnings };
    });

    if ("notFound" in outcome) return reply.status(404).send({ error: "timetable not found" });
    if ("illegalTransition" in outcome) {
      return reply.status(409).send({ error: `cannot publish a ${outcome.illegalTransition} timetable` });
    }
    if ("conflict" in outcome) {
      return reply.status(409).send({ error: "Timetable conflict", conflicts: outcome.conflict });
    }
    return reply.send({ timetable: outcome.timetable, warnings: outcome.warnings });
  });

  // Evaluate every SCHEDULED slot of a timetable against the term's other slots,
  // aggregating the ConflictReport. Used by /check and /publish.
  async function evaluateTimetable(
    tx: Prisma.TransactionClient,
    institutionId: string,
    timetableId: string,
    academicTermId: string,
    departmentScope: string | null,
  ): Promise<ConflictReport> {
    const slots = await tx.scheduledClass.findMany({
      where: { institutionId, timetableId, status: "SCHEDULED" },
      select: {
        id: true,
        classSectionId: true,
        facultyId: true,
        room: true,
        dayOfWeek: true,
        date: true,
        startTime: true,
        endTime: true,
        status: true,
      },
    });

    const aggregated: ConflictReport = { blocking: [], warnings: [] };
    for (const slot of slots) {
      const candidate = toSlotInput(slot);
      const ctx = await buildConflictContext(tx, institutionId, academicTermId, candidate, departmentScope, slot.id);
      const report = detectTimetableConflicts(ctx);
      aggregated.blocking.push(...report.blocking);
      aggregated.warnings.push(...report.warnings);
    }
    return aggregated;
  }

  // Program-level scope for HOD on create (the program IS the department anchor).
  function scopeToProgram(request: FastifyRequest): Record<string, unknown> {
    const roles = request.auth?.roles ?? [];
    const scope = request.auth?.departmentScope ?? null;
    if (roles.includes("HOD") && !roles.includes("ADMIN") && scope) {
      return { departmentId: scope };
    }
    return {};
  }
}
