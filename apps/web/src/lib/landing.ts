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
  if (STAFF_FEES.some((p) => permissions.includes(p))) return "/app/fees";
  if (permissions.includes("fees.view_own")) return "/app/fees/me";

  // 4. Authenticated but no known landing.
  return "/app";
}
