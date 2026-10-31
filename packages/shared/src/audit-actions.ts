// Phase 0 audit-action catalogue — single source of truth for the generic
// `audit_events.action` string (design §4.1). Unlike the permission catalogue
// there is NO pg enum and NO seeded rows for audit actions, so this catalogue
// needs no migration mirror; validation lives in the single `recordAuditEvent`
// writer, which rejects any key not in AUDIT_ACTION_KEY_SET.
//
// Keys are "<module>.<action>" (lower snake segments). This file stays free of
// any @campusgate/db / @prisma/client dependency: the legacy `AuditAction` enum
// is mirrored here as the local LegacyAuditAction string-literal union so the
// enum→key map is exhaustively type-checked without pulling Prisma into shared.

export interface AuditActionDef {
  key: string; // "<module>.<action>"
  module: string; // "campus_movement" | "admin" | "platform" | ...
  description: string;
}

export const AUDIT_ACTIONS = [
  // campus_movement.* (14)
  { key: "campus_movement.pass.requested", module: "campus_movement", description: "Student requested a gate pass" },
  { key: "campus_movement.pass.approved", module: "campus_movement", description: "Pass approved" },
  { key: "campus_movement.pass.rejected", module: "campus_movement", description: "Pass rejected" },
  { key: "campus_movement.pass.cancelled", module: "campus_movement", description: "Pass cancelled by requester" },
  { key: "campus_movement.pass.revoked", module: "campus_movement", description: "Pass revoked by staff" },
  { key: "campus_movement.pass.expired", module: "campus_movement", description: "Pass auto-expired" },
  { key: "campus_movement.pass.override", module: "campus_movement", description: "Emergency/allowance override applied to a pass" },
  { key: "campus_movement.gate.exit", module: "campus_movement", description: "Gate exit scanned" },
  { key: "campus_movement.gate.return", module: "campus_movement", description: "Gate return scanned" },
  { key: "campus_movement.shift.created", module: "campus_movement", description: "Guard shift created" },
  { key: "campus_movement.shift.started", module: "campus_movement", description: "Guard shift started" },
  { key: "campus_movement.shift.ended", module: "campus_movement", description: "Guard shift ended" },
  { key: "campus_movement.emergency.declared", module: "campus_movement", description: "Emergency declared" },
  { key: "campus_movement.emergency.resolved", module: "campus_movement", description: "Emergency resolved" },
  // admin.* (14)
  { key: "admin.user.created", module: "admin", description: "Institution user created" },
  { key: "admin.user.updated", module: "admin", description: "Institution user updated" },
  { key: "admin.user.deactivated", module: "admin", description: "Institution user deactivated" },
  { key: "admin.user.reactivated", module: "admin", description: "Institution user reactivated" },
  { key: "admin.students.imported", module: "admin", description: "Bulk student import" },
  { key: "admin.gate.created", module: "admin", description: "Gate created" },
  { key: "admin.gate.updated", module: "admin", description: "Gate updated" },
  { key: "admin.department.created", module: "admin", description: "Department created" },
  { key: "admin.department.updated", module: "admin", description: "Department updated" },
  { key: "admin.reason.created", module: "admin", description: "Pass reason created" },
  { key: "admin.reason.updated", module: "admin", description: "Pass reason updated" },
  { key: "admin.allowance_policy.updated", module: "admin", description: "Allowance policy updated" },
  { key: "admin.institution_config.updated", module: "admin", description: "Institution config updated" },
  { key: "admin.academic_calendar.updated", module: "admin", description: "Academic calendar updated" },
  // platform.* (9)
  { key: "platform.institution.created", module: "platform", description: "Institution created (platform)" },
  { key: "platform.institution.status_changed", module: "platform", description: "Institution status changed" },
  { key: "platform.support_grant.created", module: "platform", description: "Support grant created" },
  { key: "platform.support_grant.activated", module: "platform", description: "Support grant activated" },
  { key: "platform.support_grant.accessed", module: "platform", description: "Tenant data accessed under a support grant" },
  { key: "platform.support_grant.revoked", module: "platform", description: "Support grant revoked" },
  { key: "platform.support_grant.expired", module: "platform", description: "Support grant expired" },
  { key: "platform.mfa.enrolled", module: "platform", description: "Platform MFA enrolled" },
  { key: "platform.mfa.step_up", module: "platform", description: "Platform MFA step-up assertion" },
  { key: "platform.module.entitled", module: "platform", description: "Platform granted a module entitlement to an institution" },
  { key: "platform.module.revoked", module: "platform", description: "Platform revoked a module entitlement" },
  // admin.module.* (2)
  { key: "admin.module.activated", module: "admin", description: "Institution activated a module" },
  { key: "admin.module.suspended", module: "admin", description: "Institution suspended a module" },
  // academics.* (11)
  { key: "academics.session.created", module: "academics", description: "Academic session created" },
  { key: "academics.session.updated", module: "academics", description: "Academic session updated" },
  { key: "academics.session.activated", module: "academics", description: "Academic session activated" },
  { key: "academics.session.closed", module: "academics", description: "Academic session closed" },
  { key: "academics.term.created", module: "academics", description: "Academic term created" },
  { key: "academics.term.updated", module: "academics", description: "Academic term updated" },
  { key: "academics.term.activated", module: "academics", description: "Academic term activated" },
  { key: "academics.term.closed", module: "academics", description: "Academic term closed" },
  { key: "academics.program.created", module: "academics", description: "Academic program created" },
  { key: "academics.program.updated", module: "academics", description: "Academic program updated" },
  { key: "academics.calendar.updated", module: "academics", description: "Academic calendar entry created, updated or deleted" },
  // students.* (8) — Phase 2 SIS student lifecycle
  { key: "students.student.created", module: "students", description: "Student record created" },
  { key: "students.student.updated", module: "students", description: "Student permitted profile fields updated" },
  { key: "students.student.program_assigned", module: "students", description: "Student assigned a structured program" },
  { key: "students.student.enrolled", module: "students", description: "Student enrolled into a session/term" },
  { key: "students.student.promoted", module: "students", description: "Student promoted (term/semester advanced)" },
  { key: "students.student.transferred", module: "students", description: "Student transferred (department/program changed)" },
  { key: "students.student.deactivated", module: "students", description: "Student archived via status change" },
  { key: "students.student.imported", module: "students", description: "Bulk student import (SIS model)" },
  // classes.* (18) — Phase 3 Class & Course Management mutations (past-tense)
  { key: "classes.course.created", module: "classes", description: "Course created" },
  { key: "classes.course.updated", module: "classes", description: "Course updated" },
  { key: "classes.subject.created", module: "classes", description: "Subject created" },
  { key: "classes.subject.updated", module: "classes", description: "Subject updated" },
  { key: "classes.section.created", module: "classes", description: "Class section created" },
  { key: "classes.section.updated", module: "classes", description: "Class section updated" },
  { key: "classes.enrollment.enrolled", module: "classes", description: "Student enrolled into a class section" },
  { key: "classes.enrollment.dropped", module: "classes", description: "Student dropped from a class section" },
  { key: "classes.faculty.profile_created", module: "classes", description: "Faculty profile created" },
  { key: "classes.faculty.assigned", module: "classes", description: "Faculty assigned to a subject/section" },
  { key: "classes.faculty.substituted", module: "classes", description: "Faculty substituted (reassignment, prior assignment ended)" },
  { key: "classes.faculty.unassigned", module: "classes", description: "Faculty assignment ended (unassigned)" },
  { key: "classes.timetable.created", module: "classes", description: "Timetable created" },
  { key: "classes.timetable.published", module: "classes", description: "Timetable published" },
  { key: "classes.timetable.archived", module: "classes", description: "Timetable archived" },
  { key: "classes.scheduled_class.added", module: "classes", description: "Scheduled class added to a timetable" },
  { key: "classes.scheduled_class.updated", module: "classes", description: "Scheduled class updated" },
  { key: "classes.scheduled_class.cancelled", module: "classes", description: "Scheduled class cancelled" },
  // attendance.* (9) — Phase 4 Attendance mutations (past-tense)
  { key: "attendance.session.opened", module: "attendance", description: "AttendanceSession created (OPEN)" },
  { key: "attendance.records.marked", module: "attendance", description: "Records marked/updated inside an OPEN/SUBMITTED session" },
  { key: "attendance.session.submitted", module: "attendance", description: "Session OPEN -> SUBMITTED" },
  { key: "attendance.session.finalized", module: "attendance", description: "Session SUBMITTED -> FINALIZED" },
  { key: "attendance.correction.requested", module: "attendance", description: "Correction row created (PENDING)" },
  { key: "attendance.correction.approved", module: "attendance", description: "Correction PENDING -> APPROVED (record rewritten, history row written)" },
  { key: "attendance.correction.rejected", module: "attendance", description: "Correction PENDING -> REJECTED" },
  { key: "attendance.exported", module: "attendance", description: "Attendance export performed" },
  { key: "attendance.low_attendance.alerted", module: "attendance", description: "Low-attendance alert emitted" },
  // library.* (18) — Phase 5 Library circulation mutations (past-tense)
  { key: "library.title.created", module: "library", description: "BookTitle created" },
  { key: "library.title.updated", module: "library", description: "BookTitle bibliographic fields updated" },
  { key: "library.copy.registered", module: "library", description: "BookCopy registered (acquisition)" },
  { key: "library.copy.updated", module: "library", description: "BookCopy shelf/condition updated" },
  { key: "library.copy.withdrawn", module: "library", description: "BookCopy withdrawn from circulation" },
  { key: "library.copy.marked_lost", module: "library", description: "BookCopy marked lost (loan closed)" },
  { key: "library.copy.marked_damaged", module: "library", description: "BookCopy marked damaged" },
  { key: "library.loan.issued", module: "library", description: "Loan issued (copy -> student)" },
  { key: "library.loan.returned", module: "library", description: "Loan returned (copy freed)" },
  { key: "library.loan.renewed", module: "library", description: "Loan renewed (due date extended)" },
  { key: "library.reservation.created", module: "library", description: "Reservation (hold) created on a title" },
  { key: "library.reservation.fulfilled", module: "library", description: "Reservation fulfilled (copy designated)" },
  { key: "library.reservation.cancelled", module: "library", description: "Reservation cancelled" },
  { key: "library.reservation.expired", module: "library", description: "Reservation expired (uncollected hold swept)" },
  { key: "library.fine.created", module: "library", description: "LibraryFine created (rule-driven)" },
  { key: "library.fine.waived", module: "library", description: "LibraryFine waived" },
  { key: "library.fine.paid", module: "library", description: "LibraryFine marked paid" },
  { key: "library.overdue.reminded", module: "library", description: "Overdue reminder emitted to a student" },
  // admissions.* (17) — Phase 6 Admissions mutations (past-tense)
  { key: "admissions.applicant.registered", module: "admissions", description: "Applicant self-registered (User + ACTIVE membership + APPLICANT role)" },
  { key: "admissions.campaign.created", module: "admissions", description: "Admission campaign created" },
  { key: "admissions.campaign.updated", module: "admissions", description: "Admission campaign updated" },
  { key: "admissions.campaign.opened", module: "admissions", description: "Admission campaign opened (DRAFT/CLOSED -> OPEN)" },
  { key: "admissions.campaign.closed", module: "admissions", description: "Admission campaign closed (OPEN -> CLOSED)" },
  { key: "admissions.application.submitted", module: "admissions", description: "Application submitted (DRAFT -> SUBMITTED)" },
  { key: "admissions.application.withdrawn", module: "admissions", description: "Application withdrawn by applicant" },
  { key: "admissions.application.status_changed", module: "admissions", description: "Application status advanced via the state machine" },
  { key: "admissions.application.rejected", module: "admissions", description: "Application rejected" },
  { key: "admissions.application.enrolled", module: "admissions", description: "Application enrolled (create-or-link StudentProfile)" },
  { key: "admissions.document.added", module: "admissions", description: "Application document added" },
  { key: "admissions.document.verified", module: "admissions", description: "Application document verified" },
  { key: "admissions.review.recorded", module: "admissions", description: "Append-only ApplicationReview decision recorded" },
  { key: "admissions.offer.issued", module: "admissions", description: "Admission offer issued" },
  { key: "admissions.offer.accepted", module: "admissions", description: "Admission offer accepted by applicant" },
  { key: "admissions.offer.declined", module: "admissions", description: "Admission offer declined by applicant" },
  { key: "admissions.offer.expired", module: "admissions", description: "Admission offer expired" },
  // fees.* (16) — Phase 7 Fees & Payments slice 1 mutations (past-tense). No
  // migration mirror (validated in recordAuditEvent). The webhook-level audits
  // that occur before/without a tenant tx (signature rejected, duplicate
  // ignored, module inactive) are written via privilegedPrisma (design §D.13).
  { key: "fees.structure.created", module: "fees", description: "Fee structure created" },
  { key: "fees.structure.updated", module: "fees", description: "Fee structure updated" },
  { key: "fees.component.added", module: "fees", description: "Fee component added to a structure" },
  { key: "fees.charge.posted", module: "fees", description: "Charge posted to a single student" },
  { key: "fees.charges.bulk_posted", module: "fees", description: "Charges bulk-posted by program/session" },
  { key: "fees.payment.order_created", module: "fees", description: "Razorpay order created (PaymentTransaction CREATED)" },
  { key: "fees.payment.signature_verified", module: "fees", description: "Checkout payment signature verified (CREATED -> AUTHORIZED)" },
  { key: "fees.payment.signature_rejected", module: "fees", description: "Checkout payment signature rejected (nothing authoritative written)" },
  { key: "fees.payment.captured", module: "fees", description: "Payment captured via webhook (authoritative)" },
  { key: "fees.payment.failed", module: "fees", description: "Payment marked FAILED (reconciliation)" },
  { key: "fees.payment.reconciled", module: "fees", description: "Stuck transaction reconciled against Razorpay" },
  { key: "fees.receipt.issued", module: "fees", description: "Receipt issued after server-verified capture" },
  { key: "fees.webhook.received", module: "fees", description: "Razorpay webhook received (signature-verified)" },
  { key: "fees.webhook.duplicate_ignored", module: "fees", description: "Duplicate webhook event id ignored (idempotent no-op)" },
  { key: "fees.webhook.signature_rejected", module: "fees", description: "Razorpay webhook HMAC rejected (nothing written)" },
  { key: "fees.webhook.skipped_module_inactive", module: "fees", description: "Webhook skipped: fees module not ACTIVE for the resolved tenant" },
  // fees.* (5) — Phase 7 Fees & Payments slice 7.1 money-OUT + corrections
  // mutations (past-tense). No migration mirror (validated in recordAuditEvent).
  // refund.created webhook acknowledgements reuse fees.webhook.received (NIT-2).
  { key: "fees.concession.posted", module: "fees", description: "Concession/scholarship posted as credit allocations against charges" },
  { key: "fees.refund.requested", module: "fees", description: "Refund requested (Refund row REQUESTED) under step-up" },
  { key: "fees.refund.processed", module: "fees", description: "Refund settled PROCESSED (reversing credits inserted, status recomputed)" },
  { key: "fees.refund.failed", module: "fees", description: "Refund settled FAILED (no reversals; reservation released)" },
  { key: "fees.adjustment.posted", module: "fees", description: "Adjustment posted (waiver/write-off/correction credit or debit)" },
] as const satisfies readonly AuditActionDef[];

