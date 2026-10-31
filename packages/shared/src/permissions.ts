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

  // classes.* — Phase 3 Class & Course Management: courses/subjects, sections,
  // enrollment, faculty, timetables. Foundational institution-layer data,
  // permission-gated ONLY (never module-gated).
  {
    key: "classes.courses.manage",
    module: "classes",
    description: "Create/update courses and subjects",
  },
  {
    key: "classes.sections.manage",
    module: "classes",
    description: "Create/update class sections",
  },
  {
    key: "classes.enroll",
    module: "classes",
    description: "Enroll / drop students in a section",
  },
  {
    key: "classes.faculty.assign",
    module: "classes",
    description: "Create faculty profiles and assign/substitute faculty",
  },
  {
    key: "classes.timetable.manage",
    module: "classes",
    description: "Create/edit/publish timetables and scheduled classes",
  },
  {
    key: "classes.view",
    module: "classes",
    description: "View courses/subjects/sections/timetables (staff read)",
  },
  {
    key: "classes.view_own",
    module: "classes",
    description: "Faculty/Student view own schedule only",
  },

  // attendance.* — Phase 4 Attendance: sessions, records, corrections, reports.
  // Gated module (requireModuleActive("attendance")) in addition to permission.
  {
    key: "attendance.view",
    module: "attendance",
    description: "Staff read of sessions/records/reports (HOD dept-scoped, ADMIN whole-tenant)",
  },
  {
    key: "attendance.mark",
    module: "attendance",
    description: "Faculty opens a session, marks records, submits, finalizes — assigned classes only (record-level scope)",
  },
  {
    key: "attendance.correct",
    module: "attendance",
    description: "Review (approve/reject) a correction request",
  },
  {
    key: "attendance.export",
    module: "attendance",
    description: "Export attendance (authorized and audited)",
  },
  {
    key: "attendance.view_own",
    module: "attendance",
    description: "Student reads only their own attendance",
  },

  // library.* — Phase 5 Library: catalogue, copies, circulation, reservations,
  // fines. Gated module (requireModuleActive("library")) in addition to permission.
  {
    key: "library.books.view",
    module: "library",
    description: "Staff read of catalogue, copies, loans, reservations, reports",
  },
  {
    key: "library.books.manage",
    module: "library",
    description: "Create/edit BookTitle + register/edit BookCopy (acquisition, condition, withdraw)",
  },
  {
    key: "library.issue",
    module: "library",
    description: "Issue a copy to a student (concurrency-safe)",
  },
  {
    key: "library.return",
    module: "library",
    description: "Return / renew a loan; mark lost/damaged",
  },
  {
    key: "library.reservations.manage",
    module: "library",
    description: "Fulfil / cancel / expire reservations on behalf of circulation",
  },
  {
    key: "library.fines.manage",
    module: "library",
    description: "Create (rule-driven) / waive / mark-paid a LibraryFine",
  },
  {
    key: "library.view_own",
    module: "library",
    description: "A student reads only their own loans/history/reservations/fines and searches the catalogue; requests/cancels their own reservations",
  },

  // admissions.* — Phase 6 Admissions: campaigns, applications, documents,
  // reviews, offers, enrollment. Gated module (requireModuleActive("admissions"))
  // in addition to permission.
  {
    key: "admissions.campaigns.manage",
    module: "admissions",
    description: "Create/update/open/close campaigns + manage offered programs + config",
  },
  {
    key: "admissions.applications.view",
    module: "admissions",
    description: "Staff read of applications/documents/reviews/offers",
  },
  {
    key: "admissions.applications.manage",
    module: "admissions",
    description: "Create/advance applications on behalf; verify documents; request documents; shortlist; reject",
  },
  {
    key: "admissions.applications.review",
    module: "admissions",
    description: "Record an (append-only) ApplicationReview decision",
  },
  {
    key: "admissions.offers.manage",
    module: "admissions",
    description: "Issue/expire offers (officer side)",
  },
  {
    key: "admissions.enroll",
    module: "admissions",
    description: "Enroll an ACCEPTED application (create-or-link StudentProfile)",
  },
  {
    key: "admissions.view_own",
    module: "admissions",
    description: "Applicant reads only their own applications/documents/offers; submits/withdraws own; accepts/declines own offer",
  },

  // fees.* — Phase 7 Fees & Payments (slice 1): structures, charges, the
  // Razorpay payment flow, receipts, reconciliation. Gated module
  // (requireModuleActive("fees")) in addition to permission (the webhook is
  // signature-gated, not module/permission-gated). fees.refund / fees.adjust are
  // forward-declared for slice 7.1 (step-up-gated) and bound to NO role yet
  // (design §D.12) — catalogue-sync asserts permission-key and role-pair
  // set-equality independently, so an unbound key is legal.
  {
    key: "fees.structures.manage",
    module: "fees",
    description: "Create/update fee structures + components",
  },
  {
    key: "fees.charges.manage",
    module: "fees",
    description: "Post charges (single + bulk)",
  },
  {
    key: "fees.view",
    module: "fees",
    description: "Staff read of structures, a student ledger, payments, receipts, reconciliation",
  },
  {
    key: "fees.collect",
    module: "fees",
    description: "Trigger order creation on behalf / run reconciliation (collection ops)",
  },
  {
    key: "fees.view_own",
    module: "fees",
    description: "Student reads own charges/outstanding/receipts and initiates/verifies own payment",
  },
  {
    key: "fees.refund",
    module: "fees",
    description: "Approve a refund (step-up-gated; bound to ACCOUNTANT + ADMIN in slice 7.1)",
  },
  {
    key: "fees.adjust",
    module: "fees",
    description: "Approve a fee adjustment (step-up-gated; bound to ACCOUNTANT + ADMIN in slice 7.1)",
  },
  {
    key: "fees.concession.manage",
    module: "fees",
    description: "Create concession definitions + post concessions/scholarships",
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
    "classes.view_own",
    "attendance.view_own",
    "library.view_own",
    "fees.view_own",
  ],
  FACULTY: ["classes.view_own", "attendance.mark", "attendance.view_own"],
  // ACCOUNTANT — additive platform template role (FACULTY/LIBRARIAN/
  // ADMISSION_OFFICER precedent); fees-scoped ONLY (grants no exams/library/etc).
  ACCOUNTANT: [
    "fees.structures.manage",
    "fees.charges.manage",
    "fees.view",
    "fees.collect",
    "fees.concession.manage",
    "fees.refund",
    "fees.adjust",
  ],
  LIBRARIAN: [
    "library.books.view",
    "library.books.manage",
    "library.issue",
    "library.return",
    "library.reservations.manage",
    "library.fines.manage",
  ],
  ADMISSION_OFFICER: [
    "admissions.campaigns.manage",
    "admissions.applications.view",
    "admissions.applications.manage",
    "admissions.applications.review",
    "admissions.offers.manage",
    "admissions.enroll",
  ],
  APPLICANT: ["admissions.view_own"],
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
    "classes.courses.manage",
    "classes.sections.manage",
    "classes.enroll",
    "classes.faculty.assign",
    "classes.timetable.manage",
    "classes.view",
    "classes.view_own",
    "attendance.view",
    "attendance.correct",
    "attendance.export",
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
    "classes.courses.manage",
    "classes.sections.manage",
    "classes.enroll",
    "classes.faculty.assign",
    "classes.timetable.manage",
    "classes.view",
    "classes.view_own",
    "attendance.view",
    "attendance.correct",
    "attendance.export",
    "library.books.view",
    "library.books.manage",
    "library.issue",
    "library.return",
    "library.reservations.manage",
    "library.fines.manage",
    "admissions.campaigns.manage",
    "admissions.applications.view",
    "admissions.applications.manage",
    "admissions.applications.review",
    "admissions.offers.manage",
    "admissions.enroll",
    "fees.structures.manage",
    "fees.charges.manage",
    "fees.view",
    "fees.collect",
    "fees.concession.manage",
    "fees.refund",
    "fees.adjust",
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
