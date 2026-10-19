import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { withTenant } from "@campusgate/db";
import { approvePassSchema, rejectPassSchema, revokePassSchema, QR_TOKEN_VALIDITY_MINUTES } from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission, requireModuleActive } from "../services/authz-engine.js";
import { notifyUser } from "../services/notifications.js";
import { ReliabilityEngine } from "../services/reliability-engine.js";
import { AllowanceEngine } from "../services/allowance-engine.js";
import { getHodInTenant } from "../services/authz.js";
import { recordAuditEvent } from "../services/audit.js";
import { buildPassTimeline, computeOutsideDurationMinutes } from "../services/pass-lifecycle.js";

export async function hodRoutes(app: FastifyInstance) {
  // Authentication runs exactly once per request via this single top-level hook
  // (replaces the former requireTenantRole("HOD") hook — §7). Per-route
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

  // ─── GET PENDING REQUESTS (for HOD's department) ───────────────────────────
  app.get("/requests", { preHandler: [requirePermission("campus_movement.pass.view_department"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { status = "PENDING" } = request.query as { status?: string };

    const result = await withTenant(institutionId, async (tx) => {
      const hod = await getHodInTenant(userId, institutionId, tx);
      if (!hod) return null;

      const validStatuses = ["PENDING", "APPROVED", "ACTIVE", "OUTSIDE", "REJECTED", "COMPLETED", "ALL"];
      const statusFilter = validStatuses.includes(status) ? status : "PENDING";

      const where: any = {
        student: {
          departmentId: hod.departmentId,
          user: { institutionId },
        },
      };

      if (statusFilter !== "ALL") {
        where.status = statusFilter;
      }

      return tx.gatePass.findMany({
        where,
        include: {
          student: { include: { department: true } },
          reason: true,
          approvedBy: true,
        },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      });
    });

    if (!result) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }

    return reply.send(result);
  });

  // ─── GET SINGLE REQUEST DETAIL ─────────────────────────────────────────────
  app.get("/requests/:passId", { preHandler: [requirePermission("campus_movement.pass.view_department"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { passId } = request.params as { passId: string };

    const result = await withTenant(institutionId, async (tx) => {
      const hod = await getHodInTenant(userId, institutionId, tx);
      if (!hod) return { notFoundHod: true as const };

      const pass = await tx.gatePass.findFirst({
        where: {
          id: passId,
          student: { departmentId: hod.departmentId, user: { institutionId } },
        },
        include: {
          student: { include: { department: true } },
          reason: true,
          approvedBy: true,
          gateEvents: { include: { gate: true } },
        },
      });

      if (!pass) return { notFoundPass: true as const };

      // Include student allowance info for HOD decision-making (Req 7.1, 7.2, 7.3)
      const allowance = await AllowanceEngine.getRemainingAllowance(pass.studentId, institutionId, tx);
      const policy = await AllowanceEngine.getOrCreatePolicy(institutionId, tx);

      // Include reliability score as advisory information (Req 9.5, 12.3)
      const score = await ReliabilityEngine.computeScore(pass.studentId, institutionId, tx);

      return { pass, allowance, policy, score };
    });

    if ("notFoundHod" in result) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }
    if ("notFoundPass" in result) {
      return reply.status(404).send({ error: "Request not found" });
    }

    return reply.send({
      ...result.pass,
      allowance: { ...result.allowance, enforcement: result.policy.enforcement.toLowerCase() },
      reliabilityScore: result.score.hasSufficientData ? result.score : null,
    });
  });

  // ─── GET STUDENT RELIABILITY SCORE FOR A REQUEST ─────────────────────────
  app.get("/requests/:passId/reliability", { preHandler: [requirePermission("campus_movement.pass.view_department"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { passId } = request.params as { passId: string };

    const result = await withTenant(institutionId, async (tx) => {
      const hod = await getHodInTenant(userId, institutionId, tx);
      if (!hod) return { notFoundHod: true as const };

      const pass = await tx.gatePass.findFirst({
        where: {
          id: passId,
          student: { departmentId: hod.departmentId, user: { institutionId } },
        },
      });
      if (!pass) return { notFoundPass: true as const };

      const score = await ReliabilityEngine.computeScore(pass.studentId, institutionId, tx);
      return { score };
    });

    if ("notFoundHod" in result) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }
    if ("notFoundPass" in result) {
      return reply.status(404).send({ error: "Request not found" });
    }

    return reply.send(result.score);
  });

  // ─── GET STUDENT ALLOWANCE FOR A REQUEST ─────────────────────────────────
  app.get("/requests/:passId/allowance", { preHandler: [requirePermission("campus_movement.pass.view_department"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { passId } = request.params as { passId: string };

    const result = await withTenant(institutionId, async (tx) => {
      const hod = await getHodInTenant(userId, institutionId, tx);
      if (!hod) return { notFoundHod: true as const };

      const pass = await tx.gatePass.findFirst({
        where: {
          id: passId,
          student: { departmentId: hod.departmentId, user: { institutionId } },
        },
      });
      if (!pass) return { notFoundPass: true as const };

      const summary = await AllowanceEngine.getRemainingAllowance(pass.studentId, institutionId, tx);
      const policy = await AllowanceEngine.getOrCreatePolicy(institutionId, tx);
      return { summary, policy };
    });

    if ("notFoundHod" in result) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }
    if ("notFoundPass" in result) {
      return reply.status(404).send({ error: "Request not found" });
    }

    return reply.send({ ...result.summary, enforcement: result.policy.enforcement.toLowerCase() });
  });

  // ─── EMERGENCY OVERRIDE ───────────────────────────────────────────────────
  app.post("/emergency-override", { preHandler: [requirePermission("campus_movement.pass.override"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { passId, justification } = request.body as { passId: string; justification: string };

    if (!justification || justification.length < 10) {
      return reply.status(400).send({ error: "Justification must be at least 10 characters" });
    }

    const result = await withTenant(institutionId, async (tx) => {
      const hod = await getHodInTenant(userId, institutionId, tx);
      if (!hod) return { notFoundHod: true as const };

      // Verify pass belongs to HOD's department
      const pass = await tx.gatePass.findFirst({
        where: {
          id: passId,
          student: { departmentId: hod.departmentId, user: { institutionId } },
        },
        include: { student: true },
      });
      if (!pass) return { notFoundPass: true as const };

      // Create override record
      const override = await tx.emergencyOverride.create({
        data: {
          gatePassId: passId,
          institutionId,
          overriddenById: userId,
          justification,
        },
      });

      // Create audit log entry (Req 5.3)
      await recordAuditEvent(
        {
          action: "campus_movement.pass.override",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "GatePass",
          resourceId: passId,
          requestRef: request.id,
          metadata: { justification, studentId: pass.studentId },
        },
        tx,
      );

      return { override };
    });

    if ("notFoundHod" in result) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }
    if ("notFoundPass" in result) {
      return reply.status(404).send({ error: "Pass not found in your department" });
    }

    return reply.status(201).send(result.override);
  });

  // ─── APPROVE REQUEST ───────────────────────────────────────────────────────
  app.post("/approve", { preHandler: [requirePermission("campus_movement.pass.approve"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = approvePassSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const result = await withTenant(institutionId, async (tx) => {
      const hod = await getHodInTenant(userId, institutionId, tx);
      if (!hod) return { notFoundHod: true as const };

      // Find the pass and verify it belongs to HOD's department
      const pass = await tx.gatePass.findFirst({
        where: {
          id: parsed.data.passId,
          status: "PENDING",
          student: { departmentId: hod.departmentId, user: { institutionId } },
        },
        include: { student: true },
      });

      if (!pass) return { notFoundPass: true as const };

      // Generate QR token
      const qrToken = nanoid(32);
      const qrExpiresAt = new Date(
        Date.now() + QR_TOKEN_VALIDITY_MINUTES * 60 * 1000
      );

      // Atomic update: PENDING → APPROVED
      const updated = await tx.gatePass.update({
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
      await recordAuditEvent(
        {
          action: "campus_movement.pass.approved",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "GatePass",
          resourceId: pass.id,
          requestRef: request.id,
          metadata: { studentId: pass.studentId, passNumber: pass.passNumber },
        },
        tx,
      );

      // Notify student
      await notifyUser(
        pass.student.userId,
        {
          title: "Gate Pass Approved",
          body: `Your gate pass ${pass.passNumber} has been approved.`,
          type: "PASS_APPROVED",
          data: { passId: pass.id },
        },
        tx,
      );

      return { updated };
    });

    if ("notFoundHod" in result) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }
    if ("notFoundPass" in result) {
      return reply
        .status(404)
        .send({ error: "Pending request not found or not in your department" });
    }

    return reply.send(result.updated);
  });

  // ─── REJECT REQUEST ────────────────────────────────────────────────────────
  app.post("/reject", { preHandler: [requirePermission("campus_movement.pass.reject"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = rejectPassSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const result = await withTenant(institutionId, async (tx) => {
      const hod = await getHodInTenant(userId, institutionId, tx);
      if (!hod) return { notFoundHod: true as const };

      const pass = await tx.gatePass.findFirst({
        where: {
          id: parsed.data.passId,
          status: "PENDING",
          student: { departmentId: hod.departmentId, user: { institutionId } },
        },
        include: { student: true },
      });

      if (!pass) return { notFoundPass: true as const };

      const updated = await tx.gatePass.update({
        where: { id: pass.id, status: "PENDING" },
        data: {
          status: "REJECTED",
          rejectionReason: parsed.data.rejectionReason,
          approvedById: hod.id,
          approvedAt: new Date(),
        },
      });

      await recordAuditEvent(
        {
          action: "campus_movement.pass.rejected",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "GatePass",
          resourceId: pass.id,
          requestRef: request.id,
          metadata: { reason: parsed.data.rejectionReason },
        },
        tx,
      );

      // Notify student
      await notifyUser(
        pass.student.userId,
        {
          title: "Gate Pass Rejected",
          body: `Your gate pass ${pass.passNumber} was rejected: ${parsed.data.rejectionReason}`,
          type: "PASS_REJECTED",
          data: { passId: pass.id },
        },
        tx,
      );

      return { updated };
    });

    if ("notFoundHod" in result) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }
    if ("notFoundPass" in result) {
      return reply
        .status(404)
        .send({ error: "Pending request not found or not in your department" });
    }

    return reply.send(result.updated);
  });

  // ─── REVOKE PASS ──────────────────────────────────────────────────────────
  app.post("/revoke", { preHandler: [requirePermission("campus_movement.pass.revoke"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = revokePassSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const result = await withTenant(institutionId, async (tx) => {
      const hod = await getHodInTenant(userId, institutionId, tx);
      if (!hod) return { notFoundHod: true as const };

      const pass = await tx.gatePass.findFirst({
        where: {
          id: parsed.data.passId,
          student: { departmentId: hod.departmentId, user: { institutionId } },
          status: { in: ["APPROVED", "ACTIVE", "OUTSIDE"] },
        },
        include: { student: { select: { userId: true, name: true } } },
      });

      if (!pass) return { notFoundPass: true as const };

      const previousStatus = pass.status;

      const transitioned = await tx.gatePass.updateMany({
        where: {
          id: pass.id,
          status: previousStatus,
        },
        data: {
          status: "REVOKED",
          qrToken: null,
          qrExpiresAt: null,
        },
      });

      if (transitioned.count === 0) return { conflict: true as const };

      const updated = {
        ...pass,
        status: "REVOKED",
        qrToken: null,
        qrExpiresAt: null,
      };

      await recordAuditEvent(
        {
          action: "campus_movement.pass.revoked",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "GatePass",
          resourceId: pass.id,
          requestRef: request.id,
          metadata: {
            reason: parsed.data.reason,
            previousStatus,
            newStatus: "REVOKED",
          },
        },
        tx,
      );

      await notifyUser(
        pass.student.userId,
        {
          title: "Gate Pass Revoked",
          body: `Your gate pass ${pass.passNumber} was revoked: ${parsed.data.reason}`,
          type: "PASS_REVOKED",
          data: { passId: pass.id },
        },
        tx,
      );

      return { updated };
    });

    if ("notFoundHod" in result) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }
    if ("notFoundPass" in result) {
      return reply.status(404).send({ error: "Eligible pass not found for revocation" });
    }
    if ("conflict" in result) {
      return reply.status(409).send({ error: "Pass state changed, please refresh and try again" });
    }

    return reply.send(result.updated);
  });

  // ─── REQUEST TIMELINE ──────────────────────────────────────────────────────
  app.get("/requests/:passId/timeline", { preHandler: [requirePermission("campus_movement.pass.view_department"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { passId } = request.params as { passId: string };

    const result = await withTenant(institutionId, async (tx) => {
      const hod = await getHodInTenant(userId, institutionId, tx);
      if (!hod) return { notFoundHod: true as const };

      const pass = await tx.gatePass.findFirst({
        where: {
          id: passId,
          student: { departmentId: hod.departmentId, user: { institutionId } },
        },
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

    if ("notFoundHod" in result) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }
    if ("notFoundPass" in result) {
      return reply.status(404).send({ error: "Request not found" });
    }

    const timeline = buildPassTimeline(result.pass as any, result.logs as any);
    return reply.send({ passId: result.pass.id, timeline });
  });

  // ─── REQUEST SUMMARY ───────────────────────────────────────────────────────
  app.get("/requests/:passId/summary", { preHandler: [requirePermission("campus_movement.pass.view_department"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { passId } = request.params as { passId: string };

    const result = await withTenant(institutionId, async (tx) => {
      const hod = await getHodInTenant(userId, institutionId, tx);
      if (!hod) return { notFoundHod: true as const };

      const pass = await tx.gatePass.findFirst({
        where: {
          id: passId,
          student: { departmentId: hod.departmentId, user: { institutionId } },
        },
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

    if ("notFoundHod" in result) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }
    if ("notFoundPass" in result) {
      return reply.status(404).send({ error: "Request not found" });
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

  // ─── DASHBOARD STATS ───────────────────────────────────────────────────────
  app.get("/stats", { preHandler: [requirePermission("campus_movement.pass.view_department"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const result = await withTenant(institutionId, async (tx) => {
      const hod = await getHodInTenant(userId, institutionId, tx);
      if (!hod) return null;

      const [pending, approvedToday, rejectedToday, currentlyOutside] =
        await Promise.all([
          tx.gatePass.count({
            where: {
              status: "PENDING",
              student: { departmentId: hod.departmentId, user: { institutionId } },
            },
          }),
          tx.gatePass.count({
            where: {
              status: { in: ["APPROVED", "ACTIVE", "OUTSIDE", "COMPLETED"] },
              approvedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
              student: { departmentId: hod.departmentId, user: { institutionId } },
            },
          }),
          tx.gatePass.count({
            where: {
              status: "REJECTED",
              approvedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
              student: { departmentId: hod.departmentId, user: { institutionId } },
            },
          }),
          tx.gatePass.count({
            where: {
              status: "OUTSIDE",
              student: { departmentId: hod.departmentId, user: { institutionId } },
            },
          }),
        ]);

      return { pending, approvedToday, rejectedToday, currentlyOutside };
    });

    if (!result) {
      return reply.status(404).send({ error: "HOD profile not found" });
    }

    return reply.send(result);
  });
}
