import type { FastifyInstance, FastifyRequest } from "fastify";
import ExcelJS from "exceljs";
import { withTenant, Prisma } from "@campusgate/db";
import {
  createEmployeeSchema,
  patchEmployeeSchema,
  createContractSchema,
  supersedeContractSchema,
  putLeavePolicySchema,
  createLeaveApplicationSchema,
  reviewLeaveApplicationSchema,
  putShiftSchema,
  patchShiftSchema,
  recordAttendanceSchema,
  correctAttendanceSchema,
  leaveBalanceQuerySchema,
  hrReportRangeQuerySchema,
  hrDatePathSchema,
  hrLeaveTypeEnum,
  hrEmployeeListQuerySchema,
  hrLeaveListQuerySchema,
  hrAttendanceRosterQuerySchema,
  hrUserLookupQuerySchema,
  type HrLeaveTypeValue,
} from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission, requireModuleActive } from "../services/authz-engine.js";
import { recordAuditEvent } from "../services/audit.js";
import { computeBalance, type LeaveBalancePolicy } from "../services/hr/leave-balance.js";

// The module registry key is `hr_management`; the permission/audit KEY prefix is
// `hr.*` (the exams examinations->exams.* / faculty faculty_management->faculty.*
// precedent). HR Management adds the EMPLOYMENT domain — employee records that
// REFERENCE the authoritative tenant-owned User via a composite FK (never
// duplicating identity), contracts, a deterministic leave subsystem, employee
// attendance + shifts, and JSON/XLSX reports. Routes are registered at `/api/hr`.
const MODULE_KEY = "hr_management" as const;

// The additive self-service template role bound to a user when their
// hr_employees row is created (design §3.3 / H1). Global template (institutionId
// NULL), seeded by the migration; holds ONLY hr.view_own.
const EMPLOYEE_ROLE_KEY = "EMPLOYEE" as const;

/**
 * HR Management operational routes (design §9 matrix), registered at `/api/hr`
 * (see server.ts). `hr_management` is a GATED module — every route carries
 * `requireModuleActive("hr_management")` IN ADDITION to `requirePermission(...)`.
 *
 * House pattern (mirrors faculty.ts / library.ts / exams.ts):
 *  - a single top-level `authenticate` preHandler;
 *  - per-route `[requirePermission(key), requireModuleActive(gate)]`;
 *  - every handler runs inside `withTenant(institutionId, tx => ...)` with
 *    `institutionId` from the verified token (`request.user`), never from input;
 *  - every mutation writes an `hr.*` AuditEvent via `recordAuditEvent` in the
 *    SAME transaction; deny branches record a DENIED audit then RETURN the 4xx
 *    from a normally-returning `withTenant` callback (never `throw`);
 *  - the leave-approve path serializes on a bound-parameter advisory lock and
 *    recomputes the balance IN-TX before the status flip (design §4.5);
 *  - Zod validates every external input; JSON is deterministic and well-typed.
 */