export type AuditActionKey = (typeof AUDIT_ACTIONS)[number]["key"];
export const AUDIT_ACTION_KEYS: readonly AuditActionKey[] = AUDIT_ACTIONS.map((a) => a.key);
export const AUDIT_ACTION_KEY_SET: ReadonlySet<string> = new Set<string>(AUDIT_ACTION_KEYS);

/**
 * The live `AuditAction` Prisma enum (28 values, verified in schema.prisma)
 * mirrored as a string-literal union so LEGACY_AUDIT_ACTION_MAP is exhaustively
 * type-checked WITHOUT importing @prisma/client into @campusgate/shared.
 */
export type LegacyAuditAction =
  | "PASS_REQUESTED"
  | "PASS_APPROVED"
  | "PASS_REJECTED"
  | "PASS_CANCELLED"
  | "PASS_REVOKED"
  | "PASS_EXPIRED"
  | "GATE_EXIT"
  | "GATE_RETURN"
  | "SHIFT_CREATED"
  | "SHIFT_STARTED"
  | "SHIFT_ENDED"
  | "EMERGENCY_DECLARED"
  | "EMERGENCY_RESOLVED"
  | "EMERGENCY_OVERRIDE"
  | "USER_CREATED"
  | "USER_UPDATED"
  | "USER_DEACTIVATED"
  | "USER_REACTIVATED"
  | "GATE_CREATED"
  | "GATE_UPDATED"
  | "DEPARTMENT_CREATED"
  | "DEPARTMENT_UPDATED"
  | "REASON_CREATED"
  | "REASON_UPDATED"
  | "BULK_IMPORT"
  | "ALLOWANCE_POLICY_UPDATED"
  | "INSTITUTION_CONFIG_UPDATED"
  | "ACADEMIC_CALENDAR_UPDATED";

