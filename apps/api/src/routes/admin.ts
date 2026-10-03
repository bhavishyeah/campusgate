import type { FastifyInstance } from "fastify";
import bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import ExcelJS from "exceljs";
import { prisma } from "@campusgate/db";
import {
  createUserSchema,
  bulkImportStudentSchema,
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
