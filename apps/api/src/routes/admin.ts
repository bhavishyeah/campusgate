import type { FastifyInstance } from "fastify";
import bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import ExcelJS from "exceljs";
import { withTenant, privilegedPrisma } from "@campusgate/db";
import {
  createUserSchema,
  bulkImportStudentSchema,
  createGuardShiftSchema,
  declareEmergencySchema,
  resolveEmergencySchema,
  updateInstitutionConfigSchema,
  upsertAcademicCalendarDaySchema,
  createAcademicSessionSchema,
  createAcademicTermSchema,
  createProgramSchema,
  academicSessionObject,
  academicTermObject,
  AUDIT_ACTION_KEY_SET,
  LEGACY_AUDIT_ACTION_MAP,
  type LegacyAuditAction,
  MODULES,
  MODULE_KEY_SET,
  type ModuleKey,
} from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission, requireModuleActive } from "../services/authz-engine.js";
import { recordAuditEvent } from "../services/audit.js";
import { activate, suspend } from "../services/module-system.js";
import { AllowanceEngine } from "../services/allowance-engine.js";
import { CalendarService } from "../services/calendar-service.js";
import {
  activateSession,
  closeSession,
  activateTerm,
  closeTerm,
  termCountWarning,
  termOutsideSessionWarning,
  termOverlapWarning,
  type Warning,
} from "../services/academic-session.js";
import {
  notifyUser,
  notifyInstitution,
  broadcastToInstitution,
} from "../services/notifications.js";

