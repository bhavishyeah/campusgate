"use client";

import { useState } from "react";
import { CalendarOff } from "lucide-react";
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
import { DecisionDialog } from "@/components/hostel/DecisionDialog";
import { PAGE_SIZE, useHostelLeaveQueue } from "@/features/hostel/hooks";
import { studentLabel } from "@/features/hostel/format";
import { leaveStatusLabel, toOptions } from "@/features/hostel/labels";
import { staffLeaveActions } from "@/features/hostel/transitions";
import { formatDate, formatDateTime } from "@/features/hr/format";
import type { LeaveRow } from "@/features/hostel/types";

export default function HostelLeavePage() {
  return (
    <RouteGuard requirePermission="hostel.view">
      <LeaveInner />
    </RouteGuard>
  );
}

function LeaveInner() {
  // Requested is the queue waiting for a decision.
  const [status, setStatus] = useState("REQUESTED");
  const [page, setPage] = useState(1);
  const [review, setReview] = useState<{ row: LeaveRow; mode: "approve" | "reject" } | null>(null);
  const list = useHostelLeaveQueue({ status: status || undefined, page });

  return (
    <div className="space-y-6">
      <SectionNav items={HOSTEL_STAFF_NAV} />
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Hostel leave</h1>
        <p className="text-sm text-gray-500">Approve or reject student leave applications.</p>
      </div>
      <div className="w-44">
        <SimpleSelect
          ariaLabel="Status"
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          noneLabel="All"
          options={toOptions(leaveStatusLabel)}
        />
      </div>

      {!list.allowed ? (
        <NoAccess what="the hostel leave queue" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.applications.length === 0 ? (
        <EmptyState
          icon={CalendarOff}
          label={status === "REQUESTED" ? "No requested leave applications." : "No leave applications match this filter."}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Student</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Decision note</TableHead>
                <TableHead>Decided</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.applications.map((a) => {
                const actions = staffLeaveActions(a.status);
                return (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{studentLabel(a.student)}</TableCell>
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
                    <TableCell>{formatDateTime(a.decidedAt)}</TableCell>
                    <TableCell>
                      {actions.length > 0 ? (
                        <Can permission="hostel.leave.manage">
                          <div className="flex justify-end gap-2">
                            <Button size="sm" onClick={() => setReview({ row: a, mode: "approve" })}>
                              Approve
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setReview({ row: a, mode: "reject" })}>
                              Reject
                            </Button>
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

      <Can permission="hostel.leave.manage">
        {review ? (
          <DecisionDialog
            key={`${review.row.id}-${review.mode}`}
            open
            onOpenChange={(o) => !o && setReview(null)}
            application={review.row}
            mode={review.mode}
          />
        ) : null}
      </Can>
    </div>
  );
}
