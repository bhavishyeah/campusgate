// Phase 0 permission catalogue — single source of truth shared by the API
// engine, the seed, the login resolver, and the catalogue-sync meta-test.
// Keys are derived from the real GatePass routes (design §4). Edit here and
// mirror into the identity_rbac_b2 migration (the meta-test asserts set-equality).

export interface PermissionDef {
  key: string;
  module: string;
  description: string;
}

export const PERMISSIONS = [
  // campus_movement.* — student + pass lifecycle + guard gate ops + emergency
  {
    key: "campus_movement.pass.request",
    module: "campus_movement",
    description: "Student creates a gate pass",
  },
  {
    key: "campus_movement.pass.cancel",
    module: "campus_movement",
    description: "Student cancels own pending pass",
  },
  {
    key: "campus_movement.pass.view_own",
    module: "campus_movement",
    description: "Student views own passes, history, timeline and summary",
  },
  {
    key: "campus_movement.pass.view_department",
    module: "campus_movement",
    description: "HOD views department requests, detail, timeline and stats",
  },
  {
    key: "campus_movement.pass.approve",
    module: "campus_movement",
    description: "HOD approves a gate pass",
  },
  {
    key: "campus_movement.pass.reject",
    module: "campus_movement",
    description: "HOD rejects a gate pass",
  },
  {
    key: "campus_movement.pass.revoke",
    module: "campus_movement",
    description: "HOD or Admin revokes a gate pass",
  },
  {
    key: "campus_movement.pass.override",
    module: "campus_movement",
    description: "Emergency override of a gate pass",
  },
  {
    key: "campus_movement.gate.verify",
    module: "campus_movement",
    description: "Guard verifies a pass QR code",
  },
  {
    key: "campus_movement.gate.mark_exit",
    module: "campus_movement",
    description: "Guard marks a student exit",
  },
  {
    key: "campus_movement.gate.mark_return",
    module: "campus_movement",
    description: "Guard marks a student return",
  },
  {
    key: "campus_movement.gate.lookup",
    module: "campus_movement",
    description: "Guard manual lookup and gate activity",
  },
  {
    key: "campus_movement.shift.manage_own",
    module: "campus_movement",
    description: "Guard starts, ends and views own shift",
  },
  {
    key: "campus_movement.emergency.view",
    module: "campus_movement",
    description: "View the active emergency",
  },
  {
    key: "campus_movement.emergency.declare",
    module: "campus_movement",
    description: "Admin declares an emergency",
  },
  {
    key: "campus_movement.emergency.resolve",
    module: "campus_movement",
    description: "Admin resolves an emergency",
  },
  {
    key: "campus_movement.analytics.view",
    module: "campus_movement",
    description: "Admin views dashboard stats and analytics",
  },
  {
    key: "campus_movement.audit.view",
    module: "campus_movement",
    description: "Admin reads audit logs",
  },

  // admin.* — institution administration (configuration + identity)
  {
    key: "admin.users.view",
    module: "admin",
    description: "View institution users",
  },
  {
    key: "admin.users.create",
    module: "admin",
    description: "Create institution users",
  },
  {
    key: "admin.users.approve",
    module: "admin",
    description: "Approve pending institution users",
  },
  {
    key: "admin.users.deactivate",
    module: "admin",
    description: "Deactivate institution users",
  },
  {
    key: "admin.users.reactivate",
    module: "admin",
    description: "Reactivate institution users",
  },
  {
    key: "admin.students.import",
    module: "admin",
    description: "Bulk import students",
  },
  {
    key: "admin.students.export",
    module: "admin",
    description: "Export students (authorized and audited)",
  },
  {
    key: "admin.departments.manage",
    module: "admin",
    description: "Manage institution departments",
  },
  {
    key: "admin.gates.manage",
    module: "admin",
    description: "Manage gates and gate health",
  },
  {
    key: "admin.shifts.manage",
    module: "admin",
    description: "Manage guard shift scheduling",
  },
  {
    key: "admin.reasons.manage",
    module: "admin",
    description: "Manage pass reasons",
  },
  {
    key: "admin.allowance_policy.manage",
    module: "admin",
    description: "Manage the allowance policy",
  },
  {
    key: "admin.institution_config.manage",
    module: "admin",
    description: "Manage institution configuration",
  },
  {
    key: "admin.academic_calendar.manage",
    module: "admin",
    description: "Manage the academic calendar",
  },
  {
    key: "admin.support.revoke",
    module: "admin",
    description: "Tenant admin revokes a break-glass support grant into their institution",
  },
  {
    key: "admin.modules.manage",
    module: "admin",
    description: "Activate / suspend / view the institution's modules",
  },

  // academics.* — Phase 1 academic sessions / terms / programs / calendar
  {
    key: "academics.sessions.manage",
    module: "academics",
    description: "Manage academic sessions and terms (create, update, activate, close)",
  },
  {
    key: "academics.programs.manage",
    module: "academics",
    description: "Manage academic programs",
  },
  {
    key: "academics.calendar.manage",
    module: "academics",
    description: "Manage academic calendar entries",
  },
  {
    key: "academics.view",
    module: "academics",
    description: "View academic sessions, terms, programs and calendar",
  },

  // students.* — Phase 2 SIS: the authoritative student record + lifecycle ops.
  // Foundational institution-layer data, permission-gated ONLY (never module-gated).
  {
    key: "students.view",
    module: "students",
    description: "View student records, detail and history (list/detail/history)",
  },
  {
    key: "students.create",
    module: "students",
    description: "Create a student",
  },
  {
    key: "students.update",
    module: "students",
    description: "Edit permitted fields; assign program; transfer; reactivate",
  },
  {
    key: "students.enroll",
    module: "students",
    description: "Enroll a student into a session/term",
  },
  {
    key: "students.promote",
    module: "students",
    description: "Promote a student (advance term/semester)",
  },
  {
    key: "students.deactivate",
    module: "students",
    description: "Archive a student via status (withdraw/suspend/graduate/leave)",
  },
  {
    key: "students.view_own",
    module: "students",
    description: "Student views only their own profile and academic info",
  },

  // platform.* — SUPER_ADMIN only; NOT tenant permissions
  {
    key: "platform.institutions.manage",
    module: "platform",
    description: "List, create and manage institution status",
  },
  {
    key: "platform.analytics.view",
    module: "platform",
    description: "View platform-wide aggregate analytics",
  },
  {
    key: "platform.onboarding",
    module: "platform",
    description: "Platform onboarding (enforcement arrives with its phase)",
  },
  {
    key: "platform.entitlements.manage",
    module: "platform",
    description: "Manage module entitlements (enforcement arrives with its phase)",
  },
  {
    key: "platform.subscriptions.manage",
    module: "platform",
    description: "Manage subscriptions (enforcement arrives with its phase)",
  },
  {
    key: "platform.support.grant",
    module: "platform",
    description: "Grant support access (enforcement arrives with its phase)",
  },
  {
    key: "platform.security.respond",
    module: "platform",
    description: "Respond to security events (enforcement arrives with its phase)",
  },
] as const satisfies readonly PermissionDef[];

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

