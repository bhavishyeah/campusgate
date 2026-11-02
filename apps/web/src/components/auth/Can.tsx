"use client";

import type { PermissionKey } from "@campusgate/shared";
import { useAuthStore } from "@/stores/auth";

/**
 * UX gate ONLY — hides/shows UI based on the held permission set so the UI never
 * offers an action the user lacks. The authoritative boundary is the backend
 * (requirePermission -> 403); this component never grants anything.
 */
export function Can({
  permission,
  anyOf,
  fallback = null,
  children,
}: {
  permission?: PermissionKey;
  anyOf?: PermissionKey[];
  fallback?: React.ReactNode;
  children: React.ReactNode;
}) {
  const perms = useAuthStore((s) => s.permissions);
  const allowed = permission
    ? perms.includes(permission)
    : anyOf
      ? anyOf.some((p) => perms.includes(p))
      : false;
  return allowed ? <>{children}</> : <>{fallback}</>;
}
