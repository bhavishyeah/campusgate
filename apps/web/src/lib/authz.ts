import type { PermissionKey } from "@campusgate/shared";
import { useAuthStore } from "@/stores/auth";

/** Set-membership mirror of the backend can(). Hold the key => allowed. */
export function can(permission: PermissionKey, perms: string[]): boolean {
  return perms.includes(permission);
}

export function canAny(permissions: PermissionKey[], perms: string[]): boolean {
  return permissions.some((p) => perms.includes(p));
}

export function hasRole(role: string, roles: string[]): boolean {
  return roles.includes(role);
}

export function hasAnyRole(wanted: string[], roles: string[]): boolean {
  return wanted.some((r) => roles.includes(r));
}

// Store-reading hooks (subscribe to the live permission/role set).
export function useCan(permission: PermissionKey): boolean {
  return useAuthStore((s) => s.permissions.includes(permission));
}

export function useCanAny(permissions: PermissionKey[]): boolean {
  return useAuthStore((s) => permissions.some((p) => s.permissions.includes(p)));
}

export function useHasRole(role: string): boolean {
  return useAuthStore((s) => s.roles.includes(role));
}
