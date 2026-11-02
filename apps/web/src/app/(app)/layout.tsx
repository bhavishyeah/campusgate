"use client";

import { RouteGuard } from "@/components/auth/RouteGuard";
import { AppShell } from "@/components/shell/AppShell";

export default function AppGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RouteGuard>
      <AppShell>{children}</AppShell>
    </RouteGuard>
  );
}
