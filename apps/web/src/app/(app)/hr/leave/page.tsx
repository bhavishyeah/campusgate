"use client";

import { useState } from "react";
import { CalendarOff } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { SectionNav, HR_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { LeaveReviewDialog } from "@/components/hr/LeaveReviewDialog";
import { LeaveTable } from "@/components/hr/LeaveTable";
import { PAGE_SIZE, useLeaveQueue } from "@/features/hr/hooks";
import { leaveStatusLabel, leaveTypeLabel, toOptions } from "@/features/hr/labels";
import { staffLeaveActions } from "@/features/hr/transitions";
import type { LeaveQueueRow } from "@/features/hr/types";

export default function LeaveQueuePage() {
  return (
    <RouteGuard requirePermission="hr.leave.manage">
      <LeaveQueueInner />
    </RouteGuard>
  );
}

function LeaveQueueInner() {
  // Default tab is Requested: the applications waiting for a decision.
  const [status, setStatus] = useState("REQUESTED");
  const [leaveType, setLeaveType] = useState("");
  const [page, setPage] = useState(1);
  const [review, setReview] = useState<{ row: LeaveQueueRow; mode: "approve" | "reject" } | null>(null);
  const queue = useLeaveQueue({ status: status || undefined, leaveType: leaveType || undefined, page });

  return (
    <div className="space-y-6">
      <SectionNav items={HR_STAFF_NAV} />
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Leave requests</h1>
        <p className="text-sm text-gray-500">Approve or reject leave applications.</p>
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
            noneLabel="All"
            options={toOptions(leaveStatusLabel)}
          />
        </div>
        <div className="w-44">
          <SimpleSelect
            ariaLabel="Leave type"
            value={leaveType}
            onChange={(v) => {
              setLeaveType(v);
              setPage(1);
            }}
            noneLabel="All leave types"
            placeholder="Leave type"
            options={toOptions(leaveTypeLabel)}
          />
        </div>
      </div>

      {!queue.allowed ? (
        <NoAccess what="the leave queue" />
      ) : queue.isLoading ? (
        <TableSkeleton />
      ) : queue.isError ? (
        <ErrorBlock error={queue.error} onRetry={() => void queue.refetch()} />
      ) : !queue.data || queue.data.leaveApplications.length === 0 ? (
        <EmptyState
          icon={CalendarOff}
          label={status === "REQUESTED" ? "No requested leave applications." : "No leave applications match these filters."}
        />
      ) : (
        <>
          <LeaveTable
            showEmployee
            rows={queue.data.leaveApplications}
            renderActions={(r) => {
              const actions = staffLeaveActions(r.status);
              if (actions.length === 0 || !("employee" in r)) return null;
              return (
                <Can permission="hr.leave.manage">
                  <div className="flex justify-end gap-2">
                    {actions.includes("APPROVED") ? (
                      <Button size="sm" onClick={() => setReview({ row: r, mode: "approve" })}>
                        Approve
                      </Button>
                    ) : null}
                    {actions.includes("REJECTED") ? (
                      <Button size="sm" variant="outline" onClick={() => setReview({ row: r, mode: "reject" })}>
                        Reject
                      </Button>
                    ) : null}
                  </div>
                </Can>
              );
            }}
          />
          <Pagination page={queue.data.page} pageSize={PAGE_SIZE} total={queue.data.total} onPage={setPage} />
        </>
      )}

      <Can permission="hr.leave.manage">
        {review ? (
          <LeaveReviewDialog
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
