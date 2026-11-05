"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth";
import { FullPageSkeleton } from "@/components/auth/FullPageSkeleton";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { decidePlatformAccess } from "@/features/platform/guard";

/**
 * Fail-closed gate for the platform surface. Identity is a SINGLE source:
 * roles.includes("SUPER_ADMIN") — we do NOT branch on user.role. /login is
 * reserved for the no-session case; a wrong-role user gets a hard <NoAccess/>
 * (this replaces the old layout's wrong-role router.replace('/login')).
 */
export function PlatformGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const roles = useAuthStore((s) => s.roles);
  const hydrated = useAuthStore((s) => s.hydrated);

  const hasSession = Boolean(token && user);
  const isSuper = roles.includes("SUPER_ADMIN");

  useEffect(() => {
    if (hydrated && (!token || !user)) router.replace("/login");
  }, [hydrated, token, user, router]);

  const decision = decidePlatformAccess({ hydrated, hasSession, isSuper });
  switch (decision) {
    case "skeleton":
      return <FullPageSkeleton />;
    case "redirect":
      return null; // redirect in-flight
    case "noaccess":
      return <NoAccess what="the platform console" />;
    case "allow":
      return <>{children}</>;
  }
}
