import type { FastifyInstance, FastifyRequest } from "fastify";
import { withTenant, type AttendanceStatus, type Prisma } from "@campusgate/db";
import {
  openAttendanceSessionSchema,
  markAttendanceRecordsSchema,
  requestCorrectionSchema,
  reviewCorrectionSchema,
  attendanceReportQuerySchema,
  attendanceExportQuerySchema,
} from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission, requireModuleActive } from "../services/authz-engine.js";
import { recordAuditEvent } from "../services/audit.js";
import { notifyUser } from "../services/notifications.js";
import {
  resolveMarkingFaculty,
  assertFacultyAssigned,
  dayOfWeekToIndex,
} from "../services/attendance-authz.js";
import {
  attendancePolicy,
  attendanceRate,
  crossedBelowThreshold,
  type AttendancePolicy,
} from "../services/attendance-policy.js";

const MODULE_KEY = "attendance" as const;

/**
 * Attendance routes (design §8), registered at `/api/attendance` (see server.ts).
 * Attendance is a GATED module — every operational route carries
 * `requireModuleActive("attendance")` IN ADDITION to `requirePermission(...)`
 * (the campus_movement precedent), unlike the foundational classes/students
 * routes.
 *
 * House pattern (mirrors classes.ts):
 *  - a single top-level `authenticate` preHandler;
 *  - per-route `requirePermission(key)` AND `requireModuleActive("attendance")`;
 *  - every handler runs inside `withTenant(institutionId, tx => ...)` with
 *    `institutionId` from the verified token (`request.user`), never from input;
 *  - every mutation writes an `attendance.*` AuditEvent via `recordAuditEvent`
 *    in the SAME transaction;
 *  - deny branches record a DENIED audit then RETURN the 403 from a
 *    normally-returning `withTenant` callback (never `throw`) so the audit
 *    commits (design §7.3/NIT-1);
 *  - HOD callers are narrowed to their `departmentScope` via a relation-filter
 *    helper; an out-of-scope row is 404 (not-found).
 */
