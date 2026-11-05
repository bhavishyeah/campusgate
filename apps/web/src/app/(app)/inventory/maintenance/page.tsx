"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Wrench } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { INVENTORY_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { InventoryStatusBadge } from "@/components/inventory/StatusBadges";
import { MaintenanceCreateDialog } from "@/components/inventory/MaintenanceCreateDialog";
import { MaintenanceTransitionDialog } from "@/components/inventory/MaintenanceTransitionDialog";
import { PAGE_SIZE, useMaintenance } from "@/features/inventory/hooks";
import { maintenanceActions } from "@/features/inventory/transitions";
import { maintenanceStatusLabel, toOptions } from "@/features/inventory/labels";
import { formatMinor } from "@/features/inventory/money";
import { formatDate } from "@/features/hr/format";
import { readIdParam } from "@/lib/paging";
import type { MaintenanceRow } from "@/features/inventory/types";

export default function MaintenancePage() {
  return (
    <RouteGuard requirePermission="inventory.view">
      <Suspense fallback={<TableSkeleton />}>
        <MaintenanceInner />
      </Suspense>
    </RouteGuard>
  );
}

const STATUS_OPTIONS = toOptions(maintenanceStatusLabel);

type Dialog = { kind: "create" } | { kind: "transition"; row: MaintenanceRow; target: "IN_PROGRESS" | "RESOLVED" | "CANCELLED" };

function MaintenanceInner() {
  const params = useSearchParams();
  const [assetId, setAssetId] = useState(() => readIdParam(params.get("assetId")) ?? "");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const list = useMaintenance({ status: status || undefined, assetId: assetId || undefined, page });

  return (
    <div className="space-y-6">
      <SectionNav items={INVENTORY_STAFF_NAV} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Maintenance</h1>
          <p className="text-sm text-gray-500">Asset maintenance requests.</p>
        </div>
        <Can permission="inventory.maintenance.manage">
          <Button onClick={() => setDialog({ kind: "create" })}>New request</Button>
        </Can>
      </div>
      <div className="flex flex-wrap items-center gap-3">
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
            options={STATUS_OPTIONS}
          />
        </div>
        {assetId ? (
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <span>Filtered by asset</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setAssetId("");
                setPage(1);
              }}
            >
              Clear
            </Button>
          </div>
        ) : null}
      </div>

      {!list.allowed ? (
        <NoAccess what="inventory maintenance" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.requests.length === 0 ? (
        <EmptyState icon={Wrench} label={status || assetId ? "No requests match these filters." : "No maintenance requests."} />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Issue</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Assignee</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead>Reported</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.requests.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="max-w-xs truncate font-medium" title={r.issue}>
                    {r.issue}
                  </TableCell>
                  <TableCell>
                    <InventoryStatusBadge kind="maintenance" status={r.status} />
                  </TableCell>
                  <TableCell>{r.assigneeUserId ? "Assigned" : "-"}</TableCell>
                  <TableCell>{formatMinor(r.cost)}</TableCell>
                  <TableCell>{formatDate(r.createdAt)}</TableCell>
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

      <Can permission="inventory.maintenance.manage">
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
  const actions = maintenanceActions(row.status);
  if (actions.length === 0) return null;
  return (
    <Can permission="inventory.maintenance.manage">
      <div className="flex flex-wrap justify-end gap-2">
        {actions.includes("IN_PROGRESS") ? (
          <Button size="sm" variant="outline" onClick={() => onDialog({ kind: "transition", row, target: "IN_PROGRESS" })}>
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
