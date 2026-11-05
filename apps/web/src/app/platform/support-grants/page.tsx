"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { GrantList } from "@/components/platform/GrantList";
import { SupportGrantForm } from "@/components/platform/SupportGrantForm";
import { useMfaGate } from "@/components/platform/MfaEnrollmentGate";
import { useInstitutions, useSupportGrants } from "@/features/platform/hooks";
import { PLATFORM_PERM } from "@/features/platform/permissions";
import type { SupportGrantStatus } from "@/features/platform/types";

const STATUS_OPTIONS: { value: SupportGrantStatus; label: string }[] = [
  { value: "REQUESTED", label: "Requested" },
  { value: "ACTIVE", label: "Active" },
  { value: "EXPIRED", label: "Expired" },
  { value: "REVOKED", label: "Revoked" },
];

function SupportGrantsInner() {
  const { reportError } = useMfaGate();
  const [institutionId, setInstitutionId] = useState("");
  const [status, setStatus] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const institutions = useInstitutions();
  const grants = useSupportGrants(
    institutionId || undefined,
    (status as SupportGrantStatus) || undefined,
  );

  useEffect(() => {
    if (grants.error) reportError(grants.error);
  }, [grants.error, reportError]);
  useEffect(() => {
    if (institutions.error) reportError(institutions.error);
  }, [institutions.error, reportError]);

  const institutionOptions = (institutions.data ?? []).map((inst) => ({
    value: inst.id,
    label: `${inst.name} (${inst.code})`,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">Support grants</h2>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" />
          Create grant
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="w-64 space-y-1">
          <Label>Institution</Label>
          <SimpleSelect
            value={institutionId}
            onChange={setInstitutionId}
            options={institutionOptions}
            noneLabel="All institutions"
            placeholder="All institutions"
            ariaLabel="Filter by institution"
          />
        </div>
        <div className="w-48 space-y-1">
          <Label>Status</Label>
          <SimpleSelect
            value={status}
            onChange={setStatus}
            options={STATUS_OPTIONS}
            noneLabel="Any status"
            placeholder="Any status"
            ariaLabel="Filter by status"
          />
        </div>
      </div>

      <GrantList
        grants={grants.data}
        isLoading={grants.isLoading}
        isError={grants.isError}
        error={grants.error}
      />

      <SupportGrantForm
        open={showCreate}
        institutionId={institutionId || undefined}
        onOpenChange={setShowCreate}
      />
    </div>
  );
}

export default function SupportGrantsPage() {
  return (
    <RouteGuard requirePermission={PLATFORM_PERM.supportGrant}>
      <SupportGrantsInner />
    </RouteGuard>
  );
}