export async function adminRoutes(app: FastifyInstance) {
  // Authentication runs exactly once per request via this single top-level hook
  // (replaces the former requireTenantRole("ADMIN") hook — §7). Per-route
  // requirePermission(...) below owns the access decision and does NOT re-auth.
  app.addHook("preHandler", authenticate);

  // ─── DASHBOARD STATS ───────────────────────────────────────────────────────
  app.get("/stats", { preHandler: [requirePermission("campus_movement.analytics.view"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const today = new Date(new Date().setHours(0, 0, 0, 0));

    const [
      totalStudents,
      totalHods,
      totalGuards,
      totalGates,
      todayExits,
      todayReturns,
      currentlyOutside,
      pendingApprovals,
      pendingRegistrations,
    ] = await withTenant(institutionId, (tx) =>
      Promise.all([
        tx.user.count({ where: { institutionId, role: "STUDENT", accountStatus: "ACTIVE" } }),
        tx.user.count({ where: { institutionId, role: "HOD", accountStatus: "ACTIVE" } }),
        tx.user.count({ where: { institutionId, role: "GUARD", accountStatus: "ACTIVE" } }),
        tx.gate.count({ where: { institutionId, isActive: true } }),
        tx.gateEvent.count({
          where: {
            eventType: "EXIT",
            timestamp: { gte: today },
            pass: { student: { user: { institutionId } } },
          },
        }),
        tx.gateEvent.count({
          where: {
            eventType: "RETURN",
            timestamp: { gte: today },
            pass: { student: { user: { institutionId } } },
          },
        }),
        tx.gatePass.count({
          where: { status: "OUTSIDE", student: { user: { institutionId } } },
        }),
        tx.gatePass.count({
          where: { status: "PENDING", student: { user: { institutionId } } },
        }),
        tx.user.count({ where: { institutionId, accountStatus: "PENDING_APPROVAL" } }),
      ]),
    );

    return reply.send({
      totalStudents,
      totalHods,
      totalGuards,
      totalGates,
      todayExits,
      todayReturns,
      currentlyOutside,
      pendingApprovals,
      pendingRegistrations,
    });
  });

  // ─── MOVEMENT ANALYTICS ───────────────────────────────────────────────────
  app.get("/analytics", { preHandler: [requirePermission("campus_movement.analytics.view"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { from, to } = request.query as { from?: string; to?: string };

    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      return reply.status(400).send({ error: "Invalid date range" });
    }

    const now = new Date();

    const basePassWhere = {
      createdAt: { gte: start, lte: end },
      student: { user: { institutionId } },
    };

    const [
      totalRequests,
      approvedRequests,
      rejectedRequests,
      revokedRequests,
      revokedWhileOutside,
      completedMovements,
      currentlyOutside,
      overdueStudents,
      passes,
      movementPasses,
      gateEvents,
      emergencyAlerts,
      activeEmergency,
    ] = await withTenant(institutionId, (tx) =>
      Promise.all([
        tx.gatePass.count({ where: basePassWhere }),
        tx.gatePass.count({
          where: {
            ...basePassWhere,
            status: { in: ["APPROVED", "ACTIVE", "OUTSIDE", "COMPLETED", "REVOKED", "EXPIRED"] },
          },
        }),
        tx.gatePass.count({ where: { ...basePassWhere, status: "REJECTED" } }),
        tx.gatePass.count({ where: { ...basePassWhere, status: "REVOKED" } }),
        tx.gatePass.count({
          where: {
            ...basePassWhere,
            status: "REVOKED",
            actualExit: { not: null },
            actualReturn: null,
          },
        }),
        tx.gatePass.count({ where: { ...basePassWhere, status: "COMPLETED" } }),
        tx.gatePass.count({ where: { status: "OUTSIDE", student: { user: { institutionId } } } }),
        tx.gatePass.count({
          where: {
            status: "OUTSIDE",
            expectedReturn: { lt: now },
            student: { user: { institutionId } },
          },
        }),
        tx.gatePass.findMany({
          where: basePassWhere,
          select: {
            id: true,
            createdAt: true,
            status: true,
            reason: { select: { label: true } },
            student: { select: { department: { select: { name: true } } } },
          },
        }),
        tx.gatePass.findMany({
          where: {
            status: "COMPLETED",
            actualExit: { gte: start, lte: end },
            actualReturn: { not: null },
            student: { user: { institutionId } },
          },
          select: {
            actualExit: true,
            actualReturn: true,
            student: { select: { department: { select: { name: true } } } },
            reason: { select: { label: true } },
          },
        }),
        tx.gateEvent.findMany({
          where: {
            timestamp: { gte: start, lte: end },
            pass: { student: { user: { institutionId } } },
          },
          select: {
            eventType: true,
            timestamp: true,
            gate: { select: { name: true } },
          },
        }),
        tx.emergencyAlert.findMany({
          where: {
            institutionId,
            declaredAt: { gte: start, lte: end },
          },
          select: {
            declaredAt: true,
            resolvedAt: true,
            type: true,
            status: true,
          },
        }),
        tx.emergencyAlert.findFirst({
          where: { institutionId, status: "ACTIVE" },
          select: { id: true, declaredAt: true, type: true, title: true },
        }),
      ]),
    );

    const departmentMap = new Map<string, { requests: number; approved: number; rejected: number }>();
    const reasonMap = new Map<string, number>();

    for (const pass of passes) {
      const dept = pass.student.department.name;
      const existing = departmentMap.get(dept) ?? { requests: 0, approved: 0, rejected: 0 };
      existing.requests += 1;
      if (["APPROVED", "ACTIVE", "OUTSIDE", "COMPLETED", "REVOKED", "EXPIRED"].includes(pass.status)) {
        existing.approved += 1;
      }
      if (pass.status === "REJECTED") {
        existing.rejected += 1;
      }
      departmentMap.set(dept, existing);

      const reason = pass.reason.label;
      reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);
    }

    const movementDurationByDept = new Map<string, { totalMinutes: number; completed: number }>();
    let totalOutsideMinutes = 0;

    for (const m of movementPasses) {
      if (!m.actualExit || !m.actualReturn) continue;
      const mins = Math.max(0, Math.round((m.actualReturn.getTime() - m.actualExit.getTime()) / 60000));
      totalOutsideMinutes += mins;

      const dept = m.student.department.name;
      const existing = movementDurationByDept.get(dept) ?? { totalMinutes: 0, completed: 0 };
      existing.totalMinutes += mins;
      existing.completed += 1;
      movementDurationByDept.set(dept, existing);
    }

    const departmentStats = Array.from(departmentMap.entries())
      .map(([department, values]) => {
        const duration = movementDurationByDept.get(department);
        return {
          department,
          requests: values.requests,
          approved: values.approved,
          rejected: values.rejected,
          avgOutsideMinutes:
            duration && duration.completed > 0 ? Math.round(duration.totalMinutes / duration.completed) : 0,
        };
      })
      .sort((a, b) => b.requests - a.requests);

    const reasonStats = Array.from(reasonMap.entries())
      .map(([reason, count]) => ({
        reason,
        count,
        percentage: totalRequests > 0 ? Math.round((count / totalRequests) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    const gateMap = new Map<string, { exits: number; returns: number }>();
    const hourlyMap = new Map<number, number>();
    const dailyMap = new Map<string, { requests: number; exits: number; returns: number }>();

    const dayKey = (d: Date) => d.toISOString().slice(0, 10);

    for (const pass of passes) {
      const k = dayKey(pass.createdAt);
      const ex = dailyMap.get(k) ?? { requests: 0, exits: 0, returns: 0 };
      ex.requests += 1;
      dailyMap.set(k, ex);
    }

    for (const event of gateEvents) {
      const gateName = event.gate.name;
      const gate = gateMap.get(gateName) ?? { exits: 0, returns: 0 };
      if (event.eventType === "EXIT") gate.exits += 1;
      if (event.eventType === "RETURN") gate.returns += 1;
      gateMap.set(gateName, gate);

      const k = dayKey(event.timestamp);
      const ex = dailyMap.get(k) ?? { requests: 0, exits: 0, returns: 0 };
      if (event.eventType === "EXIT") ex.exits += 1;
      if (event.eventType === "RETURN") ex.returns += 1;
      dailyMap.set(k, ex);

      if (event.eventType === "EXIT") {
        const h = event.timestamp.getHours();
        hourlyMap.set(h, (hourlyMap.get(h) ?? 0) + 1);
      }
    }

    const gateStats = Array.from(gateMap.entries())
      .map(([gate, v]) => ({ gate, exits: v.exits, returns: v.returns, total: v.exits + v.returns }))
      .sort((a, b) => b.total - a.total);

    const emergencyByTypeMap = new Map<string, number>();
    const emergencyDailyMap = new Map<string, { declared: number; resolved: number }>();
    let totalResolutionMinutes = 0;
    let resolvedCount = 0;

    for (const alert of emergencyAlerts) {
      emergencyByTypeMap.set(alert.type, (emergencyByTypeMap.get(alert.type) ?? 0) + 1);

      const d = dayKey(alert.declaredAt);
      const daily = emergencyDailyMap.get(d) ?? { declared: 0, resolved: 0 };
      daily.declared += 1;
      emergencyDailyMap.set(d, daily);

      if (alert.resolvedAt) {
        const rd = dayKey(alert.resolvedAt);
        const resolvedDaily = emergencyDailyMap.get(rd) ?? { declared: 0, resolved: 0 };
        resolvedDaily.resolved += 1;
        emergencyDailyMap.set(rd, resolvedDaily);

        const mins = Math.max(0, Math.round((alert.resolvedAt.getTime() - alert.declaredAt.getTime()) / 60000));
        totalResolutionMinutes += mins;
        resolvedCount += 1;
      }
    }

    const emergencyByType = Array.from(emergencyByTypeMap.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);

    const emergencyDailyTrend = Array.from(emergencyDailyMap.entries())
      .map(([date, v]) => ({ date, declared: v.declared, resolved: v.resolved }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const hourlyExitDistribution = Array.from({ length: 24 }).map((_, hour) => ({
      hour,
      label: `${hour.toString().padStart(2, "0")}:00`,
      count: hourlyMap.get(hour) ?? 0,
    }));

    const dailyTrend = Array.from(dailyMap.entries())
      .map(([date, v]) => ({ date, requests: v.requests, exits: v.exits, returns: v.returns }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return reply.send({
      range: { from: start.toISOString(), to: end.toISOString() },
      overview: {
        totalRequests,
        approvedRequests,
        rejectedRequests,
        revokedRequests,
        revokedWhileOutside,
        completedMovements,
        currentlyOutside,
        overdueStudents,
        avgOutsideMinutes: movementPasses.length > 0 ? Math.round(totalOutsideMinutes / movementPasses.length) : 0,
        totalOutsideMinutes,
      },
      departmentStats,
      reasonStats,
      gateStats,
      hourlyExitDistribution,
      dailyTrend,
      emergencyOverview: {
        declaredCount: emergencyAlerts.length,
        resolvedCount,
        activeNow: !!activeEmergency,
        avgResolutionMinutes: resolvedCount > 0 ? Math.round(totalResolutionMinutes / resolvedCount) : 0,
        activeAlert: activeEmergency,
      },
      emergencyByType,
      emergencyDailyTrend,
    });
  });

  // ─── EMERGENCY ALERTS ─────────────────────────────────────────────────────
  app.get("/emergency/active", { preHandler: [requirePermission("campus_movement.emergency.view"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const active = await withTenant(institutionId, (tx) =>
      tx.emergencyAlert.findFirst({
        where: { institutionId, status: "ACTIVE" },
        orderBy: { declaredAt: "desc" },
        include: {
          declaredBy: { select: { id: true, email: true } },
        },
      }),
    );

    return reply.send(active);
  });

  app.get("/emergency", { preHandler: [requirePermission("campus_movement.emergency.view"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { limit = "20" } = request.query as { limit?: string };
    const take = Math.min(100, Math.max(1, parseInt(limit || "20", 10) || 20));

    const alerts = await withTenant(institutionId, (tx) =>
      tx.emergencyAlert.findMany({
        where: { institutionId },
        orderBy: { declaredAt: "desc" },
        take,
        include: {
          declaredBy: { select: { id: true, email: true } },
          resolvedBy: { select: { id: true, email: true } },
        },
      }),
    );

    return reply.send(alerts);
  });

  app.post("/emergency/declare", { preHandler: [requirePermission("campus_movement.emergency.declare"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = declareEmergencySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const result = await withTenant(institutionId, async (tx) => {
      const existingActive = await tx.emergencyAlert.findFirst({
        where: { institutionId, status: "ACTIVE" },
        orderBy: { declaredAt: "desc" },
      });

      if (existingActive) return { conflict: true as const };

      const alert = await tx.emergencyAlert.create({
        data: {
          institutionId,
          type: parsed.data.type,
          title: parsed.data.title,
          message: parsed.data.message,
          affectedArea: parsed.data.affectedArea,
          declaredById: userId,
        },
        include: {
          declaredBy: { select: { id: true, email: true } },
        },
      });

      await recordAuditEvent(
        {
          action: "campus_movement.emergency.declared",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "EmergencyAlert",
          resourceId: alert.id,
          requestRef: request.id,
          metadata: {
            type: alert.type,
            title: alert.title,
            affectedArea: alert.affectedArea,
          },
        },
        tx,
      );

      await notifyInstitution(
        institutionId,
        {
          title: `Emergency: ${alert.title}`,
          body: alert.message,
          type: "EMERGENCY_DECLARED",
          data: { alertId: alert.id, emergencyType: alert.type, affectedArea: alert.affectedArea },
        },
        tx,
      );

      return { alert };
    });

    if ("conflict" in result) {
      return reply.status(409).send({ error: "An emergency is already active. Resolve it first." });
    }

    // Instant push to anyone online right now, independent of persisted
    // per-user notifications above (which also reach offline users on login).
    broadcastToInstitution(institutionId, {
      type: "emergency_declared",
      data: result.alert,
    });

    return reply.status(201).send(result.alert);
  });

  app.post("/emergency/:id/resolve", { preHandler: [requirePermission("campus_movement.emergency.resolve"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { id } = request.params as { id: string };

    const parsed = resolveEmergencySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const result = await withTenant(institutionId, async (tx) => {
      const existing = await tx.emergencyAlert.findFirst({
        where: { id, institutionId },
      });

      if (!existing) return { notFound: true as const };
      if (existing.status !== "ACTIVE") return { conflict: true as const };

      const resolved = await tx.emergencyAlert.update({
        where: { id: existing.id },
        data: {
          status: "RESOLVED",
          resolvedById: userId,
          resolvedAt: new Date(),
          resolutionNote: parsed.data.resolutionNote,
        },
        include: {
          declaredBy: { select: { id: true, email: true } },
          resolvedBy: { select: { id: true, email: true } },
        },
      });

      await recordAuditEvent(
        {
          action: "campus_movement.emergency.resolved",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "EmergencyAlert",
          resourceId: resolved.id,
          requestRef: request.id,
          metadata: {
            resolutionNote: parsed.data.resolutionNote,
          },
        },
        tx,
      );

      await notifyInstitution(
        institutionId,
        {
          title: "Emergency Resolved",
          body: `The ${resolved.type.toLowerCase()} alert "${resolved.title}" has been resolved.`,
          type: "EMERGENCY_RESOLVED",
          data: { alertId: resolved.id },
        },
        tx,
      );

      return { resolved };
    });

    if ("notFound" in result) {
      return reply.status(404).send({ error: "Emergency alert not found" });
    }
    if ("conflict" in result) {
      return reply.status(409).send({ error: "Emergency alert is already resolved" });
    }

    broadcastToInstitution(institutionId, {
      type: "emergency_resolved",
      data: result.resolved,
    });

    return reply.send(result.resolved);
  });

  // ─── LIST USERS ────────────────────────────────────────────────────────────
  app.get("/users", { preHandler: [requirePermission("admin.users.view")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { role, status, page = "1", limit = "20" } = request.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    const where: any = { institutionId };
    if (role) where.role = role;
    if (status) where.accountStatus = status;

    const [users, total] = await withTenant(institutionId, (tx) =>
      Promise.all([
        tx.user.findMany({
          where,
          include: {
            studentProfile: { include: { department: true } },
            hodProfile: { include: { department: true } },
            guardProfile: { include: { assignedGates: { include: { gate: true } } } },
          },
          orderBy: { createdAt: "desc" },
          skip: (pageNum - 1) * limitNum,
          take: limitNum,
        }),
        tx.user.count({ where }),
      ]),
    );

    return reply.send({
      users,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  });

  // ─── CREATE USER ───────────────────────────────────────────────────────────
  app.post("/users", { preHandler: [requirePermission("admin.users.create")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const { email, name, role, departmentId, enrollmentNo, program, semester, section, gateIds } =
      parsed.data;

    // Generate a temporary password
    const tempPassword = randomBytes(9).toString("base64url");
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const result = await withTenant(institutionId, async (tx) => {
      const existing = await tx.user.findUnique({ where: { email } });
      if (existing) return { conflict: true as const };

      const newUser = await tx.user.create({
        data: {
          email,
          passwordHash,
          role,
          accountStatus: "ACTIVE",
          institutionId,
        },
      });

      // Create role-specific profile
      if (role === "STUDENT" && departmentId && enrollmentNo && program && semester) {
        await tx.studentProfile.create({
          data: {
            userId: newUser.id,
            institutionId,
            name,
            enrollmentNo,
            departmentId,
            program,
            semester,
            section,
          },
        });
      } else if (role === "HOD" && departmentId) {
        await tx.hodProfile.create({
          data: { userId: newUser.id, institutionId, name, departmentId },
        });
      } else if (role === "GUARD") {
        const guard = await tx.guardProfile.create({
          data: { userId: newUser.id, institutionId, name },
        });
        if (gateIds && gateIds.length > 0) {
          await tx.guardGateAssignment.createMany({
            data: gateIds.map((gateId) => ({ guardId: guard.id, gateId, institutionId })),
          });
        }
      }

      await recordAuditEvent(
        {
          action: "admin.user.created",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "User",
          resourceId: newUser.id,
          requestRef: request.id,
          metadata: { role, email },
        },
        tx,
      );

      return { user: newUser };
    });

    if ("conflict" in result) {
      return reply.status(409).send({ error: "Email already in use" });
    }

    return reply.status(201).send({
      user: { id: result.user.id, email: result.user.email, role: result.user.role },
      tempPassword, // In production, send this via email
    });
  });

  // ─── APPROVE PENDING REGISTRATION ─────────────────────────────────────────
  app.post("/users/:id/approve", { preHandler: [requirePermission("admin.users.approve")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { id } = request.params as { id: string };

    const result = await withTenant(institutionId, async (tx) => {
      const user = await tx.user.findFirst({
        where: { id, institutionId, accountStatus: "PENDING_APPROVAL" },
      });
      if (!user) return { notFound: true as const };

      await tx.user.update({
        where: { id: user.id },
        data: { accountStatus: "ACTIVE" },
      });

      await recordAuditEvent(
        {
          action: "admin.user.reactivated",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "User",
          resourceId: id,
          requestRef: request.id,
          metadata: { reason: "registration_approved" },
        },
        tx,
      );

      return { ok: true as const };
    });

    if ("notFound" in result) {
      return reply.status(404).send({ error: "No pending user found" });
    }

    return reply.send({ message: "User approved" });
  });

  // ─── DEACTIVATE USER ───────────────────────────────────────────────────────
  app.post("/users/:id/deactivate", { preHandler: [requirePermission("admin.users.deactivate")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { id } = request.params as { id: string };

    const result = await withTenant(institutionId, async (tx) => {
      const target = await tx.user.findFirst({ where: { id, institutionId } });
      if (!target) return { notFound: true as const };

      await tx.user.update({
        where: { id: target.id },
        data: { accountStatus: "INACTIVE" },
      });

      await recordAuditEvent(
        {
          action: "admin.user.deactivated",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "User",
          resourceId: id,
          requestRef: request.id,
        },
        tx,
      );

      return { ok: true as const };
    });

    if ("notFound" in result) {
      return reply.status(404).send({ error: "User not found" });
    }

    return reply.send({ message: "User deactivated" });
  });

  // ─── REACTIVATE USER ──────────────────────────────────────────────────────
  app.post("/users/:id/reactivate", { preHandler: [requirePermission("admin.users.reactivate")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { id } = request.params as { id: string };

    const result = await withTenant(institutionId, async (tx) => {
      const target = await tx.user.findFirst({ where: { id, institutionId } });
      if (!target) return { notFound: true as const };

      await tx.user.update({
        where: { id: target.id },
        data: { accountStatus: "ACTIVE" },
      });

      await recordAuditEvent(
        {
          action: "admin.user.reactivated",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "User",
          resourceId: id,
          requestRef: request.id,
        },
        tx,
      );

      return { ok: true as const };
    });

    if ("notFound" in result) {
      return reply.status(404).send({ error: "User not found" });
    }

    return reply.send({ message: "User reactivated" });
  });

  // ─── BULK IMPORT STUDENTS (CSV) ───────────────────────────────────────────
  app.post("/students/bulk-import", { preHandler: [requirePermission("admin.students.import")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { students } = request.body as { students: any[] };

    if (!Array.isArray(students) || students.length === 0) {
      return reply.status(400).send({ error: "No students provided" });
    }

    if (students.length > 500) {
      return reply.status(400).send({ error: "Maximum 500 students per import" });
    }

    const results = { created: 0, skipped: 0, errors: [] as string[] };

    await withTenant(institutionId, async (tx) => {
      for (const row of students) {
        const parsed = bulkImportStudentSchema.safeParse(row);
        if (!parsed.success) {
          results.errors.push(`Row ${results.created + results.skipped + 1}: Invalid data`);
          results.skipped++;
          continue;
        }

        const data = parsed.data;

        // Find course by code
        const dept = await tx.department.findFirst({
          where: { code: data.courseCode, institutionId },
        });
        if (!dept) {
          results.errors.push(`${data.enrollmentNo}: Course '${data.courseCode}' not found`);
          results.skipped++;
          continue;
        }

        // Check existing
        const existing = await tx.user.findUnique({ where: { email: data.email } });
        if (existing) {
          results.errors.push(`${data.enrollmentNo}: Email already exists`);
          results.skipped++;
          continue;
        }

        try {
          await tx.user.create({
            data: {
              email: data.email,
              passwordHash: null,
              role: "STUDENT",
              accountStatus: "ACTIVE",
              institutionId,
              studentProfile: {
                create: {
                  name: data.name,
                  enrollmentNo: data.enrollmentNo,
                  rollNumber: data.rollNumber,
                  departmentId: dept.id,
                  institutionId,
                  program: data.program,
                  semester: data.semester,
                  section: data.section,
                  dob: data.dob,
                  phone: data.phone,
                  address: data.address,
                },
              },
            },
          });
          results.created++;
        } catch {
          results.errors.push(`${data.enrollmentNo}: Creation failed`);
          results.skipped++;
        }
      }

      await recordAuditEvent(
        {
          action: "admin.students.imported",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "User",
          requestRef: request.id,
          metadata: { created: results.created, skipped: results.skipped },
        },
        tx,
      );
    });

    return reply.send(results);
  });

  // ─── EXPORT STUDENTS (CSV) ────────────────────────────────────────────────
  app.get("/students/export", { preHandler: [requirePermission("admin.students.export")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const students = await withTenant(institutionId, (tx) =>
      tx.user.findMany({
        where: { institutionId, role: "STUDENT" },
        include: {
          studentProfile: { include: { department: true } },
        },
        orderBy: [{ createdAt: "asc" }],
      }),
    );

    const headers = [
      "userId",
      "email",
      "accountStatus",
      "name",
      "enrollmentNo",
      "rollNumber",
      "courseCode",
      "courseName",
      "program",
      "semester",
      "section",
      "dob",
      "phone",
      "address",
      "createdAt",
      "lastLoginAt",
    ];

    const escapeCsv = (value: unknown) => {
      if (value === null || value === undefined) return "";
      const str = String(value);
      const escaped = str.replace(/"/g, '""');
      return /[",\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
    };

    const rows = students.map((u) => {
      const s = u.studentProfile;
      return [
        u.id,
        u.email,
        u.accountStatus,
        s?.name,
        s?.enrollmentNo,
        s?.rollNumber,
        s?.department?.code,
        s?.department?.name,
        s?.program,
        s?.semester,
        s?.section,
        s?.dob,
        s?.phone,
        s?.address,
        u.createdAt.toISOString(),
        u.lastLoginAt ? u.lastLoginAt.toISOString() : "",
      ]
        .map(escapeCsv)
        .join(",");
    });

    const csv = [headers.join(","), ...rows].join("\n");
    const filename = `students-${new Date().toISOString().slice(0, 10)}.csv`;

    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(`\uFEFF${csv}`);
  });

  // ─── EXPORT STUDENTS (XLSX) ────────────────────────────────────────────────
  app.get("/students/export.xlsx", { preHandler: [requirePermission("admin.students.export")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const students = await withTenant(institutionId, (tx) =>
      tx.user.findMany({
        where: { institutionId, role: "STUDENT" },
        include: {
          studentProfile: { include: { department: true } },
        },
        orderBy: [{ createdAt: "asc" }],
      }),
    );

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Students");

    const columns = [
      { header: "User ID", key: "userId", width: 22 },
      { header: "Email", key: "email", width: 28 },
      { header: "Account Status", key: "accountStatus", width: 18 },
      { header: "Name", key: "name", width: 24 },
      { header: "Enrollment No", key: "enrollmentNo", width: 18 },
      { header: "Roll Number", key: "rollNumber", width: 16 },
      { header: "Course Code", key: "courseCode", width: 14 },
      { header: "Course Name", key: "courseName", width: 36 },
      { header: "Program", key: "program", width: 14 },
      { header: "Semester", key: "semester", width: 10 },
      { header: "Section", key: "section", width: 10 },
      { header: "DOB", key: "dob", width: 14 },
      { header: "Phone", key: "phone", width: 16 },
      { header: "Address", key: "address", width: 30 },
      { header: "Created At", key: "createdAt", width: 24 },
      { header: "Last Login At", key: "lastLoginAt", width: 24 },
    ];

    sheet.columns = columns;

    for (const u of students) {
      const s = u.studentProfile;
      sheet.addRow({
        userId: u.id,
        email: u.email,
        accountStatus: u.accountStatus,
        name: s?.name ?? "",
        enrollmentNo: s?.enrollmentNo ?? "",
        rollNumber: s?.rollNumber ?? "",
        courseCode: s?.department?.code ?? "",
        courseName: s?.department?.name ?? "",
        program: s?.program ?? "",
        semester: s?.semester ?? "",
        section: s?.section ?? "",
        dob: s?.dob ?? "",
        phone: s?.phone ?? "",
        address: s?.address ?? "",
        createdAt: u.createdAt.toISOString(),
        lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : "",
      });
    }

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };

    const filename = `students-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const buffer = await workbook.xlsx.writeBuffer();

    return reply
      .header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      )
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(Buffer.from(buffer));
  });

  // ─── DEPARTMENTS ───────────────────────────────────────────────────────────
  app.get("/departments", { preHandler: [requirePermission("admin.departments.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const depts = await withTenant(institutionId, (tx) =>
      tx.department.findMany({ where: { institutionId } }),
    );
    return reply.send(depts);
  });

  app.post("/departments", { preHandler: [requirePermission("admin.departments.manage")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { name, code } = request.body as { name: string; code: string };

    if (!name || !code) {
      return reply.status(400).send({ error: "Name and code are required" });
    }

    const dept = await withTenant(institutionId, async (tx) => {
      const created = await tx.department.create({
        data: { name, code, institutionId },
      });

      await recordAuditEvent(
        {
          action: "admin.department.created",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "Department",
          resourceId: created.id,
          requestRef: request.id,
        },
        tx,
      );

      return created;
    });

    return reply.status(201).send(dept);
  });

  // ─── GATES ─────────────────────────────────────────────────────────────────
  app.get("/gates", { preHandler: [requirePermission("admin.gates.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const gates = await withTenant(institutionId, (tx) =>
      tx.gate.findMany({
        where: { institutionId },
        include: { assignedGuards: { include: { guard: true } } },
      }),
    );
    return reply.send(gates);
  });

  // ─── GATE HEALTH MONITORING ───────────────────────────────────────────────
  app.get("/gates/health", { preHandler: [requirePermission("admin.gates.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const now = Date.now();
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0));

    const rows = await withTenant(institutionId, async (tx) => {
      const gates = await tx.gate.findMany({
        where: { institutionId },
        include: {
          assignedGuards: { include: { guard: true } },
          gateEvents: {
            orderBy: { timestamp: "desc" },
            take: 1,
            include: { guard: true },
          },
        },
        orderBy: { name: "asc" },
      });

      return Promise.all(
        gates.map(async (gate) => {
          const [todayExits, todayReturns] = await Promise.all([
            tx.gateEvent.count({
              where: { gateId: gate.id, eventType: "EXIT", timestamp: { gte: todayStart } },
            }),
            tx.gateEvent.count({
              where: { gateId: gate.id, eventType: "RETURN", timestamp: { gte: todayStart } },
            }),
          ]);

          const lastEvent = gate.gateEvents[0] ?? null;
        const lastActivityAt = lastEvent?.timestamp ?? null;
        const minutesSinceLastActivity = lastActivityAt
          ? Math.floor((now - lastActivityAt.getTime()) / 60000)
          : null;

        let status: "OPERATIONAL" | "WARNING" | "OFFLINE" | "CLOSED";
        if (!gate.isActive) {
          status = "CLOSED";
        } else if (!lastActivityAt) {
          status = "WARNING";
        } else if ((minutesSinceLastActivity ?? 0) > 120) {
          status = "OFFLINE";
        } else if ((minutesSinceLastActivity ?? 0) > 30) {
          status = "WARNING";
        } else {
          status = "OPERATIONAL";
        }

        return {
          gateId: gate.id,
          gateName: gate.name,
          location: gate.location,
          status,
          isActive: gate.isActive,
          assignedGuards: gate.assignedGuards.map((a) => ({ id: a.guard.id, name: a.guard.name })),
          lastActivityAt,
          lastGuardName: lastEvent?.guard?.name ?? null,
          minutesSinceLastActivity,
          todayExits,
          todayReturns,
        };
        })
      );
    });

    return reply.send(rows);
  });

  app.get("/gates/:gateId/health", { preHandler: [requirePermission("admin.gates.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { gateId } = request.params as { gateId: string };

    const now = Date.now();
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0));

    const data = await withTenant(institutionId, async (tx) => {
      const gate = await tx.gate.findFirst({
        where: { id: gateId, institutionId },
        include: {
          assignedGuards: { include: { guard: true } },
          gateEvents: {
            orderBy: { timestamp: "desc" },
            take: 20,
            include: { guard: true, pass: { include: { student: true } } },
          },
        },
      });

      if (!gate) return null;

      const [todayExits, todayReturns] = await Promise.all([
        tx.gateEvent.count({
          where: { gateId: gate.id, eventType: "EXIT", timestamp: { gte: todayStart } },
        }),
        tx.gateEvent.count({
          where: { gateId: gate.id, eventType: "RETURN", timestamp: { gte: todayStart } },
        }),
      ]);

      return { gate, todayExits, todayReturns };
    });

    if (!data) {
      return reply.status(404).send({ error: "Gate not found" });
    }

    const { gate, todayExits, todayReturns } = data;

    const lastEvent = gate.gateEvents[0] ?? null;
    const lastActivityAt = lastEvent?.timestamp ?? null;
    const minutesSinceLastActivity = lastActivityAt
      ? Math.floor((now - lastActivityAt.getTime()) / 60000)
      : null;

    let status: "OPERATIONAL" | "WARNING" | "OFFLINE" | "CLOSED";
    if (!gate.isActive) {
      status = "CLOSED";
    } else if (!lastActivityAt) {
      status = "WARNING";
    } else if ((minutesSinceLastActivity ?? 0) > 120) {
      status = "OFFLINE";
    } else if ((minutesSinceLastActivity ?? 0) > 30) {
      status = "WARNING";
    } else {
      status = "OPERATIONAL";
    }

    return reply.send({
      gateId: gate.id,
      gateName: gate.name,
      location: gate.location,
      status,
      isActive: gate.isActive,
      assignedGuards: gate.assignedGuards.map((a) => ({ id: a.guard.id, name: a.guard.name })),
      lastActivityAt,
      minutesSinceLastActivity,
      todayExits,
      todayReturns,
      recentEvents: gate.gateEvents.map((e) => ({
        id: e.id,
        type: e.eventType,
        timestamp: e.timestamp,
        guardName: e.guard.name,
        passNumber: e.pass.passNumber,
        studentName: e.pass.student.name,
        enrollmentNo: e.pass.student.enrollmentNo,
      })),
    });
  });

  app.post("/gates", { preHandler: [requirePermission("admin.gates.manage")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { name, location } = request.body as { name: string; location?: string };

    if (!name) {
      return reply.status(400).send({ error: "Gate name is required" });
    }

    const gate = await withTenant(institutionId, async (tx) => {
      const created = await tx.gate.create({
        data: { name, location, institutionId },
      });

      await recordAuditEvent(
        {
          action: "admin.gate.created",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "Gate",
          resourceId: created.id,
          requestRef: request.id,
        },
        tx,
      );

      return created;
    });

    return reply.status(201).send(gate);
  });

  // ─── GUARD SHIFTS ──────────────────────────────────────────────────────────
  app.get("/guard-shifts", { preHandler: [requirePermission("admin.shifts.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { from, to } = request.query as { from?: string; to?: string };

    let fromDate: Date | undefined;
    let toDate: Date | undefined;

    if (from) {
      fromDate = new Date(from);
      if (Number.isNaN(fromDate.getTime())) {
        return reply.status(400).send({ error: "Invalid from date" });
      }
    }

    if (to) {
      toDate = new Date(to);
      if (Number.isNaN(toDate.getTime())) {
        return reply.status(400).send({ error: "Invalid to date" });
      }
    }

    const shifts = await withTenant(institutionId, (tx) =>
      tx.guardShift.findMany({
        where: {
          institutionId,
          ...(fromDate || toDate
            ? {
                scheduledStartAt: {
                  ...(fromDate ? { gte: fromDate } : {}),
                  ...(toDate ? { lte: toDate } : {}),
                },
              }
            : {}),
        },
        include: {
          guard: { select: { id: true, name: true } },
          gate: { select: { id: true, name: true, location: true } },
        },
        orderBy: { scheduledStartAt: "asc" },
      }),
    );

    return reply.send(shifts);
  });

  app.post("/guard-shifts", { preHandler: [requirePermission("admin.shifts.manage")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = createGuardShiftSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const { guardId, gateId, scheduledStartAt, scheduledEndAt, note } = parsed.data;
    const shiftStart = new Date(scheduledStartAt);
    const shiftEnd = new Date(scheduledEndAt);

    const result = await withTenant(institutionId, async (tx) => {
      const [guard, gate] = await Promise.all([
        tx.guardProfile.findFirst({ where: { id: guardId, user: { institutionId } } }),
        tx.gate.findFirst({ where: { id: gateId, institutionId } }),
      ]);

      if (!guard) return { error: { status: 404 as const, body: { error: "Guard not found in your institution" } } };
      if (!gate) return { error: { status: 404 as const, body: { error: "Gate not found in your institution" } } };

      const assignment = await tx.guardGateAssignment.findUnique({
        where: { guardId_gateId: { guardId: guard.id, gateId: gate.id } },
      });

      if (!assignment) {
        return { error: { status: 400 as const, body: { error: "Guard is not assigned to this gate" } } };
      }

      const overlap = await tx.guardShift.findFirst({
        where: {
          institutionId,
          guardId: guard.id,
          status: { in: ["SCHEDULED", "ACTIVE"] },
          scheduledStartAt: { lt: shiftEnd },
          scheduledEndAt: { gt: shiftStart },
        },
      });

      if (overlap) {
        return { error: { status: 409 as const, body: { error: "Guard already has an overlapping shift" } } };
      }

      const shift = await tx.guardShift.create({
        data: {
          institutionId,
          guardId: guard.id,
          gateId: gate.id,
          scheduledStartAt: shiftStart,
          scheduledEndAt: shiftEnd,
          note,
          createdById: userId,
        },
        include: {
          guard: { select: { id: true, name: true } },
          gate: { select: { id: true, name: true, location: true } },
        },
      });

      await recordAuditEvent(
        {
          action: "campus_movement.shift.created",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "GuardShift",
          resourceId: shift.id,
          requestRef: request.id,
          metadata: { guardId, gateId, scheduledStartAt, scheduledEndAt },
        },
        tx,
      );

      return { shift };
    });

    if ("error" in result && result.error) {
      return reply.status(result.error.status).send(result.error.body);
    }

    return reply.status(201).send(result.shift);
  });

  // ─── EXIT REASONS ──────────────────────────────────────────────────────────
  app.get("/reasons", { preHandler: [requirePermission("admin.reasons.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const reasons = await withTenant(institutionId, (tx) =>
      tx.exitReason.findMany({ where: { institutionId } }),
    );
    return reply.send(reasons);
  });

  app.post("/reasons", { preHandler: [requirePermission("admin.reasons.manage")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { label, requiresNote } = request.body as { label: string; requiresNote?: boolean };

    if (!label) {
      return reply.status(400).send({ error: "Label is required" });
    }

    const reason = await withTenant(institutionId, async (tx) => {
      const created = await tx.exitReason.create({
        data: { label, requiresNote: requiresNote || false, institutionId },
      });

      await recordAuditEvent(
        {
          action: "admin.reason.created",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "ExitReason",
          resourceId: created.id,
          requestRef: request.id,
        },
        tx,
      );

      return created;
    });

    return reply.status(201).send(reason);
  });

  // ─── ALLOWANCE POLICY ────────────────────────────────────────────────────────
  app.get("/allowance-policy", { preHandler: [requirePermission("admin.allowance_policy.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const policy = await withTenant(institutionId, (tx) =>
      AllowanceEngine.getOrCreatePolicy(institutionId, tx),
    );

    return reply.send({
      allowanceAmount: policy.allowanceAmount,
      policyPeriod: policy.policyPeriod,
      gracePeriod: policy.gracePeriod,
      enforcement: policy.enforcement,
      minimumSampleSize: policy.minimumSampleSize,
      severityMinorMax: policy.severityThresholds.minorMax,
      severityModerateMax: policy.severityThresholds.moderateMax,
      severitySignificantMax: policy.severityThresholds.significantMax,
    });
  });

  app.put("/allowance-policy", { preHandler: [requirePermission("admin.allowance_policy.manage")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const body = request.body as any;

    // Validate bounds
    if (body.allowanceAmount !== undefined && (body.allowanceAmount < 60 || body.allowanceAmount > 10080)) {
      return reply.status(400).send({ error: "allowanceAmount must be between 60 and 10080" });
    }
    if (body.gracePeriod !== undefined && (body.gracePeriod < 0 || body.gracePeriod > 60)) {
      return reply.status(400).send({ error: "gracePeriod must be between 0 and 60" });
    }
    if (body.minimumSampleSize !== undefined && (body.minimumSampleSize < 3 || body.minimumSampleSize > 20)) {
      return reply.status(400).send({ error: "minimumSampleSize must be between 3 and 20" });
    }

    // Validate enums
    const validPeriods = ["DAILY", "WEEKLY", "MONTHLY", "SEMESTER"];
    if (body.policyPeriod && !validPeriods.includes(body.policyPeriod)) {
      return reply.status(400).send({ error: "Invalid policyPeriod" });
    }
    const validEnforcements = ["BLOCK_NEW_REQUESTS", "WARN_ONLY"];
    if (body.enforcement && !validEnforcements.includes(body.enforcement)) {
      return reply.status(400).send({ error: "Invalid enforcement mode" });
    }

    // Build validated fields object
    const validatedFields: Record<string, any> = {};
    if (body.allowanceAmount !== undefined) validatedFields.allowanceAmount = body.allowanceAmount;
    if (body.policyPeriod !== undefined) validatedFields.policyPeriod = body.policyPeriod;
    if (body.gracePeriod !== undefined) validatedFields.gracePeriod = body.gracePeriod;
    if (body.enforcement !== undefined) validatedFields.enforcement = body.enforcement;
    if (body.minimumSampleSize !== undefined) validatedFields.minimumSampleSize = body.minimumSampleSize;
    if (body.severityMinorMax !== undefined) validatedFields.severityMinorMax = body.severityMinorMax;
    if (body.severityModerateMax !== undefined) validatedFields.severityModerateMax = body.severityModerateMax;
    if (body.severitySignificantMax !== undefined) validatedFields.severitySignificantMax = body.severitySignificantMax;

    // Upsert the policy
    const policy = await withTenant(institutionId, async (tx) => {
      const upserted = await tx.allowancePolicy.upsert({
        where: { institutionId },
        update: validatedFields,
        create: { institutionId, ...validatedFields },
      });

      // Audit
      await recordAuditEvent(
        {
          action: "admin.allowance_policy.updated",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "AllowancePolicy",
          resourceId: upserted.id,
          requestRef: request.id,
          metadata: body,
        },
        tx,
      );

      return upserted;
    });

    return reply.send(policy);
  });

  // ─── INSTITUTION CONFIG ───────────────────────────────────────────────────
  app.get("/institution-config", { preHandler: [requirePermission("admin.institution_config.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;

    const config = await withTenant(institutionId, (tx) =>
      AllowanceEngine.getOrCreateInstitutionConfig(institutionId, tx),
    );
    return reply.send(config);
  });

  app.put("/institution-config", { preHandler: [requirePermission("admin.institution_config.manage")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = updateInstitutionConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const payload = parsed.data;

    const normalizedWorkingDays = payload.workingDaysOfWeek
      ? Array.from(new Set(payload.workingDaysOfWeek)).sort((a, b) => a - b)
      : undefined;

    const config = await withTenant(institutionId, async (tx) => {
      const upserted = await tx.institutionConfig.upsert({
        where: { institutionId },
        update: {
          ...(payload.timezone !== undefined ? { timezone: payload.timezone } : {}),
          ...(payload.weekStartDay !== undefined ? { weekStartDay: payload.weekStartDay } : {}),
          ...(normalizedWorkingDays !== undefined ? { workingDaysOfWeek: normalizedWorkingDays } : {}),
          ...(payload.lowAllowanceThresholdMinutes !== undefined
            ? { lowAllowanceThresholdMinutes: payload.lowAllowanceThresholdMinutes }
            : {}),
        },
        create: {
          institutionId,
          timezone: payload.timezone ?? "Asia/Kolkata",
          weekStartDay: payload.weekStartDay ?? "MONDAY",
          workingDaysOfWeek: normalizedWorkingDays ?? [1, 2, 3, 4, 5, 6],
          lowAllowanceThresholdMinutes: payload.lowAllowanceThresholdMinutes ?? 60,
        },
      });

      await recordAuditEvent(
        {
          action: "admin.institution_config.updated",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "InstitutionConfig",
          resourceId: upserted.id,
          requestRef: request.id,
          metadata: payload,
        },
        tx,
      );

      return upserted;
    });

    return reply.send(config);
  });

  // ─── ACADEMIC CALENDAR (generalized — Phase 1, Decision A/D) ──────────────
  // These handlers are gated on the new academics.calendar.manage permission
  // (NOT the retained-but-route-unused admin.academic_calendar.manage), carry NO
  // requireModuleActive (academics is foundational, not a gated module — Decision
  // A), run through withTenant, write an append-only AcademicCalendarDayRevision
  // row in the SAME transaction before each mutation, and audit
  // academics.calendar.updated. The gone (institutionId, date) compound-unique is
  // replaced by findFirst/create/update keyed on (institutionId, date,
  // departmentId ?? null) — the partial-unique shape is not a Prisma compound key.
  app.get("/academic-calendar", { preHandler: [requirePermission("academics.calendar.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { startDate, endDate, departmentId } = request.query as {
      startDate?: string;
      endDate?: string;
      departmentId?: string;
    };

    const now = new Date();
    const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const defaultEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const start = startDate ? new Date(startDate) : defaultStart;
    const end = endDate ? new Date(endDate) : defaultEnd;

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      return reply.status(400).send({ error: "Invalid date range" });
    }

    const days = await withTenant(institutionId, (tx) =>
      CalendarService.getEntries(institutionId, start, end, tx, {
        departmentId: departmentId || undefined,
      }),
    );

    return reply.send(days);
  });

  app.put("/academic-calendar/day", { preHandler: [requirePermission("academics.calendar.manage")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = upsertAcademicCalendarDaySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const { date, dayType, note, departmentId, academicSessionId, academicTermId } = parsed.data;
    const parts = date.split("-").map((v) => Number(v));
    if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) {
      return reply.status(400).send({ error: "Invalid date" });
    }

    const normalizedDate = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
    const scopeDepartmentId = departmentId ?? null;

    const day = await withTenant(institutionId, async (tx) => {
      const existing = await tx.academicCalendarDay.findFirst({
        where: { institutionId, date: normalizedDate, departmentId: scopeDepartmentId },
      });

      // Append-only revision row written BEFORE the mutation, in the same tx.
      await tx.academicCalendarDayRevision.create({
        data: {
          institutionId,
          calendarDayId: existing?.id ?? null,
          date: normalizedDate,
          departmentId: scopeDepartmentId,
          previousDayType: existing?.dayType ?? null,
          newDayType: dayType,
          previousNote: existing?.note ?? null,
          newNote: note ?? null,
          changeType: existing ? "UPDATE" : "CREATE",
          actorUserId: userId,
          academicSessionId: academicSessionId ?? null,
          academicTermId: academicTermId ?? null,
        },
      });

      const upserted = existing
        ? await tx.academicCalendarDay.update({
            where: { id: existing.id },
            data: { dayType, note: note ?? null, academicSessionId: academicSessionId ?? null, academicTermId: academicTermId ?? null },
          })
        : await tx.academicCalendarDay.create({
            data: {
              institutionId,
              date: normalizedDate,
              dayType,
              note: note ?? null,
              departmentId: scopeDepartmentId,
              academicSessionId: academicSessionId ?? null,
              academicTermId: academicTermId ?? null,
            },
          });

      await recordAuditEvent(
        {
          action: "academics.calendar.updated",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "AcademicCalendarDay",
          resourceId: upserted.id,
          requestRef: request.id,
          metadata: { date: upserted.date, dayType: upserted.dayType, changeType: existing ? "UPDATE" : "CREATE", departmentId: scopeDepartmentId },
        },
        tx,
      );

      return upserted;
    });

    return reply.send({ calendarDay: day, warnings: [] as Warning[] });
  });

  app.delete("/academic-calendar/day/:date", { preHandler: [requirePermission("academics.calendar.manage")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { date } = request.params as { date: string };
    const { departmentId } = request.query as { departmentId?: string };

    const parts = date.split("-").map((v) => Number(v));
    if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) {
      return reply.status(400).send({ error: "Invalid date" });
    }

    const normalizedDate = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
    const scopeDepartmentId = departmentId ?? null;

    const result = await withTenant(institutionId, async (tx) => {
      const existing = await tx.academicCalendarDay.findFirst({
        where: { institutionId, date: normalizedDate, departmentId: scopeDepartmentId },
      });

      if (!existing) return { notFound: true as const };

      // Append-only DELETE revision written BEFORE the delete, in the same tx.
      await tx.academicCalendarDayRevision.create({
        data: {
          institutionId,
          calendarDayId: existing.id,
          date: normalizedDate,
          departmentId: scopeDepartmentId,
          previousDayType: existing.dayType,
          newDayType: null,
          previousNote: existing.note,
          newNote: null,
          changeType: "DELETE",
          actorUserId: userId,
          academicSessionId: existing.academicSessionId,
          academicTermId: existing.academicTermId,
        },
      });

      await tx.academicCalendarDay.delete({ where: { id: existing.id } });

      await recordAuditEvent(
        {
          action: "academics.calendar.updated",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "AcademicCalendarDay",
          resourceId: existing.id,
          requestRef: request.id,
          metadata: { deleted: true, date: normalizedDate, changeType: "DELETE", departmentId: scopeDepartmentId },
        },
        tx,
      );

      return { ok: true as const };
    });

    if ("notFound" in result) {
      return reply.status(404).send({ error: "Calendar day not found" });
    }

    return reply.send({ success: true, warnings: [] as Warning[] });
  });

  // ─── ACADEMIC SESSIONS + TERMS (Phase 1 — permission-gated only, Decision A) ─
  // All routes below: requirePermission(academics.*), withTenant, recordAuditEvent
  // in-tx, success-plus-warnings envelope { <resource>, warnings }. NO
  // requireModuleActive — academics is foundational, not a gated module.
  app.get("/academic/sessions", { preHandler: [requirePermission("academics.sessions.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { status } = request.query as { status?: string };

    const where: Record<string, unknown> = { institutionId };
    if (status) where.status = status;

    const sessions = await withTenant(institutionId, (tx) =>
      tx.academicSession.findMany({ where, orderBy: { createdAt: "desc" } }),
    );

    return reply.send({ sessions, warnings: [] as Warning[] });
  });

  app.post("/academic/sessions", { preHandler: [requirePermission("academics.sessions.manage")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = createAcademicSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { name, structureType, startDate, endDate } = parsed.data;

    const result = await withTenant(institutionId, async (tx) => {
      const dup = await tx.academicSession.findFirst({ where: { institutionId, name } });
      if (dup) return { conflict: true as const };

      const session = await tx.academicSession.create({
        data: {
          institutionId,
          name,
          structureType,
          startDate: new Date(startDate),
          endDate: new Date(endDate),
        },
      });

      await recordAuditEvent(
        {
          action: "academics.session.created",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "AcademicSession",
          resourceId: session.id,
          requestRef: request.id,
          metadata: { name: session.name, structureType: session.structureType },
        },
        tx,
      );

      return { session };
    });

    if ("conflict" in result) {
      return reply.status(409).send({ error: "session name exists" });
    }

    return reply.status(201).send({ session: result.session, warnings: [] as Warning[] });
  });

  app.get("/academic/sessions/:id", { preHandler: [requirePermission("academics.sessions.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { id } = request.params as { id: string };

    const session = await withTenant(institutionId, (tx) =>
      tx.academicSession.findFirst({
        where: { id, institutionId },
        include: { terms: { orderBy: { ordinal: "asc" } } },
      }),
    );

    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }

    return reply.send({ session, warnings: [] as Warning[] });
  });

  app.patch("/academic/sessions/:id", { preHandler: [requirePermission("academics.sessions.manage")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { id } = request.params as { id: string };

    const parsed = academicSessionObject.partial().safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const result = await withTenant(institutionId, async (tx) => {
      const existing = await tx.academicSession.findFirst({ where: { id, institutionId } });
      if (!existing) return { notFound: true as const };
      // PATCH allowed ONLY while UPCOMING (preserve-history §5.1).
      if (existing.status !== "UPCOMING") return { notEditable: true as const };

      const data: Record<string, unknown> = {};
      if (parsed.data.name !== undefined) data.name = parsed.data.name;
      if (parsed.data.structureType !== undefined) data.structureType = parsed.data.structureType;
      if (parsed.data.startDate !== undefined) data.startDate = new Date(parsed.data.startDate);
      if (parsed.data.endDate !== undefined) data.endDate = new Date(parsed.data.endDate);

      const session = await tx.academicSession.update({ where: { id }, data });

      await recordAuditEvent(
        {
          action: "academics.session.updated",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "AcademicSession",
          resourceId: session.id,
          requestRef: request.id,
        },
        tx,
      );

      return { session };
    });

    if ("notFound" in result) return reply.status(404).send({ error: "Session not found" });
    if ("notEditable" in result) return reply.status(409).send({ error: "session not editable" });

    return reply.send({ session: result.session, warnings: [] as Warning[] });
  });

  app.post("/academic/sessions/:id/terms", { preHandler: [requirePermission("academics.sessions.manage")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { id } = request.params as { id: string };

    const parsed = academicTermObject
      .omit({ academicSessionId: true })
      .refine((d) => new Date(d.startDate) < new Date(d.endDate), {
        message: "Start date must be before end date",
        path: ["endDate"],
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { name, ordinal, startDate, endDate } = parsed.data;

    const result = await withTenant(institutionId, async (tx) => {
      const session = await tx.academicSession.findFirst({ where: { id, institutionId } });
      if (!session) return { notFound: true as const };

      const dup = await tx.academicTerm.findFirst({
        where: { academicSessionId: id, ordinal },
      });
      if (dup) return { ordinalConflict: true as const };

      const existingTerms = await tx.academicTerm.findMany({
        where: { academicSessionId: id, institutionId },
      });

      const newRange = { startDate: new Date(startDate), endDate: new Date(endDate) };
      const warnings: Warning[] = [];
      const outside = termOutsideSessionWarning(newRange, {
        startDate: session.startDate,
        endDate: session.endDate,
      });
      if (outside) warnings.push(outside);
      const overlap = termOverlapWarning(
        newRange,
        existingTerms.map((t) => ({ startDate: t.startDate, endDate: t.endDate })),
      );
      if (overlap) warnings.push(overlap);
      const countWarn = termCountWarning(session.structureType, existingTerms.length + 1);
      if (countWarn) warnings.push(countWarn);

      const term = await tx.academicTerm.create({
        data: {
          institutionId,
          academicSessionId: id,
          name,
          ordinal,
          startDate: newRange.startDate,
          endDate: newRange.endDate,
        },
      });

      await recordAuditEvent(
        {
          action: "academics.term.created",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "AcademicTerm",
          resourceId: term.id,
          requestRef: request.id,
          metadata: { name: term.name, ordinal: term.ordinal },
        },
        tx,
      );

      return { term, warnings };
    });

    if ("notFound" in result) return reply.status(404).send({ error: "Session not found" });
    if ("ordinalConflict" in result) return reply.status(409).send({ error: "ordinal exists" });

    return reply.status(201).send({ term: result.term, warnings: result.warnings });
  });

  app.patch("/academic/terms/:id", { preHandler: [requirePermission("academics.sessions.manage")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { id } = request.params as { id: string };

    const parsed = academicTermObject
      .omit({ academicSessionId: true })
      .partial()
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const result = await withTenant(institutionId, async (tx) => {
      const existing = await tx.academicTerm.findFirst({ where: { id, institutionId } });
      if (!existing) return { notFound: true as const };
      if (existing.status === "CLOSED") return { notEditable: true as const };

      const data: Record<string, unknown> = {};
      if (parsed.data.name !== undefined) data.name = parsed.data.name;
      if (parsed.data.ordinal !== undefined) data.ordinal = parsed.data.ordinal;
      if (parsed.data.startDate !== undefined) data.startDate = new Date(parsed.data.startDate);
      if (parsed.data.endDate !== undefined) data.endDate = new Date(parsed.data.endDate);

      const term = await tx.academicTerm.update({ where: { id }, data });

      await recordAuditEvent(
        {
          action: "academics.term.updated",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "AcademicTerm",
          resourceId: term.id,
          requestRef: request.id,
        },
        tx,
      );

      return { term };
    });

    if ("notFound" in result) return reply.status(404).send({ error: "Term not found" });
    if ("notEditable" in result) return reply.status(409).send({ error: "term not editable" });

    return reply.send({ term: result.term, warnings: [] as Warning[] });
  });

  // ─── SESSION / TERM LIFECYCLE (state machine in academic-session.ts) ─────────
  app.post("/academic/sessions/:id/activate", { preHandler: [requirePermission("academics.sessions.manage")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { id } = request.params as { id: string };
    const query = request.query as { handover?: string };
    const body = (request.body ?? {}) as { handover?: boolean };
    const handover = query.handover === "true" || body.handover === true;

    const outcome = await withTenant(institutionId, async (tx) => {
      const result = await activateSession(tx, institutionId, id, handover);
      if (!result.ok) return { result };

      await recordAuditEvent(
        {
          action: "academics.session.activated",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "AcademicSession",
          resourceId: result.session.id,
          requestRef: request.id,
        },
        tx,
      );

      if (result.closedSessionId) {
        await recordAuditEvent(
          {
            action: "academics.session.closed",
            result: "SUCCESS",
            actorUserId: userId,
            actorRoleKey: request.auth?.roles[0] ?? request.user.role,
            institutionId,
            actorMembershipId: request.auth?.membershipId,
            resourceType: "AcademicSession",
            resourceId: result.closedSessionId,
            requestRef: request.id,
            metadata: { handover: true },
          },
          tx,
        );
      }

      return { result };
    });

    const r = outcome.result;
    if (!r.ok) {
      switch (r.code) {
        case "NOT_FOUND":
          return reply.status(404).send({ error: "Session not found" });
        case "INVALID_STATE":
          return reply.status(409).send({ error: "invalid state" });
        case "NO_TERMS":
          return reply.status(409).send({ error: "session needs >=1 term" });
        case "TERM_INVALID_DATES":
          return reply.status(409).send({ error: "term has invalid dates", termId: r.termId });
        case "ACTIVE_EXISTS":
          return reply.status(409).send({ error: "active session exists; pass handover=true" });
      }
    }

    return reply.send({ session: r.session, warnings: r.warnings });
  });

  app.post("/academic/sessions/:id/close", { preHandler: [requirePermission("academics.sessions.manage")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { id } = request.params as { id: string };

    const outcome = await withTenant(institutionId, async (tx) => {
      const result = await closeSession(tx, institutionId, id);
      if (!result.ok) return { result };

      await recordAuditEvent(
        {
          action: "academics.session.closed",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "AcademicSession",
          resourceId: result.session.id,
          requestRef: request.id,
        },
        tx,
      );

      return { result };
    });

    const r = outcome.result;
    if (!r.ok) {
      if (r.code === "NOT_FOUND") return reply.status(404).send({ error: "Session not found" });
      return reply.status(409).send({ error: "invalid state" });
    }

    return reply.send({ session: r.session, warnings: [] as Warning[] });
  });

  app.post("/academic/terms/:id/activate", { preHandler: [requirePermission("academics.sessions.manage")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { id } = request.params as { id: string };

    const outcome = await withTenant(institutionId, async (tx) => {
      const result = await activateTerm(tx, institutionId, id);
      if (!result.ok) return { result };

      await recordAuditEvent(
        {
          action: "academics.term.activated",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "AcademicTerm",
          resourceId: result.term.id,
          requestRef: request.id,
        },
        tx,
      );

      return { result };
    });

    const r = outcome.result;
    if (!r.ok) {
      if (r.code === "NOT_FOUND") return reply.status(404).send({ error: "Term not found" });
      if (r.code === "SESSION_NOT_ACTIVE") return reply.status(409).send({ error: "session not active" });
      return reply.status(409).send({ error: "invalid state" });
    }

    return reply.send({ term: r.term, warnings: [] as Warning[] });
  });

  app.post("/academic/terms/:id/close", { preHandler: [requirePermission("academics.sessions.manage")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { id } = request.params as { id: string };

    const outcome = await withTenant(institutionId, async (tx) => {
      const result = await closeTerm(tx, institutionId, id);
      if (!result.ok) return { result };

      await recordAuditEvent(
        {
          action: "academics.term.closed",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "AcademicTerm",
          resourceId: result.term.id,
          requestRef: request.id,
        },
        tx,
      );

      return { result };
    });

    const r = outcome.result;
    if (!r.ok) {
      if (r.code === "NOT_FOUND") return reply.status(404).send({ error: "Term not found" });
      return reply.status(409).send({ error: "invalid state" });
    }

    return reply.send({ term: r.term, warnings: [] as Warning[] });
  });

  // ─── ACADEMIC PROGRAMS (Phase 1 — permission-gated only, Decision A) ─────────
  app.get("/academic/programs", { preHandler: [requirePermission("academics.programs.manage")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { departmentId, status } = request.query as { departmentId?: string; status?: string };

    const where: Record<string, unknown> = { institutionId };
    if (departmentId) where.departmentId = departmentId;
    if (status) where.status = status;

    const programs = await withTenant(institutionId, (tx) =>
      tx.program.findMany({ where, orderBy: { createdAt: "desc" } }),
    );

    return reply.send({ programs, warnings: [] as Warning[] });
  });

  app.post("/academic/programs", { preHandler: [requirePermission("academics.programs.manage")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = createProgramSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { departmentId, name, code, duration, durationUnit } = parsed.data;

    const result = await withTenant(institutionId, async (tx) => {
      const dept = await tx.department.findFirst({ where: { id: departmentId, institutionId } });
      if (!dept) return { unknownDept: true as const };

      const dup = await tx.program.findFirst({ where: { institutionId, code } });
      if (dup) return { codeConflict: true as const };

      const program = await tx.program.create({
        data: { institutionId, departmentId, name, code, duration, durationUnit },
      });

      await recordAuditEvent(
        {
          action: "academics.program.created",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "Program",
          resourceId: program.id,
          requestRef: request.id,
          metadata: { code: program.code, name: program.name },
        },
        tx,
      );

      return { program };
    });

    if ("unknownDept" in result) return reply.status(400).send({ error: "unknown department" });
    if ("codeConflict" in result) return reply.status(409).send({ error: "program code exists" });

    return reply.status(201).send({ program: result.program, warnings: [] as Warning[] });
  });

  app.patch("/academic/programs/:id", { preHandler: [requirePermission("academics.programs.manage")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { id } = request.params as { id: string };

    const parsed = createProgramSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    // Program status (ACTIVE/INACTIVE) is edited via a separate body field — it
    // is a different enum from durationUnit, so it is read off the raw body and
    // whitelisted below rather than added to the create schema.
    const statusRaw = (request.body as { status?: string } | undefined)?.status;

    const result = await withTenant(institutionId, async (tx) => {
      const existing = await tx.program.findFirst({ where: { id, institutionId } });
      if (!existing) return { notFound: true as const };

      const data: Record<string, unknown> = {};
      if (parsed.data.name !== undefined) data.name = parsed.data.name;
      if (parsed.data.duration !== undefined) data.duration = parsed.data.duration;
      if (parsed.data.durationUnit !== undefined) data.durationUnit = parsed.data.durationUnit;
      if (statusRaw === "ACTIVE" || statusRaw === "INACTIVE") data.status = statusRaw;

      if (parsed.data.departmentId !== undefined && parsed.data.departmentId !== existing.departmentId) {
        const dept = await tx.department.findFirst({
          where: { id: parsed.data.departmentId, institutionId },
        });
        if (!dept) return { unknownDept: true as const };
        data.departmentId = parsed.data.departmentId;
      }

      if (parsed.data.code !== undefined && parsed.data.code !== existing.code) {
        const dup = await tx.program.findFirst({ where: { institutionId, code: parsed.data.code } });
        if (dup) return { codeConflict: true as const };
        data.code = parsed.data.code;
      }

      const program = await tx.program.update({ where: { id }, data });

      await recordAuditEvent(
        {
          action: "academics.program.updated",
          result: "SUCCESS",
          actorUserId: userId,
          actorRoleKey: request.auth?.roles[0] ?? request.user.role,
          institutionId,
          actorMembershipId: request.auth?.membershipId,
          resourceType: "Program",
          resourceId: program.id,
          requestRef: request.id,
        },
        tx,
      );

      return { program };
    });

    if ("notFound" in result) return reply.status(404).send({ error: "Program not found" });
    if ("unknownDept" in result) return reply.status(400).send({ error: "unknown department" });
    if ("codeConflict" in result) return reply.status(409).send({ error: "program code exists" });

    return reply.send({ program: result.program, warnings: [] as Warning[] });
  });

  // ─── ADMIN PASS REVOCATION ────────────────────────────────────────────────
  app.post("/passes/:passId/revoke", { preHandler: [requirePermission("campus_movement.pass.revoke"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { passId } = request.params as { passId: string };
    const { reason } = request.body as { reason?: string };

    if (!reason || reason.trim().length < 3) {
      return reply.status(400).send({ error: "Revocation reason is required" });
    }

    const result = await withTenant(institutionId, async (tx) => {
      const pass = await tx.gatePass.findFirst({
        where: {
          id: passId,
          student: { user: { institutionId } },
          status: { in: ["APPROVED", "ACTIVE", "OUTSIDE"] },
        },
        include: { student: { select: { userId: true, name: true } } },
      });

      if (!pass) return { notFound: true as const };

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
            reason: reason.trim(),
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
          body: `Your gate pass ${pass.passNumber} was revoked: ${reason.trim()}`,
          type: "PASS_REVOKED",
          data: { passId: pass.id },
        },
        tx,
      );

      return { updated };
    });

    if ("notFound" in result) {
      return reply.status(404).send({ error: "Eligible pass not found for revocation" });
    }
    if ("conflict" in result) {
      return reply.status(409).send({ error: "Pass state changed, please refresh and try again" });
    }

    return reply.send(result.updated);
  });

  // ─── ADMIN EMERGENCY OVERRIDE ─────────────────────────────────────────────
  app.post("/emergency-override", { preHandler: [requirePermission("campus_movement.pass.override"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { passId, justification } = request.body as { passId: string; justification: string };

    if (!justification || justification.length < 10) {
      return reply.status(400).send({ error: "Justification must be at least 10 characters" });
    }

    const result = await withTenant(institutionId, async (tx) => {
      const pass = await tx.gatePass.findFirst({
        where: {
          id: passId,
          student: { user: { institutionId } },
        },
      });
      if (!pass) return { notFound: true as const };

      const override = await tx.emergencyOverride.create({
        data: { gatePassId: passId, institutionId, overriddenById: userId, justification },
      });

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

    if ("notFound" in result) {
      return reply.status(404).send({ error: "Pass not found" });
    }

    return reply.status(201).send(result.override);
  });

  // ─── AUDIT LOGS ────────────────────────────────────────────────────────────
  app.get("/audit-logs", { preHandler: [requirePermission("campus_movement.audit.view"), requireModuleActive("campus_movement")] }, async (request, reply) => {
    const { institutionId } = request.user;
    const { page = "1", limit = "50", action } = request.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    // Rely on RLS (tenant_isolation_select: institutionId = GUC) for tenant
    // scoping under withTenant — NO actor.institutionId join (design §4.4): the
    // actor join would hide break-glass rows whose actor is a PLATFORM user.
    const where: any = {};
    if (action) {
      let actionKey: string | undefined;
      if (AUDIT_ACTION_KEY_SET.has(action)) {
        actionKey = action;
      } else if (action in LEGACY_AUDIT_ACTION_MAP) {
        actionKey = LEGACY_AUDIT_ACTION_MAP[action as LegacyAuditAction];
      } else {
        return reply.status(400).send({ error: "unknown action filter" });
      }
      where.action = actionKey;
    }

    // Read the audit rows under RLS WITHOUT a relational include on actorUser.
    // A break-glass `.accessed` row's actor is a PLATFORM user whose `users` row
    // is invisible to this tenant's RLS; a required-relation `include` would make
    // Prisma throw when that row is joined (the actor resolves to null), which
    // would 500 exactly the break-glass-transparency rows the tenant MUST see
    // (design §4.4). Instead select the rows under RLS, then resolve the actor
    // summary separately on privilegedPrisma and attach it, preserving the
    // existing { logs: [{ ...row, actorUser }], pagination } response shape.
    const [rows, total] = await withTenant(institutionId, (tx) =>
      Promise.all([
        tx.auditEvent.findMany({
          where,
          orderBy: { timestamp: "desc" },
          skip: (pageNum - 1) * limitNum,
          take: limitNum,
        }),
        tx.auditEvent.count({ where }),
      ]),
    );

    const actorIds = [...new Set(rows.map((r) => r.actorUserId))];
    const actors = actorIds.length
      ? await privilegedPrisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, email: true, role: true },
        })
      : [];
    const actorById = new Map(actors.map((a) => [a.id, a]));
    const logs = rows.map((r) => ({ ...r, actorUser: actorById.get(r.actorUserId) ?? null }));

    return reply.send({
      logs,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  });

  // ─── SUPPORT GRANTS (tenant transparency + revoke) ─────────────────────────

  // Tenant admin revokes a break-glass grant into THEIR institution (design
  // §7.2). Gated on the dedicated write permission admin.support.revoke (NOT the
  // read key). The grant is loaded on privilegedPrisma (support_grants is a
  // platform table; campass_app has SELECT only, no write); a grant into another
  // tenant returns 404 (avoid existence disclosure).
  app.post(
    "/support-grants/:id/revoke",
    { preHandler: [requirePermission("admin.support.revoke")] },
    async (request, reply) => {
      const { userId, institutionId } = request.user;
      const { id } = request.params as { id: string };
      const { reason } = (request.body ?? {}) as { reason?: string };

      const grant = await privilegedPrisma.supportGrant.findUnique({ where: { id } });
      if (!grant || grant.institutionId !== institutionId) {
        return reply.status(404).send({ error: "Support grant not found" });
      }

      const updated = await privilegedPrisma.supportGrant.update({
        where: { id },
        data: {
          status: "REVOKED",
          revokedAt: new Date(),
          revokedByUserId: userId,
          revokedReason: reason ?? null,
        },
      });

      await recordAuditEvent({
        action: "platform.support_grant.revoked",
        result: "SUCCESS",
        actorUserId: userId,
        actorRoleKey: request.auth?.roles[0] ?? request.user.role,
        institutionId,
        actorMembershipId: request.auth?.membershipId ?? null,
        supportGrantId: grant.id,
        resourceType: "SupportGrant",
        resourceId: grant.id,
        requestRef: request.id,
      });

      return reply.send(updated);
    },
  );

  // Tenant admin reads grants affecting THEIR institution (design §7.3). Read is
  // correctly gated on the READ permission. Reads via withTenant so the
  // support_grants_tenant_read RLS policy scopes to the caller's tenant.
  app.get(
    "/support-grants",
    { preHandler: [requirePermission("campus_movement.audit.view")] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const grants = await withTenant(institutionId, (tx) =>
        tx.supportGrant.findMany({ orderBy: { createdAt: "desc" } }),
      );
      return reply.send(grants);
    },
  );

  // ─── MODULE ACTIVATION (tenant admin; design §6.2) ─────────────────────────
  // NOT module-gated themselves (gating module management on the module being
  // active would be circular). Permission-gated via admin.modules.manage only.

  // List own module matrix: every MODULES key with the institution's effective
  // state (NOT_ENTITLED where no row). Iterate the STATIC catalogue; the findMany
  // takes NO explicit filter — RLS scopes it to the caller's own institution.
  app.get(
    "/modules",
    { preHandler: [requirePermission("admin.modules.manage")] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const rows = await withTenant(institutionId, (tx) =>
        tx.institutionModule.findMany({
          select: { moduleKey: true, state: true, entitledAt: true, activatedAt: true, suspendedAt: true },
        }),
      );
      const byKey = new Map(rows.map((r) => [r.moduleKey, r]));
      const modules = MODULES.map((m) => {
        const row = byKey.get(m.key);
        return {
          moduleKey: m.key,
          name: m.name,
          state: row?.state ?? "NOT_ENTITLED",
          entitledAt: row?.entitledAt ?? null,
          activatedAt: row?.activatedAt ?? null,
          suspendedAt: row?.suspendedAt ?? null,
        };
      });
      return reply.send({ institutionId, modules });
    },
  );

  // Activate a module: ENTITLED/SUSPENDED -> ACTIVE (dependency-validated).
  app.post(
    "/modules/:moduleKey/activate",
    { preHandler: [requirePermission("admin.modules.manage")] },
    async (request, reply) => {
      const { userId, institutionId } = request.user;
      const { moduleKey } = request.params as { moduleKey: string };
      if (!MODULE_KEY_SET.has(moduleKey)) {
        return reply.status(400).send({ error: "Unknown moduleKey" });
      }
      const key = moduleKey as ModuleKey;

      const result = await withTenant(institutionId, async (tx) => {
        const r = await activate(tx, institutionId, key, userId);
        if (r.ok) {
          await recordAuditEvent(
            {
              action: "admin.module.activated",
              result: "SUCCESS",
              actorUserId: userId,
              actorRoleKey: request.auth?.roles[0] ?? request.user.role,
              institutionId,
              actorMembershipId: request.auth?.membershipId,
              resourceType: "InstitutionModule",
              resourceId: key,
              requestRef: request.id,
              metadata: { moduleKey: key },
            },
            tx,
          );
        }
        return r;
      });

      if (!result.ok) {
        if (result.reason === "NOT_ENTITLED") {
          return reply.status(404).send({ error: "Module not entitled for this institution" });
        }
        return reply.status(409).send({
          error: "Module dependencies not satisfied",
          moduleKey: key,
          missingDependencies: result.missingDependencies,
        });
      }
      return reply.send({ institutionId, moduleKey: key, state: "ACTIVE" });
    },
  );

  // Suspend a module: ACTIVE -> SUSPENDED (history preserved; dependents warned).
  app.post(
    "/modules/:moduleKey/suspend",
    { preHandler: [requirePermission("admin.modules.manage")] },
    async (request, reply) => {
      const { userId, institutionId } = request.user;
      const { moduleKey } = request.params as { moduleKey: string };
      if (!MODULE_KEY_SET.has(moduleKey)) {
        return reply.status(400).send({ error: "Unknown moduleKey" });
      }
      const key = moduleKey as ModuleKey;

      const result = await withTenant(institutionId, async (tx) => {
        const r = await suspend(tx, institutionId, key, userId);
        if (r.ok) {
          await recordAuditEvent(
            {
              action: "admin.module.suspended",
              result: "SUCCESS",
              actorUserId: userId,
              actorRoleKey: request.auth?.roles[0] ?? request.user.role,
              institutionId,
              actorMembershipId: request.auth?.membershipId,
              resourceType: "InstitutionModule",
              resourceId: key,
              requestRef: request.id,
              metadata: {
                moduleKey: key,
                affectedDependents: r.affectedDependents.join(","),
                affectedDependentsCount: r.affectedDependents.length,
              },
            },
            tx,
          );
        }
        return r;
      });

      if (!result.ok) {
        return reply.status(409).send({ error: "Module is not ACTIVE", moduleKey: key });
      }
      return reply.send({
        institutionId,
        moduleKey: key,
        state: "SUSPENDED",
        warnings: { affectedDependents: result.affectedDependents },
      });
    },
  );
}
