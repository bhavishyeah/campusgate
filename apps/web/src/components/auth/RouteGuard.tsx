"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { PermissionKey } from "@campusgate/shared";
import { useAuthStore } from "@/stores/auth";
import { FullPageSkeleton } from "@/components/auth/FullPageSkeleton";
import { ForbiddenScreen } from "@/components/auth/ForbiddenScreen";

/**
 * Wraps protected (app) content. Waits for rehydration (flash-avoidance),
 * redirects to /login when unauthenticated, and shows a friendly 403 for a
 * deep-linked screen the user lacks the required permission for. UX gate only —
 * the backend remains the authoritative authorization boundary.
 */
export function RouteGuard({
  requirePermission,
  children,
}: {
  requirePermission?: PermissionKey;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const permissions = useAuthStore((s) => s.permissions);

  useEffect(() => {
    if (!hydrated) return;
    if (!token || !user) router.replace("/login");
  }, [hydrated, token, user, router]);

  if (!hydrated) return <FullPageSkeleton />;
  if (!token || !user) return null; // redirect in-flight
  if (requirePermission && !permissions.includes(requirePermission)) {
    return <ForbiddenScreen />;
  }
  return <>{children}</>;
}
