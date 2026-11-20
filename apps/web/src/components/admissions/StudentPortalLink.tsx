"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth";

/**
 * Shown to an ENROLLED applicant. The link needs the STUDENT role in the session;
 * the client refreshes its token on its own after enrollment, so a session that
 * still lacks the role is rare (offline, or refresh was throttled) and is told to
 * sign in again.
 */
export function StudentPortalLink({ size = "default" }: { size?: "default" | "sm" }) {
  const roles = useAuthStore((s) => s.roles);
  if (roles.includes("STUDENT")) {
    return (
      <Button size={size} asChild>
        <Link href="/student">Open student portal</Link>
      </Button>
    );
  }
  return <p className="text-sm text-gray-700">Sign out and back in to open the student portal.</p>;
}
