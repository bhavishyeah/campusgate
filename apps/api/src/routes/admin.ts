import type { FastifyInstance } from "fastify";
import bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import ExcelJS from "exceljs";
import { prisma } from "@campusgate/db";
import {
  createUserSchema,
  bulkImportStudentSchema,
  createGuardShiftSchema,
  declareEmergencySchema,
  resolveEmergencySchema,
  updateInstitutionConfigSchema,
  upsertAcademicCalendarDaySchema,
} from "@campusgate/shared";
import { requireTenantRole } from "../middleware/auth.js";
import { AllowanceEngine } from "../services/allowance-engine.js";

export async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireTenantRole("ADMIN"));

  // ─── DASHBOARD STATS ───────────────────────────────────────────────────────
  app.get("/stats", async (request, reply) => {
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
    ] = await Promise.all([
      prisma.user.count({ where: { institutionId, role: "STUDENT", accountStatus: "ACTIVE" } }),
      prisma.user.count({ where: { institutionId, role: "HOD", accountStatus: "ACTIVE" } }),
      prisma.user.count({ where: { institutionId, role: "GUARD", accountStatus: "ACTIVE" } }),
      prisma.gate.count({ where: { institutionId, isActive: true } }),
      prisma.gateEvent.count({
        where: {
          eventType: "EXIT",
          timestamp: { gte: today },
          pass: { student: { user: { institutionId } } },
        },
      }),
      prisma.gateEvent.count({
        where: {
          eventType: "RETURN",
          timestamp: { gte: today },
          pass: { student: { user: { institutionId } } },
        },
      }),
      prisma.gatePass.count({
        where: { status: "OUTSIDE", student: { user: { institutionId } } },
      }),
      prisma.gatePass.count({
        where: { status: "PENDING", student: { user: { institutionId } } },
      }),
      prisma.user.count({ where: { institutionId, accountStatus: "PENDING_APPROVAL" } }),
    ]);

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
  app.get("/analytics", async (request, reply) => {
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
    ] = await Promise.all([
      prisma.gatePass.count({ where: basePassWhere }),
      prisma.gatePass.count({
        where: {
          ...basePassWhere,
          status: { in: ["APPROVED", "ACTIVE", "OUTSIDE", "COMPLETED", "REVOKED", "EXPIRED"] },
        },
      }),
      prisma.gatePass.count({ where: { ...basePassWhere, status: "REJECTED" } }),
      prisma.gatePass.count({ where: { ...basePassWhere, status: "REVOKED" } }),
      prisma.gatePass.count({
        where: {
          ...basePassWhere,
          status: "REVOKED",
          actualExit: { not: null },
          actualReturn: null,
        },
      }),
      prisma.gatePass.count({ where: { ...basePassWhere, status: "COMPLETED" } }),
      prisma.gatePass.count({ where: { status: "OUTSIDE", student: { user: { institutionId } } } }),
      prisma.gatePass.count({
        where: {
          status: "OUTSIDE",
          expectedReturn: { lt: now },
          student: { user: { institutionId } },
        },
      }),
      prisma.gatePass.findMany({
        where: basePassWhere,
        select: {
          id: true,
          createdAt: true,
          status: true,
          reason: { select: { label: true } },
          student: { select: { department: { select: { name: true } } } },
        },
      }),
      prisma.gatePass.findMany({
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
      prisma.gateEvent.findMany({
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
      prisma.emergencyAlert.findMany({
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
      prisma.emergencyAlert.findFirst({
        where: { institutionId, status: "ACTIVE" },
        select: { id: true, declaredAt: true, type: true, title: true },
      }),
    ]);

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
  app.get("/emergency/active", async (request, reply) => {
    const { institutionId } = request.user;

    const active = await prisma.emergencyAlert.findFirst({
      where: { institutionId, status: "ACTIVE" },
      orderBy: { declaredAt: "desc" },
      include: {
        declaredBy: { select: { id: true, email: true } },
      },
    });

    return reply.send(active);
  });

  app.get("/emergency", async (request, reply) => {
    const { institutionId } = request.user;
    const { limit = "20" } = request.query as { limit?: string };
    const take = Math.min(100, Math.max(1, parseInt(limit || "20", 10) || 20));

    const alerts = await prisma.emergencyAlert.findMany({
      where: { institutionId },
      orderBy: { declaredAt: "desc" },
      take,
      include: {
        declaredBy: { select: { id: true, email: true } },
        resolvedBy: { select: { id: true, email: true } },
      },
    });

    return reply.send(alerts);
  });

  app.post("/emergency/declare", async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = declareEmergencySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const existingActive = await prisma.emergencyAlert.findFirst({
      where: { institutionId, status: "ACTIVE" },
      orderBy: { declaredAt: "desc" },
    });

    if (existingActive) {
      return reply.status(409).send({ error: "An emergency is already active. Resolve it first." });
    }

    const alert = await prisma.emergencyAlert.create({
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

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "EMERGENCY_DECLARED",
        targetId: alert.id,
        targetType: "EmergencyAlert",
        metadata: {
          type: alert.type,
          title: alert.title,
          affectedArea: alert.affectedArea,
        },
      },
    });

    return reply.status(201).send(alert);
  });

  app.post("/emergency/:id/resolve", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { id } = request.params as { id: string };

    const parsed = resolveEmergencySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const existing = await prisma.emergencyAlert.findFirst({
      where: { id, institutionId },
    });

    if (!existing) {
      return reply.status(404).send({ error: "Emergency alert not found" });
    }

    if (existing.status !== "ACTIVE") {
      return reply.status(409).send({ error: "Emergency alert is already resolved" });
    }

    const resolved = await prisma.emergencyAlert.update({
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

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "EMERGENCY_RESOLVED",
        targetId: resolved.id,
        targetType: "EmergencyAlert",
        metadata: {
          resolutionNote: parsed.data.resolutionNote,
        },
      },
    });

    return reply.send(resolved);
  });

  // ─── LIST USERS ────────────────────────────────────────────────────────────
  app.get("/users", async (request, reply) => {
    const { institutionId } = request.user;
    const { role, status, page = "1", limit = "20" } = request.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    const where: any = { institutionId };
    if (role) where.role = role;
    if (status) where.accountStatus = status;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
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
      prisma.user.count({ where }),
    ]);

    return reply.send({
      users,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  });

  // ─── CREATE USER ───────────────────────────────────────────────────────────
  app.post("/users", async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const { email, name, role, departmentId, enrollmentNo, program, semester, section, gateIds } =
      parsed.data;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return reply.status(409).send({ error: "Email already in use" });
    }

    // Generate a temporary password
    const tempPassword = randomBytes(9).toString("base64url");
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const user = await prisma.$transaction(async (tx) => {
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
          data: { userId: newUser.id, name, departmentId },
        });
      } else if (role === "GUARD") {
        const guard = await tx.guardProfile.create({
          data: { userId: newUser.id, name },
        });
        if (gateIds && gateIds.length > 0) {
          await tx.guardGateAssignment.createMany({
            data: gateIds.map((gateId) => ({ guardId: guard.id, gateId })),
          });
        }
      }

      return newUser;
    });

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "USER_CREATED",
        targetId: user.id,
        targetType: "User",
        metadata: { role, email },
      },
    });

    return reply.status(201).send({
      user: { id: user.id, email: user.email, role: user.role },
      tempPassword, // In production, send this via email
    });
  });

  // ─── APPROVE PENDING REGISTRATION ─────────────────────────────────────────
  app.post("/users/:id/approve", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { id } = request.params as { id: string };

    const user = await prisma.user.findFirst({
      where: { id, institutionId, accountStatus: "PENDING_APPROVAL" },
    });
    if (!user) {
      return reply.status(404).send({ error: "No pending user found" });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { accountStatus: "ACTIVE" },
    });

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "USER_REACTIVATED",
        targetId: id,
        targetType: "User",
        metadata: { reason: "registration_approved" },
      },
    });

    return reply.send({ message: "User approved" });
  });

  // ─── DEACTIVATE USER ───────────────────────────────────────────────────────
  app.post("/users/:id/deactivate", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { id } = request.params as { id: string };

    const target = await prisma.user.findFirst({ where: { id, institutionId } });
    if (!target) {
      return reply.status(404).send({ error: "User not found" });
    }

    await prisma.user.update({
      where: { id: target.id },
      data: { accountStatus: "INACTIVE" },
    });

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "USER_DEACTIVATED",
        targetId: id,
        targetType: "User",
      },
    });

    return reply.send({ message: "User deactivated" });
  });

  // ─── REACTIVATE USER ──────────────────────────────────────────────────────
  app.post("/users/:id/reactivate", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { id } = request.params as { id: string };

    const target = await prisma.user.findFirst({ where: { id, institutionId } });
    if (!target) {
      return reply.status(404).send({ error: "User not found" });
    }

    await prisma.user.update({
      where: { id: target.id },
      data: { accountStatus: "ACTIVE" },
    });

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "USER_REACTIVATED",
        targetId: id,
        targetType: "User",
      },
    });

    return reply.send({ message: "User reactivated" });
  });

  // ─── BULK IMPORT STUDENTS (CSV) ───────────────────────────────────────────
  app.post("/students/bulk-import", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { students } = request.body as { students: any[] };

    if (!Array.isArray(students) || students.length === 0) {
      return reply.status(400).send({ error: "No students provided" });
    }

    if (students.length > 500) {
      return reply.status(400).send({ error: "Maximum 500 students per import" });
    }

    const results = { created: 0, skipped: 0, errors: [] as string[] };

    for (const row of students) {
      const parsed = bulkImportStudentSchema.safeParse(row);
      if (!parsed.success) {
        results.errors.push(`Row ${results.created + results.skipped + 1}: Invalid data`);
        results.skipped++;
        continue;
      }

      const data = parsed.data;

      // Find course by code
      const dept = await prisma.department.findFirst({
        where: { code: data.courseCode, institutionId },
      });
      if (!dept) {
        results.errors.push(`${data.enrollmentNo}: Course '${data.courseCode}' not found`);
        results.skipped++;
        continue;
      }

      // Check existing
      const existing = await prisma.user.findUnique({ where: { email: data.email } });
      if (existing) {
        results.errors.push(`${data.enrollmentNo}: Email already exists`);
        results.skipped++;
        continue;
      }

      try {
        await prisma.user.create({
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

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "BULK_IMPORT",
        targetType: "User",
        metadata: { created: results.created, skipped: results.skipped },
      },
    });

    return reply.send(results);
  });

  // ─── EXPORT STUDENTS (CSV) ────────────────────────────────────────────────
  app.get("/students/export", async (request, reply) => {
    const { institutionId } = request.user;

    const students = await prisma.user.findMany({
      where: { institutionId, role: "STUDENT" },
      include: {
        studentProfile: { include: { department: true } },
      },
      orderBy: [{ createdAt: "asc" }],
    });

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
  app.get("/students/export.xlsx", async (request, reply) => {
    const { institutionId } = request.user;

    const students = await prisma.user.findMany({
      where: { institutionId, role: "STUDENT" },
      include: {
        studentProfile: { include: { department: true } },
      },
      orderBy: [{ createdAt: "asc" }],
    });

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
  app.get("/departments", async (request, reply) => {
    const { institutionId } = request.user;
    const depts = await prisma.department.findMany({ where: { institutionId } });
    return reply.send(depts);
  });

  app.post("/departments", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { name, code } = request.body as { name: string; code: string };

    if (!name || !code) {
      return reply.status(400).send({ error: "Name and code are required" });
    }

    const dept = await prisma.department.create({
      data: { name, code, institutionId },
    });

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "DEPARTMENT_CREATED",
        targetId: dept.id,
        targetType: "Department",
      },
    });

    return reply.status(201).send(dept);
  });

  // ─── GATES ─────────────────────────────────────────────────────────────────
  app.get("/gates", async (request, reply) => {
    const { institutionId } = request.user;
    const gates = await prisma.gate.findMany({
      where: { institutionId },
      include: { assignedGuards: { include: { guard: true } } },
    });
    return reply.send(gates);
  });

  // ─── GATE HEALTH MONITORING ───────────────────────────────────────────────
  app.get("/gates/health", async (request, reply) => {
    const { institutionId } = request.user;

    const now = Date.now();
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0));

    const gates = await prisma.gate.findMany({
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

    const rows = await Promise.all(
      gates.map(async (gate) => {
        const [todayExits, todayReturns] = await Promise.all([
          prisma.gateEvent.count({
            where: { gateId: gate.id, eventType: "EXIT", timestamp: { gte: todayStart } },
          }),
          prisma.gateEvent.count({
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

    return reply.send(rows);
  });

  app.get("/gates/:gateId/health", async (request, reply) => {
    const { institutionId } = request.user;
    const { gateId } = request.params as { gateId: string };

    const now = Date.now();
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0));

    const gate = await prisma.gate.findFirst({
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

    if (!gate) {
      return reply.status(404).send({ error: "Gate not found" });
    }

    const [todayExits, todayReturns] = await Promise.all([
      prisma.gateEvent.count({
        where: { gateId: gate.id, eventType: "EXIT", timestamp: { gte: todayStart } },
      }),
      prisma.gateEvent.count({
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

  app.post("/gates", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { name, location } = request.body as { name: string; location?: string };

    if (!name) {
      return reply.status(400).send({ error: "Gate name is required" });
    }

    const gate = await prisma.gate.create({
      data: { name, location, institutionId },
    });

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "GATE_CREATED",
        targetId: gate.id,
        targetType: "Gate",
      },
    });

    return reply.status(201).send(gate);
  });

  // ─── GUARD SHIFTS ──────────────────────────────────────────────────────────
  app.get("/guard-shifts", async (request, reply) => {
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

    const shifts = await prisma.guardShift.findMany({
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
    });

    return reply.send(shifts);
  });

  app.post("/guard-shifts", async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = createGuardShiftSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const { guardId, gateId, scheduledStartAt, scheduledEndAt, note } = parsed.data;
    const shiftStart = new Date(scheduledStartAt);
    const shiftEnd = new Date(scheduledEndAt);

    const [guard, gate] = await Promise.all([
      prisma.guardProfile.findFirst({ where: { id: guardId, user: { institutionId } } }),
      prisma.gate.findFirst({ where: { id: gateId, institutionId } }),
    ]);

    if (!guard) {
      return reply.status(404).send({ error: "Guard not found in your institution" });
    }

    if (!gate) {
      return reply.status(404).send({ error: "Gate not found in your institution" });
    }

    const assignment = await prisma.guardGateAssignment.findUnique({
      where: { guardId_gateId: { guardId: guard.id, gateId: gate.id } },
    });

    if (!assignment) {
      return reply.status(400).send({ error: "Guard is not assigned to this gate" });
    }

    const overlap = await prisma.guardShift.findFirst({
      where: {
        institutionId,
        guardId: guard.id,
        status: { in: ["SCHEDULED", "ACTIVE"] },
        scheduledStartAt: { lt: shiftEnd },
        scheduledEndAt: { gt: shiftStart },
      },
    });

    if (overlap) {
      return reply.status(409).send({ error: "Guard already has an overlapping shift" });
    }

    const shift = await prisma.guardShift.create({
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

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "SHIFT_CREATED",
        targetId: shift.id,
        targetType: "GuardShift",
        metadata: { guardId, gateId, scheduledStartAt, scheduledEndAt },
      },
    });

    return reply.status(201).send(shift);
  });

  // ─── EXIT REASONS ──────────────────────────────────────────────────────────
  app.get("/reasons", async (request, reply) => {
    const { institutionId } = request.user;
    const reasons = await prisma.exitReason.findMany({ where: { institutionId } });
    return reply.send(reasons);
  });

  app.post("/reasons", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { label, requiresNote } = request.body as { label: string; requiresNote?: boolean };

    if (!label) {
      return reply.status(400).send({ error: "Label is required" });
    }

    const reason = await prisma.exitReason.create({
      data: { label, requiresNote: requiresNote || false, institutionId },
    });

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "REASON_CREATED",
        targetId: reason.id,
        targetType: "ExitReason",
      },
    });

    return reply.status(201).send(reason);
  });

  // ─── ALLOWANCE POLICY ────────────────────────────────────────────────────────
  app.get("/allowance-policy", async (request, reply) => {
    const { institutionId } = request.user;
    const policy = await AllowanceEngine.getOrCreatePolicy(institutionId);

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

  app.put("/allowance-policy", async (request, reply) => {
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
    const policy = await prisma.allowancePolicy.upsert({
      where: { institutionId },
      update: validatedFields,
      create: { institutionId, ...validatedFields },
    });

    // Audit
    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "ALLOWANCE_POLICY_UPDATED",
        targetId: policy.id,
        targetType: "AllowancePolicy",
        metadata: body,
      },
    });

    return reply.send(policy);
  });

  // ─── INSTITUTION CONFIG ───────────────────────────────────────────────────
  app.get("/institution-config", async (request, reply) => {
    const { institutionId } = request.user;

    const config = await AllowanceEngine.getOrCreateInstitutionConfig(institutionId);
    return reply.send(config);
  });

  app.put("/institution-config", async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = updateInstitutionConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const payload = parsed.data;

    const normalizedWorkingDays = payload.workingDaysOfWeek
      ? Array.from(new Set(payload.workingDaysOfWeek)).sort((a, b) => a - b)
      : undefined;

    const config = await prisma.institutionConfig.upsert({
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

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "INSTITUTION_CONFIG_UPDATED",
        targetId: config.id,
        targetType: "InstitutionConfig",
        metadata: payload,
      },
    });

    return reply.send(config);
  });

  // ─── ACADEMIC CALENDAR ────────────────────────────────────────────────────
  app.get("/academic-calendar", async (request, reply) => {
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

    const days = await prisma.academicCalendarDay.findMany({
      where: {
        institutionId,
        date: { gte: start, lte: end },
      },
      orderBy: { date: "asc" },
    });

    return reply.send(days);
  });

  app.put("/academic-calendar/day", async (request, reply) => {
    const { userId, institutionId } = request.user;

    const parsed = upsertAcademicCalendarDaySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const { date, dayType, note } = parsed.data;
    const parts = date.split("-").map((v) => Number(v));
    if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) {
      return reply.status(400).send({ error: "Invalid date" });
    }

    const normalizedDate = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);

    const day = await prisma.academicCalendarDay.upsert({
      where: {
        institutionId_date: {
          institutionId,
          date: normalizedDate,
        },
      },
      update: { dayType, note },
      create: {
        institutionId,
        date: normalizedDate,
        dayType,
        note,
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "ACADEMIC_CALENDAR_UPDATED",
        targetId: day.id,
        targetType: "AcademicCalendarDay",
        metadata: { date: day.date, dayType: day.dayType },
      },
    });

    return reply.send(day);
  });

  app.delete("/academic-calendar/day/:date", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { date } = request.params as { date: string };

    const parts = date.split("-").map((v) => Number(v));
    if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) {
      return reply.status(400).send({ error: "Invalid date" });
    }

    const normalizedDate = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);

    const existing = await prisma.academicCalendarDay.findUnique({
      where: {
        institutionId_date: {
          institutionId,
          date: normalizedDate,
        },
      },
    });

    if (!existing) {
      return reply.status(404).send({ error: "Calendar day not found" });
    }

    await prisma.academicCalendarDay.delete({
      where: {
        institutionId_date: {
          institutionId,
          date: normalizedDate,
        },
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "ACADEMIC_CALENDAR_UPDATED",
        targetId: existing.id,
        targetType: "AcademicCalendarDay",
        metadata: { deleted: true, date: normalizedDate },
      },
    });

    return reply.send({ success: true });
  });

  // ─── ADMIN PASS REVOCATION ────────────────────────────────────────────────
  app.post("/passes/:passId/revoke", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { passId } = request.params as { passId: string };
    const { reason } = request.body as { reason?: string };

    if (!reason || reason.trim().length < 3) {
      return reply.status(400).send({ error: "Revocation reason is required" });
    }

    const pass = await prisma.gatePass.findFirst({
      where: {
        id: passId,
        student: { user: { institutionId } },
        status: { in: ["APPROVED", "ACTIVE", "OUTSIDE"] },
      },
    });

    if (!pass) {
      return reply.status(404).send({ error: "Eligible pass not found for revocation" });
    }

    const previousStatus = pass.status;

    const transitioned = await prisma.gatePass.updateMany({
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

    if (transitioned.count === 0) {
      return reply.status(409).send({ error: "Pass state changed, please refresh and try again" });
    }

    const updated = {
      ...pass,
      status: "REVOKED",
      qrToken: null,
      qrExpiresAt: null,
    };

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "PASS_REVOKED",
        targetId: pass.id,
        targetType: "GatePass",
        metadata: {
          reason: reason.trim(),
          previousStatus,
          newStatus: "REVOKED",
        },
      },
    });

    return reply.send(updated);
  });

  // ─── ADMIN EMERGENCY OVERRIDE ─────────────────────────────────────────────
  app.post("/emergency-override", async (request, reply) => {
    const { userId, institutionId } = request.user;
    const { passId, justification } = request.body as { passId: string; justification: string };

    if (!justification || justification.length < 10) {
      return reply.status(400).send({ error: "Justification must be at least 10 characters" });
    }

    const pass = await prisma.gatePass.findFirst({
      where: {
        id: passId,
        student: { user: { institutionId } },
      },
    });
    if (!pass) {
      return reply.status(404).send({ error: "Pass not found" });
    }

    const override = await prisma.emergencyOverride.create({
      data: { gatePassId: passId, overriddenById: userId, justification },
    });

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

  // ─── AUDIT LOGS ────────────────────────────────────────────────────────────
  app.get("/audit-logs", async (request, reply) => {
    const { institutionId } = request.user;
    const { page = "1", limit = "50", action } = request.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    const where: any = {
      actor: { institutionId },
    };
    if (action) where.action = action;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { actor: { select: { id: true, email: true, role: true } } },
        orderBy: { timestamp: "desc" },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      prisma.auditLog.count({ where }),
    ]);

    return reply.send({
      logs,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  });
}
