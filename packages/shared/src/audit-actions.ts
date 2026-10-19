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
