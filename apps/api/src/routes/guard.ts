import type { FastifyInstance } from "fastify";
import { prisma } from "@campusgate/db";
import {
  verifyQrSchema,
  markExitSchema,
  markReturnSchema,
  startGuardShiftSchema,
  endGuardShiftSchema,
} from "@campusgate/shared";
import { requireTenantRole } from "../middleware/auth.js";
import { ReliabilityEngine } from "../services/reliability-engine.js";
import { getGuardInTenant } from "../services/authz.js";
import { notifyUser } from "../services/notifications.js";

export async function guardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireTenantRole("GUARD"));

  const getActiveShiftForGuard = async (guardId: string, institutionId: string) => {
    return prisma.guardShift.findFirst({
      where: { institutionId, guardId, status: "ACTIVE" },
      include: { gate: true },
      orderBy: { actualStartAt: "desc" },
    });
  };

  // ─── GET ACTIVE EMERGENCY ALERT ───────────────────────────────────────────
  app.get("/emergency/active", async (request, reply) => {
    const { institutionId } = request.user;

    const active = await prisma.emergencyAlert.findFirst({
      where: { institutionId, status: "ACTIVE" },
      orderBy: { declaredAt: "desc" },
    });

    return reply.send(active);
  });

  // ─── SHIFT STATUS ───────────────────────────────────────────────────────────
  app.get("/shift/current", async (request, reply) => {
    const { userId, institutionId } = request.user;

    const guard = await getGuardInTenant(userId, institutionId);
    if (!guard) {
      return reply.status(404).send({ error: "Guard profile not found" });
    }

    const now = new Date();

    const [activeShift, nextShift] = await Promise.all([
      getActiveShiftForGuard(guard.id, institutionId),
      prisma.guardShift.findFirst({
        where: {
          institutionId,
          guardId: guard.id,
          status: "SCHEDULED",
          scheduledEndAt: { gte: now },
        },
        include: { gate: true },
        orderBy: { scheduledStartAt: "asc" },
      }),
    ]);

    return reply.send({ activeShift, nextShift });
  });

  app.post("/shift/start", async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = startGuardShiftSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const guard = await getGuardInTenant(userId, institutionId);
    if (!guard) {
      return reply.status(404).send({ error: "Guard profile not found" });
    }

    const shift = await prisma.guardShift.findFirst({
      where: {
        id: parsed.data.shiftId,
        institutionId,
        guardId: guard.id,
      },
      include: { gate: true },
    });

    if (!shift) {
      return reply.status(404).send({ error: "Shift not found" });
    }

    if (shift.status !== "SCHEDULED") {
      return reply.status(409).send({ error: `Shift cannot be started from ${shift.status} state` });
    }

    const activeShift = await getActiveShiftForGuard(guard.id, institutionId);
    if (activeShift) {
      return reply.status(409).send({ error: "You already have an active shift" });
    }

    const assignment = await prisma.guardGateAssignment.findUnique({
      where: { guardId_gateId: { guardId: guard.id, gateId: shift.gateId } },
    });
    if (!assignment) {
      return reply.status(403).send({ error: "You are no longer assigned to this gate" });
    }

    const now = new Date();
    const earlyWindowStart = new Date(shift.scheduledStartAt.getTime() - 30 * 60 * 1000);

    if (now < earlyWindowStart) {
      return reply.status(400).send({ error: "Shift start window has not opened yet" });
    }

    if (now > shift.scheduledEndAt) {
      return reply.status(400).send({ error: "Shift has already ended" });
    }

    const started = await prisma.guardShift.update({
      where: { id: shift.id },
      data: { status: "ACTIVE", actualStartAt: now },
      include: { gate: true },
    });

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "SHIFT_STARTED",
        targetId: shift.id,
        targetType: "GuardShift",
        metadata: { gateId: shift.gateId },
      },
    });

    return reply.send({ message: "Shift started", shift: started });
  });

  app.post("/shift/end", async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = endGuardShiftSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const guard = await getGuardInTenant(userId, institutionId);
    if (!guard) {
      return reply.status(404).send({ error: "Guard profile not found" });
    }

    const shift = await prisma.guardShift.findFirst({
      where: {
        id: parsed.data.shiftId,
        institutionId,
        guardId: guard.id,
      },
      include: { gate: true },
    });

    if (!shift) {
      return reply.status(404).send({ error: "Shift not found" });
    }

    if (shift.status !== "ACTIVE") {
      return reply.status(409).send({ error: `Shift cannot be ended from ${shift.status} state` });
    }

    const now = new Date();
    const ended = await prisma.guardShift.update({
      where: { id: shift.id },
      data: { status: "COMPLETED", actualEndAt: now },
      include: { gate: true },
    });

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "SHIFT_ENDED",
        targetId: shift.id,
        targetType: "GuardShift",
        metadata: { gateId: shift.gateId },
      },
    });

    return reply.send({ message: "Shift ended", shift: ended });
  });

  // ─── VERIFY QR TOKEN ───────────────────────────────────────────────────────
  app.post("/verify", async (request, reply) => {
    const { institutionId } = request.user;

    const parsed = verifyQrSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const { qrToken } = parsed.data;

    const pass = await prisma.gatePass.findFirst({
      where: {
        qrToken,
        student: { user: { institutionId } },
      },
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

    // Don't expire passes in OUTSIDE status — they must always be completable for return
    const qrTimedOut =
      pass.status !== "OUTSIDE" &&
      (pass.status === "EXPIRED" || (pass.qrExpiresAt && new Date() > pass.qrExpiresAt));

    if (qrTimedOut) {
      // Persist the transition the first time we observe it, so analytics,
      // reliability scoring, and the student's history reflect reality
      // instead of leaving the pass stuck as APPROVED/ACTIVE forever.
      if (pass.status !== "EXPIRED") {
        const expiredNow = await prisma.gatePass.updateMany({
          where: { id: pass.id, status: pass.status },
          data: { status: "EXPIRED", qrToken: null, qrExpiresAt: null },
        });

        if (expiredNow.count > 0) {
          await prisma.auditLog.create({
            data: {
              actorId: pass.student.userId,
              action: "PASS_EXPIRED",
              targetId: pass.id,
              targetType: "GatePass",
              metadata: { previousStatus: pass.status },
            },
          });

          await notifyUser(pass.student.userId, {
            title: "Gate Pass Expired",
            body: `Your gate pass ${pass.passNumber} expired before it was used.`,
            type: "PASS_EXPIRED",
            data: { passId: pass.id },
          });
        }
      }

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
    const { userId, institutionId } = request.user;

    const parsed = markExitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const guard = await getGuardInTenant(userId, institutionId);
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

    const activeShift = await getActiveShiftForGuard(guard.id, institutionId);

    // Enforce shift requirement only when the institution actually uses shifts.
    // If no shift records exist for this institution at all, skip the check —
    // this lets institutions that haven't set up shift scheduling yet operate normally.
    const institutionUsesShifts = await prisma.guardShift.count({ where: { institutionId } });
    if (institutionUsesShifts > 0 && (!activeShift || activeShift.gateId !== parsed.data.gateId)) {
      return reply.status(403).send({
        success: false,
        error: "No active shift for this gate. Start your shift first.",
      });
    }

    // Atomic state transition: APPROVED/ACTIVE → OUTSIDE
    // Using a transaction to prevent concurrent duplicate exits
    try {
      const result = await prisma.$transaction(async (tx) => {
        const pass = await tx.gatePass.findFirst({
          where: {
            id: parsed.data.passId,
            student: { user: { institutionId } },
          },
        });

        if (!pass) {
          throw new Error("Pass not found");
        }

        if (pass.status !== "APPROVED" && pass.status !== "ACTIVE") {
          throw new Error(
            `Cannot mark exit: pass is in ${pass.status} state`
          );
        }

        // Update pass status and remove QR expiration (pass must stay valid for return)
        const updatedPass = await tx.gatePass.update({
          where: { id: pass.id },
          data: {
            status: "OUTSIDE",
            actualExit: new Date(),
            qrExpiresAt: null,
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

      // Notify the student their exit was recorded (fire-and-forget)
      ;(async () => {
        try {
          const passInfo = await prisma.gatePass.findUnique({
            where: { id: parsed.data.passId },
            select: { passNumber: true, student: { select: { userId: true } } },
          });
          if (passInfo) {
            await notifyUser(passInfo.student.userId, {
              title: "Exit Recorded",
              body: `Your gate pass ${passInfo.passNumber} exit has been recorded at the gate.`,
              type: "GATE_EXIT",
              data: { passId: parsed.data.passId },
            });
          }
        } catch (err) {
          app.log.error(err, "Failed to notify student of exit");
        }
      })();

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
    const { userId, institutionId } = request.user;

    const parsed = markReturnSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const guard = await getGuardInTenant(userId, institutionId);
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

    const activeShift = await getActiveShiftForGuard(guard.id, institutionId);
    const institutionUsesShiftsReturn = await prisma.guardShift.count({ where: { institutionId } });
    if (institutionUsesShiftsReturn > 0 && (!activeShift || activeShift.gateId !== parsed.data.gateId)) {
      return reply.status(403).send({
        success: false,
        error: "No active shift for this gate. Start your shift first.",
      });
    }

    // Atomic state transition: OUTSIDE → COMPLETED
    try {
      const result = await prisma.$transaction(async (tx) => {
        const pass = await tx.gatePass.findFirst({
          where: {
            id: parsed.data.passId,
            student: { user: { institutionId } },
          },
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

      // Trigger reliability snapshot computation (Req 13.1)
      // Run async fire-and-forget so it doesn't block the response
      (async () => {
        try {
          const pass = await prisma.gatePass.findFirst({
            where: {
              id: parsed.data.passId,
              student: { user: { institutionId } },
            },
            include: {
              student: { include: { user: true } },
              emergencyOverride: true,
            },
          });

          if (!pass) return;

          // Notify the student their return was recorded
          await notifyUser(pass.student.userId, {
            title: "Return Recorded",
            body: `Your gate pass ${pass.passNumber} return has been recorded at the gate.`,
            type: "GATE_RETURN",
            data: { passId: parsed.data.passId },
          });

          // Check exclusion rules: don't record snapshot for emergency override passes (Req 11.2)
          if (pass.emergencyOverride) return;

          const passInstitutionId = pass.student.user.institutionId;

          // Compute the current score
          const score = await ReliabilityEngine.computeScore(pass.studentId, passInstitutionId);

          if (score.hasSufficientData) {
            // Count the student's completed movements for the movementNumber
            const movementCount = await prisma.gatePass.count({
              where: { studentId: pass.studentId, status: "COMPLETED" },
            });

            await ReliabilityEngine.recordSnapshot(pass.studentId, score.overall, movementCount);
          }
        } catch (err) {
          // Log but don't fail the request
          app.log.error(err, "Failed to record reliability snapshot");
        }
      })();

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
    const { institutionId } = request.user;
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
        student: { user: { institutionId } },
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
    const { userId, institutionId } = request.user;

    const guard = await getGuardInTenant(userId, institutionId);
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
