import type { PermissionKey } from "@campusgate/shared";

/**
 * Typed permission constants for the platform (super-admin) surface. Each value
 * is checked against the shared PermissionKey union at compile time, so a typo
 * or a key missing from the catalogue fails typecheck. Mirrors the 7
 * platform.* keys held by ROLE_PERMISSIONS.SUPER_ADMIN.
 */
export const PLATFORM_PERM = {
  institutionsManage: "platform.institutions.manage",
  analyticsView: "platform.analytics.view",
  onboarding: "platform.onboarding",
  entitlementsManage: "platform.entitlements.manage",
  subscriptionsManage: "platform.subscriptions.manage",
  supportGrant: "platform.support.grant",
  securityRespond: "platform.security.respond",
} as const satisfies Record<string, PermissionKey>;
