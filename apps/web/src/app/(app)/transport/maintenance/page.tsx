"use client";

import { useState } from "react";
import { Wrench } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { SectionNav, TRANSPORT_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { TransportStatusBadge } from "@/components/transport/StatusBadges";
import { MaintenanceCreateDialog } from "@/components/transport/MaintenanceCreateDialog";
import { MaintenanceTransitionDialog } from "@/components/transport/MaintenanceTransitionDialog";
import { PAGE_SIZE, useTransportMaintenance } from "@/features/transport/hooks";
import { maintenanceStatusLabel, toOptions } from "@/features/transport/labels";
import { formatCost } from "@/features/transport/money";
import { maintenanceActions } from "@/features/transport/transitions";
import { formatDate } from "@/features/hr/format";
import type { MaintenanceRow } from "@/features/transport/types";

export default function TransportMaintenancePage() {
  return (
    <RouteGuard requirePermission="transport.view">
      <MaintenanceInner />
    </RouteGuard>
  );
}

type Dialog = { kind: "create" } | { kind: "transition"; row: MaintenanceRow; target: "IN_PROGRESS" | "RESOLVED" | "CANCELLED" };

function MaintenanceInner() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const list = useTransportMaintenance({ status: status || undefined, page });

  return (
    <div className="space-y-6">
      <SectionNav items={TRANSPORT_STAFF_NAV} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Vehicle maintenance</h1>
          <p className="text-sm text-gray-500">Maintenance requests for vehicles.</p>
        </div>
        <Can permission="transport.maintenance.manage">
          <Button onClick={() => setDialog({ kind: "create" })}>New request</Button>
        </Can>
      </div>
      <div className="w-44">
        <SimpleSelect
          ariaLabel="Status"
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          noneLabel="All statuses"
          placeholder="Status"
          options={toOptions(maintenanceStatusLabel)}
        />
      </div>

      {!list.allowed ? (
        <NoAccess what="vehicle maintenance" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.requests.length === 0 ? (
        <EmptyState icon={Wrench} label={status ? "No requests match this filter." : "No maintenance requests."} />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vehicle</TableHead>
                <TableHead>Issue</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Assigned</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead>Reported</TableHead>
                <TableHead>Resolved</TableHead>
                <TableHead>Resolution note</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.requests.map((r) => {
                const actions = maintenanceActions(r.status);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.vehicle.registrationNo}</TableCell>
                    <TableCell className="max-w-xs truncate" title={r.issue}>
                      {r.issue}
                    </TableCell>
                    <TableCell>
                      <TransportStatusBadge kind="maintenance" status={r.status} />
                    </TableCell>
                    <TableCell>{r.assigneeUserId ? "Assigned" : "-"}</TableCell>
                    <TableCell>{formatCost(r.cost)}</TableCell>
                    <TableCell>{formatDate(r.createdAt)}</TableCell>
                    <TableCell>{formatDate(r.resolvedAt)}</TableCell>
                    <TableCell>{r.resolutionNote ?? "-"}</TableCell>
                    <TableCell>
                      {actions.length > 0 ? (
                        <Can permission="transport.maintenance.manage">
                          <div className="flex flex-wrap justify-end gap-2">
                            {actions.includes("IN_PROGRESS") ? (
                              <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "transition", row: r, target: "IN_PROGRESS" })}>
                                Mark in progress
                              </Button>
                            ) : null}
                            {actions.includes("RESOLVED") ? (
                              <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "transition", row: r, target: "RESOLVED" })}>
                                Mark resolved
                              </Button>
                            ) : null}
                            {actions.includes("CANCELLED") ? (
                              <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "transition", row: r, target: "CANCELLED" })}>
                                Cancel request
                              </Button>
                            ) : null}
                          </div>
                        </Can>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <Pagination page={list.data.page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </>
      )}

      <Can permission="transport.maintenance.manage">
        {dialog?.kind === "create" ? <MaintenanceCreateDialog open onOpenChange={(o) => !o && setDialog(null)} /> : null}
        {dialog?.kind === "transition" ? (
          <MaintenanceTransitionDialog
            key={`${dialog.row.id}-${dialog.target}`}
            open
            onOpenChange={(o) => !o && setDialog(null)}
            request={dialog.row}
            target={dialog.target}
          />
        ) : null}
      </Can>
    </div>
  );
}