// Template role → permission map (design §5). Keys are the five template role
// keys; values are the permission keys each role exercises. Single source of
// truth for the seed, the login resolver, and the catalogue-sync meta-test.
export const ROLE_PERMISSIONS: Record<string, readonly PermissionKey[]> = {
  STUDENT: [
    "campus_movement.pass.request",
    "campus_movement.pass.cancel",
    "campus_movement.pass.view_own",
    "campus_movement.emergency.view",
    "academics.view",
    "students.view_own",
  ],
  GUARD: [
    "campus_movement.gate.verify",
    "campus_movement.gate.mark_exit",
    "campus_movement.gate.mark_return",
    "campus_movement.gate.lookup",
    "campus_movement.shift.manage_own",
    "campus_movement.emergency.view",
    "academics.view",
  ],
  HOD: [
    "campus_movement.pass.view_department",
    "campus_movement.pass.approve",
    "campus_movement.pass.reject",
    "campus_movement.pass.revoke",
    "campus_movement.pass.override",
    "campus_movement.emergency.view",
    "academics.view",
    "students.view",
    "students.update",
    "students.enroll",
    "students.promote",
    "students.view_own",
  ],
  ADMIN: [
    "admin.users.view",
    "admin.users.create",
    "admin.users.approve",
    "admin.users.deactivate",
    "admin.users.reactivate",
    "admin.students.import",
    "admin.students.export",
    "admin.departments.manage",
    "admin.gates.manage",
    "admin.shifts.manage",
    "admin.reasons.manage",
    "admin.allowance_policy.manage",
    "admin.institution_config.manage",
    "admin.academic_calendar.manage",
    "admin.support.revoke",
    "admin.modules.manage",
    "academics.sessions.manage",
    "academics.programs.manage",
    "academics.calendar.manage",
    "academics.view",
    "students.view",
    "students.create",
    "students.update",
    "students.enroll",
    "students.promote",
    "students.deactivate",
    "students.view_own",
    "campus_movement.pass.revoke",
    "campus_movement.pass.override",
    "campus_movement.emergency.declare",
    "campus_movement.emergency.resolve",
    "campus_movement.emergency.view",
    "campus_movement.analytics.view",
    "campus_movement.audit.view",
  ],
  SUPER_ADMIN: [
    "platform.institutions.manage",
    "platform.analytics.view",
    "platform.onboarding",
    "platform.entitlements.manage",
    "platform.subscriptions.manage",
    "platform.support.grant",
    "platform.security.respond",
  ],
};
