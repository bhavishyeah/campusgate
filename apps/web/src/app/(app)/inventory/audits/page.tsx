"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { INVENTORY_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { AuditCreateDialog } from "@/components/inventory/AuditCreateDialog";
import { seedAuditSession } from "@/features/inventory/auditState";
import { can } from "@/lib/authz";
import { useAuthStore } from "@/stores/auth";

export default function AuditsPage() {
  return (
    <RouteGuard requirePermission="inventory.view">
      <AuditsInner />
    </RouteGuard>
  );
}

function AuditsInner() {
  const router = useRouter();
  const perms = useAuthStore((s) => s.permissions);
  const allowed = can("inventory.view", perms);
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-6">
      <SectionNav items={INVENTORY_STAFF_NAV} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Stock-take audits</h1>
          <p className="text-sm text-gray-500">Start a session, add lines, then close it. Sessions are held locally.</p>
        </div>
        <Can permission="inventory.audits.manage">
          <Button onClick={() => setOpen(true)}>Start a stock-take</Button>
        </Can>
      </div>

      {!allowed ? (
        <NoAccess what="inventory audits" />
      ) : (
        <EmptyState icon={ClipboardCheck} label="Start a stock-take session to begin counting." />
      )}

      <Can permission="inventory.audits.manage">
        {open ? (
          <AuditCreateDialog
            open
            onOpenChange={setOpen}
            onCreated={(session) => {
              seedAuditSession(session);
              router.push(`/inventory/audits/${session.id}`);
            }}
          />
        ) : null}
      </Can>
    </div>
  );
}
