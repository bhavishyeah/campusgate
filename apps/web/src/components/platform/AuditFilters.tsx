"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import type { AuditScope } from "@/features/platform/keys";

const SCOPE_OPTIONS: { value: AuditScope; label: string }[] = [
  { value: "platform", label: "Platform" },
  { value: "grant", label: "Grant" },
];

/**
 * Controls for the audit explorer. The grantId input is enabled and required
 * only when scope="grant" (the query stays disabled until it's present, with an
 * inline hint mirroring the server's 400). The limit input is clamped to
 * [1, 100] by the parent via clampAuditLimit before the query is enabled.
 */
export function AuditFilters({
  scope,
  grantId,
  limit,
  onScopeChange,
  onGrantIdChange,
  onLimitChange,
}: {
  scope: AuditScope;
  grantId: string;
  limit: number;
  onScopeChange: (scope: AuditScope) => void;
  onGrantIdChange: (grantId: string) => void;
  onLimitChange: (limit: number) => void;
}) {
  const grantScope = scope === "grant";
  const grantIdMissing = grantScope && grantId.trim() === "";

  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="w-48 space-y-1">
        <Label>Scope</Label>
        <SimpleSelect
          value={scope}
          onChange={(v) => onScopeChange(v as AuditScope)}
          options={SCOPE_OPTIONS}
          ariaLabel="Audit scope"
        />
      </div>
      <div className="w-72 space-y-1">
        <Label htmlFor="audit-grant-id">Grant ID</Label>
        <Input
          id="audit-grant-id"
          value={grantId}
          disabled={!grantScope}
          placeholder="grant_…"
          onChange={(e) => onGrantIdChange(e.target.value)}
        />
        {grantIdMissing && (
          <p className="text-xs text-warning-700">Enter a grant id</p>
        )}
      </div>
      <div className="w-32 space-y-1">
        <Label htmlFor="audit-limit">Limit</Label>
        <Input
          id="audit-limit"
          type="number"
          min={1}
          max={100}
          value={limit}
          onChange={(e) => onLimitChange(Number(e.target.value))}
        />
      </div>
    </div>
  );
}
