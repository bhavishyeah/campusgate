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

  // exams.* — Phase 8 Examinations & Results (slice 8.1): exam lifecycle,
  // schedules + capacity-aware room allocation, candidates, weighted assessment
  // components, faculty-scoped marks entry with audited corrections, moderation/
  // approval, a deterministic grading engine, and controlled append-only
  // versioned result publication (step-up-gated). Gated module
  // (requireModuleActive("examinations")) in addition to permission. The module
  // registry key is `examinations`; the permission/audit KEY prefix is `exams.*`.
  // Separation of duties (design §12): ADMIN never gets exams.marks.enter;
  // ADMIN never gets the STUDENT-only exams.results.view_own.
  {
    key: "exams.manage",
    module: "examinations",
    description: "Create/update examinations, schedules, assessments; status advance to APPROVED",
  },
  {
    key: "exams.grading.manage",
    module: "examinations",
    description: "Create/update grading schemes + bands",
  },
  {
    key: "exams.candidates.manage",
    module: "examinations",
    description: "Register candidates; allocate rooms",
  },
  {
    key: "exams.marks.enter",
    module: "examinations",
    description: "Enter/edit own in-scope marks (scope enforced in service)",
  },
  {
    key: "exams.moderate",
    module: "examinations",
    description: "Lock marks, run moderation corrections, approve",
  },
  {
    key: "exams.results.publish",
    module: "examinations",
    description: "Publish results (step-up-gated)",
  },
  {
    key: "exams.results.view",
    module: "examinations",
    description: "Staff read of unpublished + published results/reports",
  },
  {
    key: "exams.results.view_own",
    module: "examinations",
    description: "Student read of OWN latest PUBLISHED result only",
  },
  // exams.* slice 8.2: re-evaluation. The STUDENT-only self-service request key
  // and the staff processing/re-mark key. Separation of duties: STUDENT never
  // gets exams.reeval.manage; staff never gets exams.reeval.request_own.
  {
    key: "exams.reeval.request_own",
    module: "examinations",
    description: "Student self-service re-evaluation request against OWN published result",
  },
  {
    key: "exams.reeval.manage",
    module: "examinations",
    description: "Staff re-evaluation processing (transition + re-mark on a PUBLISHED exam)",
  },

  // faculty.* — Phase 9.1 Faculty Management: academic qualifications, per-term
  // workload (+ policy), teaching history, and the consolidated directory read.
  // Gated module (requireModuleActive("faculty_management")) in addition to
  // permission. The module registry key is `faculty_management`; the permission/
  // audit KEY prefix is `faculty.*` (the exams examinations->exams.* precedent).
  // Separation of duties (design §B.8): FACULTY never gets a .manage/.directory.view
  // staff key; staff roles never get the SELF-scope faculty.view_own.
  {
    key: "faculty.qualifications.manage",
    module: "faculty_management",
    description: "Create/update/delete + list faculty qualifications (staff)",
  },
  {
    key: "faculty.workload.manage",
    module: "faculty_management",
    description: "Create/update/recompute workload + manage workload policy (staff)",
  },
  {
    key: "faculty.teaching_history.manage",
    module: "faculty_management",
    description: "Reconcile/append + read teaching history (staff)",
  },
  {
    key: "faculty.directory.view",
    module: "faculty_management",
    description: "Read any faculty member's consolidated academic profile (staff)",
  },
  {
    key: "faculty.view_own",
    module: "faculty_management",
    description: "Faculty self-service read of OWN profile/workload/history/qualifications",
  },

  // hr.* — Phase 9.2 HR Management: employees, contracts, leave (policies +
  // applications + balance engine), employee attendance + shifts, reports. Gated
  // module (requireModuleActive("hr_management")) in addition to permission. The
  // module registry key is `hr_management`; the permission/audit KEY prefix is
  // `hr.*` (the exams examinations->exams.* / faculty faculty_management->faculty.*
  // precedent). Separation of duties (design §B.9): STUDENT/FACULTY never get an
  // hr.* key; the self-scope hr.view_own binds to the NEW additive EMPLOYEE role
  // ONLY; staff roles (ADMIN, HR_MANAGER) never get hr.view_own.
  {
    key: "hr.employees.manage",
    module: "hr_management",
    description: "Create/update employee records (staff)",
  },
  {
    key: "hr.contracts.manage",
    module: "hr_management",
    description: "Create/supersede/end employment contracts (staff)",
  },
  {
    key: "hr.leave.manage",
    module: "hr_management",
    description: "Manage leave policies + approve/reject leave applications (staff)",
  },
  {
    key: "hr.attendance.manage",
    module: "hr_management",
    description: "Manage shifts + record/correct employee attendance (staff)",
  },
  {
    key: "hr.reports.view",
    module: "hr_management",
    description: "Read + export (XLSX) leave/attendance reports (staff)",
  },
  {
    key: "hr.directory.view",
    module: "hr_management",
    description: "Read any employee's records, contracts, leave, attendance, config (staff)",
  },
  {
    key: "hr.view_own",
    module: "hr_management",
    description: "Employee self-service read of OWN employment/contracts/leave/attendance; self-apply/cancel leave",
  },

  // hostel.* — Phase 9.3 Hostel Management: buildings, rooms, capacity-safe
  // allocation + transfer, immutable check-in/out, forward-only hostel leave,
  // per-room maintenance, and computed occupancy. Gated module
  // (requireModuleActive("hostel")) in addition to permission. The module
  // registry key and the permission/audit KEY prefix are both `hostel`.
  // Separation of duties (design §B.8): STUDENT never gets a staff key; no staff
  // role gets the SELF-scope hostel.view_own.
  {
    key: "hostel.buildings.manage",
    module: "hostel",
    description: "Create/update buildings + rooms; reduce capacity (guarded)",
  },
  {
    key: "hostel.allocations.manage",
    module: "hostel",
    description: "Allocate, transfer, vacate; record check-in/out",
  },
  {
    key: "hostel.leave.manage",
    module: "hostel",
    description: "Warden/admin approve/reject hostel leave",
  },
  {
    key: "hostel.maintenance.manage",
    module: "hostel",
    description: "Create/advance/resolve maintenance requests",
  },
  {
    key: "hostel.view",
    module: "hostel",
    description: "Staff read of buildings/rooms/allocations/occupancy/leave/maintenance + reports/export",
  },
  {
    key: "hostel.view_own",
    module: "hostel",
    description: "Student self-service: own allocation + room occupancy + apply/list/cancel own leave",
  },

  // transport.* — Phase 9.4 Transport Management: vehicles, drivers, routes +
  // stops, route assignments, capacity-safe student enrollment, vehicle
  // maintenance, and schedules. Gated module (requireModuleActive("transport"))
  // in addition to permission. The module registry key and the permission/audit
  // KEY prefix are both `transport`. Separation of duties (design §D.1): STUDENT
  // never gets a staff key; no staff role gets the SELF-scope transport.view_own.
  {
    key: "transport.vehicles.manage",
    module: "transport",
    description: "Create/update vehicles (staff)",
  },
  {
    key: "transport.drivers.manage",
    module: "transport",
    description: "Create/update drivers (staff)",
  },
  {
    key: "transport.routes.manage",
    module: "transport",
    description: "Create/update routes + stops (staff)",
  },
  {
    key: "transport.assignments.manage",
    module: "transport",
    description: "Assign/end vehicle+driver to a route (staff)",
  },
  {
    key: "transport.enrollments.manage",
    module: "transport",
    description: "Enroll/suspend/end a student on a route (staff)",
  },
  {
    key: "transport.maintenance.manage",
    module: "transport",
    description: "Create/advance/resolve vehicle maintenance requests (staff)",
  },
  {
    key: "transport.view",
    module: "transport",
    description: "Staff read of vehicles/drivers/routes/stops/assignments/enrollments/maintenance/schedules + reports/export",
  },
  {
    key: "transport.view_own",
    module: "transport",
    description: "Student self-service read of OWN transport enrollment + route/stop/schedule",
  },

  // inventory.* — Phase 9.5 Inventory & Assets Management: asset categories,
  // asset registry (forward-only + terminal lifecycle), custody transfers,
  // consumable stock (concurrency-safe on-hand + movement ledger), maintenance,
  // disposal, stock-take audits, reports/export, and custodian self-service.
  // Gated module (requireModuleActive("inventory")) in addition to permission.
  // The module registry key and the permission/audit KEY prefix are both
  // `inventory`. Separation of duties (design §B.9): STUDENT never gets any
  // inventory key; inventory.view_own binds ONLY to INVENTORY_MANAGER (a
  // DELIBERATE deviation — inventory has no non-staff self role, so /me/assets
  // self-scopes by custodyUserId == token.userId and must be reachable by a
  // seeded role; ADMIN is excluded, matching the module-era precedent that ADMIN
  // holds no module-gated *.view_own key).
  {
    key: "inventory.categories.manage",
    module: "inventory",
    description: "Create/update asset categories (staff)",
  },
  {
    key: "inventory.assets.manage",
    module: "inventory",
    description: "Create/update assets + custody transfer/assign (staff)",
  },
  {
    key: "inventory.stock.manage",
    module: "inventory",
    description: "Record stock receipts/issues/adjustments (staff)",
  },
  {
    key: "inventory.maintenance.manage",
    module: "inventory",
    description: "Open/advance/resolve asset maintenance requests (staff)",
  },
  {
    key: "inventory.disposals.manage",
    module: "inventory",
    description: "Dispose/retire assets (staff)",
  },
  {
    key: "inventory.audits.manage",
    module: "inventory",
    description: "Create stock-take audit sessions + append audit lines (staff)",
  },
  {
    key: "inventory.view",
    module: "inventory",
    description: "Staff read of categories/assets/stock/maintenance/disposals/audits + reports/export",
  },
  {
    key: "inventory.view_own",
    module: "inventory",
    description: "Custodian self-service read of assets currently in OWN custody",
  },

  // service_requests.* — Phase 9.6 Service Requests Management: predefined
  // request types + data-driven form field definitions, a FIXED enumerated
  // request lifecycle (not a generic workflow engine), assignment, an approval
  // gate, derived SLA, an append-only comments/activity ledger, one-per-request
  // feedback, and staff reports/export, plus the requester self-service surface.
  // Gated module (requireModuleActive("service_requests")) in addition to
  // permission. The module registry key and the permission/audit KEY prefix are
  // both `service_requests`. Separation of duties (design §7): STUDENT holds ONLY
  // the self key service_requests.request_own; staff roles (ADMIN, SERVICE_AGENT)
  // never get the self key and STUDENT never gets a staff key.
  {
    key: "service_requests.types.manage",
    module: "service_requests",
    description: "Create/update request types + field definitions + SLA config (staff)",
  },
  {
    key: "service_requests.assign.manage",
    module: "service_requests",
    description: "Assign/reassign a request to an agent (staff)",
  },
  {
    key: "service_requests.requests.handle",
    module: "service_requests",
    description: "Drive lifecycle (IN_PROGRESS/PENDING_APPROVAL/RESOLVED), resolve, comment, close/cancel any (staff)",
  },
  {
    key: "service_requests.requests.approve",
    module: "service_requests",
    description: "Approve/reject a PENDING_APPROVAL request (staff)",
  },
  {
    key: "service_requests.view",
    module: "service_requests",
    description: "Staff read of all requests/types/activity/feedback + reports/export",
  },
  {
    key: "service_requests.request_own",
    module: "service_requests",
    description: "Self-service: raise, list/view OWN, comment OWN, cancel OWN OPEN, close/feedback OWN",
  },

  // documents.* — Phase 9.7 Document Management: document metadata + object-
  // storage blobs behind the ObjectStore adapter seam, an append-only version
  // chain, not-public-by-default access grants (user OR department, READ|MANAGE),
  // short-lived signed-URL downloads, an append-only access ledger, a
  // retention policy + forward-only purge lifecycle, and staff reports/export.
  // Gated module (requireModuleActive("documents")) in addition to permission.
  // The module registry key and the permission/audit KEY prefix are both
  // `documents`. ACCESS MODEL: a document is NOT visible unless the requester is
  // OWNER, holds an active GRANT, or is ADMIN/DOCUMENT_MANAGER — the record-level
  // canAccessDocument check is the SOLE real visibility gate. `documents.download`
  // is a GENUINE baseline-reachability key held by EVERY non-applicant tenant
  // role so ANY same-tenant user- or department-grantee reaches that check; it
  // carries NO record-level authority (a holder with no grant still gets 404).
  // Separation of duties: the two owner self keys (upload_own, view_own) bind
  // ONLY to FACULTY (the document-owning role), never to ADMIN/DOCUMENT_MANAGER.
  {
    key: "documents.upload_own",
    module: "documents",
    description: "Upload a new document + a new version of OWN docs (owner self)",
  },
  {
    key: "documents.view_own",
    module: "documents",
    description: "List/view/download OWN docs + manage grants on OWN docs (owner self)",
  },
  {
    key: "documents.download",
    module: "documents",
    description: "Baseline-reachability key (every non-applicant tenant role); the TRUE gate is the record-level canAccessDocument active-grant/owner/admin check",
  },
  {
    key: "documents.grants.manage",
    module: "documents",
    description: "Grant/revoke access on a doc the caller owns, MANAGE-holds, or admins",
  },
  {
    key: "documents.admin.view_all",
    module: "documents",
    description: "See ALL tenant documents + versions; run the aggregate report (inventory + access-log summary + purge queue) + XLSX export",
  },
  {
    key: "documents.retention.manage",
    module: "documents",
    description: "Manage retention policies; archive/unarchive/purge-request/purge any doc",
  },
  {
    key: "documents.audit.view",
    module: "documents",
    description: "Read the per-document access-log DETAIL ledger (GET /:id/access-log)",
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
    "exams.results.view_own",
    "exams.reeval.request_own",
    "hostel.view_own",
    "transport.view_own",
    "service_requests.request_own",
    "documents.download",
  ],
  FACULTY: [
    "classes.view_own",
    "attendance.mark",
    "attendance.view_own",
    "exams.marks.enter",
    "faculty.view_own",
    // Phase 9.7: FACULTY is the document-owning role (owner self keys) + the
    // baseline download + delegated grant administration.
    "documents.upload_own",
    "documents.view_own",
    "documents.download",
    "documents.grants.manage",
  ],
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
    "documents.download",
  ],
  LIBRARIAN: [
    "library.books.view",
    "library.books.manage",
    "library.issue",
    "library.return",
    "library.reservations.manage",
    "library.fines.manage",
    "documents.download",
  ],
  // WARDEN — additive platform template role (ACCOUNTANT/LIBRARIAN/
  // ADMISSION_OFFICER precedent); hostel-scoped ONLY. A warden runs the hostel
  // end to end within tenant (buildings/rooms, allocation, leave, maintenance,
  // read) without inheriting institution-wide admin rights. Separation of duties:
  // WARDEN never gets the STUDENT-only hostel.view_own.
  WARDEN: [
    "hostel.buildings.manage",
    "hostel.allocations.manage",
    "hostel.leave.manage",
    "hostel.maintenance.manage",
    "hostel.view",
    "documents.download",
  ],
  ADMISSION_OFFICER: [
    "admissions.campaigns.manage",
    "admissions.applications.view",
    "admissions.applications.manage",
    "admissions.applications.review",
    "admissions.offers.manage",
    "admissions.enroll",
    "documents.download",
  ],
  // APPLICANT is the external admissions applicant — NOT an internal tenant
  // member who would receive an internal document grant, so it is the ONLY role
  // excluded from the baseline documents.download key (keeps the SIS/admissions
  // decoupling intact).
  APPLICANT: ["admissions.view_own"],
  // HR_MANAGER — additive platform template role (ACCOUNTANT/LIBRARIAN/
  // ADMISSION_OFFICER precedent); the six HR staff keys ONLY (full-tenant HR
  // visibility + management). Does NOT hold the self-scope hr.view_own.
  HR_MANAGER: [
    "hr.employees.manage",
    "hr.contracts.manage",
    "hr.leave.manage",
    "hr.attendance.manage",
    "hr.reports.view",
    "hr.directory.view",
    "documents.download",
  ],
  // EMPLOYEE — additive platform template role (design §3.3): the HR self-service
  // role bound to a user when their hr_employees row is created. Holds ONLY the
  // self-scope hr.view_own; never a staff .manage/.directory.view/.reports key.
  EMPLOYEE: ["hr.view_own", "documents.download"],
  // TRANSPORT_MANAGER — additive platform template role (WARDEN/HR_MANAGER
  // precedent); transport-scoped ONLY. A transport manager runs transport end to
  // end within tenant (vehicles/drivers/routes, assignments, enrollment,
  // maintenance, read) without inheriting institution-wide admin rights.
  // Separation of duties: TRANSPORT_MANAGER never gets the STUDENT-only
  // transport.view_own.
  TRANSPORT_MANAGER: [
    "transport.vehicles.manage",
    "transport.drivers.manage",
    "transport.routes.manage",
    "transport.assignments.manage",
    "transport.enrollments.manage",
    "transport.maintenance.manage",
    "transport.view",
    "documents.download",
  ],
  // INVENTORY_MANAGER — additive platform template role (WARDEN/HR_MANAGER/
  // TRANSPORT_MANAGER precedent); inventory-scoped ONLY. An inventory manager
  // runs inventory end to end within a tenant (categories, assets, custody,
  // stock, maintenance, disposal, audits, reports) without inheriting
  // institution-wide admin rights. DELIBERATE DEVIATION (design §B.9/NIT-B):
  // unlike every other module where *.view_own binds to a NON-staff self role,
  // inventory.view_own binds to this staff manager role because inventory has no
  // non-staff self role — custodians are staff users and /me/assets self-scopes
  // by custodyUserId == token.userId, read-only. Kept on purpose.
  INVENTORY_MANAGER: [
    "inventory.categories.manage",
    "inventory.assets.manage",
    "inventory.stock.manage",
    "inventory.maintenance.manage",
    "inventory.disposals.manage",
    "inventory.audits.manage",
    "inventory.view",
    "inventory.view_own",
    "documents.download",
  ],
  // SERVICE_AGENT — additive platform template role (WARDEN/HR_MANAGER/
  // TRANSPORT_MANAGER/INVENTORY_MANAGER precedent); service-requests-scoped ONLY.
  // A service agent runs service requests end to end within a tenant (configure
  // types/fields/SLA, assign, handle, approve/reject, resolve, read + export)
  // without inheriting institution-wide admin rights. Separation of duties
  // (design §7): SERVICE_AGENT never gets the STUDENT-only
  // service_requests.request_own self key.
  SERVICE_AGENT: [
    "service_requests.types.manage",
    "service_requests.assign.manage",
    "service_requests.requests.handle",
    "service_requests.requests.approve",
    "service_requests.view",
    "documents.download",
  ],
  // DOCUMENT_MANAGER — additive platform template role (SERVICE_AGENT/
  // INVENTORY_MANAGER/WARDEN precedent); documents-scoped ONLY. A document
  // manager administers documents end to end within a tenant (see all docs,
  // administer any grant, manage retention/purge, read the access ledger)
  // without inheriting institution-wide admin rights, PLUS the baseline
  // documents.download (it is a tenant role and may itself be a grantee).
  // Separation of duties: DOCUMENT_MANAGER never gets the two owner self keys
  // (upload_own, view_own) — grants.manage + admin.view_all already cover
  // administering any grant and seeing all docs.
  DOCUMENT_MANAGER: [
    "documents.download",
    "documents.grants.manage",
    "documents.admin.view_all",
    "documents.retention.manage",
    "documents.audit.view",
  ],
  GUARD: [
    "campus_movement.gate.verify",
    "campus_movement.gate.mark_exit",
    "campus_movement.gate.mark_return",
    "campus_movement.gate.lookup",
    "campus_movement.shift.manage_own",
    "campus_movement.emergency.view",
    "academics.view",
    "documents.download",
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
    "exams.manage",
    "exams.grading.manage",
    "exams.candidates.manage",
    "exams.moderate",
    "exams.results.publish",
    "exams.results.view",
    "exams.reeval.manage",
    "faculty.qualifications.manage",
    "faculty.workload.manage",
    "faculty.teaching_history.manage",
    "faculty.directory.view",
    "documents.download",
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
    "exams.manage",
    "exams.grading.manage",
    "exams.candidates.manage",
    "exams.moderate",
    "exams.results.publish",
    "exams.results.view",
    "exams.reeval.manage",
    "faculty.qualifications.manage",
    "faculty.workload.manage",
    "faculty.teaching_history.manage",
    "faculty.directory.view",
    "hr.employees.manage",
    "hr.contracts.manage",
    "hr.leave.manage",
    "hr.attendance.manage",
    "hr.reports.view",
    "hr.directory.view",
    "hostel.buildings.manage",
    "hostel.allocations.manage",
    "hostel.leave.manage",
    "hostel.maintenance.manage",
    "hostel.view",
    "transport.vehicles.manage",
    "transport.drivers.manage",
    "transport.routes.manage",
    "transport.assignments.manage",
    "transport.enrollments.manage",
    "transport.maintenance.manage",
    "transport.view",
    "inventory.categories.manage",
    "inventory.assets.manage",
    "inventory.stock.manage",
    "inventory.maintenance.manage",
    "inventory.disposals.manage",
    "inventory.audits.manage",
    "inventory.view",
    "service_requests.types.manage",
    "service_requests.assign.manage",
    "service_requests.requests.handle",
    "service_requests.requests.approve",
    "service_requests.view",
    "documents.download",
    "documents.grants.manage",
    "documents.admin.view_all",
    "documents.retention.manage",
    "documents.audit.view",
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
