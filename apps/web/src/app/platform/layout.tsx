"use client";

import { PlatformGuard } from "@/components/platform/PlatformGuard";
import { MfaEnrollmentGate } from "@/components/platform/MfaEnrollmentGate";
import { PlatformShell } from "@/components/platform/PlatformShell";

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return (
    <PlatformGuard>
      <MfaEnrollmentGate>
        <PlatformShell>{children}</PlatformShell>
      </MfaEnrollmentGate>
    </PlatformGuard>
  );
}
