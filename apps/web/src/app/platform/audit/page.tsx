"use client";

import { useState } from "react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { AuditFilters } from "@/components/platform/AuditFilters";
import { AuditTable } from "@/components/platform/AuditTable";
import type { AuditScope } from "@/features/platform/keys";
import { clampAuditLimit } from "@/features/platform/schemas";
import { PLATFORM_PERM } from "@/features/platform/permissions";

function AuditInner() {
  const [scope, setScope] = useState<AuditScope>("platform");
  const [grantId, setGrantId] = useState("");
  const [limit, setLimit] = useState(50);

  const clampedLimit = clampAuditLimit(limit);
  // scope=grant requires a grantId before the query may run.
  const enabled = scope === "platform" || grantId.trim() !== "";

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900">Audit explorer</h2>
      <AuditFilters
        scope={scope}
        grantId={grantId}
        limit={limit}
        onScopeChange={setScope}
        onGrantIdChange={setGrantId}
        onLimitChange={setLimit}
      />
      <AuditTable
        scope={scope}
        grantId={scope === "grant" ? grantId.trim() : null}
        limit={clampedLimit}
        enabled={enabled}
      />
    </div>
  );
}

export default function AuditPage() {
  return (
    <RouteGuard requirePermission={PLATFORM_PERM.securityRespond}>
      <AuditInner />
    </RouteGuard>
  );
}
