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

  // 4. Authenticated but no known landing.
  return "/app";
}
