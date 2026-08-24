import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { prisma } from "@campusgate/db";
import { approvePassSchema, rejectPassSchema, QR_TOKEN_VALIDITY_MINUTES } from "@campusgate/shared";
import { requireRole } from "../middleware/auth.js";
import { notifyUser } from "../services/notifications.js";
import { ReliabilityEngine } from "../services/reliability-engine.js";
import { AllowanceEngine } from "../services/allowance-engine.js";

export async function hodRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireRole("HOD"));

  // ─── GET PENDING REQUESTS (for HOD's department) ───────────────────────────
  app.get("/requests", async (request, reply) => {
    const { userId } = request.user;
    const { status = "PENDING" } = request.query as { status?: string };

    const hod = await prisma.hodProfile.findUnique({
      where: { userId },
    });
    if (!hod) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }

    const validStatuses = ["PENDING", "APPROVED", "REJECTED", "ALL"];
    const statusFilter = validStatuses.includes(status) ? status : "PENDING";

    const where: any = {
      student: { departmentId: hod.departmentId },
    };

    if (statusFilter !== "ALL") {
      where.status = statusFilter;
    }

    const requests = await prisma.gatePass.findMany({
      where,
      include: {
        student: { include: { department: true } },
        reason: true,
        approvedBy: true,
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });

    return reply.send(requests);
  });

  // ─── GET SINGLE REQUEST DETAIL ─────────────────────────────────────────────
  app.get("/requests/:passId", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { passId } = request.params as { passId: string };

    const hod = await prisma.hodProfile.findUnique({
      where: { userId },
    });
    if (!hod) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }

    const pass = await prisma.gatePass.findFirst({
      where: {
        id: passId,
        student: { departmentId: hod.departmentId },
      },
      include: {
        student: { include: { department: true } },
        reason: true,
        approvedBy: true,
        gateEvents: { include: { gate: true } },
      },
    });

    if (!pass) {
      return reply.status(404).send({ error: "Request not found" });
    }

    // Include student allowance info for HOD decision-making (Req 7.1, 7.2, 7.3)
    const allowance = await AllowanceEngine.getRemainingAllowance(pass.studentId, institutionId);
    const policy = await AllowanceEngine.getOrCreatePolicy(institutionId);

    // Include reliability score as advisory information (Req 9.5, 12.3)
    const score = await ReliabilityEngine.computeScore(pass.studentId, institutionId);

    return reply.send({
      ...pass,
      allowance: { ...allowance, enforcement: policy.enforcement.toLowerCase() },
      reliabilityScore: score.hasSufficientData ? score : null,
    });
  });

  // ─── GET STUDENT RELIABILITY SCORE FOR A REQUEST ─────────────────────────
  app.get("/requests/:passId/reliability", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { passId } = request.params as { passId: string };

    const hod = await prisma.hodProfile.findUnique({
      where: { userId },
    });
    if (!hod) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }

    const pass = await prisma.gatePass.findFirst({
      where: {
        id: passId,
        student: { departmentId: hod.departmentId },
      },
    });
    if (!pass) {
      return reply.status(404).send({ error: "Request not found" });
    }

    const score = await ReliabilityEngine.computeScore(pass.studentId, institutionId);
    return reply.send(score);
  });

  // ─── GET STUDENT ALLOWANCE FOR A REQUEST ─────────────────────────────────
  app.get("/requests/:passId/allowance", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { passId } = request.params as { passId: string };

    const hod = await prisma.hodProfile.findUnique({
      where: { userId },
    });
    if (!hod) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }

    const pass = await prisma.gatePass.findFirst({
      where: {
        id: passId,
        student: { departmentId: hod.departmentId },
      },
    });
    if (!pass) {
      return reply.status(404).send({ error: "Request not found" });
    }

    const summary = await AllowanceEngine.getRemainingAllowance(pass.studentId, institutionId);
    const policy = await AllowanceEngine.getOrCreatePolicy(institutionId);
    return reply.send({ ...summary, enforcement: policy.enforcement.toLowerCase() });
  });

  // ─── EMERGENCY OVERRIDE ───────────────────────────────────────────────────
  app.post("/emergency-override", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { passId, justification } = request.body as { passId: string; justification: string };

    if (!justification || justification.length < 10) {
      return reply.status(400).send({ error: "Justification must be at least 10 characters" });
    }

    const hod = await prisma.hodProfile.findUnique({
      where: { userId },
    });
    if (!hod) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }

    // Verify pass belongs to HOD's department
    const pass = await prisma.gatePass.findFirst({
      where: {
        id: passId,
        student: { departmentId: hod.departmentId },
      },
      include: { student: true },
    });
    if (!pass) {
      return reply.status(404).send({ error: "Pass not found in your department" });
    }

    // Create override record
    const override = await prisma.emergencyOverride.create({
      data: {
        gatePassId: passId,
        overriddenById: userId,
        justification,
      },
    });

    // Create audit log entry (Req 5.3)
    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "EMERGENCY_OVERRIDE",
        targetId: passId,
        targetType: "GatePass",
        metadata: { justification, studentId: pass.studentId },
      },
    });

    return reply.status(201).send(override);
  });

  // ─── APPROVE REQUEST ───────────────────────────────────────────────────────
  app.post("/approve", async (request, reply) => {
    const { userId } = request.user;

    const parsed = approvePassSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const hod = await prisma.hodProfile.findUnique({
      where: { userId },
    });
    if (!hod) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }

    // Find the pass and verify it belongs to HOD's department
    const pass = await prisma.gatePass.findFirst({
      where: {
        id: parsed.data.passId,
        status: "PENDING",
        student: { departmentId: hod.departmentId },
      },
      include: { student: true },
    });

    if (!pass) {
      return reply
        .status(404)
        .send({ error: "Pending request not found or not in your department" });
    }

    // Generate QR token
    const qrToken = nanoid(32);
    const qrExpiresAt = new Date(
      Date.now() + QR_TOKEN_VALIDITY_MINUTES * 60 * 1000
    );

    // Atomic update: PENDING → APPROVED
    const updated = await prisma.gatePass.update({
      where: { id: pass.id, status: "PENDING" }, // Optimistic lock
      data: {
        status: "APPROVED",
        approvedById: hod.id,
        approvedAt: new Date(),
        qrToken,
        qrExpiresAt,
      },
    });

    // Audit
    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "PASS_APPROVED",
        targetId: pass.id,
        targetType: "GatePass",
        metadata: { studentId: pass.studentId, passNumber: pass.passNumber },
      },
    });

    // Notify student
    await notifyUser(pass.student.userId, {
      title: "Gate Pass Approved",
      body: `Your gate pass ${pass.passNumber} has been approved.`,
      type: "PASS_APPROVED",
      data: { passId: pass.id },
    });

    return reply.send(updated);
  });

  // ─── REJECT REQUEST ────────────────────────────────────────────────────────
  app.post("/reject", async (request, reply) => {
    const { userId } = request.user;

    const parsed = rejectPassSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const hod = await prisma.hodProfile.findUnique({
      where: { userId },
    });
    if (!hod) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }

    const pass = await prisma.gatePass.findFirst({
      where: {
        id: parsed.data.passId,
        status: "PENDING",
        student: { departmentId: hod.departmentId },
      },
      include: { student: true },
    });

    if (!pass) {
      return reply
        .status(404)
        .send({ error: "Pending request not found or not in your department" });
    }

    const updated = await prisma.gatePass.update({
      where: { id: pass.id, status: "PENDING" },
      data: {
        status: "REJECTED",
        rejectionReason: parsed.data.rejectionReason,
        approvedById: hod.id,
        approvedAt: new Date(),
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "PASS_REJECTED",
        targetId: pass.id,
        targetType: "GatePass",
        metadata: { reason: parsed.data.rejectionReason },
      },
    });

    // Notify student
    await notifyUser(pass.student.userId, {
      title: "Gate Pass Rejected",
      body: `Your gate pass ${pass.passNumber} was rejected: ${parsed.data.rejectionReason}`,
      type: "PASS_REJECTED",
      data: { passId: pass.id },
    });

    return reply.send(updated);
  });

  // ─── DASHBOARD STATS ───────────────────────────────────────────────────────
  app.get("/stats", async (request, reply) => {
    const { userId } = request.user;

    const hod = await prisma.hodProfile.findUnique({
      where: { userId },
    });
    if (!hod) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }

    const [pending, approvedToday, rejectedToday, currentlyOutside] =
      await Promise.all([
        prisma.gatePass.count({
          where: {
            status: "PENDING",
            student: { departmentId: hod.departmentId },
          },
        }),
        prisma.gatePass.count({
          where: {
            status: { in: ["APPROVED", "ACTIVE", "OUTSIDE", "COMPLETED"] },
            approvedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
            student: { departmentId: hod.departmentId },
          },
        }),
        prisma.gatePass.count({
          where: {
            status: "REJECTED",
            approvedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
            student: { departmentId: hod.departmentId },
          },
        }),
        prisma.gatePass.count({
          where: {
            status: "OUTSIDE",
            student: { departmentId: hod.departmentId },
          },
        }),
      ]);

    return reply.send({
      pending,
      approvedToday,
      rejectedToday,
      currentlyOutside,
    });
  });
}