/**
 * Full legacy enum → new catalogue-key mapping (design §4.4). Every one of the
 * 28 `AuditAction` enum values maps to exactly one AuditActionKey. Note the two
 * previously-ambiguous cases, now pinned:
 *   - EMERGENCY_OVERRIDE → campus_movement.pass.override
 *   - SHIFT_*            → campus_movement.shift.*
 */
export const LEGACY_AUDIT_ACTION_MAP: Record<LegacyAuditAction, AuditActionKey> = {
  PASS_REQUESTED: "campus_movement.pass.requested",
  PASS_APPROVED: "campus_movement.pass.approved",
  PASS_REJECTED: "campus_movement.pass.rejected",
  PASS_CANCELLED: "campus_movement.pass.cancelled",
  PASS_REVOKED: "campus_movement.pass.revoked",
  PASS_EXPIRED: "campus_movement.pass.expired",
  GATE_EXIT: "campus_movement.gate.exit",
  GATE_RETURN: "campus_movement.gate.return",
  SHIFT_CREATED: "campus_movement.shift.created",
  SHIFT_STARTED: "campus_movement.shift.started",
  SHIFT_ENDED: "campus_movement.shift.ended",
  EMERGENCY_DECLARED: "campus_movement.emergency.declared",
  EMERGENCY_RESOLVED: "campus_movement.emergency.resolved",
  EMERGENCY_OVERRIDE: "campus_movement.pass.override",
  USER_CREATED: "admin.user.created",
  USER_UPDATED: "admin.user.updated",
  USER_DEACTIVATED: "admin.user.deactivated",
  USER_REACTIVATED: "admin.user.reactivated",
  BULK_IMPORT: "admin.students.imported",
  GATE_CREATED: "admin.gate.created",
  GATE_UPDATED: "admin.gate.updated",
  DEPARTMENT_CREATED: "admin.department.created",
  DEPARTMENT_UPDATED: "admin.department.updated",
  REASON_CREATED: "admin.reason.created",
  REASON_UPDATED: "admin.reason.updated",
  ALLOWANCE_POLICY_UPDATED: "admin.allowance_policy.updated",
  INSTITUTION_CONFIG_UPDATED: "admin.institution_config.updated",
  ACADEMIC_CALENDAR_UPDATED: "admin.academic_calendar.updated",
};
