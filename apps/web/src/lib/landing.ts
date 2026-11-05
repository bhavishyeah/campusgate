/**
 * Permission/role-derived default landing route. ORDER IS LOAD-BEARING:
 * SUPER_ADMIN first, then legacy GatePass roles BEFORE any permission-driven
 * landing — because ROLE_PERMISSIONS.STUDENT holds fees.view_own and ADMIN holds
 * the fees staff set, so a permission-first order would hijack GatePass users
 * off their Phase-0 home.
 */
export function landingRoute(roles: string[], permissions: string[]): string {
  // 1. Platform super-admin.
  if (roles.includes("SUPER_ADMIN")) return "/platform";

  // 2. Legacy GatePass roles keep their EXISTING homes (resolved FIRST).
  if (roles.includes("STUDENT")) return "/student";
  if (roles.includes("HOD")) return "/hod";
  if (roles.includes("GUARD")) return "/guard";
  if (roles.includes("ADMIN")) return "/admin";

  // 3. New permission-driven module landings (ACCOUNTANT, future roles).
  const STAFF_FEES = [
    "fees.view",
    "fees.charges.manage",
    "fees.structures.manage",
    "fees.collect",
  ];
  if (STAFF_FEES.some((p) => permissions.includes(p))) return "/fees";
  if (permissions.includes("fees.view_own")) return "/fees/me";

  // 3b. Library / Admissions landings (LIBRARIAN, ADMISSION_OFFICER, APPLICANT).
  // Evaluated AFTER the fees checks so fees users are unchanged. `roles` are the
  // membership role keys, so the seeded applicant (legacy User.role=STUDENT but
  // membership role APPLICANT) has roles=["APPLICANT"] and never hits /student.
  // Each key is the guard key of its target page.
  if (permissions.includes("library.books.view")) return "/library";
  if (permissions.includes("admissions.applications.view")) return "/admissions";
  if (permissions.includes("admissions.view_own")) return "/admissions/my";
  if (permissions.includes("library.view_own")) return "/library/my";
  // 3c. Faculty Management / HR landings (HR_MANAGER, EMPLOYEE, FACULTY). Appended AFTER 3b.
  if (permissions.includes("hr.directory.view")) return "/hr";
  if (permissions.includes("hr.view_own")) return "/hr/me";
  if (permissions.includes("faculty.directory.view")) return "/faculty-mgmt";
  if (permissions.includes("faculty.view_own")) return "/faculty-mgmt/me";
  // 3d. Hostel / Transport landings (WARDEN, TRANSPORT_MANAGER, custom roles). Appended AFTER 3c.
  if (permissions.includes("hostel.view")) return "/hostel";
  if (permissions.includes("transport.view")) return "/transport";
  if (permissions.includes("hostel.view_own")) return "/hostel/me";
  if (permissions.includes("transport.view_own")) return "/transport/me";
  // 3e. Inventory / Service Requests landings (INVENTORY_MANAGER, SERVICE_AGENT, custom roles). Appended AFTER 3d.
  if (permissions.includes("inventory.view")) return "/inventory";
  if (permissions.includes("service_requests.view")) return "/service-requests";
  if (permissions.includes("inventory.view_own")) return "/inventory/me";
  if (permissions.includes("service_requests.request_own")) return "/service-requests/me";
  // 3f. Documents landings. Appended AFTER 3e. documents.download is a baseline
  // key held by every non-applicant role, so it is NEVER used here (it would
  // hijack fees/library/hr/etc. users). Only the admin-view and owner keys land,
  // and only for holders not already captured above (e.g. DOCUMENT_MANAGER).
  if (permissions.includes("documents.admin.view_all")) return "/documents";
  if (permissions.includes("documents.view_own")) return "/documents";

  // 4. Authenticated but no known landing.
  return "/app";
}
