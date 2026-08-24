import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { prisma } from "@campusgate/db";
import { createGatePassSchema, PASS_NUMBER_PREFIX } from "@campusgate/shared";
import { requireRole } from "../middleware/auth.js";
import { notifyDepartmentHods } from "../services/notifications.js";
import { ReliabilityEngine } from "../services/reliability-engine.js";
import { AllowanceEngine } from "../services/allowance-engine.js";

export async function studentRoutes(app: FastifyInstance) {
  // All student routes require STUDENT role
  app.addHook("preHandler", requireRole("STUDENT"));

  // ─── GET EXIT REASONS ────────────────────────────────────────────────────────
  app.get("/reasons", async (request, reply) => {
    const { institutionId } = request.user;
    const reasons = await prisma.exitReason.findMany({
      where: { institutionId, isActive: true },
      orderBy: { label: "asc" },
    });
    return reply.send(reasons);
  });

  // ─── GET ALLOWANCE SUMMARY ─────────────────────────────────────────────────
  app.get("/allowance", async (request, reply) => {
    const { userId, institutionId } = request.user;

    const student = await prisma.studentProfile.findUnique({
      where: { userId },
    });
    if (!student) {
      return reply.status(404).send({ error: "Student profile not found" });
    }

    const summary = await AllowanceEngine.getRemainingAllowance(student.id, institutionId);
    return reply.send(summary);
  });

  // ─── GET DASHBOARD (current movement state) ────────────────────────────────
  app.get("/dashboard", async (request, reply) => {
    const { userId } = request.user;

    const student = await prisma.studentProfile.findUnique({
      where: { userId },
    });

    if (!student) {
      return reply.status(404).send({ error: "Student profile not found" });
    }

    // Get the most recent active pass
    const activePass = await prisma.gatePass.findFirst({
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
  app.post("/gate-pass", async (request, reply) => {
    const { userId } = request.user;

    const parsed = createGatePassSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const student = await prisma.studentProfile.findUnique({
      where: { userId },
    });
    if (!student) {
      return reply.status(404).send({ error: "Student profile not found" });
    }

    // Check if student already has an active pass
    const existingActive = await prisma.gatePass.findFirst({
      where: {
        studentId: student.id,
        status: { in: ["PENDING", "APPROVED", "ACTIVE", "OUTSIDE"] },
      },
    });

    if (existingActive) {
      return reply.status(409).send({
        error: "You already have an active gate pass request",
        existingPassId: existingActive.id,
      });
    }

    // Check allowance enforcement before proceeding
    const enforcement = await AllowanceEngine.getEnforcementDecision(student.id, request.user.institutionId);

    if (enforcement.action === "block") {
      return reply.status(403).send({ error: enforcement.message });
    }

    // Validate reason
    const reason = await prisma.exitReason.findUnique({
      where: { id: parsed.data.reasonId },
    });
    if (!reason || !reason.isActive) {
      return reply.status(400).send({ error: "Invalid exit reason" });
    }

    // If reason requires note, custom reason must be provided
    if (reason.requiresNote && !parsed.data.customReason) {
      return reply.status(400).send({ error: "Custom reason is required for this exit type" });
    }

    // Generate pass number: CG-YYYY-XXXXXX
    const year = new Date().getFullYear();
    const seq = nanoid(6).toUpperCase();
    const passNumber = `${PASS_NUMBER_PREFIX}-${year}-${seq}`;

    const gatePass = await prisma.gatePass.create({
      data: {
        passNumber,
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
    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "PASS_REQUESTED",
        targetId: gatePass.id,
        targetType: "GatePass",
        metadata: { passNumber: gatePass.passNumber },
      },
    });

    // Notify HODs in student's department
    await notifyDepartmentHods(student.departmentId, {
      title: "New Gate Pass Request",
      body: `${student.name} (${student.enrollmentNo}) has requested a gate pass.`,
      type: "NEW_REQUEST",
      data: { passId: gatePass.id },
    });

    return reply.status(201).send(gatePass);
  });

  // ─── GET ACTIVE PASS (with QR) ────────────────────────────────────────────
  app.get("/active-pass", async (request, reply) => {
    const { userId } = request.user;

    const student = await prisma.studentProfile.findUnique({
      where: { userId },
    });
    if (!student) {
      return reply.status(404).send({ error: "Student profile not found" });
    }

    const activePass = await prisma.gatePass.findFirst({
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

    if (!activePass) {
      return reply.status(404).send({ error: "No active pass found" });
    }

    return reply.send(activePass);
  });

  // ─── CANCEL PENDING REQUEST ────────────────────────────────────────────────
  app.post("/gate-pass/:passId/cancel", async (request, reply) => {
    const { userId } = request.user;
    const { passId } = request.params as { passId: string };

    const student = await prisma.studentProfile.findUnique({
      where: { userId },
    });
    if (!student) {
      return reply.status(404).send({ error: "Student profile not found" });
    }

    const pass = await prisma.gatePass.findFirst({
      where: { id: passId, studentId: student.id, status: "PENDING" },
    });

    if (!pass) {
      return reply.status(404).send({ error: "No pending pass found to cancel" });
    }

    const updated = await prisma.gatePass.update({
      where: { id: passId },
      data: { status: "CANCELLED" },
    });

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "PASS_CANCELLED",
        targetId: passId,
        targetType: "GatePass",
      },
    });

    return reply.send(updated);
  });

  // ─── PASS HISTORY ──────────────────────────────────────────────────────────
  app.get("/history", async (request, reply) => {
    const { userId } = request.user;
    const { page = "1", limit = "10" } = request.query as Record<string, string>;

    const student = await prisma.studentProfile.findUnique({
      where: { userId },
    });
    if (!student) {
      return reply.status(404).send({ error: "Student profile not found" });
    }

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [passes, total] = await Promise.all([
      prisma.gatePass.findMany({
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
      prisma.gatePass.count({ where: { studentId: student.id } }),
    ]);

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

  // ─── GET RELIABILITY SCORE ─────────────────────────────────────────────────
  app.get("/reliability", async (request, reply) => {
    const { userId, institutionId } = request.user;

    const student = await prisma.studentProfile.findUnique({
      where: { userId },
    });
    if (!student) {
      return reply.status(404).send({ error: "Student profile not found" });
    }

    const score = await ReliabilityEngine.computeScore(student.id, institutionId);

    if (!score.hasSufficientData) {
      return reply.send({
        ...score,
        message: "Insufficient data to compute reliability score. Complete more gate pass movements.",
      });
    }

    return reply.send(score);
  });
}
