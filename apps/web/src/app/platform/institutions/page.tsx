"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Ban, Building2, CheckCircle2, Plus, SlidersHorizontal } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { CreateInstitutionDialog } from "@/components/platform/CreateInstitutionDialog";
import { InstitutionStatusConfirm } from "@/components/platform/InstitutionStatusConfirm";
import { useMfaGate } from "@/components/platform/MfaEnrollmentGate";
import { useInstitutions } from "@/features/platform/hooks";
import { PLATFORM_PERM } from "@/features/platform/permissions";
import type { InstitutionRow } from "@/features/platform/types";
import { describeApiError } from "@/lib/apiErrors";

function InstitutionsInner() {
  const institutions = useInstitutions();
  const { reportError } = useMfaGate();
  const [showCreate, setShowCreate] = useState(false);
  const [statusTarget, setStatusTarget] = useState<InstitutionRow | null>(null);

  useEffect(() => {
    if (institutions.error) reportError(institutions.error);
  }, [institutions.error, reportError]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">Institutions</h2>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" />
          New institution
        </Button>
      </div>

      {institutions.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : institutions.isError ? (
        <InlineError message={describeApiError(institutions.error)} />
      ) : !institutions.data || institutions.data.length === 0 ? (
        <EmptyState
          icon={Building2}
          label="No institutions yet."
          description="Create the first institution to get started."
          action={
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" />
              New institution
            </Button>
          }
        />
      ) : (
        <div className="card p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Users</TableHead>
                <TableHead>Departments</TableHead>
                <TableHead>Gates</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {institutions.data.map((inst) => (
                <TableRow key={inst.id}>
                  <TableCell className="font-medium text-gray-900">
                    {inst.name}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{inst.code}</TableCell>
                  <TableCell>
                    <Badge
                      variant={inst.status === "ACTIVE" ? "default" : "destructive"}
                    >
                      {inst.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{inst._count.users}</TableCell>
                  <TableCell>{inst._count.departments}</TableCell>
                  <TableCell>{inst._count.gates}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-2">
                      <Button variant="outline" size="sm" asChild>
                        <Link href={`/platform/institutions/${inst.id}/modules`}>
                          <SlidersHorizontal className="h-3.5 w-3.5" />
                          Modules
                        </Link>
                      </Button>
                      <Button
                        variant={inst.status === "ACTIVE" ? "destructive" : "default"}
                        size="sm"
                        onClick={() => setStatusTarget(inst)}
                      >
                        {inst.status === "ACTIVE" ? (
                          <>
                            <Ban className="h-3.5 w-3.5" />
                            Suspend
                          </>
                        ) : (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Activate
                          </>
                        )}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateInstitutionDialog open={showCreate} onOpenChange={setShowCreate} />
      {statusTarget && (
        <InstitutionStatusConfirm
          open
          institution={statusTarget}
          onOpenChange={(next) => {
            if (!next) setStatusTarget(null);
          }}
        />
      )}
    </div>
  );
}

export default function InstitutionsPage() {
  return (
    <RouteGuard requirePermission={PLATFORM_PERM.institutionsManage}>
      <InstitutionsInner />
    </RouteGuard>
  );
}
