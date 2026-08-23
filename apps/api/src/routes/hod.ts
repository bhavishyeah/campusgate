import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { prisma } from "@campusgate/db";
import { approvePassSchema, rejectPassSchema, QR_TOKEN_VALIDITY_MINUTES } from "@campusgate/shared";
import { requireRole } from "../middleware/auth.js";
import { notifyUser } from "../services/notifications.js";

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
    const { userId } = request.user;
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

    return reply.send(pass);
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
