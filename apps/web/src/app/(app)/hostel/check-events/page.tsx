"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LogIn } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { HOSTEL_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { HostelStatusBadge } from "@/components/hostel/StatusBadges";
import { PAGE_SIZE, useCheckEvents } from "@/features/hostel/hooks";
import { roomLabel, studentLabel } from "@/features/hostel/format";
import { formatDateTime } from "@/features/hr/format";
import { readIdParam } from "@/lib/paging";

export default function CheckEventsPage() {
  return (
    <RouteGuard requirePermission="hostel.view">
      <Suspense fallback={<TableSkeleton />}>
        <CheckEventsInner />
      </Suspense>
    </RouteGuard>
  );
}

function CheckEventsInner() {
  const params = useSearchParams();
  const [allocationId, setAllocationId] = useState(() => readIdParam(params.get("allocationId")));
  const [studentId, setStudentId] = useState(() => readIdParam(params.get("studentId")));
  const [page, setPage] = useState(1);
  const list = useCheckEvents({ allocationId, studentId, page });

  return (
    <div className="space-y-6">
      <SectionNav items={HOSTEL_STAFF_NAV} />
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Check-in/out history</h1>
        <p className="text-sm text-gray-500">Append-only record of check-in and check-out events, newest first.</p>
      </div>
      {allocationId || studentId ? (
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <span>{allocationId ? "Filtered by allocation" : "Filtered by student"}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setAllocationId(undefined);
              setStudentId(undefined);
              setPage(1);
            }}
          >
            Clear
          </Button>
        </div>
      ) : null}

      {!list.allowed ? (
        <NoAccess what="check-in/out history" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.events.length === 0 ? (
        <EmptyState icon={LogIn} label="No check events recorded." />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Student</TableHead>
                <TableHead>Room</TableHead>
                <TableHead>Event</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{formatDateTime(e.occurredAt)}</TableCell>
                  <TableCell className="font-medium">{studentLabel(e.student)}</TableCell>
                  <TableCell>{roomLabel(e.allocation?.room)}</TableCell>
                  <TableCell>
                    <HostelStatusBadge kind="checkEvent" status={e.eventType} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination page={list.data.page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}
