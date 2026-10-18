import type { FastifyInstance } from "fastify";
import { withTenant } from "@campusgate/db";
import {
  verifyQrSchema,
  markExitSchema,
  markReturnSchema,
  startGuardShiftSchema,
  endGuardShiftSchema,
} from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../services/authz-engine.js";
import { ReliabilityEngine } from "../services/reliability-engine.js";
import { getGuardInTenant } from "../services/authz.js";
import { notifyUser } from "../services/notifications.js";
import type { Prisma } from "@campusgate/db";

export async function guardRoutes(app: FastifyInstance) {
  // Authentication runs exactly once per request via this single top-level hook
  // (replaces the former requireTenantRole("GUARD") hook — §7). Per-route
  // requirePermission(...) below owns the access decision and does NOT re-auth.
  app.addHook("preHandler", authenticate);

  const getActiveShiftForGuard = async (
    guardId: string,
    institutionId: string,
    db: Prisma.TransactionClient,
  ) => {
    return db.guardShift.findFirst({
      where: { institutionId, guardId, status: "ACTIVE" },
      include: { gate: true },
      orderBy: { actualStartAt: "desc" },
    });
  };

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

  // ─── SHIFT STATUS ───────────────────────────────────────────────────────────
  app.get("/shift/current", { preHandler: [requirePermission("campus_movement.shift.manage_own")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const result = await withTenant(institutionId, async (tx) => {
      const guard = await getGuardInTenant(userId, institutionId, tx);
      if (!guard) return null;

      const now = new Date();

      const [activeShift, nextShift] = await Promise.all([
        getActiveShiftForGuard(guard.id, institutionId, tx),
        tx.guardShift.findFirst({
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

      return { activeShift, nextShift };
    });

    if (!result) {
      return reply.status(404).send({ error: "Guard profile not found" });
    }

    return reply.send(result);
  });

  app.post("/shift/start", { preHandler: [requirePermission("campus_movement.shift.manage_own")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = startGuardShiftSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const result = await withTenant(institutionId, async (tx) => {
      const guard = await getGuardInTenant(userId, institutionId, tx);
      if (!guard) return { error: { status: 404 as const, body: { error: "Guard profile not found" } } };

      const shift = await tx.guardShift.findFirst({
        where: {
          id: parsed.data.shiftId,
          institutionId,
          guardId: guard.id,
        },
        include: { gate: true },
      });

      if (!shift) return { error: { status: 404 as const, body: { error: "Shift not found" } } };

      if (shift.status !== "SCHEDULED") {
        return { error: { status: 409 as const, body: { error: `Shift cannot be started from ${shift.status} state` } } };
      }

      const activeShift = await getActiveShiftForGuard(guard.id, institutionId, tx);
      if (activeShift) {
        return { error: { status: 409 as const, body: { error: "You already have an active shift" } } };
      }

      const assignment = await tx.guardGateAssignment.findUnique({
        where: { guardId_gateId: { guardId: guard.id, gateId: shift.gateId } },
      });
      if (!assignment) {
        return { error: { status: 403 as const, body: { error: "You are no longer assigned to this gate" } } };
      }

      const now = new Date();
      const earlyWindowStart = new Date(shift.scheduledStartAt.getTime() - 30 * 60 * 1000);

      if (now < earlyWindowStart) {
        return { error: { status: 400 as const, body: { error: "Shift start window has not opened yet" } } };
      }

      if (now > shift.scheduledEndAt) {
        return { error: { status: 400 as const, body: { error: "Shift has already ended" } } };
      }

      const started = await tx.guardShift.update({
        where: { id: shift.id },
        data: { status: "ACTIVE", actualStartAt: now },
        include: { gate: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: userId,
          institutionId,
          action: "SHIFT_STARTED",
          targetId: shift.id,
          targetType: "GuardShift",
          metadata: { gateId: shift.gateId },
        },
      });

      return { started };
    });

    if ("error" in result && result.error) {
      return reply.status(result.error.status).send(result.error.body);
    }

    return reply.send({ message: "Shift started", shift: result.started });
  });

  app.post("/shift/end", { preHandler: [requirePermission("campus_movement.shift.manage_own")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = endGuardShiftSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const result = await withTenant(institutionId, async (tx) => {
      const guard = await getGuardInTenant(userId, institutionId, tx);
      if (!guard) return { error: { status: 404 as const, body: { error: "Guard profile not found" } } };

      const shift = await tx.guardShift.findFirst({
        where: {
          id: parsed.data.shiftId,
          institutionId,
          guardId: guard.id,
        },
        include: { gate: true },
      });

      if (!shift) return { error: { status: 404 as const, body: { error: "Shift not found" } } };

      if (shift.status !== "ACTIVE") {
        return { error: { status: 409 as const, body: { error: `Shift cannot be ended from ${shift.status} state` } } };
      }

      const now = new Date();
      const ended = await tx.guardShift.update({
        where: { id: shift.id },
        data: { status: "COMPLETED", actualEndAt: now },
        include: { gate: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: userId,
          institutionId,
          action: "SHIFT_ENDED",
          targetId: shift.id,
          targetType: "GuardShift",
          metadata: { gateId: shift.gateId },
        },
      });

      return { ended };
    });

    if ("error" in result && result.error) {
      return reply.status(result.error.status).send(result.error.body);
    }

    return reply.send({ message: "Shift ended", shift: result.ended });
  });

  // ─── VERIFY QR TOKEN ───────────────────────────────────────────────────────
  app.post("/verify", { preHandler: [requirePermission("campus_movement.gate.verify")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const parsed = verifyQrSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const { qrToken } = parsed.data;

    const response = await withTenant(institutionId, async (tx) => {
    const pass = await tx.gatePass.findFirst({
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
      return {
        valid: false,
        status: "INVALID",
        message: "Pass not found",
      };
    }

    if (pass.status === "REVOKED") {
      return {
        valid: false,
        status: "REVOKED",
        message: "This pass has been revoked",
      };
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
        const expiredNow = await tx.gatePass.updateMany({
          where: { id: pass.id, status: pass.status },
          data: { status: "EXPIRED", qrToken: null, qrExpiresAt: null },
        });

        if (expiredNow.count > 0) {
          await tx.auditLog.create({
            data: {
              actorId: pass.student.userId,
              institutionId,
              action: "PASS_EXPIRED",
              targetId: pass.id,
              targetType: "GatePass",
              metadata: { previousStatus: pass.status },
            },
          });

          await notifyUser(
            pass.student.userId,
            {
              title: "Gate Pass Expired",
              body: `Your gate pass ${pass.passNumber} expired before it was used.`,
              type: "PASS_EXPIRED",
              data: { passId: pass.id },
            },
            tx,
          );
        }
      }

      return {
        valid: false,
        status: "EXPIRED",
        message: "This pass has expired",
      };
    }

    if (pass.status === "COMPLETED") {
      return {
        valid: false,
        status: "COMPLETED",
        message: "This pass has already been completed",
      };
    }

    if (pass.status === "CANCELLED") {
      return {
        valid: false,
        status: "CANCELLED",
        message: "This pass was cancelled",
      };
    }

    if (pass.status === "REJECTED") {
      return {
        valid: false,
        status: "REJECTED",
        message: "This pass was rejected",
      };
    }

    if (pass.status === "PENDING") {
      return {
        valid: false,
        status: "PENDING",
        message: "This pass has not been approved yet",
      };
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

    return {
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
    };
    });

    return reply.send(response);
  });

  // ─── MARK EXIT ─────────────────────────────────────────────────────────────
  app.post("/mark-exit", { preHandler: [requirePermission("campus_movement.gate.mark_exit")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = markExitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    // The whole tenant-scoped flow runs inside one withTenant transaction so
    // the pre-checks, the atomic state transition, the gate event and the audit
    // log all share the tenant RLS context (and atomicity). The inner
    // prisma.$transaction is flattened onto this outer tx.
    const outcome = await withTenant(institutionId, async (tx) => {
      const guard = await getGuardInTenant(userId, institutionId, tx);
      if (!guard) {
        return { error: { status: 404 as const, body: { error: "Guard profile not found" } } };
      }

      // Verify guard is assigned to this gate
      const assignment = await tx.guardGateAssignment.findUnique({
        where: { guardId_gateId: { guardId: guard.id, gateId: parsed.data.gateId } },
      });
      if (!assignment) {
        return { error: { status: 403 as const, body: { error: "You are not assigned to this gate" } } };
      }

      const activeShift = await getActiveShiftForGuard(guard.id, institutionId, tx);

      // Enforce shift requirement only when the institution actually uses shifts.
      // If no shift records exist for this institution at all, skip the check —
      // this lets institutions that haven't set up shift scheduling yet operate normally.
      const institutionUsesShifts = await tx.guardShift.count({ where: { institutionId } });
      if (institutionUsesShifts > 0 && (!activeShift || activeShift.gateId !== parsed.data.gateId)) {
        return {
          error: {
            status: 403 as const,
            body: { success: false, error: "No active shift for this gate. Start your shift first." },
          },
        };
      }

      // Atomic state transition: APPROVED/ACTIVE → OUTSIDE
      const pass = await tx.gatePass.findFirst({
        where: {
          id: parsed.data.passId,
          student: { user: { institutionId } },
        },
      });

      if (!pass) {
        return { conflict: { error: "Pass not found" } };
      }

      if (pass.status !== "APPROVED" && pass.status !== "ACTIVE") {
        return { conflict: { error: `Cannot mark exit: pass is in ${pass.status} state` } };
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
          institutionId,
          gateId: parsed.data.gateId,
          guardId: guard.id,
          eventType: "EXIT",
          method: "QR_SCAN",
        },
      });

      // Audit inside the same tenant tx (AuditLog is tenant-owned)
      await tx.auditLog.create({
        data: {
          actorId: userId,
          institutionId,
          action: "GATE_EXIT",
          targetId: parsed.data.passId,
          targetType: "GatePass",
          metadata: { gateId: parsed.data.gateId },
        },
      });

      return { result: updatedPass };
    });

    if ("error" in outcome && outcome.error) {
      return reply.status(outcome.error.status).send(outcome.error.body);
    }
    if ("conflict" in outcome && outcome.conflict) {
      return reply.status(409).send({ success: false, error: outcome.conflict.error });
    }

    // Notify the student their exit was recorded (fire-and-forget). Runs in its
    // own tenant transaction so the notification write satisfies RLS WITH CHECK.
    ;(async () => {
      try {
        await withTenant(institutionId, async (tx) => {
          const passInfo = await tx.gatePass.findUnique({
            where: { id: parsed.data.passId },
            select: { passNumber: true, student: { select: { userId: true } } },
          });
          if (passInfo) {
            await notifyUser(
              passInfo.student.userId,
              {
                title: "Exit Recorded",
                body: `Your gate pass ${passInfo.passNumber} exit has been recorded at the gate.`,
                type: "GATE_EXIT",
                data: { passId: parsed.data.passId },
              },
              tx,
            );
          }
        });
      } catch (err) {
        app.log.error(err, "Failed to notify student of exit");
      }
    })();

    return reply.send({
      success: true,
      message: "Exit recorded successfully",
      pass: outcome.result,
    });
  });

  // ─── MARK RETURN ───────────────────────────────────────────────────────────
  app.post("/mark-return", { preHandler: [requirePermission("campus_movement.gate.mark_return")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = markReturnSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const outcome = await withTenant(institutionId, async (tx) => {
      const guard = await getGuardInTenant(userId, institutionId, tx);
      if (!guard) {
        return { error: { status: 404 as const, body: { error: "Guard profile not found" } } };
      }

      // Verify guard is assigned to this gate
      const assignment = await tx.guardGateAssignment.findUnique({
        where: { guardId_gateId: { guardId: guard.id, gateId: parsed.data.gateId } },
      });
      if (!assignment) {
        return { error: { status: 403 as const, body: { error: "You are not assigned to this gate" } } };
      }

      const activeShift = await getActiveShiftForGuard(guard.id, institutionId, tx);
      const institutionUsesShiftsReturn = await tx.guardShift.count({ where: { institutionId } });
      if (institutionUsesShiftsReturn > 0 && (!activeShift || activeShift.gateId !== parsed.data.gateId)) {
        return {
          error: {
            status: 403 as const,
            body: { success: false, error: "No active shift for this gate. Start your shift first." },
          },
        };
      }

      // Atomic state transition: OUTSIDE → COMPLETED
      const pass = await tx.gatePass.findFirst({
        where: {
          id: parsed.data.passId,
          student: { user: { institutionId } },
        },
      });

      if (!pass) {
        return { conflict: { error: "Pass not found" } };
      }

      if (pass.status !== "OUTSIDE") {
        return { conflict: { error: `Cannot mark return: pass is in ${pass.status} state` } };
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
          institutionId,
          gateId: parsed.data.gateId,
          guardId: guard.id,
          eventType: "RETURN",
          method: "QR_SCAN",
        },
      });

      // Audit inside the same tenant tx (AuditLog is tenant-owned)
      await tx.auditLog.create({
        data: {
          actorId: userId,
          institutionId,
          action: "GATE_RETURN",
          targetId: parsed.data.passId,
          targetType: "GatePass",
          metadata: { gateId: parsed.data.gateId, overdueMinutes: updatedPass.overdueMinutes },
        },
      });

      return { result: updatedPass };
    });

    if ("error" in outcome && outcome.error) {
      return reply.status(outcome.error.status).send(outcome.error.body);
    }
    if ("conflict" in outcome && outcome.conflict) {
      return reply.status(409).send({ success: false, error: outcome.conflict.error });
    }

    // Trigger reliability snapshot computation (Req 13.1) + notify the student.
    // Run async fire-and-forget so it doesn't block the response, inside its own
    // tenant transaction so the notification + snapshot writes satisfy RLS.
    (async () => {
      try {
        await withTenant(institutionId, async (tx) => {
          const pass = await tx.gatePass.findFirst({
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
          await notifyUser(
            pass.student.userId,
            {
              title: "Return Recorded",
              body: `Your gate pass ${pass.passNumber} return has been recorded at the gate.`,
              type: "GATE_RETURN",
              data: { passId: parsed.data.passId },
            },
            tx,
          );

          // Check exclusion rules: don't record snapshot for emergency override passes (Req 11.2)
          if (pass.emergencyOverride) return;

          const passInstitutionId = pass.student.user.institutionId;

          // Compute the current score
          const score = await ReliabilityEngine.computeScore(pass.studentId, passInstitutionId, tx);

          if (score.hasSufficientData) {
            // Count the student's completed movements for the movementNumber
            const movementCount = await tx.gatePass.count({
              where: { studentId: pass.studentId, status: "COMPLETED" },
            });

            await ReliabilityEngine.recordSnapshot(pass.studentId, passInstitutionId, score.overall, movementCount, tx);
          }
        });
      } catch (err) {
        // Log but don't fail the request
        app.log.error(err, "Failed to record reliability snapshot");
      }
    })();

    return reply.send({
      success: true,
      message: "Return recorded successfully",
      pass: outcome.result,
    });
  });

  // ─── MANUAL LOOKUP ─────────────────────────────────────────────────────────
  app.get("/lookup", { preHandler: [requirePermission("campus_movement.gate.lookup")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { query } = request.query as { query?: string };

    if (!query || query.length < 2) {
      return reply.status(400).send({ error: "Query too short" });
    }

    // Search by pass number or enrollment number
    const pass = await withTenant(institutionId, (tx) =>
      tx.gatePass.findFirst({
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
      }),
    );

    if (!pass) {
      return reply.status(404).send({ error: "No active pass found for this query" });
    }

    return reply.send(pass);
  });

  // ─── GUARD ACTIVITY (today) ────────────────────────────────────────────────
  app.get("/activity", { preHandler: [requirePermission("campus_movement.gate.lookup")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const result = await withTenant(institutionId, async (tx) => {
      const guard = await getGuardInTenant(userId, institutionId, tx);
      if (!guard) return null;

      const today = new Date(new Date().setHours(0, 0, 0, 0));

      const events = await tx.gateEvent.findMany({
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

      return events;
    });

    if (!result) {
      return reply.status(404).send({ error: "Guard profile not found" });
    }

    const events = result;
    const exits = events.filter((e) => e.eventType === "EXIT").length;
    const returns = events.filter((e) => e.eventType === "RETURN").length;

    return reply.send({
      todayExits: exits,
      todayReturns: returns,
      recentEvents: events.slice(0, 20),
    });
  });
}