export async function hrRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);
  const gate = MODULE_KEY;

  // ─── Shared helpers ─────────────────────────────────────────────────────────

  function actor(request: FastifyRequest) {
    return {
      actorUserId: request.user.userId,
      actorRoleKey: request.auth?.roles[0] ?? request.user.role,
      actorMembershipId: request.auth?.membershipId ?? null,
      requestRef: request.id,
    };
  }

  // Deny result shape returned from a withTenant callback so a deny branch can
  // RETURN a 4xx (never throw) after recording a DENIED audit in the same tx.
  interface Deny {
    deny: string;
    status: number;
    extra?: Record<string, unknown>;
  }
  function deny(message: string, status: number, extra?: Record<string, unknown>): Deny {
    return { deny: message, status, extra };
  }
  function isDeny(x: unknown): x is Deny {
    return typeof x === "object" && x !== null && "deny" in x;
  }

  function isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
  }
  function isRestrictViolation(err: unknown): boolean {
    // Postgres restrict_violation (23001) raised by the column-guard /
    // append-only triggers surfaces through Prisma carrying the trigger text.
    // No legal route issues an illegal transition, so hitting it is a code
    // defect surfaced as 500 (the faculty_management backstop precedent).
    const msg = String((err as Error)?.message ?? err);
    return (
      msg.includes("restrict_violation") || msg.includes("illegal") || msg.includes("append-only")
    );
  }

  // Advisory xact lock on a tenant-qualified key (the library/exams/fees idiom).
  // The key is built in TypeScript and passed as a SINGLE BOUND parameter — no
  // in-SQL concatenation of tenant/id values. Held until the tx commits/rolls back.
  async function advisoryLock(tx: Prisma.TransactionClient, key: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }

  // ─── Date helpers (UTC, integer-day discipline) ──────────────────────────────

  // Inclusive day count between two calendar dates (both endpoints counted), so
  // a single-day leave is 1 day. Derived server-side; the client `days` (if any)
  // is ignored (design §7). startDate/endDate are same-year (validated upstream).
  function inclusiveDays(startDate: Date, endDate: Date): number {
    const start = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate());
    const end = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
    return Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1;
  }

  // Dec 31 (UTC) of a period year.
  function endOfYear(year: number): Date {
    return new Date(Date.UTC(year, 11, 31));
  }

  // The ONE reference-date rule shared by the balance READ and the APPROVE
  // decision: min(operationDate, Dec 31 of periodYear) (design §4.5 M1).
  function referenceDate(operationDate: Date, periodYear: number): Date {
    const eoy = endOfYear(periodYear);
    return operationDate.getTime() < eoy.getTime() ? operationDate : eoy;
  }

  // ─── Serializers ─────────────────────────────────────────────────────────────

  function serializeEmployee(e: {
    id: string;
    institutionId: string;
    userId: string;
    employeeNo: string;
    designation: string | null;
    employmentType: string;
    departmentId: string | null;
    joiningDate: Date;
    status: string;
    createdByUserId: string;
    updatedByUserId: string;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: e.id,
      userId: e.userId,
      employeeNo: e.employeeNo,
      designation: e.designation,
      employmentType: e.employmentType,
      departmentId: e.departmentId,
      joiningDate: e.joiningDate.toISOString(),
      status: e.status,
      createdByUserId: e.createdByUserId,
      updatedByUserId: e.updatedByUserId,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    };
  }

  // Display projections (G-H1): the base HrEmployee row carries only a userId,
  // so a directory/queue table could render nothing but an opaque id. `User` has
  // no name column (email only); a display name is available only when the user
  // also has a Faculty/Student profile, so `name` is nullable. Read-only,
  // tenant-scoped through the surrounding withTenant tx.
  const userDisplaySelect = {
    id: true,
    email: true,
    studentProfile: { select: { name: true } },
    facultyProfile: { select: { name: true } },
  } as const;
  const employeeDetailInclude = {
    user: { select: userDisplaySelect },
    department: { select: { id: true, name: true } },
  } as const;
  const employeeBriefSelect = {
    id: true,
    employeeNo: true,
    designation: true,
    status: true,
    user: { select: userDisplaySelect },
  } as const;
  type UserDisplay = {
    id: string;
    email: string;
    studentProfile: { name: string } | null;
    facultyProfile: { name: string } | null;
  };
  function userDisplay(u: UserDisplay) {
    return { id: u.id, email: u.email, name: u.studentProfile?.name ?? u.facultyProfile?.name ?? null };
  }
  function employeeBrief(e: {
    id: string;
    employeeNo: string;
    designation: string | null;
    status: string;
    user: UserDisplay;
  }) {
    const u = userDisplay(e.user);
    return {
      id: e.id,
      employeeNo: e.employeeNo,
      designation: e.designation,
      status: e.status,
      email: u.email,
      name: u.name,
    };
  }
  function serializeEmployeeDetail(
    e: Parameters<typeof serializeEmployee>[0] & {
      user: UserDisplay;
      department: { id: string; name: string } | null;
    },
  ) {
    return { ...serializeEmployee(e), user: userDisplay(e.user), department: e.department };
  }

  function serializeContract(c: {
    id: string;
    employeeId: string;
    contractType: string;
    startDate: Date;
    endDate: Date | null;
    termsMetadata: Prisma.JsonValue | null;
    salaryAmount: bigint | null;
    currency: string;
    status: string;
    supersedesContractId: string | null;
    createdByUserId: string;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: c.id,
      employeeId: c.employeeId,
      contractType: c.contractType,
      startDate: c.startDate.toISOString(),
      endDate: c.endDate ? c.endDate.toISOString() : null,
      termsMetadata: c.termsMetadata ?? null,
      // BigInt is not JSON-serializable — surface salary minor units as a string.
      salaryAmount: c.salaryAmount === null ? null : c.salaryAmount.toString(),
      currency: c.currency,
      status: c.status,
      supersedesContractId: c.supersedesContractId,
      createdByUserId: c.createdByUserId,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  function serializePolicy(p: {
    id: string;
    leaveType: string;
    annualQuotaDays: number;
    accrualRule: string;
    active: boolean;
    updatedByUserId: string;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: p.id,
      leaveType: p.leaveType,
      annualQuotaDays: p.annualQuotaDays,
      accrualRule: p.accrualRule,
      active: p.active,
      updatedByUserId: p.updatedByUserId,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  function serializeLeaveApp(a: {
    id: string;
    employeeId: string;
    leaveType: string;
    startDate: Date;
    endDate: Date;
    days: number;
    periodYear: number;
    reason: string;
    status: string;
    reviewedByUserId: string | null;
    reviewedAt: Date | null;
    reviewNote: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: a.id,
      employeeId: a.employeeId,
      leaveType: a.leaveType,
      startDate: a.startDate.toISOString(),
      endDate: a.endDate.toISOString(),
      days: a.days,
      periodYear: a.periodYear,
      reason: a.reason,
      status: a.status,
      reviewedByUserId: a.reviewedByUserId,
      reviewedAt: a.reviewedAt ? a.reviewedAt.toISOString() : null,
      reviewNote: a.reviewNote,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  }

  function serializeShift(s: {
    id: string;
    name: string;
    startMinute: number;
    endMinute: number;
    active: boolean;
    updatedByUserId: string;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: s.id,
      name: s.name,
      startMinute: s.startMinute,
      endMinute: s.endMinute,
      active: s.active,
      updatedByUserId: s.updatedByUserId,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  function serializeAttendance(a: {
    id: string;
    employeeId: string;
    attendanceDate: Date;
    status: string;
    source: string;
    shiftId: string | null;
    recordedByUserId: string;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: a.id,
      employeeId: a.employeeId,
      // attendanceDate is a @db.Date — surface the calendar date only.
      attendanceDate: a.attendanceDate.toISOString().slice(0, 10),
      status: a.status,
      source: a.source,
      shiftId: a.shiftId,
      recordedByUserId: a.recordedByUserId,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  }

  // ─── In-tx lookups ────────────────────────────────────────────────────────────

  // Resolve a tenant employee by id, or null (RLS makes a foreign-tenant id
  // invisible so this is also the cross-tenant backstop).
  async function findEmployee(tx: Prisma.TransactionClient, institutionId: string, id: string) {
    return tx.hrEmployee.findFirst({ where: { id, institutionId } });
  }

  // Sum of APPROVED leave days for an (employee, leaveType, periodYear), optionally
  // excluding one application id (the approve path excludes the row being decided).
  async function approvedDaysSum(
    tx: Prisma.TransactionClient,
    institutionId: string,
    employeeId: string,
    leaveType: HrLeaveTypeValue,
    periodYear: number,
    excludeAppId?: string,
  ): Promise<number> {
    const agg = await tx.hrLeaveApplication.aggregate({
      _sum: { days: true },
      where: {
        institutionId,
        employeeId,
        leaveType,
        periodYear,
        status: "APPROVED",
        ...(excludeAppId ? { id: { not: excludeAppId } } : {}),
      },
    });
    return agg._sum.days ?? 0;
  }

  // Compute the balance array (one entry per ACTIVE policy) for an employee at a
  // given operation date (design §4.5 balance-READ contract, routes #15 / #27b).
  async function computeBalanceArray(
    tx: Prisma.TransactionClient,
    institutionId: string,
    employeeId: string,
    year: number,
    operationDate: Date,
  ) {
    const policies = await tx.hrLeavePolicy.findMany({
      where: { institutionId, active: true },
      orderBy: [{ leaveType: "asc" }],
    });
    const ref = referenceDate(operationDate, year);
    const out: Array<{
      leaveType: string;
      periodYear: number;
      entitlement: number;
      taken: number;
      remaining: number;
    }> = [];
    for (const policy of policies) {
      const taken = await approvedDaysSum(
        tx,
        institutionId,
        employeeId,
        policy.leaveType as HrLeaveTypeValue,
        year,
      );
      const enginePolicy: LeaveBalancePolicy = {
        annualQuotaDays: policy.annualQuotaDays,
        accrualRule: policy.accrualRule as LeaveBalancePolicy["accrualRule"],
      };
      const balance = computeBalance(enginePolicy, year, ref, taken);
      out.push({
        leaveType: policy.leaveType,
        periodYear: year,
        entitlement: balance.entitlement,
        taken: balance.taken,
        remaining: balance.remaining,
      });
    }
    return out;
  }

  // Resolve the caller's own hr_employees row for a /me/* self-service route.
  // Never reads an employeeId from input — scopes by the token userId.
  async function resolveSelf(tx: Prisma.TransactionClient, institutionId: string, userId: string) {
    return tx.hrEmployee.findFirst({ where: { institutionId, userId } });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 1–4. EMPLOYEES
  // ════════════════════════════════════════════════════════════════════════════

  // ─── 1. POST /employees (hr.employees.manage) ────────────────────────────────
  // Creates the hr_employees row AND binds the target user to the EMPLOYEE
  // template role in the SAME tx (design §3.3 / H1), so the self-service /me/*
  // routes are reachable. The grant is idempotent (upsert) and retained on
  // status changes.
  app.post(
    "/employees",
    { preHandler: [requirePermission("hr.employees.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createEmployeeSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      try {
        const outcome = await withTenant(institutionId, async (tx) => {
          // Resolve the EMPLOYEE template role (global, institutionId NULL). A DB
          // that never seeded the catalogue → 500 role_missing, whole tx rolled
          // back (the admissions role_missing precedent) rather than creating an
          // employee who can never self-serve.
          const role = await tx.role.findFirst({
            where: { key: EMPLOYEE_ROLE_KEY, institutionId: null },
            select: { id: true },
          });
          if (!role) return deny("role_missing", 500);

          const employee = await tx.hrEmployee.create({
            data: {
              institutionId,
              userId: data.userId,
              employeeNo: data.employeeNo,
              designation: data.designation ?? null,
              employmentType: data.employmentType,
              departmentId: data.departmentId ?? null,
              joiningDate: new Date(data.joiningDate),
              status: data.status ?? "ACTIVE",
              createdByUserId: request.user.userId,
              updatedByUserId: request.user.userId,
            },
          });

          // Bind the EMPLOYEE role to the target user (the admissions
          // resolve-or-create idiom; idempotent upserts never race/duplicate).
          const membership = await tx.institutionMembership.upsert({
            where: { userId_institutionId: { userId: data.userId, institutionId } },
            update: {},
            create: {
              userId: data.userId,
              institutionId,
              membershipStatus: "ACTIVE",
              permissionsVersion: 0,
            },
            select: { id: true },
          });
          await tx.membershipRole.upsert({
            where: { membershipId_roleId: { membershipId: membership.id, roleId: role.id } },
            update: {},
            create: { membershipId: membership.id, roleId: role.id, institutionId },
          });

          await recordAuditEvent(
            {
              action: "hr.employee.created",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "HrEmployee",
              resourceId: employee.id,
              metadata: { userId: data.userId, employeeNo: employee.employeeNo },
            },
            tx,
          );
          return { employee };
        });

        if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
        return reply.status(201).send(serializeEmployee(outcome.employee));
      } catch (err) {
        if (isUniqueViolation(err)) {
          await recordAuditEvent({
            action: "hr.employee.created",
            result: "DENIED",
            ...actor(request),
            institutionId,
            resourceType: "HrEmployee",
            metadata: { reason: "employee already exists", userId: data.userId },
          });
          return reply.status(409).send({ error: "employee already exists" });
        }
        throw err;
      }
    },
  );

  // ─── 2. PATCH /employees/:id (hr.employees.manage) ───────────────────────────
  app.patch(
    "/employees/:id",
    { preHandler: [requirePermission("hr.employees.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = patchEmployeeSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      try {
        const outcome = await withTenant(institutionId, async (tx) => {
          const existing = await findEmployee(tx, institutionId, id);
          if (!existing) {
            await recordAuditEvent(
              {
                action: "hr.employee.updated",
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "HrEmployee",
                resourceId: id,
                metadata: { reason: "employee not found" },
              },
              tx,
            );
            return deny("employee not found", 404);
          }
          const updated = await tx.hrEmployee.update({
            where: { id },
            data: {
              ...(data.employeeNo !== undefined ? { employeeNo: data.employeeNo } : {}),
              ...(data.designation !== undefined ? { designation: data.designation } : {}),
              ...(data.employmentType !== undefined ? { employmentType: data.employmentType } : {}),
              ...(data.departmentId !== undefined ? { departmentId: data.departmentId } : {}),
              ...(data.joiningDate !== undefined ? { joiningDate: new Date(data.joiningDate) } : {}),
              ...(data.status !== undefined ? { status: data.status } : {}),
              updatedByUserId: request.user.userId,
            },
          });
          await recordAuditEvent(
            {
              action: "hr.employee.updated",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "HrEmployee",
              resourceId: id,
              metadata: {},
            },
            tx,
          );
          return { updated };
        });

        if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
        return reply.send(serializeEmployee(outcome.updated));
      } catch (err) {
        if (isUniqueViolation(err)) {
          await recordAuditEvent({
            action: "hr.employee.updated",
            result: "DENIED",
            ...actor(request),
            institutionId,
            resourceType: "HrEmployee",
            resourceId: id,
            metadata: { reason: "employeeNo already exists" },
          });
          return reply.status(409).send({ error: "employeeNo already exists" });
        }
        throw err;
      }
    },
  );

  // ─── 3. GET /employees (hr.directory.view) ───────────────────────────────────
  // G-H1: added q/status/departmentId/employmentType filters + pagination (the
  // list endpoint had none — a directory screen cannot page or search without
  // this). Response shape is additive: `employees` stays an array, `total` /
  // `page` / `pageSize` are new fields (the library/admissions list idiom).
  app.get(
    "/employees",
    { preHandler: [requirePermission("hr.directory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = hrEmployeeListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { q, status, departmentId, employmentType, page, pageSize } = parsed.data;

      const where: Prisma.HrEmployeeWhereInput = {
        institutionId,
        ...(status ? { status } : {}),
        ...(departmentId ? { departmentId } : {}),
        ...(employmentType ? { employmentType } : {}),
        ...(q
          ? {
              OR: [
                { employeeNo: { contains: q, mode: "insensitive" } },
                { designation: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      };

      const whereWithName: Prisma.HrEmployeeWhereInput = q
        ? {
            institutionId,
            ...(status ? { status } : {}),
            ...(departmentId ? { departmentId } : {}),
            ...(employmentType ? { employmentType } : {}),
            OR: [
              { employeeNo: { contains: q, mode: "insensitive" } },
              { designation: { contains: q, mode: "insensitive" } },
              { user: { email: { contains: q, mode: "insensitive" } } },
              { user: { studentProfile: { name: { contains: q, mode: "insensitive" } } } },
              { user: { facultyProfile: { name: { contains: q, mode: "insensitive" } } } },
            ],
          }
        : where;

      const [rows, total] = await withTenant(institutionId, (tx) =>
        Promise.all([
          tx.hrEmployee.findMany({
            where: whereWithName,
            orderBy: [{ createdAt: "desc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
            select: employeeBriefSelect,
          }),
          tx.hrEmployee.count({ where: whereWithName }),
        ]),
      );
      return reply.send({ employees: rows.map(employeeBrief), total, page, pageSize });
    },
  );

  // ─── G-H2. GET /users/lookup (hr.employees.manage) ───────────────────────────
  // HR_MANAGER needs to pick the User to bind when creating an employee, but
  // does NOT hold admin.users.view (that is an ADMIN-only key — granting it
  // would hand HR_MANAGER the entire user-admin surface). A narrowly scoped
  // lookup mirrors the library G3 `students/lookup` precedent: excludes users
  // who already have an hr_employees row (can't double-bind) and returns only
  // display fields, gated by the WRITE key for this screen (hr.employees.manage).
  app.get(
    "/users/lookup",
    { preHandler: [requirePermission("hr.employees.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = hrUserLookupQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { q, limit } = parsed.data;

      const users = await withTenant(institutionId, (tx) =>
        tx.user.findMany({
          where: {
            institutionId,
            hrEmployees: { none: {} },
            OR: [
              { email: { contains: q, mode: "insensitive" } },
              { studentProfile: { name: { contains: q, mode: "insensitive" } } },
              { facultyProfile: { name: { contains: q, mode: "insensitive" } } },
            ],
          },
          orderBy: [{ email: "asc" }],
          take: limit,
          select: {
            id: true,
            email: true,
            role: true,
            studentProfile: { select: { name: true } },
            facultyProfile: { select: { name: true } },
          },
        }),
      );
      return reply.send({
        users: users.map((u) => ({
          id: u.id,
          email: u.email,
          role: u.role,
          name: u.studentProfile?.name ?? u.facultyProfile?.name ?? null,
        })),
      });
    },
  );

  // ─── G-H3. GET /lookups (hr.employees.manage) ────────────────────────────────
  // The employee create/edit form needs a department picker. HR_MANAGER does
  // NOT hold admin.departments.manage (ADMIN-only); a narrowly gated read-only
  // lookup is added instead of broadening that key (the faculty G2 precedent).
  app.get(
    "/lookups",
    { preHandler: [requirePermission("hr.employees.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const departments = await withTenant(institutionId, (tx) =>
        tx.department.findMany({
          where: { institutionId },
          orderBy: [{ name: "asc" }],
          select: { id: true, name: true, code: true },
        }),
      );
      return reply.send({ departments });
    },
  );

  // ─── 4. GET /employees/:id (hr.directory.view) ───────────────────────────────
  // G-H1: now also returns `user` (email/name display) and `department` so the
  // detail screen never has to issue a second lookup for the referenced ids.
  app.get(
    "/employees/:id",
    { preHandler: [requirePermission("hr.directory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const outcome = await withTenant(institutionId, async (tx) => {
        const employee = await tx.hrEmployee.findFirst({
          where: { id, institutionId },
          include: employeeDetailInclude,
        });
        if (!employee) return deny("employee not found", 404);
        return { employee };
      });
      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send(serializeEmployeeDetail(outcome.employee));
    },
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 5–8. CONTRACTS
  // ════════════════════════════════════════════════════════════════════════════

  // ─── 5. POST /employees/:id/contracts (hr.contracts.manage) ──────────────────
  app.post(
    "/employees/:id/contracts",
    { preHandler: [requirePermission("hr.contracts.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = createContractSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const employee = await findEmployee(tx, institutionId, id);
        if (!employee) {
          await recordAuditEvent(
            {
              action: "hr.contract.created",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "HrContract",
              metadata: { reason: "employee not found", employeeId: id },
            },
            tx,
          );
          return deny("employee not found", 404);
        }
        const contract = await tx.hrContract.create({
          data: {
            institutionId,
            employeeId: id,
            contractType: data.contractType,
            startDate: new Date(data.startDate),
            endDate: data.endDate ? new Date(data.endDate) : null,
            termsMetadata:
              data.termsMetadata === undefined
                ? undefined
                : (data.termsMetadata as Prisma.InputJsonValue),
            salaryAmount: data.salaryAmount === undefined ? null : BigInt(data.salaryAmount),
            currency: data.currency,
            status: "ACTIVE",
            createdByUserId: request.user.userId,
          },
        });
        await recordAuditEvent(
          {
            action: "hr.contract.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HrContract",
            resourceId: contract.id,
            metadata: { employeeId: id, contractType: contract.contractType },
          },
          tx,
        );
        return { contract };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.status(201).send(serializeContract(outcome.contract));
    },
  );

  // ─── 6. POST /employees/:id/contracts/:contractId/supersede ──────────────────
  // Insert a new ACTIVE row + flip the old ACTIVE row to SUPERSEDED in one tx,
  // emitting BOTH hr.contract.superseded (old) and hr.contract.created (new).
  app.post(
    "/employees/:id/contracts/:contractId/supersede",
    { preHandler: [requirePermission("hr.contracts.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id, contractId } = request.params as { id: string; contractId: string };
      const parsed = supersedeContractSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      try {
        const outcome = await withTenant(institutionId, async (tx) => {
          const employee = await findEmployee(tx, institutionId, id);
          if (!employee) return deny("employee not found", 404);
          const old = await tx.hrContract.findFirst({
            where: { id: contractId, institutionId, employeeId: id },
          });
          if (!old) {
            await recordAuditEvent(
              {
                action: "hr.contract.superseded",
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "HrContract",
                resourceId: contractId,
                metadata: { reason: "contract not found", employeeId: id },
              },
              tx,
            );
            return deny("contract not found", 404);
          }
          // A terminal/already-superseded target → 409 BEFORE the guard (the
          // guard is the backstop, design §4.2 / §12).
          if (old.status !== "ACTIVE") {
            await recordAuditEvent(
              {
                action: "hr.contract.superseded",
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "HrContract",
                resourceId: contractId,
                metadata: { reason: "contract not active", status: old.status },
              },
              tx,
            );
            return deny("contract is not active", 409);
          }

          const created = await tx.hrContract.create({
            data: {
              institutionId,
              employeeId: id,
              contractType: data.contractType,
              startDate: new Date(data.startDate),
              endDate: data.endDate ? new Date(data.endDate) : null,
              termsMetadata:
                data.termsMetadata === undefined
                  ? undefined
                  : (data.termsMetadata as Prisma.InputJsonValue),
              salaryAmount: data.salaryAmount === undefined ? null : BigInt(data.salaryAmount),
              currency: data.currency,
              status: "ACTIVE",
              supersedesContractId: contractId,
              createdByUserId: request.user.userId,
            },
          });
          await tx.hrContract.update({
            where: { id: contractId },
            data: { status: "SUPERSEDED" },
          });

          await recordAuditEvent(
            {
              action: "hr.contract.superseded",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "HrContract",
              resourceId: contractId,
              metadata: { employeeId: id, newContractId: created.id },
            },
            tx,
          );
          await recordAuditEvent(
            {
              action: "hr.contract.created",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "HrContract",
              resourceId: created.id,
              metadata: { employeeId: id, supersedesContractId: contractId },
            },
            tx,
          );
          return { created };
        });

        if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
        return reply.status(201).send(serializeContract(outcome.created));
      } catch (err) {
        if (isRestrictViolation(err)) {
          request.log.error({ err }, "hr.contract.superseded: unexpected guard restrict_violation");
          return reply.status(500).send({ error: "contract lifecycle violation" });
        }
        throw err;
      }
    },
  );

  // ─── 7. POST /employees/:id/contracts/:contractId/end (hr.contracts.manage) ──
  app.post(
    "/employees/:id/contracts/:contractId/end",
    { preHandler: [requirePermission("hr.contracts.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id, contractId } = request.params as { id: string; contractId: string };

      try {
        const outcome = await withTenant(institutionId, async (tx) => {
          const employee = await findEmployee(tx, institutionId, id);
          if (!employee) return deny("employee not found", 404);
          const old = await tx.hrContract.findFirst({
            where: { id: contractId, institutionId, employeeId: id },
          });
          if (!old) {
            await recordAuditEvent(
              {
                action: "hr.contract.ended",
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "HrContract",
                resourceId: contractId,
                metadata: { reason: "contract not found", employeeId: id },
              },
              tx,
            );
            return deny("contract not found", 404);
          }
          if (old.status !== "ACTIVE") {
            await recordAuditEvent(
              {
                action: "hr.contract.ended",
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "HrContract",
                resourceId: contractId,
                metadata: { reason: "contract not active", status: old.status },
              },
              tx,
            );
            return deny("contract is not active", 409);
          }
          const ended = await tx.hrContract.update({
            where: { id: contractId },
            data: { status: "ENDED" },
          });
          await recordAuditEvent(
            {
              action: "hr.contract.ended",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "HrContract",
              resourceId: contractId,
              metadata: { employeeId: id },
            },
            tx,
          );
          return { ended };
        });

        if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
        return reply.send(serializeContract(outcome.ended));
      } catch (err) {
        if (isRestrictViolation(err)) {
          request.log.error({ err }, "hr.contract.ended: unexpected guard restrict_violation");
          return reply.status(500).send({ error: "contract lifecycle violation" });
        }
        throw err;
      }
    },
  );

  // ─── 8. GET /employees/:id/contracts (hr.directory.view) ─────────────────────
  app.get(
    "/employees/:id/contracts",
    { preHandler: [requirePermission("hr.directory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const outcome = await withTenant(institutionId, async (tx) => {
        const employee = await findEmployee(tx, institutionId, id);
        if (!employee) return deny("employee not found", 404);
        const rows = await tx.hrContract.findMany({
          where: { institutionId, employeeId: id },
          orderBy: [{ createdAt: "asc" }],
        });
        return { rows };
      });
      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send({ contracts: outcome.rows.map(serializeContract) });
    },
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 9–15. LEAVE
  // ════════════════════════════════════════════════════════════════════════════

  // ─── 9. PUT /leave-policies/:leaveType (hr.leave.manage) ─────────────────────
  app.put(
    "/leave-policies/:leaveType",
    { preHandler: [requirePermission("hr.leave.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { leaveType: rawLeaveType } = request.params as { leaveType: string };
      const leaveTypeParsed = hrLeaveTypeEnum.safeParse(rawLeaveType);
      if (!leaveTypeParsed.success) return reply.status(400).send({ error: "invalid leaveType" });
      const leaveType = leaveTypeParsed.data;
      const parsed = putLeavePolicySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const policy = await withTenant(institutionId, async (tx) => {
        const existing = await tx.hrLeavePolicy.findFirst({
          where: { institutionId, leaveType },
          select: { id: true },
        });
        const saved = existing
          ? await tx.hrLeavePolicy.update({
              where: { id: existing.id },
              data: {
                annualQuotaDays: data.annualQuotaDays,
                accrualRule: data.accrualRule,
                ...(data.active !== undefined ? { active: data.active } : {}),
                updatedByUserId: request.user.userId,
              },
            })
          : await tx.hrLeavePolicy.create({
              data: {
                institutionId,
                leaveType,
                annualQuotaDays: data.annualQuotaDays,
                accrualRule: data.accrualRule,
                active: data.active ?? true,
                updatedByUserId: request.user.userId,
              },
            });
        await recordAuditEvent(
          {
            action: "hr.leave_policy.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HrLeavePolicy",
            resourceId: saved.id,
            metadata: { leaveType, annualQuotaDays: saved.annualQuotaDays },
          },
          tx,
        );
        return saved;
      });

      return reply.send(serializePolicy(policy));
    },
  );

  // ─── G-H4. GET /leave (hr.leave.manage) ──────────────────────────────────────
  // The approve/reject screen (routes #12/#13) needs a cross-employee queue to
  // find pending application ids — there was no list endpoint, only the
  // per-employee `GET /employees/:id/leave` (route #14, hr.directory.view).
  // Gated by the WRITE key (hr.leave.manage) since this is the approval queue,
  // not a general directory read; each row carries `employee` display fields
  // so the table never needs a second round-trip per row.
  app.get(
    "/leave",
    { preHandler: [requirePermission("hr.leave.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = hrLeaveListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { status, leaveType, employeeId, page, pageSize } = parsed.data;

      const where: Prisma.HrLeaveApplicationWhereInput = {
        institutionId,
        ...(status ? { status } : {}),
        ...(leaveType ? { leaveType } : {}),
        ...(employeeId ? { employeeId } : {}),
      };

      const { rows, total } = await withTenant(institutionId, async (tx) => {
        const [rows, total] = await Promise.all([
          tx.hrLeaveApplication.findMany({
            where,
            orderBy: [{ createdAt: "desc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
            include: { employee: { select: employeeBriefSelect } },
          }),
          tx.hrLeaveApplication.count({ where }),
        ]);
        return { rows, total };
      });

      return reply.send({
        leaveApplications: rows.map((r) => ({
          ...serializeLeaveApp(r),
          employee: employeeBrief(r.employee),
        })),
        total,
        page,
        pageSize,
      });
    },
  );

  // ─── 10. GET /leave-policies (hr.directory.view) ─────────────────────────────
  app.get(
    "/leave-policies",
    { preHandler: [requirePermission("hr.directory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const rows = await withTenant(institutionId, (tx) =>
        tx.hrLeavePolicy.findMany({ where: { institutionId }, orderBy: [{ leaveType: "asc" }] }),
      );
      return reply.send({ leavePolicies: rows.map(serializePolicy) });
    },
  );

  // ─── 11. POST /employees/:id/leave — staff on behalf (hr.leave.manage) ───────
  app.post(
    "/employees/:id/leave",
    { preHandler: [requirePermission("hr.leave.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = createLeaveApplicationSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const employee = await findEmployee(tx, institutionId, id);
        if (!employee) {
          await recordAuditEvent(
            {
              action: "hr.leave.requested",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "HrLeaveApplication",
              metadata: { reason: "employee not found", employeeId: id },
            },
            tx,
          );
          return deny("employee not found", 404);
        }
        const start = new Date(data.startDate);
        const end = new Date(data.endDate);
        const application = await tx.hrLeaveApplication.create({
          data: {
            institutionId,
            employeeId: id,
            leaveType: data.leaveType,
            startDate: start,
            endDate: end,
            days: inclusiveDays(start, end),
            periodYear: start.getUTCFullYear(),
            reason: data.reason,
            status: "REQUESTED",
          },
        });
        await recordAuditEvent(
          {
            action: "hr.leave.requested",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HrLeaveApplication",
            resourceId: application.id,
            metadata: { employeeId: id, leaveType: application.leaveType, days: application.days },
          },
          tx,
        );
        return { application };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.status(201).send(serializeLeaveApp(outcome.application));
    },
  );

  // ─── 12. POST /leave/:appId/approve (hr.leave.manage) ────────────────────────
  // The §4.5 in-tx order EXACTLY: advisory lock → entitlement at
  // referenceDate = min(approvalDate, Dec 31 of periodYear) → takenExcludingThis
  // → over-balance check BEFORE the flip (no flip on over-balance) → flip + audit.
  app.post(
    "/leave/:appId/approve",
    { preHandler: [requirePermission("hr.leave.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { appId } = request.params as { appId: string };
      const parsed = reviewLeaveApplicationSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      try {
        const outcome = await withTenant(institutionId, async (tx) => {
          const pending = await tx.hrLeaveApplication.findFirst({
            where: { id: appId, institutionId },
          });
          if (!pending) {
            await recordAuditEvent(
              {
                action: "hr.leave.approved",
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "HrLeaveApplication",
                resourceId: appId,
                metadata: { reason: "leave application not found" },
              },
              tx,
            );
            return deny("leave application not found", 404);
          }
          if (pending.status !== "REQUESTED") {
            await recordAuditEvent(
              {
                action: "hr.leave.approved",
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "HrLeaveApplication",
                resourceId: appId,
                metadata: { reason: "not requested", status: pending.status },
              },
              tx,
            );
            return deny("leave application is not pending", 409);
          }

          // 1. Serialize all approvals for this (institution, employee, type, year).
          const lockKey = `hr_leave:${institutionId}:${pending.employeeId}:${pending.leaveType}:${pending.periodYear}`;
          await advisoryLock(tx, lockKey);

          // 2. Entitlement at the shared reference date.
          const policy = await tx.hrLeavePolicy.findFirst({
            where: { institutionId, leaveType: pending.leaveType },
            select: { annualQuotaDays: true, accrualRule: true },
          });
          const ref = referenceDate(new Date(), pending.periodYear);
          const enginePolicy: LeaveBalancePolicy = {
            annualQuotaDays: policy?.annualQuotaDays ?? 0,
            accrualRule: (policy?.accrualRule ?? "ANNUAL_LUMP_SUM") as LeaveBalancePolicy["accrualRule"],
          };
          const { entitlement } = computeBalance(enginePolicy, pending.periodYear, ref, 0);

          // 3. Taken sum EXCLUDING the application being decided.
          const takenExcludingThis = await approvedDaysSum(
            tx,
            institutionId,
            pending.employeeId,
            pending.leaveType as HrLeaveTypeValue,
            pending.periodYear,
            appId,
          );

          // 4. Over-balance → DENIED audit + 422, NO flip.
          if (takenExcludingThis + pending.days > entitlement) {
            await recordAuditEvent(
              {
                action: "hr.leave.approved",
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "HrLeaveApplication",
                resourceId: appId,
                metadata: {
                  reason: "insufficient leave balance",
                  entitlement,
                  takenExcludingThis,
                  requested: pending.days,
                },
              },
              tx,
            );
            return deny("insufficient leave balance", 422, {
              remaining: entitlement - takenExcludingThis,
              requested: pending.days,
            });
          }

          // 5. Flip REQUESTED → APPROVED + record the decision + SUCCESS audit.
          const approved = await tx.hrLeaveApplication.update({
            where: { id: appId },
            data: {
              status: "APPROVED",
              reviewedByUserId: request.user.userId,
              reviewedAt: new Date(),
              ...(data.reviewNote !== undefined ? { reviewNote: data.reviewNote } : {}),
            },
          });
          await recordAuditEvent(
            {
              action: "hr.leave.approved",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "HrLeaveApplication",
              resourceId: appId,
              metadata: { employeeId: pending.employeeId, days: pending.days },
            },
            tx,
          );
          return { approved };
        });

        if (isDeny(outcome)) {
          return reply
            .status(outcome.status)
            .send({ error: outcome.deny, ...(outcome.extra ?? {}) });
        }
        return reply.send(serializeLeaveApp(outcome.approved));
      } catch (err) {
        if (isRestrictViolation(err)) {
          request.log.error({ err }, "hr.leave.approved: unexpected guard restrict_violation");
          return reply.status(500).send({ error: "leave lifecycle violation" });
        }
        throw err;
      }
    },
  );

  // ─── 13. POST /leave/:appId/reject (hr.leave.manage) ─────────────────────────
  app.post(
    "/leave/:appId/reject",
    { preHandler: [requirePermission("hr.leave.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { appId } = request.params as { appId: string };
      const parsed = reviewLeaveApplicationSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      try {
        const outcome = await withTenant(institutionId, async (tx) => {
          const pending = await tx.hrLeaveApplication.findFirst({
            where: { id: appId, institutionId },
          });
          if (!pending) {
            await recordAuditEvent(
              {
                action: "hr.leave.rejected",
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "HrLeaveApplication",
                resourceId: appId,
                metadata: { reason: "leave application not found" },
              },
              tx,
            );
            return deny("leave application not found", 404);
          }
          if (pending.status !== "REQUESTED") {
            await recordAuditEvent(
              {
                action: "hr.leave.rejected",
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "HrLeaveApplication",
                resourceId: appId,
                metadata: { reason: "not requested", status: pending.status },
              },
              tx,
            );
            return deny("leave application is not pending", 409);
          }
          const rejected = await tx.hrLeaveApplication.update({
            where: { id: appId },
            data: {
              status: "REJECTED",
              reviewedByUserId: request.user.userId,
              reviewedAt: new Date(),
              ...(data.reviewNote !== undefined ? { reviewNote: data.reviewNote } : {}),
            },
          });
          await recordAuditEvent(
            {
              action: "hr.leave.rejected",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "HrLeaveApplication",
              resourceId: appId,
              metadata: { employeeId: pending.employeeId },
            },
            tx,
          );
          return { rejected };
        });

        if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
        return reply.send(serializeLeaveApp(outcome.rejected));
      } catch (err) {
        if (isRestrictViolation(err)) {
          request.log.error({ err }, "hr.leave.rejected: unexpected guard restrict_violation");
          return reply.status(500).send({ error: "leave lifecycle violation" });
        }
        throw err;
      }
    },
  );

  // ─── 14. GET /employees/:id/leave (hr.directory.view) ────────────────────────
  app.get(
    "/employees/:id/leave",
    { preHandler: [requirePermission("hr.directory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const outcome = await withTenant(institutionId, async (tx) => {
        const employee = await findEmployee(tx, institutionId, id);
        if (!employee) return deny("employee not found", 404);
        const rows = await tx.hrLeaveApplication.findMany({
          where: { institutionId, employeeId: id },
          orderBy: [{ createdAt: "desc" }],
        });
        return { rows };
      });
      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send({ leaveApplications: outcome.rows.map(serializeLeaveApp) });
    },
  );

  // ─── 15. GET /employees/:id/leave-balance?year= (hr.directory.view) ──────────
  app.get(
    "/employees/:id/leave-balance",
    { preHandler: [requirePermission("hr.directory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = leaveBalanceQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const year = parsed.data.year ?? new Date().getUTCFullYear();

      const outcome = await withTenant(institutionId, async (tx) => {
        const employee = await findEmployee(tx, institutionId, id);
        if (!employee) return deny("employee not found", 404);
        const balances = await computeBalanceArray(tx, institutionId, id, year, new Date());
        return { balances };
      });
      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send({ balances: outcome.balances });
    },
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 16–20. SHIFTS + ATTENDANCE
  // ════════════════════════════════════════════════════════════════════════════

  // ─── 16a. POST /shifts (hr.attendance.manage) ────────────────────────────────
  app.post(
    "/shifts",
    { preHandler: [requirePermission("hr.attendance.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = putShiftSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      try {
        const shift = await withTenant(institutionId, async (tx) => {
          const created = await tx.hrShift.create({
            data: {
              institutionId,
              name: data.name,
              startMinute: data.startMinute,
              endMinute: data.endMinute,
              active: data.active ?? true,
              updatedByUserId: request.user.userId,
            },
          });
          await recordAuditEvent(
            {
              action: "hr.shift.created",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "HrShift",
              resourceId: created.id,
              metadata: { name: created.name },
            },
            tx,
          );
          return created;
        });
        return reply.status(201).send(serializeShift(shift));
      } catch (err) {
        if (isUniqueViolation(err)) {
          await recordAuditEvent({
            action: "hr.shift.created",
            result: "DENIED",
            ...actor(request),
            institutionId,
            resourceType: "HrShift",
            metadata: { reason: "shift name already exists", name: data.name },
          });
          return reply.status(409).send({ error: "shift name already exists" });
        }
        throw err;
      }
    },
  );

  // ─── 16b. PATCH /shifts/:id (hr.attendance.manage) ───────────────────────────
  app.patch(
    "/shifts/:id",
    { preHandler: [requirePermission("hr.attendance.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = patchShiftSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      try {
        const outcome = await withTenant(institutionId, async (tx) => {
          const existing = await tx.hrShift.findFirst({ where: { id, institutionId } });
          if (!existing) {
            await recordAuditEvent(
              {
                action: "hr.shift.updated",
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "HrShift",
                resourceId: id,
                metadata: { reason: "shift not found" },
              },
              tx,
            );
            return deny("shift not found", 404);
          }
          const updated = await tx.hrShift.update({
            where: { id },
            data: {
              ...(data.name !== undefined ? { name: data.name } : {}),
              ...(data.startMinute !== undefined ? { startMinute: data.startMinute } : {}),
              ...(data.endMinute !== undefined ? { endMinute: data.endMinute } : {}),
              ...(data.active !== undefined ? { active: data.active } : {}),
              updatedByUserId: request.user.userId,
            },
          });
          await recordAuditEvent(
            {
              action: "hr.shift.updated",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "HrShift",
              resourceId: id,
              metadata: {},
            },
            tx,
          );
          return { updated };
        });

        if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
        return reply.send(serializeShift(outcome.updated));
      } catch (err) {
        if (isUniqueViolation(err)) {
          await recordAuditEvent({
            action: "hr.shift.updated",
            result: "DENIED",
            ...actor(request),
            institutionId,
            resourceType: "HrShift",
            resourceId: id,
            metadata: { reason: "shift name already exists" },
          });
          return reply.status(409).send({ error: "shift name already exists" });
        }
        throw err;
      }
    },
  );

  // ─── 17. GET /shifts (hr.directory.view) ─────────────────────────────────────
  app.get(
    "/shifts",
    { preHandler: [requirePermission("hr.directory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const rows = await withTenant(institutionId, (tx) =>
        tx.hrShift.findMany({ where: { institutionId }, orderBy: [{ name: "asc" }] }),
      );
      return reply.send({ shifts: rows.map(serializeShift) });
    },
  );

  // ─── 18. POST /employees/:id/attendance (hr.attendance.manage) ───────────────
  // Records the current row + an immutable RECORDED history row (append-only
  // ledger). Duplicate (employee, date) → 409.
  app.post(
    "/employees/:id/attendance",
    { preHandler: [requirePermission("hr.attendance.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = recordAttendanceSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      try {
        const outcome = await withTenant(institutionId, async (tx) => {
          const employee = await findEmployee(tx, institutionId, id);
          if (!employee) {
            await recordAuditEvent(
              {
                action: "hr.attendance.recorded",
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "HrEmployeeAttendance",
                metadata: { reason: "employee not found", employeeId: id },
              },
              tx,
            );
            return deny("employee not found", 404);
          }
          const record = await tx.hrEmployeeAttendance.create({
            data: {
              institutionId,
              employeeId: id,
              attendanceDate: new Date(data.attendanceDate),
              status: data.status,
              source: data.source ?? "MANUAL",
              shiftId: data.shiftId ?? null,
              recordedByUserId: request.user.userId,
            },
          });
          await tx.hrEmployeeAttendanceHistory.create({
            data: {
              institutionId,
              employeeAttendanceId: record.id,
              changeType: "RECORDED",
              previousStatus: null,
              newStatus: record.status,
              actorUserId: request.user.userId,
            },
          });
          await recordAuditEvent(
            {
              action: "hr.attendance.recorded",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "HrEmployeeAttendance",
              resourceId: record.id,
              metadata: { employeeId: id, status: record.status },
            },
            tx,
          );
          return { record };
        });

        if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
        return reply.status(201).send(serializeAttendance(outcome.record));
      } catch (err) {
        if (isUniqueViolation(err)) {
          await recordAuditEvent({
            action: "hr.attendance.recorded",
            result: "DENIED",
            ...actor(request),
            institutionId,
            resourceType: "HrEmployeeAttendance",
            metadata: { reason: "attendance already recorded for date", employeeId: id },
          });
          return reply.status(409).send({ error: "attendance already recorded for this date" });
        }
        throw err;
      }
    },
  );

  // ─── 19. PATCH /employees/:id/attendance/:date (hr.attendance.manage) ────────
  // :date is YYYY-MM-DD (malformed → 400). A well-formed date with no matching
  // row → DENIED hr.attendance.corrected + 404. Overwrites the current row +
  // writes a CORRECTED history row.
  app.patch(
    "/employees/:id/attendance/:date",
    { preHandler: [requirePermission("hr.attendance.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id, date } = request.params as { id: string; date: string };
      const dateParsed = hrDatePathSchema.safeParse(date);
      if (!dateParsed.success) return reply.status(400).send({ error: dateParsed.error.flatten() });
      const parsed = correctAttendanceSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;
      const attendanceDate = new Date(`${dateParsed.data}T00:00:00.000Z`);

      const outcome = await withTenant(institutionId, async (tx) => {
        const existing = await tx.hrEmployeeAttendance.findFirst({
          where: { institutionId, employeeId: id, attendanceDate },
        });
        if (!existing) {
          await recordAuditEvent(
            {
              action: "hr.attendance.corrected",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "HrEmployeeAttendance",
              metadata: { reason: "attendance not found", employeeId: id, date: dateParsed.data },
            },
            tx,
          );
          return deny("attendance not found", 404);
        }
        const previousStatus = existing.status;
        const updated = await tx.hrEmployeeAttendance.update({
          where: { id: existing.id },
          data: {
            status: data.status,
            ...(data.source !== undefined ? { source: data.source } : {}),
            ...(data.shiftId !== undefined ? { shiftId: data.shiftId } : {}),
            recordedByUserId: request.user.userId,
          },
        });
        await tx.hrEmployeeAttendanceHistory.create({
          data: {
            institutionId,
            employeeAttendanceId: existing.id,
            changeType: "CORRECTED",
            previousStatus,
            newStatus: updated.status,
            actorUserId: request.user.userId,
            reason: data.reason ?? null,
            metadata:
              data.metadata === undefined ? undefined : (data.metadata as Prisma.InputJsonValue),
          },
        });
        await recordAuditEvent(
          {
            action: "hr.attendance.corrected",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HrEmployeeAttendance",
            resourceId: existing.id,
            metadata: { employeeId: id, previousStatus, newStatus: updated.status },
          },
          tx,
        );
        return { updated };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send(serializeAttendance(outcome.updated));
    },
  );

  // ─── G-H5. GET /attendance/roster?date= (hr.attendance.manage) ───────────────
  // The record/correct screens (routes #18/#19) are per-employee; without a
  // day roster the UI would need one request per employee to show who is still
  // unmarked. Returns every non-TERMINATED employee (paged, employeeNo order)
  // with that calendar day's attendance row or null. Gated by the WRITE key.
  app.get(
    "/attendance/roster",
    { preHandler: [requirePermission("hr.attendance.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = hrAttendanceRosterQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { date, page, pageSize } = parsed.data;
      const day = new Date(date);

      const where: Prisma.HrEmployeeWhereInput = { institutionId, status: { not: "TERMINATED" } };
      const { employees, total, records } = await withTenant(institutionId, async (tx) => {
        const [employees, total] = await Promise.all([
          tx.hrEmployee.findMany({
            where,
            orderBy: [{ employeeNo: "asc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
            select: employeeBriefSelect,
          }),
          tx.hrEmployee.count({ where }),
        ]);
        const records = employees.length
          ? await tx.hrEmployeeAttendance.findMany({
              where: { institutionId, attendanceDate: day, employeeId: { in: employees.map((e) => e.id) } },
            })
          : [];
        return { employees, total, records };
      });
      const byEmployee = new Map(records.map((r) => [r.employeeId, r]));
      return reply.send({
        date,
        roster: employees.map((e) => ({
          employee: employeeBrief(e),
          attendance: byEmployee.has(e.id) ? serializeAttendance(byEmployee.get(e.id)!) : null,
        })),
        total,
        page,
        pageSize,
      });
    },
  );

  // ─── 20. GET /employees/:id/attendance (hr.directory.view) ───────────────────
  app.get(
    "/employees/:id/attendance",
    { preHandler: [requirePermission("hr.directory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const outcome = await withTenant(institutionId, async (tx) => {
        const employee = await findEmployee(tx, institutionId, id);
        if (!employee) return deny("employee not found", 404);
        const rows = await tx.hrEmployeeAttendance.findMany({
          where: { institutionId, employeeId: id },
          orderBy: [{ attendanceDate: "desc" }],
        });
        return { rows };
      });
      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send({ attendance: outcome.rows.map(serializeAttendance) });
    },
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 21–24. REPORTS (hr.reports.view)
  // ════════════════════════════════════════════════════════════════════════════

  // Build the leave-summary rows (per employee/type: entitlement/taken/remaining)
  // for the current year — deterministic, ordered.
  async function buildLeaveSummary(tx: Prisma.TransactionClient, institutionId: string) {
    const year = new Date().getUTCFullYear();
    const employees = await tx.hrEmployee.findMany({
      where: { institutionId },
      orderBy: [{ employeeNo: "asc" }],
      select: { id: true, employeeNo: true },
    });
    const rows: Array<{
      employeeId: string;
      employeeNo: string;
      leaveType: string;
      periodYear: number;
      entitlement: number;
      taken: number;
      remaining: number;
    }> = [];
    for (const e of employees) {
      const balances = await computeBalanceArray(tx, institutionId, e.id, year, new Date());
      for (const b of balances) {
        rows.push({
          employeeId: e.id,
          employeeNo: e.employeeNo,
          leaveType: b.leaveType,
          periodYear: b.periodYear,
          entitlement: b.entitlement,
          taken: b.taken,
          remaining: b.remaining,
        });
      }
    }
    return { year, rows };
  }

  // Build the attendance-summary rows (per employee: day-status counts over a
  // date range) — deterministic, ordered.
  async function buildAttendanceSummary(
    tx: Prisma.TransactionClient,
    institutionId: string,
    from: Date,
    to: Date,
  ) {
    const employees = await tx.hrEmployee.findMany({
      where: { institutionId },
      orderBy: [{ employeeNo: "asc" }],
      select: { id: true, employeeNo: true },
    });
    const rows: Array<{
      employeeId: string;
      employeeNo: string;
      present: number;
      absent: number;
      onLeave: number;
      halfDay: number;
      total: number;
    }> = [];
    for (const e of employees) {
      const records = await tx.hrEmployeeAttendance.findMany({
        where: { institutionId, employeeId: e.id, attendanceDate: { gte: from, lte: to } },
        select: { status: true },
      });
      const counts = { present: 0, absent: 0, onLeave: 0, halfDay: 0 };
      for (const r of records) {
        if (r.status === "PRESENT") counts.present += 1;
        else if (r.status === "ABSENT") counts.absent += 1;
        else if (r.status === "ON_LEAVE") counts.onLeave += 1;
        else if (r.status === "HALF_DAY") counts.halfDay += 1;
      }
      rows.push({
        employeeId: e.id,
        employeeNo: e.employeeNo,
        present: counts.present,
        absent: counts.absent,
        onLeave: counts.onLeave,
        halfDay: counts.halfDay,
        total: records.length,
      });
    }
    return rows;
  }

  // ─── 21. GET /reports/leave-summary (hr.reports.view) ────────────────────────
  app.get(
    "/reports/leave-summary",
    { preHandler: [requirePermission("hr.reports.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const report = await withTenant(institutionId, (tx) => buildLeaveSummary(tx, institutionId));
      return reply.send(report);
    },
  );

  // ─── 22. GET /reports/leave-summary.xlsx (hr.reports.view, AUDITED export) ───
  app.get(
    "/reports/leave-summary.xlsx",
    { preHandler: [requirePermission("hr.reports.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const report = await withTenant(institutionId, async (tx) => {
        const built = await buildLeaveSummary(tx, institutionId);
        await recordAuditEvent(
          {
            action: "hr.reports.exported",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HrLeaveApplication",
            metadata: { report: "leave-summary", rows: built.rows.length },
          },
          tx,
        );
        return built;
      });

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Leave Summary");
      sheet.columns = [
        { header: "Employee ID", key: "employeeId", width: 26 },
        { header: "Employee No", key: "employeeNo", width: 18 },
        { header: "Leave Type", key: "leaveType", width: 14 },
        { header: "Period Year", key: "periodYear", width: 12 },
        { header: "Entitlement", key: "entitlement", width: 12 },
        { header: "Taken", key: "taken", width: 10 },
        { header: "Remaining", key: "remaining", width: 12 },
      ];
      for (const r of report.rows) {
        sheet.addRow(r);
      }
      sheet.getRow(1).font = { bold: true };

      const filename = `leave-summary-${new Date().toISOString().slice(0, 10)}.xlsx`;
      const buffer = await workbook.xlsx.writeBuffer();
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(Buffer.from(buffer));
    },
  );

  // ─── 23. GET /reports/attendance-summary (hr.reports.view) ───────────────────
  app.get(
    "/reports/attendance-summary",
    { preHandler: [requirePermission("hr.reports.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = hrReportRangeQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const from = new Date(parsed.data.from);
      const to = new Date(parsed.data.to);
      const rows = await withTenant(institutionId, (tx) =>
        buildAttendanceSummary(tx, institutionId, from, to),
      );
      return reply.send({ from: parsed.data.from, to: parsed.data.to, rows });
    },
  );

  // ─── 24. GET /reports/attendance-summary.xlsx (hr.reports.view, AUDITED) ─────
  app.get(
    "/reports/attendance-summary.xlsx",
    { preHandler: [requirePermission("hr.reports.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = hrReportRangeQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const from = new Date(parsed.data.from);
      const to = new Date(parsed.data.to);
      const rows = await withTenant(institutionId, async (tx) => {
        const built = await buildAttendanceSummary(tx, institutionId, from, to);
        await recordAuditEvent(
          {
            action: "hr.reports.exported",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HrEmployeeAttendance",
            metadata: { report: "attendance-summary", rows: built.length },
          },
          tx,
        );
        return built;
      });

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Attendance Summary");
      sheet.columns = [
        { header: "Employee ID", key: "employeeId", width: 26 },
        { header: "Employee No", key: "employeeNo", width: 18 },
        { header: "Present", key: "present", width: 10 },
        { header: "Absent", key: "absent", width: 10 },
        { header: "On Leave", key: "onLeave", width: 10 },
        { header: "Half Day", key: "halfDay", width: 10 },
        { header: "Total", key: "total", width: 10 },
      ];
      for (const r of rows) {
        sheet.addRow(r);
      }
      sheet.getRow(1).font = { bold: true };

      const filename = `attendance-summary-${new Date().toISOString().slice(0, 10)}.xlsx`;
      const buffer = await workbook.xlsx.writeBuffer();
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(Buffer.from(buffer));
    },
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 25–30. SELF-SERVICE /me/* (hr.view_own) — EMPLOYEE only
  // Every handler resolves the caller's hr_employees row by token userId and
  // scopes every query to that employeeId. No row → 404 (never a leak). An
  // EMPLOYEE can never approve/reject (no hr.leave.manage key).
  // ════════════════════════════════════════════════════════════════════════════

  // ─── 25. GET /me/employee (hr.view_own) ──────────────────────────────────────
  app.get(
    "/me/employee",
    { preHandler: [requirePermission("hr.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const outcome = await withTenant(institutionId, async (tx) => {
        const self = await tx.hrEmployee.findFirst({
          where: { institutionId, userId },
          include: employeeDetailInclude,
        });
        if (!self) return deny("employee record not found", 404);
        return { self };
      });
      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send(serializeEmployeeDetail(outcome.self));
    },
  );

  // ─── 26. GET /me/contracts (hr.view_own) ─────────────────────────────────────
  app.get(
    "/me/contracts",
    { preHandler: [requirePermission("hr.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const outcome = await withTenant(institutionId, async (tx) => {
        const self = await resolveSelf(tx, institutionId, userId);
        if (!self) return deny("employee record not found", 404);
        const rows = await tx.hrContract.findMany({
          where: { institutionId, employeeId: self.id },
          orderBy: [{ createdAt: "asc" }],
        });
        return { rows };
      });
      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send({ contracts: outcome.rows.map(serializeContract) });
    },
  );

  // ─── 27a. GET /me/leave (hr.view_own) ────────────────────────────────────────
  app.get(
    "/me/leave",
    { preHandler: [requirePermission("hr.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const outcome = await withTenant(institutionId, async (tx) => {
        const self = await resolveSelf(tx, institutionId, userId);
        if (!self) return deny("employee record not found", 404);
        const rows = await tx.hrLeaveApplication.findMany({
          where: { institutionId, employeeId: self.id },
          orderBy: [{ createdAt: "desc" }],
        });
        return { rows };
      });
      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send({ leaveApplications: outcome.rows.map(serializeLeaveApp) });
    },
  );

  // ─── 27b. GET /me/leave-balance?year= (hr.view_own) ──────────────────────────
  app.get(
    "/me/leave-balance",
    { preHandler: [requirePermission("hr.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const parsed = leaveBalanceQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const year = parsed.data.year ?? new Date().getUTCFullYear();

      const outcome = await withTenant(institutionId, async (tx) => {
        const self = await resolveSelf(tx, institutionId, userId);
        if (!self) return deny("employee record not found", 404);
        const balances = await computeBalanceArray(tx, institutionId, self.id, year, new Date());
        return { balances };
      });
      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send({ balances: outcome.balances });
    },
  );

  // ─── 28. POST /me/leave — self apply (hr.view_own) ───────────────────────────
  app.post(
    "/me/leave",
    { preHandler: [requirePermission("hr.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const parsed = createLeaveApplicationSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const self = await resolveSelf(tx, institutionId, userId);
        if (!self) return deny("employee record not found", 404);
        const start = new Date(data.startDate);
        const end = new Date(data.endDate);
        const application = await tx.hrLeaveApplication.create({
          data: {
            institutionId,
            employeeId: self.id,
            leaveType: data.leaveType,
            startDate: start,
            endDate: end,
            days: inclusiveDays(start, end),
            periodYear: start.getUTCFullYear(),
            reason: data.reason,
            status: "REQUESTED",
          },
        });
        await recordAuditEvent(
          {
            action: "hr.leave.requested",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "HrLeaveApplication",
            resourceId: application.id,
            metadata: { employeeId: self.id, leaveType: application.leaveType, days: application.days },
          },
          tx,
        );
        return { application };
      });

      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.status(201).send(serializeLeaveApp(outcome.application));
    },
  );

  // ─── 29. POST /me/leave/:appId/cancel (hr.view_own) ──────────────────────────
  // REQUESTED → CANCELLED only; not-own / not-REQUESTED → DENIED + 4xx.
  app.post(
    "/me/leave/:appId/cancel",
    { preHandler: [requirePermission("hr.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const { appId } = request.params as { appId: string };

      try {
        const outcome = await withTenant(institutionId, async (tx) => {
          const self = await resolveSelf(tx, institutionId, userId);
          if (!self) return deny("employee record not found", 404);
          // Scope to the caller's OWN application (not-own → not found → 404).
          const application = await tx.hrLeaveApplication.findFirst({
            where: { id: appId, institutionId, employeeId: self.id },
          });
          if (!application) {
            await recordAuditEvent(
              {
                action: "hr.leave.cancelled",
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "HrLeaveApplication",
                resourceId: appId,
                metadata: { reason: "leave application not found", employeeId: self.id },
              },
              tx,
            );
            return deny("leave application not found", 404);
          }
          if (application.status !== "REQUESTED") {
            await recordAuditEvent(
              {
                action: "hr.leave.cancelled",
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "HrLeaveApplication",
                resourceId: appId,
                metadata: { reason: "not requested", status: application.status },
              },
              tx,
            );
            return deny("leave application is not pending", 409);
          }
          const cancelled = await tx.hrLeaveApplication.update({
            where: { id: appId },
            data: { status: "CANCELLED" },
          });
          await recordAuditEvent(
            {
              action: "hr.leave.cancelled",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "HrLeaveApplication",
              resourceId: appId,
              metadata: { employeeId: self.id },
            },
            tx,
          );
          return { cancelled };
        });

        if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
        return reply.send(serializeLeaveApp(outcome.cancelled));
      } catch (err) {
        if (isRestrictViolation(err)) {
          request.log.error({ err }, "hr.leave.cancelled: unexpected guard restrict_violation");
          return reply.status(500).send({ error: "leave lifecycle violation" });
        }
        throw err;
      }
    },
  );

  // ─── 30. GET /me/attendance (hr.view_own) ────────────────────────────────────
  app.get(
    "/me/attendance",
    { preHandler: [requirePermission("hr.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const outcome = await withTenant(institutionId, async (tx) => {
        const self = await resolveSelf(tx, institutionId, userId);
        if (!self) return deny("employee record not found", 404);
        const rows = await tx.hrEmployeeAttendance.findMany({
          where: { institutionId, employeeId: self.id },
          orderBy: [{ attendanceDate: "desc" }],
        });
        return { rows };
      });
      if (isDeny(outcome)) return reply.status(outcome.status).send({ error: outcome.deny });
      return reply.send({ attendance: outcome.rows.map(serializeAttendance) });
    },
  );
}