export async function attendanceRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  const gate = MODULE_KEY;

  // ─── Shared helpers ────────────────────────────────────────────────────────

  function actor(request: FastifyRequest) {
    return {
      actorUserId: request.user.userId,
      actorRoleKey: request.auth?.roles[0] ?? request.user.role,
      actorMembershipId: request.auth?.membershipId ?? null,
      requestRef: request.id,
    };
  }

  // HOD department-scope relation-filter for attendance queries (design §8.4).
  // Scopes through attendanceSession -> scheduledClass -> classSection ->
  // program.departmentId for a scoped HOD; `{}` for ADMIN / non-HOD (whole tenant).
  type AttendanceScopeKind = "session" | "correction" | "record";

  function attendanceDepartmentScopeFilter(
    request: FastifyRequest,
    kind: AttendanceScopeKind,
  ): Record<string, unknown> {
    const roles = request.auth?.roles ?? [];
    const scope = request.auth?.departmentScope ?? null;
    if (!(roles.includes("HOD") && !roles.includes("ADMIN") && scope)) return {};
    const sessionPath = { scheduledClass: { classSection: { program: { departmentId: scope } } } };
    switch (kind) {
      case "session":
        return sessionPath;
      case "record":
        return { attendanceSession: sessionPath };
      case "correction":
        return { attendanceRecord: { attendanceSession: sessionPath } };
    }
  }

  // Read the tenant's attendance module policy (settings JSON) under RLS.
  async function loadPolicy(tx: Prisma.TransactionClient, institutionId: string): Promise<AttendancePolicy> {
    const row = await tx.institutionModule.findUnique({
      where: { institutionId_moduleKey: { institutionId, moduleKey: MODULE_KEY } },
      select: { settings: true },
    });
    return attendancePolicy(row?.settings ?? null);
  }

  // Truncate a Date to UTC midnight (the session `date` domain, design §8.3).
  function toUtcMidnight(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  // ─── OPEN SESSION ────────────────────────────────────────────────────────────
  app.post(
    "/sessions",
    { preHandler: [requirePermission("attendance.mark"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = openAttendanceSessionSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;
      const date = toUtcMidnight(data.date);

      const outcome = await withTenant(institutionId, async (tx) => {
        // 1. Resolve the caller's ACTIVE faculty profile.
        const marking = await resolveMarkingFaculty(tx, institutionId, request.user.userId);
        if (!marking) {
          await recordAuditEvent(
            {
              action: "attendance.session.opened",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "AttendanceSession",
              metadata: { reason: "not a faculty member", scheduledClassId: data.scheduledClassId },
            },
            tx,
          );
          return { deny: "not a faculty member" as const };
        }

        // 2. Load the scheduled class (tenant-filtered).
        const scheduled = await tx.scheduledClass.findFirst({
          where: { id: data.scheduledClassId, institutionId },
          select: {
            id: true,
            classSectionId: true,
            subjectId: true,
            academicTermId: true,
            facultyId: true,
            status: true,
            dayOfWeek: true,
            date: true,
          },
        });
        if (!scheduled) return { notFound: true as const };

        // 3. Faculty-scope ownership check.
        const assigned = await assertFacultyAssigned(tx, institutionId, marking.facultyId, scheduled);
        if (!assigned) {
          await recordAuditEvent(
            {
              action: "attendance.session.opened",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "AttendanceSession",
              resourceId: scheduled.id,
              metadata: { reason: "not assigned to this class", scheduledClassId: scheduled.id },
            },
            tx,
          );
          return { deny: "not assigned to this class" as const };
        }

        // 4. CANCELLED scheduled class cannot be marked.
        if (scheduled.status === "CANCELLED") return { conflict: "scheduled class cancelled" as const };

        // 5. Date must match the scheduled class's recurrence.
        if (scheduled.dayOfWeek) {
          if (date.getUTCDay() !== dayOfWeekToIndex(scheduled.dayOfWeek)) {
            return { conflict: "date does not match scheduled class" as const };
          }
        } else if (scheduled.date) {
          if (toUtcMidnight(scheduled.date).getTime() !== date.getTime()) {
            return { conflict: "date does not match scheduled class" as const };
          }
        } else {
          // Both null — a Phase 3 data error; defensively reject.
          return { conflict: "date does not match scheduled class" as const };
        }

        // 6. Duplicate session guard (business unique).
        const existing = await tx.attendanceSession.findFirst({
          where: { institutionId, scheduledClassId: scheduled.id, date },
          select: { id: true },
        });
        if (existing) return { conflict: "session already exists" as const };

        // 7. Create the OPEN session.
        const session = await tx.attendanceSession.create({
          data: {
            institutionId,
            scheduledClassId: scheduled.id,
            academicTermId: scheduled.academicTermId,
            date,
            status: "OPEN",
            markedByFacultyId: marking.facultyId,
            submissionDeadline: data.submissionDeadline ?? null,
          },
        });

        // 8. Snapshot one ABSENT record per ENROLLED student + a MARKED history row.
        const enrollments = await tx.classEnrollment.findMany({
          where: { institutionId, classSectionId: scheduled.classSectionId, status: "ENROLLED" },
          select: { studentId: true },
        });
        const act = actor(request);
        for (const e of enrollments) {
          const record = await tx.attendanceRecord.create({
            data: {
              institutionId,
              attendanceSessionId: session.id,
              studentId: e.studentId,
              status: "ABSENT",
            },
          });
          await tx.attendanceRecordHistory.create({
            data: {
              institutionId,
              attendanceRecordId: record.id,
              changeType: "MARKED",
              previousStatus: null,
              newStatus: "ABSENT",
              actorUserId: act.actorUserId,
              actorMembershipId: act.actorMembershipId,
            },
          });
        }

        await recordAuditEvent(
          {
            action: "attendance.session.opened",
            result: "SUCCESS",
            ...act,
            institutionId,
            resourceType: "AttendanceSession",
            resourceId: session.id,
            metadata: { scheduledClassId: scheduled.id, recordCount: enrollments.length },
          },
          tx,
        );

        return { session, recordCount: enrollments.length };
      });

      if ("deny" in outcome) return reply.status(403).send({ error: outcome.deny });
      if ("notFound" in outcome) return reply.status(404).send({ error: "scheduled class not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.status(201).send({ session: outcome.session, recordCount: outcome.recordCount });
    },
  );

  // ─── LIST SESSIONS ───────────────────────────────────────────────────────────
  app.get(
    "/sessions",
    { preHandler: [requirePermission("attendance.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const sessions = await withTenant(institutionId, (tx) =>
        tx.attendanceSession.findMany({
          where: { institutionId, ...attendanceDepartmentScopeFilter(request, "session") },
          orderBy: [{ date: "desc" }, { id: "asc" }],
        }),
      );
      return reply.send({ sessions });
    },
  );

  // ─── SESSION DETAIL ────────────────────────────────────────────────────────
  app.get(
    "/sessions/:id",
    { preHandler: [requirePermission("attendance.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const session = await withTenant(institutionId, (tx) =>
        tx.attendanceSession.findFirst({
          where: { id, institutionId, ...attendanceDepartmentScopeFilter(request, "session") },
          include: { records: { orderBy: { id: "asc" } } },
        }),
      );
      if (!session) return reply.status(404).send({ error: "session not found" });
      return reply.send(session);
    },
  );

  // ─── MARK / EDIT RECORDS ─────────────────────────────────────────────────────
  app.patch(
    "/sessions/:id/records",
    { preHandler: [requirePermission("attendance.mark"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = markAttendanceRecordsSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const marking = await resolveMarkingFaculty(tx, institutionId, request.user.userId);
        if (!marking) return { deny: "not a faculty member" as const };

        const session = await tx.attendanceSession.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true, markedByFacultyId: true },
        });
        if (!session) return { notFound: true as const };

        // Owner re-assert: only the session's marker may edit it.
        if (session.markedByFacultyId !== marking.facultyId) {
          return { deny: "not assigned to this session" as const };
        }

        if (session.status === "FINALIZED") return { conflict: "session finalized" as const };

        const policy = await loadPolicy(tx, institutionId);
        // SUBMITTED edits only allowed if policy permits self-correction.
        if (session.status === "SUBMITTED" && !policy.allowSelfCorrectionBeforeFinalize) {
          return { conflict: "session submitted" as const };
        }

        const act = actor(request);
        let changed = 0;
        for (const r of data.records) {
          const record = await tx.attendanceRecord.findFirst({
            where: { institutionId, attendanceSessionId: session.id, studentId: r.studentId },
            select: { id: true, status: true },
          });
          if (!record) return { conflict: "student not in this session" as const };
          if (record.status === r.status) continue; // no-op, skip history
          await tx.attendanceRecord.update({
            where: { id: record.id },
            data: { status: r.status, markedAt: new Date() },
          });
          await tx.attendanceRecordHistory.create({
            data: {
              institutionId,
              attendanceRecordId: record.id,
              changeType: "MARKED",
              previousStatus: record.status,
              newStatus: r.status,
              actorUserId: act.actorUserId,
              actorMembershipId: act.actorMembershipId,
            },
          });
          changed += 1;
        }

        await recordAuditEvent(
          {
            action: "attendance.records.marked",
            result: "SUCCESS",
            ...act,
            institutionId,
            resourceType: "AttendanceSession",
            resourceId: session.id,
            metadata: { changed, batchSize: data.records.length },
          },
          tx,
        );

        return { changed };
      });

      if ("deny" in outcome) return reply.status(403).send({ error: outcome.deny });
      if ("notFound" in outcome) return reply.status(404).send({ error: "session not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send({ changed: outcome.changed });
    },
  );

  // ─── SUBMIT ──────────────────────────────────────────────────────────────────
  app.post(
    "/sessions/:id/submit",
    { preHandler: [requirePermission("attendance.mark"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };

      const outcome = await withTenant(institutionId, async (tx) => {
        const marking = await resolveMarkingFaculty(tx, institutionId, request.user.userId);
        if (!marking) return { deny: "not a faculty member" as const };

        const session = await tx.attendanceSession.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true, markedByFacultyId: true },
        });
        if (!session) return { notFound: true as const };
        if (session.markedByFacultyId !== marking.facultyId) return { deny: "not assigned to this session" as const };
        if (session.status !== "OPEN") return { conflict: "session not open" as const };

        const updated = await tx.attendanceSession.update({
          where: { id: session.id },
          data: { status: "SUBMITTED", submittedAt: new Date() },
        });
        await recordAuditEvent(
          {
            action: "attendance.session.submitted",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "AttendanceSession",
            resourceId: session.id,
          },
          tx,
        );
        return { session: updated };
      });

      if ("deny" in outcome) return reply.status(403).send({ error: outcome.deny });
      if ("notFound" in outcome) return reply.status(404).send({ error: "session not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send(outcome.session);
    },
  );

  // ─── FINALIZE ─────────────────────────────────────────────────────────────────
  app.post(
    "/sessions/:id/finalize",
    { preHandler: [requirePermission("attendance.mark"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };

      const outcome = await withTenant(institutionId, async (tx) => {
        const marking = await resolveMarkingFaculty(tx, institutionId, request.user.userId);
        if (!marking) return { deny: "not a faculty member" as const };

        const session = await tx.attendanceSession.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true, markedByFacultyId: true, academicTermId: true },
        });
        if (!session) return { notFound: true as const };
        if (session.markedByFacultyId !== marking.facultyId) return { deny: "not assigned to this session" as const };
        if (session.status !== "SUBMITTED") return { conflict: "session not submitted" as const };

        const updated = await tx.attendanceSession.update({
          where: { id: session.id },
          data: { status: "FINALIZED", finalizedAt: new Date() },
        });
        await recordAuditEvent(
          {
            action: "attendance.session.finalized",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "AttendanceSession",
            resourceId: session.id,
          },
          tx,
        );
        return { sessionId: session.id, academicTermId: session.academicTermId, session: updated };
      });

      if ("deny" in outcome) return reply.status(403).send({ error: outcome.deny });
      if ("notFound" in outcome) return reply.status(404).send({ error: "session not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });

      // Post-commit low-attendance alert (design §8.6). Best-effort; never rolls
      // back the already-committed finalize.
      await emitLowAttendanceAlerts(request, institutionId, outcome.sessionId, outcome.academicTermId);

      return reply.send(outcome.session);
    },
  );

  // Compute each affected student's prior/post FINALIZED-only rate for the term
  // and, for each downward crossing, notify + audit inside a fresh short
  // withTenant tx (design §8.6). Runs AFTER the finalize tx committed.
  async function emitLowAttendanceAlerts(
    request: FastifyRequest,
    institutionId: string,
    sessionId: string,
    academicTermId: string,
  ): Promise<void> {
    let crossings: Array<{ studentId: string; studentUserId: string; ratePercent: number }> = [];
    let threshold = 75;
    try {
      const computed = await withTenant(institutionId, async (tx) => {
        const policy = await loadPolicy(tx, institutionId);
        // Students who have a record in the just-finalized session.
        const sessionRecords = await tx.attendanceRecord.findMany({
          where: { institutionId, attendanceSessionId: sessionId },
          select: { studentId: true },
        });
        const studentIds = [...new Set(sessionRecords.map((r) => r.studentId))];
        const out: Array<{ studentId: string; studentUserId: string; ratePercent: number }> = [];
        for (const studentId of studentIds) {
          // All FINALIZED records for this student in the term (post = incl. this
          // session, which is now FINALIZED and durable).
          const postRecords = await tx.attendanceRecord.findMany({
            where: {
              institutionId,
              studentId,
              attendanceSession: { status: "FINALIZED", academicTermId },
            },
            select: { status: true, attendanceSessionId: true },
          });
          const priorRecords = postRecords.filter((r) => r.attendanceSessionId !== sessionId);
          const postRate = attendanceRate(postRecords, policy);
          const priorRate = attendanceRate(priorRecords, policy);
          if (crossedBelowThreshold(priorRate, postRate, policy.lowAttendanceThresholdPercent)) {
            const student = await tx.studentProfile.findFirst({
              where: { id: studentId, institutionId },
              select: { userId: true },
            });
            if (student && postRate !== null) {
              out.push({ studentId, studentUserId: student.userId, ratePercent: postRate });
            }
          }
        }
        return { crossings: out, threshold: policy.lowAttendanceThresholdPercent };
      });
      crossings = computed.crossings;
      threshold = computed.threshold;
    } catch (err) {
      request.log.warn({ err, sessionId }, "low-attendance alert compute failed");
      return;
    }

    const act = actor(request);
    for (const s of crossings) {
      try {
        await withTenant(institutionId, async (tx) => {
          await notifyUser(
            s.studentUserId,
            {
              title: "Low attendance",
              body: `Your attendance has dropped below ${threshold}%.`,
              type: "attendance.low",
              data: { studentId: s.studentId, ratePercent: s.ratePercent, threshold },
            },
            tx,
          );
          await recordAuditEvent(
            {
              action: "attendance.low_attendance.alerted",
              result: "SUCCESS",
              ...act,
              institutionId,
              resourceType: "StudentProfile",
              resourceId: s.studentId,
              metadata: { ratePercent: s.ratePercent, threshold },
            },
            tx,
          );
        });
      } catch (err) {
        request.log.warn({ err, studentId: s.studentId }, "low-attendance alert failed");
      }
    }
  }

  // ─── REQUEST CORRECTION ───────────────────────────────────────────────────────
  app.post(
    "/corrections",
    { preHandler: [requirePermission("attendance.mark"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = requestCorrectionSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const marking = await resolveMarkingFaculty(tx, institutionId, request.user.userId);
        if (!marking) return { deny: "not a faculty member" as const };

        const record = await tx.attendanceRecord.findFirst({
          where: { id: data.attendanceRecordId, institutionId },
          select: {
            id: true,
            status: true,
            attendanceSession: { select: { id: true, status: true, markedByFacultyId: true } },
          },
        });
        if (!record) return { notFound: true as const };

        // Faculty may request only on a session they marked.
        if (record.attendanceSession.markedByFacultyId !== marking.facultyId) {
          return { deny: "not assigned to this session" as const };
        }
        if (record.attendanceSession.status !== "FINALIZED") {
          return { conflict: "session not finalized" as const };
        }
        if (data.requestedStatus === record.status) return { noChange: true as const };

        const pending = await tx.attendanceCorrection.findFirst({
          where: { institutionId, attendanceRecordId: record.id, reviewStatus: "PENDING" },
          select: { id: true },
        });
        if (pending) return { conflict: "a correction is already pending for this record" as const };

        const correction = await tx.attendanceCorrection.create({
          data: {
            institutionId,
            attendanceRecordId: record.id,
            requestedByUserId: request.user.userId,
            reason: data.reason,
            requestedStatus: data.requestedStatus,
            priorStatus: record.status,
            reviewStatus: "PENDING",
          },
        });
        await recordAuditEvent(
          {
            action: "attendance.correction.requested",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "AttendanceCorrection",
            resourceId: correction.id,
            metadata: { attendanceRecordId: record.id, requestedStatus: data.requestedStatus },
          },
          tx,
        );
        return { correction };
      });

      if ("deny" in outcome) return reply.status(403).send({ error: outcome.deny });
      if ("notFound" in outcome) return reply.status(404).send({ error: "record not found" });
      if ("noChange" in outcome) return reply.status(400).send({ error: "no change requested" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.status(201).send(outcome.correction);
    },
  );

  // ─── LIST CORRECTIONS ─────────────────────────────────────────────────────────
  app.get(
    "/corrections",
    { preHandler: [requirePermission("attendance.correct"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { status } = request.query as { status?: string };
      const corrections = await withTenant(institutionId, (tx) =>
        tx.attendanceCorrection.findMany({
          where: {
            institutionId,
            ...(status === "PENDING" || status === "APPROVED" || status === "REJECTED"
              ? { reviewStatus: status }
              : {}),
            ...attendanceDepartmentScopeFilter(request, "correction"),
          },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        }),
      );
      return reply.send({ corrections });
    },
  );

  // ─── APPROVE CORRECTION ───────────────────────────────────────────────────────
  app.post(
    "/corrections/:id/approve",
    { preHandler: [requirePermission("attendance.correct"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = reviewCorrectionSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const correction = await tx.attendanceCorrection.findFirst({
          where: { id, institutionId, ...attendanceDepartmentScopeFilter(request, "correction") },
          select: {
            id: true,
            reviewStatus: true,
            priorStatus: true,
            requestedStatus: true,
            attendanceRecordId: true,
          },
        });
        if (!correction) return { notFound: true as const };
        if (correction.reviewStatus !== "PENDING") return { conflict: "correction not pending" as const };

        const record = await tx.attendanceRecord.findFirst({
          where: { id: correction.attendanceRecordId, institutionId },
          select: { id: true, status: true, attendanceSession: { select: { status: true } } },
        });
        if (!record) return { notFound: true as const };
        if (record.attendanceSession.status !== "FINALIZED") return { conflict: "session not finalized" as const };

        // Optimistic-concurrency re-check (design §8.2).
        if (record.status !== correction.priorStatus) return { conflict: "record changed since request" as const };

        const act = actor(request);
        await tx.attendanceRecordHistory.create({
          data: {
            institutionId,
            attendanceRecordId: record.id,
            changeType: "CORRECTED",
            previousStatus: record.status,
            newStatus: correction.requestedStatus,
            correctionId: correction.id,
            actorUserId: act.actorUserId,
            actorMembershipId: act.actorMembershipId,
          },
        });
        // Update status ONLY — markedAt stays the original mark time (design §3.3/§8.2).
        await tx.attendanceRecord.update({
          where: { id: record.id },
          data: { status: correction.requestedStatus },
        });
        const updated = await tx.attendanceCorrection.update({
          where: { id: correction.id },
          data: {
            reviewStatus: "APPROVED",
            reviewedByUserId: request.user.userId,
            reviewedAt: new Date(),
            reviewNote: data.reviewNote ?? null,
          },
        });
        await recordAuditEvent(
          {
            action: "attendance.correction.approved",
            result: "SUCCESS",
            ...act,
            institutionId,
            resourceType: "AttendanceCorrection",
            resourceId: correction.id,
            metadata: {
              attendanceRecordId: record.id,
              previousStatus: record.status,
              newStatus: correction.requestedStatus,
            },
          },
          tx,
        );
        return { correction: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "correction not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send(outcome.correction);
    },
  );

  // ─── REJECT CORRECTION ────────────────────────────────────────────────────────
  app.post(
    "/corrections/:id/reject",
    { preHandler: [requirePermission("attendance.correct"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = reviewCorrectionSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const correction = await tx.attendanceCorrection.findFirst({
          where: { id, institutionId, ...attendanceDepartmentScopeFilter(request, "correction") },
          select: { id: true, reviewStatus: true },
        });
        if (!correction) return { notFound: true as const };
        if (correction.reviewStatus !== "PENDING") return { conflict: "correction not pending" as const };

        const updated = await tx.attendanceCorrection.update({
          where: { id: correction.id },
          data: {
            reviewStatus: "REJECTED",
            reviewedByUserId: request.user.userId,
            reviewedAt: new Date(),
            reviewNote: data.reviewNote ?? null,
          },
        });
        await recordAuditEvent(
          {
            action: "attendance.correction.rejected",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "AttendanceCorrection",
            resourceId: correction.id,
          },
          tx,
        );
        return { correction: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "correction not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send(outcome.correction);
    },
  );

  // ─── STUDENT OWN READ ───────────────────────────────────────────────────────
  app.get(
    "/me",
    { preHandler: [requirePermission("attendance.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = attendanceReportQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { academicTermId } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const student = await tx.studentProfile.findFirst({
          where: { userId: request.user.userId, institutionId },
          select: { id: true },
        });
        if (!student) return { notFound: true as const };

        const records = await tx.attendanceRecord.findMany({
          where: {
            institutionId,
            studentId: student.id,
            attendanceSession: { status: "FINALIZED", academicTermId },
          },
          include: {
            attendanceSession: {
              select: { date: true, scheduledClassId: true, academicTermId: true },
            },
          },
          orderBy: [{ markedAt: "asc" }, { id: "asc" }],
        });
        const policy = await loadPolicy(tx, institutionId);
        const rate = attendanceRate(records, policy);
        return { records, rate };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "student not found" });
      return reply.send({ records: outcome.records, attendanceRate: outcome.rate });
    },
  );

  // ─── SECTION REPORT ───────────────────────────────────────────────────────────
  app.get(
    "/reports/section/:sectionId",
    { preHandler: [requirePermission("attendance.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { sectionId } = request.params as { sectionId: string };
      const parsed = attendanceReportQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { academicTermId } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        // Resolve + scope the section (dept-scoped HOD → 404 out of scope).
        const section = await tx.classSection.findFirst({
          where: {
            id: sectionId,
            institutionId,
            ...sectionScopeFilter(request),
          },
          select: { id: true },
        });
        if (!section) return { notFound: true as const };

        const records = await tx.attendanceRecord.findMany({
          where: {
            institutionId,
            attendanceSession: {
              status: "FINALIZED",
              academicTermId,
              scheduledClass: { classSectionId: sectionId },
            },
          },
          select: { studentId: true, status: true },
        });
        const policy = await loadPolicy(tx, institutionId);

        const byStudent = new Map<string, { status: AttendanceStatus }[]>();
        for (const r of records) {
          const arr = byStudent.get(r.studentId) ?? [];
          arr.push({ status: r.status });
          byStudent.set(r.studentId, arr);
        }
        const perStudent: Array<{ studentId: string; rate: number | null }> = [];
        const lowAttendance: Array<{ studentId: string; rate: number }> = [];
        for (const [studentId, recs] of byStudent) {
          const rate = attendanceRate(recs, policy);
          perStudent.push({ studentId, rate });
          if (rate !== null && rate < policy.lowAttendanceThresholdPercent) {
            lowAttendance.push({ studentId, rate });
          }
        }
        return {
          perStudent,
          lowAttendance,
          thresholdPercent: policy.lowAttendanceThresholdPercent,
        };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "section not found" });
      return reply.send(outcome);
    },
  );

  // Section dept-scope filter (through program.departmentId), mirroring classes.ts.
  function sectionScopeFilter(request: FastifyRequest): Record<string, unknown> {
    const roles = request.auth?.roles ?? [];
    const scope = request.auth?.departmentScope ?? null;
    if (!(roles.includes("HOD") && !roles.includes("ADMIN") && scope)) return {};
    return { program: { departmentId: scope } };
  }

  // ─── EXPORT ───────────────────────────────────────────────────────────────────
  app.get(
    "/export",
    { preHandler: [requirePermission("attendance.export"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = attendanceExportQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { sectionId, academicTermId, format } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const section = await tx.classSection.findFirst({
          where: { id: sectionId, institutionId, ...sectionScopeFilter(request) },
          select: { id: true },
        });
        if (!section) return { notFound: true as const };

        const records = await tx.attendanceRecord.findMany({
          where: {
            institutionId,
            attendanceSession: {
              academicTermId,
              scheduledClass: { classSectionId: sectionId },
            },
          },
          select: {
            status: true,
            markedAt: true,
            student: { select: { enrollmentNo: true, name: true } },
            attendanceSession: {
              select: {
                date: true,
                status: true,
                scheduledClass: {
                  select: {
                    classSection: { select: { label: true } },
                    subject: { select: { code: true } },
                  },
                },
              },
            },
          },
          orderBy: [{ attendanceSessionId: "asc" }, { id: "asc" }],
        });

        const rows = records.map((r) => ({
          studentEnrollmentId: r.student.enrollmentNo,
          studentName: r.student.name,
          sectionCode: r.attendanceSession.scheduledClass.classSection.label ?? "",
          subjectCode: r.attendanceSession.scheduledClass.subject.code,
          sessionDate: r.attendanceSession.date.toISOString(),
          sessionStatus: r.attendanceSession.status,
          attendanceStatus: r.status,
          markedAt: r.markedAt.toISOString(),
        }));

        await recordAuditEvent(
          {
            action: "attendance.exported",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "AttendanceExport",
            metadata: { sectionId, academicTermId, format, rowCount: rows.length },
          },
          tx,
        );
        return { rows };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "section not found" });

      if (format === "json") {
        return reply.send({ rows: outcome.rows });
      }
      // CSV
      const columns = [
        "studentEnrollmentId",
        "studentName",
        "sectionCode",
        "subjectCode",
        "sessionDate",
        "sessionStatus",
        "attendanceStatus",
        "markedAt",
      ];
      const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
      const lines = [columns.join(",")];
      for (const row of outcome.rows) {
        lines.push(columns.map((c) => esc((row as Record<string, string>)[c])).join(","));
      }
      reply.header("content-type", "text/csv; charset=utf-8");
      return reply.send(lines.join("\n"));
    },
  );
}
