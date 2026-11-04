"use client";

import { useState } from "react";
import { BedDouble, UserX } from "lucide-react";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/ui-ext/ConfirmDialog";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { InlineError } from "@/components/ui-ext/InlineError";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { HostelStatusBadge } from "@/components/hostel/StatusBadges";
import { LeaveApplyDialog } from "@/components/hostel/LeaveApplyDialog";
import {
  PAGE_SIZE,
  useCancelMyLeave,
  useMyAllocation,
  useMyHostelLeave,
  useMyOccupancy,
} from "@/features/hostel/hooks";
import { isNoStudentProfile } from "@/features/hostel/errors";
import { buildingTypeLabel, leaveStatusLabel, toOptions } from "@/features/hostel/labels";
import { selfLeaveActions } from "@/features/hostel/transitions";
import { formatDate } from "@/features/hr/format";
import { describeApiError } from "@/lib/apiErrors";
import type { MyLeave } from "@/features/hostel/types";

export default function MyHostelPage() {
  return (
    <RouteGuard requirePermission="hostel.view_own">
      <MyHostelInner />
    </RouteGuard>
  );
}

const NO_RECORD = "No student record is linked to your account.";

function MyHostelInner() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">My hostel</h1>
        <p className="text-sm text-gray-500">Your room and leave applications.</p>
      </div>
      <Tabs defaultValue="room">
        <TabsList>
          <TabsTrigger value="room">Room</TabsTrigger>
          <TabsTrigger value="leave">Leave</TabsTrigger>
        </TabsList>
        <TabsContent value="room">
          <RoomTab />
        </TabsContent>
        <TabsContent value="leave">
          <LeaveTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RoomTab() {
  const alloc = useMyAllocation();
  const occ = useMyOccupancy();

  if (!alloc.allowed) return <NoAccess what="your hostel room" />;
  if (alloc.isLoading) return <TableSkeleton />;
  if (alloc.isError) {
    return isNoStudentProfile(alloc.error) ? (
      <EmptyState icon={UserX} label={NO_RECORD} />
    ) : (
      <ErrorBlock error={alloc.error} onRetry={() => void alloc.refetch()} />
    );
  }
  const a = alloc.data?.allocation ?? null;
  if (!a) return <EmptyState icon={BedDouble} label="You don't have a hostel room allocated." />;
  const o = occ.data?.occupancy ?? null;
  return (
    <Card>
      <CardContent className="space-y-1 p-4 text-sm">
        <p>
          <span className="text-gray-500">Building: </span>
          {a.room.building.name}
        </p>
        <p>
          <span className="text-gray-500">Room: </span>
          {a.room.roomNumber}
        </p>
        <p>
          <span className="text-gray-500">Floor: </span>
          {a.room.floor ?? "-"}
        </p>
        <p>
          <span className="text-gray-500">Building type: </span>
          {buildingTypeLabel[a.room.building.type] ?? a.room.building.type}
        </p>
        <p>
          <span className="text-gray-500">Allocated on: </span>
          {formatDate(a.allocatedAt)}
        </p>
        {o ? (
          <p>
            <span className="text-gray-500">Room occupancy: </span>
            {o.occupied} of {o.capacity} beds occupied
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function LeaveTab() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [applyOpen, setApplyOpen] = useState(false);
  const [cancelRow, setCancelRow] = useState<MyLeave | null>(null);
  const list = useMyHostelLeave({ status: status || undefined, page });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
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
            options={toOptions(leaveStatusLabel)}
          />
        </div>
        <Can permission="hostel.view_own">
          <Button onClick={() => setApplyOpen(true)}>Apply for leave</Button>
        </Can>
      </div>

      {!list.allowed ? (
        <NoAccess what="your leave applications" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        isNoStudentProfile(list.error) ? (
          <EmptyState icon={UserX} label={NO_RECORD} />
        ) : (
          <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
        )
      ) : !list.data || list.data.applications.length === 0 ? (
        <EmptyState icon={BedDouble} label="No leave applications." />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Dates</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Decision note</TableHead>
                <TableHead>Applied</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.applications.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    {formatDate(a.fromDate)} to {formatDate(a.toDate)}
                  </TableCell>
                  <TableCell className="max-w-xs truncate" title={a.reason}>
                    {a.reason}
                  </TableCell>
                  <TableCell>
                    <HostelStatusBadge kind="leave" status={a.status} />
                  </TableCell>
                  <TableCell>{a.decisionNote ?? "-"}</TableCell>
                  <TableCell>{formatDate(a.createdAt)}</TableCell>
                  <TableCell>
                    {selfLeaveActions(a.status).length > 0 ? (
                      <Can permission="hostel.view_own">
                        <div className="flex justify-end">
                          <Button size="sm" variant="outline" onClick={() => setCancelRow(a)}>
                            Cancel request
                          </Button>
                        </div>
                      </Can>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination page={list.data.page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </>
      )}

      <Can permission="hostel.view_own">
        {applyOpen ? <LeaveApplyDialog open onOpenChange={setApplyOpen} /> : null}
        {cancelRow ? <CancelLeaveConfirm key={cancelRow.id} row={cancelRow} onClose={() => setCancelRow(null)} /> : null}
      </Can>
    </div>
  );
}

function CancelLeaveConfirm({ row, onClose }: { row: MyLeave; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const cancel = useCancelMyLeave({ toast: false });

  async function confirm() {
    setError(null);
    try {
      await cancel.mutateAsync(row.id);
      toast.success("Leave request cancelled");
      onClose();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  return (
    <ConfirmDialog
      open
      title="Cancel leave request"
      description="Cancel this leave request? This cannot be undone."
      confirmLabel="Cancel request"
      destructive
      pending={cancel.isPending}
      onConfirm={() => void confirm()}
      onOpenChange={(o) => !o && onClose()}
    >
      {error ? <InlineError message={error} /> : null}
    </ConfirmDialog>
  );
}
