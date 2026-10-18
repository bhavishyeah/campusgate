import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { withTenant } from "@campusgate/db";
import { createGatePassSchema, PASS_NUMBER_PREFIX } from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../services/authz-engine.js";
import { notifyDepartmentHods } from "../services/notifications.js";
import { ReliabilityEngine } from "../services/reliability-engine.js";
import { AllowanceEngine } from "../services/allowance-engine.js";
import { getStudentInTenant } from "../services/authz.js";
import { buildPassTimeline, computeOutsideDurationMinutes } from "../services/pass-lifecycle.js";

export async function studentRoutes(app: FastifyInstance) {
  // Authentication runs exactly once per request via this single top-level hook
  // (replaces the former requireTenantRole("STUDENT") hook — §7). Per-route
  // requirePermission(...) below owns the access decision and does NOT re-auth.
  app.addHook("preHandler", authenticate);

  // ─── GET ACTIVE EMERGENCY ALERT ───────────────────────────────────────────
  app.get("/emergency/active", { preHandler: [requirePermission("campus_movement.emergency.view")] }, async (request, reply) => {
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
  app.get("/reasons", { preHandler: [requirePermission("campus_movement.pass.view_own")] }, async (request, reply) => {
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
  app.get("/allowance", { preHandler: [requirePermission("campus_movement.pass.view_own")] }, async (request, reply) => {
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
  app.get("/dashboard", { preHandler: [requirePermission("campus_movement.pass.view_own")] }, async (request, reply) => {
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
  app.post("/gate-pass", { preHandler: [requirePermission("campus_movement.pass.request")] }, async (request, reply) => {
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
      await tx.auditLog.create({
        data: {
          actorId: userId,
          institutionId,
          action: "PASS_REQUESTED",
          targetId: gatePass.id,
          targetType: "GatePass",
          metadata: { passNumber: gatePass.passNumber },
        },
      });

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
  app.get("/active-pass", { preHandler: [requirePermission("campus_movement.pass.view_own")] }, async (request, reply) => {
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
  app.post("/gate-pass/:passId/cancel", { preHandler: [requirePermission("campus_movement.pass.cancel")] }, async (request, reply) => {
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

      await tx.auditLog.create({
        data: {
          actorId: userId,
          institutionId,
          action: "PASS_CANCELLED",
          targetId: passId,
          targetType: "GatePass",
        },
      });

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
  app.get("/history", { preHandler: [requirePermission("campus_movement.pass.view_own")] }, async (request, reply) => {
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
  app.get("/gate-pass/:passId/timeline", { preHandler: [requirePermission("campus_movement.pass.view_own")] }, async (request, reply) => {
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

      const logs = await tx.auditLog.findMany({
        where: {
          targetType: "GatePass",
          targetId: pass.id,
          action: { in: ["PASS_REQUESTED", "PASS_APPROVED", "PASS_REJECTED", "PASS_REVOKED", "PASS_CANCELLED", "PASS_EXPIRED"] },
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
  app.get("/gate-pass/:passId/summary", { preHandler: [requirePermission("campus_movement.pass.view_own")] }, async (request, reply) => {
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
  app.get("/reliability", { preHandler: [requirePermission("campus_movement.pass.view_own")] }, async (request, reply) => {
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
}
