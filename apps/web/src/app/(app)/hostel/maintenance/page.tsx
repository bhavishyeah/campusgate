"use client";

import { useState } from "react";
import { Wrench } from "lucide-react";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { HOSTEL_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { HostelStatusBadge } from "@/components/hostel/StatusBadges";
import { MaintenanceCreateDialog } from "@/components/hostel/MaintenanceCreateDialog";
import { MaintenanceTransitionDialog } from "@/components/hostel/MaintenanceTransitionDialog";
import { PAGE_SIZE, useHostelMaintenance, useTransitionMaintenance } from "@/features/hostel/hooks";
import { roomLabel } from "@/features/hostel/format";
import { maintenanceStatusLabel, toOptions } from "@/features/hostel/labels";
import { maintenanceActions } from "@/features/hostel/transitions";
import { formatDate } from "@/features/hr/format";
import { describeApiError } from "@/lib/apiErrors";
import type { MaintenanceRow } from "@/features/hostel/types";

export default function HostelMaintenancePage() {
  return (
    <RouteGuard requirePermission="hostel.view">
      <MaintenanceInner />
    </RouteGuard>
  );
}

type Dialog = { kind: "create" } | { kind: "transition"; row: MaintenanceRow; target: "RESOLVED" | "CANCELLED" };

function MaintenanceInner() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const list = useHostelMaintenance({ status: status || undefined, page });

  return (
    <div className="space-y-6">
      <SectionNav items={HOSTEL_STAFF_NAV} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Maintenance</h1>
          <p className="text-sm text-gray-500">Room maintenance requests.</p>
        </div>
        <Can permission="hostel.maintenance.manage">
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
        <NoAccess what="hostel maintenance" />
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
                <TableHead>Room</TableHead>
                <TableHead>Issue</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Assigned</TableHead>
                <TableHead>Reported</TableHead>
                <TableHead>Resolved</TableHead>
                <TableHead>Resolution note</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.requests.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{roomLabel(r.room)}</TableCell>
                  <TableCell className="max-w-xs truncate" title={r.issue}>
                    {r.issue}
                  </TableCell>
                  <TableCell>
                    <HostelStatusBadge kind="maintenance" status={r.status} />
                  </TableCell>
                  <TableCell>{r.assigneeUserId ? "Assigned" : "-"}</TableCell>
                  <TableCell>{formatDate(r.createdAt)}</TableCell>
                  <TableCell>{formatDate(r.resolvedAt)}</TableCell>
                  <TableCell>{r.resolutionNote ?? "-"}</TableCell>
                  <TableCell>
                    <RowActions row={r} onDialog={setDialog} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination page={list.data.page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </>
      )}

      <Can permission="hostel.maintenance.manage">
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

function RowActions({ row, onDialog }: { row: MaintenanceRow; onDialog: (d: Dialog) => void }) {
  const transition = useTransitionMaintenance(row.id, { toast: false });
  const actions = maintenanceActions(row.status);
  if (actions.length === 0) return null;

  async function markInProgress() {
    try {
      await transition.mutateAsync({ toStatus: "IN_PROGRESS" });
      toast.success("Marked in progress");
    } catch (err) {
      toast.error(describeApiError(err));
    }
  }

  return (
    <Can permission="hostel.maintenance.manage">
      <div className="flex flex-wrap justify-end gap-2">
        {actions.includes("IN_PROGRESS") ? (
          <Button size="sm" variant="outline" disabled={transition.isPending} onClick={() => void markInProgress()}>
            Mark in progress
          </Button>
        ) : null}
        {actions.includes("RESOLVED") ? (
          <Button size="sm" variant="outline" onClick={() => onDialog({ kind: "transition", row, target: "RESOLVED" })}>
            Mark resolved
          </Button>
        ) : null}
        {actions.includes("CANCELLED") ? (
          <Button size="sm" variant="outline" onClick={() => onDialog({ kind: "transition", row, target: "CANCELLED" })}>
            Cancel request
          </Button>
        ) : null}
      </div>
    </Can>
  );
}
