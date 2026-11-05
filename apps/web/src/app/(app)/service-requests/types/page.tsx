"use client";

import { useState } from "react";
import Link from "next/link";
import { ListChecks } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { SERVICE_REQUESTS_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { Badge } from "@/components/ui/badge";
import { TypeFormDialog } from "@/components/service-requests/TypeFormDialog";
import { useTypes } from "@/features/service-requests/hooks";
import { slaLabel } from "@/features/service-requests/format";
import type { RequestType } from "@/features/service-requests/types";

export default function TypesPage() {
  return (
    <RouteGuard requirePermission="service_requests.view">
      <TypesInner />
    </RouteGuard>
  );
}

function TypesInner() {
  const types = useTypes();
  const [dialog, setDialog] = useState<{ type?: RequestType } | null>(null);

  return (
    <div className="space-y-6">
      <SectionNav items={SERVICE_REQUESTS_STAFF_NAV} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Request types</h1>
          <p className="text-sm text-gray-500">Types and their data-driven field configuration.</p>
        </div>
        <Can permission="service_requests.types.manage">
          <Button onClick={() => setDialog({})}>New type</Button>
        </Can>
      </div>

      {!types.allowed ? (
        <NoAccess what="request types" />
      ) : types.isLoading ? (
        <TableSkeleton />
      ) : types.isError ? (
        <ErrorBlock error={types.error} onRetry={() => void types.refetch()} />
      ) : (types.data?.length ?? 0) === 0 ? (
        <EmptyState icon={ListChecks} label="No request types yet." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>SLA</TableHead>
              <TableHead>Requires approval</TableHead>
              <TableHead>Active</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {types.data?.map((t) => (
              <TableRow key={t.id}>
                <TableCell>{t.category}</TableCell>
                <TableCell className="font-medium">{t.name}</TableCell>
                <TableCell>{t.code}</TableCell>
                <TableCell>{slaLabel(t)}</TableCell>
                <TableCell>{t.requiresApproval ? <Badge variant="outline">Yes</Badge> : "No"}</TableCell>
                <TableCell>{t.isActive ? <Badge variant="outline">Active</Badge> : "Inactive"}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <Link href={`/service-requests/types/${t.id}`} className="text-sm text-primary-600 underline self-center">
                      Fields
                    </Link>
                    <Can permission="service_requests.types.manage">
                      <Button size="sm" variant="outline" onClick={() => setDialog({ type: t })}>
                        Edit
                      </Button>
                    </Can>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Can permission="service_requests.types.manage">
        {dialog ? (
          <TypeFormDialog key={dialog.type?.id ?? "new"} open onOpenChange={(o) => !o && setDialog(null)} type={dialog.type} />
        ) : null}
      </Can>
    </div>
  );
}
