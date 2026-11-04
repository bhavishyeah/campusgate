"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BedDouble } from "lucide-react";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDialog } from "@/components/ui-ext/ConfirmDialog";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { InlineError } from "@/components/ui-ext/InlineError";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { HOSTEL_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { HostelStatusBadge } from "@/components/hostel/StatusBadges";
import { AllocateDialog } from "@/components/hostel/AllocateDialog";
import { TransferDialog } from "@/components/hostel/TransferDialog";
import { CheckEventDialog } from "@/components/hostel/CheckEventDialog";
import {
  PAGE_SIZE,
  downloadAllocations,
  useAllocations,
  useBuildingOptions,
  useVacate,
} from "@/features/hostel/hooks";
import { roomLabel, studentLabel } from "@/features/hostel/format";
import { allocationStatusLabel, toOptions } from "@/features/hostel/labels";
import { allocationActions } from "@/features/hostel/transitions";
import { formatDate } from "@/features/hr/format";
import { describeApiError } from "@/lib/apiErrors";
import { readIdParam, resolveKnownId } from "@/lib/paging";
import type { AllocationRow } from "@/features/hostel/types";

export default function AllocationsPage() {
  return (
    <RouteGuard requirePermission="hostel.view">
      <Suspense fallback={<TableSkeleton />}>
        <AllocationsInner />
      </Suspense>
    </RouteGuard>
  );
}

type Action = { kind: "allocate" } | { kind: "transfer" | "vacate" | "check"; row: AllocationRow };

function AllocationsInner() {
  const params = useSearchParams();
  const [status, setStatus] = useState("");
  const [buildingParam, setBuildingParam] = useState(() => readIdParam(params.get("buildingId")) ?? "");
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<Action | null>(null);
  const [exporting, setExporting] = useState(false);
  const buildings = useBuildingOptions();
  const buildingId = resolveKnownId(buildingParam || undefined, buildings.data?.buildings) ?? "";
  const list = useAllocations({ status: status || undefined, buildingId: buildingId || undefined, page });

  async function onExport() {
    setExporting(true);
    try {
      await downloadAllocations();
    } catch (err) {
      toast.error(describeApiError(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionNav items={HOSTEL_STAFF_NAV} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Allocations</h1>
          <p className="text-sm text-gray-500">Room allocations, newest first.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={exporting} onClick={() => void onExport()}>
            {exporting ? "Exporting..." : "Export XLSX"}
          </Button>
          <Can permission="hostel.allocations.manage">
            <Button onClick={() => setAction({ kind: "allocate" })}>Allocate student</Button>
          </Can>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
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
            options={toOptions(allocationStatusLabel)}
          />
        </div>
        <div className="w-52">
          <SimpleSelect
            ariaLabel="Building"
            value={buildingId}
            onChange={(v) => {
              setBuildingParam(v);
              setPage(1);
            }}
            noneLabel="All buildings"
            placeholder="Building"
            options={(buildings.data?.buildings ?? []).map((b) => ({ value: b.id, label: b.name }))}
          />
        </div>
      </div>

      {!list.allowed ? (
        <NoAccess what="hostel allocations" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.allocations.length === 0 ? (
        <EmptyState
          icon={BedDouble}
          label={status || buildingId ? "No allocations match these filters." : "No allocations yet."}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Student</TableHead>
                <TableHead>Program</TableHead>
                <TableHead>Room</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Allocated</TableHead>
                <TableHead>Vacated</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.allocations.map((a) => {
                const actions = allocationActions(a.status);
                return (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{studentLabel(a.student)}</TableCell>
                    <TableCell>{a.student?.program ?? "-"}</TableCell>
                    <TableCell>{roomLabel(a.room)}</TableCell>
                    <TableCell>
                      <HostelStatusBadge kind="allocation" status={a.status} />
                    </TableCell>
                    <TableCell>{formatDate(a.allocatedAt)}</TableCell>
                    <TableCell>{formatDate(a.vacatedAt)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap justify-end gap-2">
                        <Can permission="hostel.allocations.manage">
                          {actions.includes("TRANSFER") ? (
                            <Button size="sm" variant="outline" onClick={() => setAction({ kind: "transfer", row: a })}>
                              Transfer
                            </Button>
                          ) : null}
                          {actions.includes("CHECK") ? (
                            <Button size="sm" variant="outline" onClick={() => setAction({ kind: "check", row: a })}>
                              Record check-in/out
                            </Button>
                          ) : null}
                          {actions.includes("VACATE") ? (
                            <Button size="sm" variant="outline" onClick={() => setAction({ kind: "vacate", row: a })}>
                              Vacate
                            </Button>
                          ) : null}
                        </Can>
                        <Link
                          href={`/hostel/check-events?allocationId=${encodeURIComponent(a.id)}`}
                          className="inline-flex items-center text-sm text-primary-600 underline"
                        >
                          Check events
                        </Link>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <Pagination page={list.data.page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </>
      )}
      <p className="text-xs text-gray-500">The export lists raw ids.</p>

      <Can permission="hostel.allocations.manage">
        {action?.kind === "allocate" ? <AllocateDialog open onOpenChange={(o) => !o && setAction(null)} /> : null}
        {action?.kind === "transfer" ? (
          <TransferDialog key={action.row.id} open onOpenChange={(o) => !o && setAction(null)} allocation={action.row} />
        ) : null}
        {action?.kind === "check" ? (
          <CheckEventDialog key={action.row.id} open onOpenChange={(o) => !o && setAction(null)} allocation={action.row} />
        ) : null}
        {action?.kind === "vacate" ? (
          <VacateConfirm key={action.row.id} allocation={action.row} onClose={() => setAction(null)} />
        ) : null}
      </Can>
    </div>
  );
}

function VacateConfirm({ allocation, onClose }: { allocation: AllocationRow; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const vacate = useVacate(allocation.id, { toast: false });

  async function confirm() {
    setError(null);
    try {
      await vacate.mutateAsync();
      toast.success("Allocation vacated");
      onClose();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  return (
    <ConfirmDialog
      open
      title="Vacate allocation"
      description={`Vacate ${studentLabel(allocation.student)} from ${roomLabel(allocation.room)}? The allocation is closed and cannot be reopened.`}
      confirmLabel="Vacate"
      destructive
      pending={vacate.isPending}
      onConfirm={() => void confirm()}
      onOpenChange={(o) => !o && onClose()}
    >
      {error ? <InlineError message={error} /> : null}
    </ConfirmDialog>
  );
}
