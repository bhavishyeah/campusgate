import type { FastifyInstance } from "fastify";
import { prisma } from "@campusgate/db";
import { verifyQrSchema, markExitSchema, markReturnSchema } from "@campusgate/shared";
import { requireRole } from "../middleware/auth.js";

export async function guardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireRole("GUARD"));

  // ─── VERIFY QR TOKEN ───────────────────────────────────────────────────────
  app.post("/verify", async (request, reply) => {
    const parsed = verifyQrSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const { qrToken } = parsed.data;

    const pass = await prisma.gatePass.findUnique({
      where: { qrToken },
      include: {
        student: { include: { department: true } },
        reason: true,
        approvedBy: true,
        gateEvents: { include: { gate: true } },
      },
    });

    // Validation chain (Section 20 of spec)
    if (!pass) {
      return reply.send({
        valid: false,
        status: "INVALID",
        message: "Pass not found",
      });
    }

    if (pass.status === "REVOKED") {
      return reply.send({
        valid: false,
        status: "REVOKED",
        message: "This pass has been revoked",
      });
    }

    if (pass.status === "EXPIRED" || (pass.qrExpiresAt && new Date() > pass.qrExpiresAt)) {
      return reply.send({
        valid: false,
        status: "EXPIRED",
        message: "This pass has expired",
      });
    }

    if (pass.status === "COMPLETED") {
      return reply.send({
        valid: false,
        status: "COMPLETED",
        message: "This pass has already been completed",
      });
    }

    if (pass.status === "CANCELLED") {
      return reply.send({
        valid: false,
        status: "CANCELLED",
        message: "This pass was cancelled",
      });
    }

    if (pass.status === "REJECTED") {
      return reply.send({
        valid: false,
        status: "REJECTED",
        message: "This pass was rejected",
      });
    }

    if (pass.status === "PENDING") {
      return reply.send({
        valid: false,
        status: "PENDING",
        message: "This pass has not been approved yet",
      });
    }

    // Check overdue for warning
    const isOverdue =
      pass.status === "OUTSIDE" &&
      pass.expectedReturn &&
      new Date() > pass.expectedReturn;

    // Determine action available
    let action: string;
    if (pass.status === "APPROVED" || pass.status === "ACTIVE") {
      action = "MARK_EXIT";
    } else if (pass.status === "OUTSIDE") {
      action = "MARK_RETURN";
    } else {
      action = "NONE";
    }

    return reply.send({
      valid: true,
      status: isOverdue ? "OVERDUE" : pass.status,
      action,
      message: isOverdue
        ? "Student is overdue for return"
        : "Pass verified successfully",
      pass: {
        id: pass.id,
        passNumber: pass.passNumber,
        student: {
          name: pass.student.name,
          enrollmentNo: pass.student.enrollmentNo,
          department: pass.student.department.name,
          program: pass.student.program,
        },
        reason: pass.reason.label,
        customReason: pass.customReason,
        approvedBy: pass.approvedBy?.name,
        approvedAt: pass.approvedAt,
        requestedExit: pass.requestedExit,
        expectedReturn: pass.expectedReturn,
        actualExit: pass.actualExit,
        actualReturn: pass.actualReturn,
      },
    });
  });

  // ─── MARK EXIT ─────────────────────────────────────────────────────────────
  app.post("/mark-exit", async (request, reply) => {
    const { userId } = request.user;

    const parsed = markExitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const guard = await prisma.guardProfile.findUnique({
      where: { userId },
    });
    if (!guard) {
      return reply.status(404).send({ error: "Guard profile not found" });
    }

    // Verify guard is assigned to this gate
    const assignment = await prisma.guardGateAssignment.findUnique({
      where: { guardId_gateId: { guardId: guard.id, gateId: parsed.data.gateId } },
    });
    if (!assignment) {
      return reply.status(403).send({ error: "You are not assigned to this gate" });
    }

    // Atomic state transition: APPROVED/ACTIVE → OUTSIDE
    // Using a transaction to prevent concurrent duplicate exits
    try {
      const result = await prisma.$transaction(async (tx) => {
        const pass = await tx.gatePass.findUnique({
          where: { id: parsed.data.passId },
        });

        if (!pass) {
          throw new Error("Pass not found");
        }

        if (pass.status !== "APPROVED" && pass.status !== "ACTIVE") {
          throw new Error(
            `Cannot mark exit: pass is in ${pass.status} state`
          );
        }

        // Update pass status
        const updatedPass = await tx.gatePass.update({
          where: { id: pass.id },
          data: {
            status: "OUTSIDE",
            actualExit: new Date(),
          },
        });

        // Create gate event
        await tx.gateEvent.create({
          data: {
            passId: pass.id,
            gateId: parsed.data.gateId,
            guardId: guard.id,
            eventType: "EXIT",
            method: "QR_SCAN",
          },
        });

        return updatedPass;
      });

      // Audit (outside transaction for performance)
      await prisma.auditLog.create({
        data: {
          actorId: userId,
          action: "GATE_EXIT",
          targetId: parsed.data.passId,
          targetType: "GatePass",
          metadata: { gateId: parsed.data.gateId },
        },
      });

      return reply.send({
        success: true,
        message: "Exit recorded successfully",
        pass: result,
      });
    } catch (error: any) {
      return reply.status(409).send({
        success: false,
        error: error.message || "Failed to mark exit",
      });
    }
  });

  // ─── MARK RETURN ───────────────────────────────────────────────────────────
  app.post("/mark-return", async (request, reply) => {
    const { userId } = request.user;

    const parsed = markReturnSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const guard = await prisma.guardProfile.findUnique({
      where: { userId },
    });
    if (!guard) {
      return reply.status(404).send({ error: "Guard profile not found" });
    }

    // Verify guard is assigned to this gate
    const assignment = await prisma.guardGateAssignment.findUnique({
      where: { guardId_gateId: { guardId: guard.id, gateId: parsed.data.gateId } },
    });
    if (!assignment) {
      return reply.status(403).send({ error: "You are not assigned to this gate" });
    }

    // Atomic state transition: OUTSIDE → COMPLETED
    try {
      const result = await prisma.$transaction(async (tx) => {
        const pass = await tx.gatePass.findUnique({
          where: { id: parsed.data.passId },
        });

        if (!pass) {
          throw new Error("Pass not found");
        }

        if (pass.status !== "OUTSIDE") {
          throw new Error(
            `Cannot mark return: pass is in ${pass.status} state`
          );
        }

        // Calculate overdue
        let overdueMinutes: number | null = null;
        if (pass.expectedReturn && new Date() > pass.expectedReturn) {
          overdueMinutes = Math.round(
            (Date.now() - pass.expectedReturn.getTime()) / (1000 * 60)
          );
        }

        // Update pass status
        const updatedPass = await tx.gatePass.update({
          where: { id: pass.id },
          data: {
            status: "COMPLETED",
            actualReturn: new Date(),
            overdueMinutes,
          },
        });

        // Create gate event
        await tx.gateEvent.create({
          data: {
            passId: pass.id,
            gateId: parsed.data.gateId,
            guardId: guard.id,
            eventType: "RETURN",
            method: "QR_SCAN",
          },
        });

        return updatedPass;
      });

      await prisma.auditLog.create({
        data: {
          actorId: userId,
          action: "GATE_RETURN",
          targetId: parsed.data.passId,
          targetType: "GatePass",
          metadata: { gateId: parsed.data.gateId, overdueMinutes: result.overdueMinutes },
        },
      });

      return reply.send({
        success: true,
        message: "Return recorded successfully",
        pass: result,
      });
    } catch (error: any) {
      return reply.status(409).send({
        success: false,
        error: error.message || "Failed to mark return",
      });
    }
  });

  // ─── MANUAL LOOKUP ─────────────────────────────────────────────────────────
  app.get("/lookup", async (request, reply) => {
    const { query } = request.query as { query?: string };

    if (!query || query.length < 2) {
      return reply.status(400).send({ error: "Query too short" });
    }

    // Search by pass number or enrollment number
    const pass = await prisma.gatePass.findFirst({
      where: {
        OR: [
          { passNumber: { equals: query, mode: "insensitive" } },
          { student: { enrollmentNo: { equals: query, mode: "insensitive" } } },
        ],
        status: { in: ["APPROVED", "ACTIVE", "OUTSIDE"] },
      },
      include: {
        student: { include: { department: true } },
        reason: true,
        approvedBy: true,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!pass) {
      return reply.status(404).send({ error: "No active pass found for this query" });
    }

    return reply.send(pass);
  });

  // ─── GUARD ACTIVITY (today) ────────────────────────────────────────────────
  app.get("/activity", async (request, reply) => {
    const { userId } = request.user;

    const guard = await prisma.guardProfile.findUnique({
      where: { userId },
    });
    if (!guard) {
      return reply.status(404).send({ error: "Guard profile not found" });
    }

    const today = new Date(new Date().setHours(0, 0, 0, 0));

    const events = await prisma.gateEvent.findMany({
      where: {
        guardId: guard.id,
        timestamp: { gte: today },
      },
      include: {
        pass: { include: { student: true } },
        gate: true,
      },
      orderBy: { timestamp: "desc" },
    });

    const exits = events.filter((e) => e.eventType === "EXIT").length;
    const returns = events.filter((e) => e.eventType === "RETURN").length;

    return reply.send({
      todayExits: exits,
      todayReturns: returns,
      recentEvents: events.slice(0, 20),
    });
  });
}
