import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { withTenant } from "@campusgate/db";
import { createGatePassSchema, PASS_NUMBER_PREFIX } from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission, requireModuleActive } from "../services/authz-engine.js";
import { notifyDepartmentHods } from "../services/notifications.js";
import { ReliabilityEngine } from "../services/reliability-engine.js";
import { AllowanceEngine } from "../services/allowance-engine.js";
import { CalendarService } from "../services/calendar-service.js";
import { getStudentInTenant } from "../services/authz.js";
import { recordAuditEvent } from "../services/audit.js";
import { buildPassTimeline, computeOutsideDurationMinutes } from "../services/pass-lifecycle.js";

export async function studentRoutes(app: FastifyInstance) {
  // Authentication runs exactly once per request via this single top-level hook
  // (replaces the former requireTenantRole("STUDENT") hook — §7). Per-route
  // requirePermission(...) below owns the access decision and does NOT re-auth.
  app.addHook("preHandler", authenticate);

  // ─── GET ACTIVE EMERGENCY ALERT ───────────────────────────────────────────
  app.get("/emergency/active", { preHandler: [requirePermission("campus_movement.emergency.view"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const active = await withTenant(institutionId, (tx) =>
      tx.emergencyAlert.findFirst({
        where: { institutionId, status: "ACTIVE" },
        orderBy: { declaredAt: "desc" },
      }),
    );

    return reply.send(active);
  });

  // ─── GET EXIT REASONS ────────────────────────────────────────────────────────
  app.get("/reasons", { preHandler: [requirePermission("campus_movement.pass.view_own"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const reasons = await withTenant(institutionId, (tx) =>
      tx.exitReason.findMany({
        where: { institutionId, isActive: true },
        orderBy: { label: "asc" },
      }),
    );
    return reply.send(reasons);
  });

  // ─── GET ALLOWANCE SUMMARY ─────────────────────────────────────────────────
  app.get("/allowance", { preHandler: [requirePermission("campus_movement.pass.view_own"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    try {
      const summary = await withTenant(institutionId, async (tx) => {
        const student = await getStudentInTenant(userId, institutionId, tx);
        if (!student) {
          return null;
        }
        return AllowanceEngine.getRemainingAllowance(student.id, institutionId, tx);
      });

      if (!summary) {
        return reply.status(404).send({ error: "Student profile not found" });
      }

      return reply.send(summary);
    } catch (err) {
      request.log.error(err, "Failed to compute allowance");
      return reply.status(500).send({ error: "Failed to compute allowance" });
    }
  });

  // ─── GET DASHBOARD (current movement state) ────────────────────────────────
  app.get("/dashboard", { preHandler: [requirePermission("campus_movement.pass.view_own"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const result = await withTenant(institutionId, async (tx) => {
      const student = await getStudentInTenant(userId, institutionId, tx);
      if (!student) return { student: null, activePass: null };

      const activePass = await tx.gatePass.findFirst({
        where: {
          studentId: student.id,
          status: { in: ["PENDING", "APPROVED", "ACTIVE", "OUTSIDE"] },
        },
        include: {
          reason: true,
          approvedBy: true,
        },
        orderBy: { createdAt: "desc" },
      });

      return { student, activePass };
    });

    const { student, activePass } = result;

    if (!student) {
      return reply.status(404).send({ error: "Student profile not found" });
    }

    // Determine movement state
    let movementState: string;
    if (!activePass) {
      movementState = "NO_ACTIVE_REQUEST";
    } else {
      switch (activePass.status) {
        case "PENDING":
          movementState = "PENDING_APPROVAL";
          break;
        case "APPROVED":
        case "ACTIVE":
          movementState = "GATE_PASS_APPROVED";
          break;
        case "OUTSIDE":
          // Check if overdue
          if (activePass.expectedReturn && new Date() > activePass.expectedReturn) {
            movementState = "OVERDUE";
          } else {
            movementState = "CURRENTLY_OUTSIDE";
          }
          break;
        default:
          movementState = "NO_ACTIVE_REQUEST";
      }
    }

    return reply.send({
      movementState,
      activePass,
      student: {
        id: student.id,
        name: student.name,
        enrollmentNo: student.enrollmentNo,
      },
    });
  });

  // ─── CREATE GATE PASS REQUEST ──────────────────────────────────────────────
  app.post("/gate-pass", { preHandler: [requirePermission("campus_movement.pass.request"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = createGatePassSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const outcome = await withTenant(institutionId, async (tx) => {
      const student = await getStudentInTenant(userId, institutionId, tx);
      if (!student) {
        return { error: { status: 404 as const, body: { error: "Student profile not found" } } };
      }

      // Check if student already has an active pass
      const existingActive = await tx.gatePass.findFirst({
        where: {
          studentId: student.id,
          status: { in: ["PENDING", "APPROVED", "ACTIVE", "OUTSIDE"] },
        },
      });

      if (existingActive) {
        return {
          error: {
            status: 409 as const,
            body: {
              error: "You already have an active gate pass request",
              existingPassId: existingActive.id,
            },
          },
        };
      }

      // Check allowance enforcement before proceeding
      const enforcement = await AllowanceEngine.getEnforcementDecision(student.id, institutionId, tx);

      if (enforcement.action === "block") {
        return { error: { status: 403 as const, body: { error: enforcement.message } } };
      }

      // Validate reason
      const reason = await tx.exitReason.findFirst({
        where: {
          id: parsed.data.reasonId,
          institutionId,
        },
      });
      if (!reason || !reason.isActive) {
        return { error: { status: 400 as const, body: { error: "Invalid exit reason" } } };
      }

      // If reason requires note, custom reason must be provided
      if (reason.requiresNote && !parsed.data.customReason) {
        return { error: { status: 400 as const, body: { error: "Custom reason is required for this exit type" } } };
      }

      // Generate pass number: CG-YYYY-XXXXXX
      const year = new Date().getFullYear();
      const seq = nanoid(6).toUpperCase();
      const passNumber = `${PASS_NUMBER_PREFIX}-${year}-${seq}`;

      const gatePass = await tx.gatePass.create({
        data: {
          passNumber,
          institutionId,
          studentId: student.id,
          reasonId: parsed.data.reasonId,
          customReason: parsed.data.customReason,
          requestedExit: new Date(parsed.data.requestedExit),
          expectedReturn: new Date(parsed.data.expectedReturn),
          status: "PENDING",
          allowanceWarning: enforcement.action === "warn" ? enforcement.message : null,
        },
        include: { reason: true },
      });

      // Create audit log
      await recordAuditEvent(
        {
          action: "campus_movement.pass.requested",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "GatePass",
          resourceId: gatePass.id,
          requestRef: request.id,
          metadata: { passNumber: gatePass.passNumber },
        },
        tx,
      );

      // Notify HODs in student's department
      await notifyDepartmentHods(
        student.departmentId,
        {
          title: "New Gate Pass Request",
          body: `${student.name} (${student.enrollmentNo}) has requested a gate pass.`,
          type: "NEW_REQUEST",
          data: { passId: gatePass.id },
        },
        tx,
      );

      return { gatePass };
    });

    if ("error" in outcome && outcome.error) {
      return reply.status(outcome.error.status).send(outcome.error.body);
    }

    return reply.status(201).send(outcome.gatePass);
  });

  // ─── GET ACTIVE PASS (with QR) ────────────────────────────────────────────
  app.get("/active-pass", { preHandler: [requirePermission("campus_movement.pass.view_own"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const result = await withTenant(institutionId, async (tx) => {
      const student = await getStudentInTenant(userId, institutionId, tx);
      if (!student) return { student: null, activePass: null };

      const activePass = await tx.gatePass.findFirst({
        where: {
          studentId: student.id,
          status: { in: ["APPROVED", "ACTIVE", "OUTSIDE"] },
        },
        include: {
          reason: true,
          approvedBy: true,
          gateEvents: { include: { gate: true, guard: true } },
        },
      });

      return { student, activePass };
    });

    if (!result.student) {
      return reply.status(404).send({ error: "Student profile not found" });
    }

    if (!result.activePass) {
      return reply.status(404).send({ error: "No active pass found" });
    }

    return reply.send(result.activePass);
  });

  // ─── CANCEL PENDING REQUEST ────────────────────────────────────────────────
  app.post("/gate-pass/:passId/cancel", { preHandler: [requirePermission("campus_movement.pass.cancel"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { passId } = request.params as { passId: string };

    const result = await withTenant(institutionId, async (tx) => {
      const student = await getStudentInTenant(userId, institutionId, tx);
      if (!student) return { notFoundStudent: true as const };

      const pass = await tx.gatePass.findFirst({
        where: { id: passId, studentId: student.id, status: "PENDING" },
      });

      if (!pass) return { notFoundPass: true as const };

      const updated = await tx.gatePass.update({
        where: { id: passId },
        data: { status: "CANCELLED" },
      });

      await recordAuditEvent(
        {
          action: "campus_movement.pass.cancelled",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "GatePass",
          resourceId: passId,
          requestRef: request.id,
        },
        tx,
      );

      return { updated };
    });

    if ("notFoundStudent" in result) {
      return reply.status(404).send({ error: "Student profile not found" });
    }
    if ("notFoundPass" in result) {
      return reply.status(404).send({ error: "No pending pass found to cancel" });
    }

    return reply.send(result.updated);
  });

  // ─── PASS HISTORY ──────────────────────────────────────────────────────────
  app.get("/history", { preHandler: [requirePermission("campus_movement.pass.view_own"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { page = "1", limit = "10" } = request.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const result = await withTenant(institutionId, async (tx) => {
      const student = await getStudentInTenant(userId, institutionId, tx);
      if (!student) return null;

      const [passes, total] = await Promise.all([
        tx.gatePass.findMany({
          where: { studentId: student.id },
          include: {
            reason: true,
            approvedBy: true,
            gateEvents: { include: { gate: true } },
          },
          orderBy: { createdAt: "desc" },
          skip,
          take: limitNum,
        }),
        tx.gatePass.count({ where: { studentId: student.id } }),
      ]);

      return { passes, total };
    });

    if (!result) {
      return reply.status(404).send({ error: "Student profile not found" });
    }

    const { passes, total } = result;

    return reply.send({
      passes,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  });

  // ─── GET PASS TIMELINE ─────────────────────────────────────────────────────
  app.get("/gate-pass/:passId/timeline", { preHandler: [requirePermission("campus_movement.pass.view_own"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { passId } = request.params as { passId: string };

    const result = await withTenant(institutionId, async (tx) => {
      const student = await getStudentInTenant(userId, institutionId, tx);
      if (!student) return { notFoundStudent: true as const };

      const pass = await tx.gatePass.findFirst({
        where: { id: passId, studentId: student.id },
        include: {
          gateEvents: { include: { gate: true } },
        },
      });

      if (!pass) return { notFoundPass: true as const };

      const logs = await tx.auditEvent.findMany({
        where: {
          resourceType: "GatePass",
          resourceId: pass.id,
          action: {
            in: [
              "campus_movement.pass.requested",
              "campus_movement.pass.approved",
              "campus_movement.pass.rejected",
              "campus_movement.pass.revoked",
              "campus_movement.pass.cancelled",
              "campus_movement.pass.expired",
            ],
          },
        },
        orderBy: { timestamp: "asc" },
      });

      return { pass, logs };
    });

    if ("notFoundStudent" in result) {
      return reply.status(404).send({ error: "Student profile not found" });
    }
    if ("notFoundPass" in result) {
      return reply.status(404).send({ error: "Pass not found" });
    }

    const timeline = buildPassTimeline(result.pass as any, result.logs as any);
    return reply.send({ passId: result.pass.id, timeline });
  });

  // ─── GET PASS SUMMARY ──────────────────────────────────────────────────────
  app.get("/gate-pass/:passId/summary", { preHandler: [requirePermission("campus_movement.pass.view_own"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { passId } = request.params as { passId: string };

    const result = await withTenant(institutionId, async (tx) => {
      const student = await getStudentInTenant(userId, institutionId, tx);
      if (!student) return { notFoundStudent: true as const };

      const pass = await tx.gatePass.findFirst({
        where: { id: passId, studentId: student.id },
        include: {
          student: { include: { department: true } },
          reason: true,
          approvedBy: true,
          gateEvents: { include: { gate: true }, orderBy: { timestamp: "asc" } },
        },
      });

      if (!pass) return { notFoundPass: true as const };

      return { pass };
    });

    if ("notFoundStudent" in result) {
      return reply.status(404).send({ error: "Student profile not found" });
    }
    if ("notFoundPass" in result) {
      return reply.status(404).send({ error: "Pass not found" });
    }

    const pass = result.pass;
    const outsideDurationMinutes = computeOutsideDurationMinutes(pass.actualExit, pass.actualReturn);

    return reply.send({
      passId: pass.id,
      passNumber: pass.passNumber,
      status: pass.status,
      student: {
        name: pass.student.name,
        enrollmentNo: pass.student.enrollmentNo,
        department: pass.student.department.name,
      },
      reason: {
        label: pass.reason.label,
        customReason: pass.customReason,
      },
      approval: {
        approvedBy: pass.approvedBy?.name ?? null,
        approvedAt: pass.approvedAt,
        rejectionReason: pass.rejectionReason,
      },
      movement: {
        requestedExit: pass.requestedExit,
        expectedReturn: pass.expectedReturn,
        actualExit: pass.actualExit,
        actualReturn: pass.actualReturn,
        outsideDurationMinutes,
        overdueMinutes: pass.overdueMinutes,
      },
      gates: pass.gateEvents.map((e) => ({
        type: e.eventType,
        at: e.timestamp,
        gate: e.gate.name,
      })),
    });
  });

  // ─── GET RELIABILITY SCORE ─────────────────────────────────────────────────
  app.get("/reliability", { preHandler: [requirePermission("campus_movement.pass.view_own"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const result = await withTenant(institutionId, async (tx) => {
      const student = await getStudentInTenant(userId, institutionId, tx);
      if (!student) return null;
      return ReliabilityEngine.computeScore(student.id, institutionId, tx);
    });

    if (!result) {
      return reply.status(404).send({ error: "Student profile not found" });
    }

    const score = result;

    if (!score.hasSufficientData) {
      return reply.send({
        ...score,
        message: "Insufficient data to compute reliability score. Complete more gate pass movements.",
      });
    }

    return reply.send(score);
  });

  // ─── ACADEMIC READ ENDPOINTS (Phase 1 — Decision A) ─────────────────────────
  // NOTE: unlike every peer route on this file, these carry NO requireModuleActive
  // hook. Academics is FOUNDATIONAL institution-layer data, not a gated module
  // (design Decision A), so it is permission-gated (academics.view) + withTenant
  // only and is available to every tenant unconditionally.

  // The institution's single ACTIVE session + its terms.
  app.get("/me/academic/current-session", { preHandler: [requirePermission("academics.view")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const session = await withTenant(institutionId, (tx) =>
      tx.academicSession.findFirst({
        where: { institutionId, status: "ACTIVE" },
        include: {
          terms: {
            orderBy: { ordinal: "asc" },
            select: { id: true, name: true, ordinal: true, status: true, startDate: true, endDate: true },
          },
        },
      }),
    );

    return reply.send({ session, warnings: [] as Array<{ code: string; message: string }> });
  });

  // Institution-wide calendar entries for the range, plus department-scoped
  // entries ONLY for the caller's own department (from request.auth.departmentScope,
  // never from request input). The CalendarService precedence rule applies.
  app.get("/me/academic/calendar", { preHandler: [requirePermission("academics.view")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { startDate, endDate } = request.query as { startDate?: string; endDate?: string };

    const now = new Date();
    const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const defaultEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const start = startDate ? new Date(startDate) : defaultStart;
    const end = endDate ? new Date(endDate) : defaultEnd;

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      return reply.status(400).send({ error: "Invalid date range" });
    }

    const departmentScope = request.auth?.departmentScope ?? undefined;

    const entries = await withTenant(institutionId, (tx) =>
      CalendarService.getEntries(institutionId, start, end, tx, { departmentId: departmentScope }),
    );

    return reply.send({ entries, warnings: [] as Array<{ code: string; message: string }> });
  });

  // ─── SIS SELF-SERVICE (Phase 2 — Decision A) ────────────────────────────────
  // Own-record + tenant-scoped reads of the caller's own student record. Like
  // the academics reads above, these carry NO requireModuleActive hook — SIS is
  // FOUNDATIONAL institution-layer data (Decision A), permission-gated only.
  // Ownership is ALWAYS resolved via getStudentInTenant(userId, …) — never from
  // a request-supplied id — so a student can only ever read their own record.

  // The modules whose self-service entry points a student may use, keyed by the
  // module key. Only modules whose institution_modules row is ACTIVE surface
  // (ENTITLED/SUSPENDED/NOT_ENTITLED never appear — §8).
  const SELF_SERVICE_ENTRY_POINTS: Record<string, { entryPoints: string[] }> = {
    campus_movement: {
      entryPoints: [
        "gate-pass.request",
        "gate-pass.active",
        "gate-pass.history",
        "gate-pass.allowance",
        "gate-pass.reliability",
      ],
    },
  };

  // ─── GET OWN PROFILE ───────────────────────────────────────────────────────
  app.get("/me/profile", { preHandler: [requirePermission("students.view_own")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const result = await withTenant(institutionId, async (tx) => {
      const student = await getStudentInTenant(userId, institutionId, tx);
      if (!student) return null;

      const [department, structuredProgram, academicSession, currentTerm] = await Promise.all([
        tx.department.findFirst({ where: { id: student.departmentId, institutionId }, select: { id: true, name: true, code: true } }),
        student.programId
          ? tx.program.findFirst({ where: { id: student.programId, institutionId }, select: { id: true, name: true, code: true } })
          : Promise.resolve(null),
        student.academicSessionId
          ? tx.academicSession.findFirst({ where: { id: student.academicSessionId, institutionId }, select: { id: true, name: true } })
          : Promise.resolve(null),
        student.currentTermId
          ? tx.academicTerm.findFirst({ where: { id: student.currentTermId, institutionId }, select: { id: true, name: true, ordinal: true } })
          : Promise.resolve(null),
      ]);

      return { student, department, structuredProgram, academicSession, currentTerm };
    });

    if (!result) {
      return reply.status(404).send({ error: "Student profile not found" });
    }

    const { student, department, structuredProgram, academicSession, currentTerm } = result;

    return reply.send({
      id: student.id,
      name: student.name,
      enrollmentNo: student.enrollmentNo,
      rollNumber: student.rollNumber,
      email: undefined, // email lives on User; not surfaced on this profile read
      status: student.status,
      admissionDate: student.admissionDate,
      department,
      // prefer the structured program when linked, else the free-text value
      program: structuredProgram ?? { name: student.program, code: null, id: null },
      academicSession,
      // prefer the structured current term when set, else the free-text semester
      currentTerm: currentTerm ?? null,
      semester: student.semester,
      section: student.section,
    });
  });

  // ─── GET OWN ACADEMIC VIEW ───────────────────────────────────────────────────
  app.get("/me/academic", { preHandler: [requirePermission("students.view_own")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const result = await withTenant(institutionId, async (tx) => {
      const student = await getStudentInTenant(userId, institutionId, tx);
      if (!student) return null;

      const [structuredProgram, academicSession, currentTerm] = await Promise.all([
        student.programId
          ? tx.program.findFirst({ where: { id: student.programId, institutionId }, select: { id: true, name: true, code: true } })
          : Promise.resolve(null),
        student.academicSessionId
          ? tx.academicSession.findFirst({ where: { id: student.academicSessionId, institutionId }, select: { id: true, name: true, status: true } })
          : // fall back to the institution's single ACTIVE session (Phase-1 read)
            tx.academicSession.findFirst({ where: { institutionId, status: "ACTIVE" }, select: { id: true, name: true, status: true } }),
        student.currentTermId
          ? tx.academicTerm.findFirst({ where: { id: student.currentTermId, institutionId }, select: { id: true, name: true, ordinal: true } })
          : Promise.resolve(null),
      ]);

      return { student, structuredProgram, academicSession, currentTerm };
    });

    if (!result) {
      return reply.status(404).send({ error: "Student profile not found" });
    }

    const { student, structuredProgram, academicSession, currentTerm } = result;

    return reply.send({
      status: student.status,
      program: structuredProgram ?? { name: student.program, code: null, id: null },
      academicSession,
      currentTerm: currentTerm ?? null,
      semester: student.semester,
    });
  });

  // ─── GET OWN CLASS SCHEDULE (Phase 3 — own-scoped) ──────────────────────────
  // The SCHEDULED classes of the sections the caller is actively ENROLLED in.
  // Served through this dedicated own-scoped endpoint (permission classes.view_own),
  // NEVER the staff classes.view catalogue list (design A4). Ownership is resolved
  // via getStudentInTenant(userId, ...) — never a request-supplied id — so a
  // student can only ever read their own schedule. FOUNDATIONAL data: NO
  // requireModuleActive hook (design §3).
  app.get("/me/schedule", { preHandler: [requirePermission("classes.view_own")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const result = await withTenant(institutionId, async (tx) => {
      const student = await getStudentInTenant(userId, institutionId, tx);
      if (!student) return null;

      const enrollments = await tx.classEnrollment.findMany({
        where: { institutionId, studentId: student.id, status: "ENROLLED" },
        select: { classSectionId: true },
      });
      const sectionIds = enrollments.map((e) => e.classSectionId);

      if (sectionIds.length === 0) {
        return { scheduledClasses: [] as unknown[] };
      }

      const scheduledClasses = await tx.scheduledClass.findMany({
        where: {
          institutionId,
          classSectionId: { in: sectionIds },
          status: "SCHEDULED",
          timetable: { status: "PUBLISHED" },
        },
        include: {
          subject: { select: { id: true, name: true, code: true } },
          faculty: { select: { id: true, name: true } },
          classSection: { select: { id: true, label: true } },
        },
        orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
      });

      return { scheduledClasses };
    });

    if (!result) {
      return reply.status(404).send({ error: "Student profile not found" });
    }
    return reply.send(result);
  });

  // ─── GET OWN TEACHING SCHEDULE (Phase 3 — faculty own-scoped) ───────────────
  // The SCHEDULED classes taught by the caller's own FacultyProfile. Resolved by
  // the caller's FacultyProfile.id (from their userId) — never a request-supplied
  // id. Permission classes.view_own; NO requireModuleActive (foundational).
  app.get("/me/teaching-schedule", { preHandler: [requirePermission("classes.view_own")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const result = await withTenant(institutionId, async (tx) => {
      const faculty = await tx.facultyProfile.findFirst({
        where: { userId, institutionId },
        select: { id: true },
      });
      if (!faculty) return null;

      const scheduledClasses = await tx.scheduledClass.findMany({
        where: {
          institutionId,
          facultyId: faculty.id,
          status: "SCHEDULED",
          timetable: { status: "PUBLISHED" },
        },
        include: {
          subject: { select: { id: true, name: true, code: true } },
          classSection: { select: { id: true, label: true } },
        },
        orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
      });

      return { facultyId: faculty.id, scheduledClasses };
    });

    if (!result) {
      return reply.status(404).send({ error: "Faculty profile not found" });
    }
    return reply.send(result);
  });

  // ─── GET OWN SERVICES (ACTIVE modules only) ──────────────────────────────────
  app.get("/me/services", { preHandler: [requirePermission("students.view_own")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const result = await withTenant(institutionId, async (tx) => {
      const student = await getStudentInTenant(userId, institutionId, tx);
      if (!student) return null;

      const activeModules = await tx.institutionModule.findMany({
        where: { institutionId, state: "ACTIVE" },
        select: { moduleKey: true },
      });

      return activeModules.map((m) => ({
        module: m.moduleKey,
        entryPoints: SELF_SERVICE_ENTRY_POINTS[m.moduleKey]?.entryPoints ?? [],
      }));
    });

    if (!result) {
      return reply.status(404).send({ error: "Student profile not found" });
    }

    return reply.send({ services: result });
  });
}
