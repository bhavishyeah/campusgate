"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ClipboardList } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { SERVICE_REQUESTS_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { RequestStatusBadge, OverdueBadge } from "@/components/service-requests/StatusBadges";
import { PriorityBadge } from "@/components/service-requests/PriorityBadge";
import { TypePicker } from "@/components/service-requests/TypePicker";
import { PAGE_SIZE, useQueue, useTypes } from "@/features/service-requests/hooks";
import { requestStatusLabel, toOptions } from "@/features/service-requests/labels";
import { dueLabel } from "@/features/service-requests/format";
import { formatDateTime } from "@/features/hr/format";
import { readIdParam } from "@/lib/paging";

export default function QueuePage() {
  return (
    <RouteGuard requirePermission="service_requests.view">
      <Suspense fallback={<TableSkeleton />}>
        <QueueInner />
      </Suspense>
    </RouteGuard>
  );
}

const STATUS_OPTIONS = toOptions(requestStatusLabel);
const VALID_STATUS = new Set(Object.keys(requestStatusLabel));

function QueueInner() {
  const params = useSearchParams();
  const [status, setStatus] = useState(() => {
    const s = params.get("status") ?? "";
    return VALID_STATUS.has(s) ? s : "";
  });
  const [requestTypeId, setRequestTypeId] = useState(() => readIdParam(params.get("requestTypeId")) ?? "");
  const [assigneeUserId, setAssigneeUserId] = useState(() => readIdParam(params.get("assigneeUserId")) ?? "");
  const [overdue, setOverdue] = useState(params.get("overdue") === "true");
  const [page, setPage] = useState(1);

  const types = useTypes();
  const list = useQueue({
    status: status || undefined,
    requestTypeId: requestTypeId || undefined,
    assigneeUserId: assigneeUserId || undefined,
    overdue,
    page,
  });
  const typeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of types.data ?? []) m.set(t.id, t.name);
    return m;
  }, [types.data]);

  const filtered = Boolean(status || requestTypeId || assigneeUserId || overdue);

  return (
    <div className="space-y-6">
      <SectionNav items={SERVICE_REQUESTS_STAFF_NAV} />
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Service request queue</h1>
        <p className="text-sm text-gray-500">All tenant requests, newest first.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-48">
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
        <div className="w-60">
          <TypePicker
            value={requestTypeId}
            onChange={(v) => {
              setRequestTypeId(v);
              setPage(1);
            }}
          />
        </div>
        {assigneeUserId ? (
          <button
            className="text-sm text-primary-600 underline"
            onClick={() => {
              setAssigneeUserId("");
              setPage(1);
            }}
          >
            Clear assignee filter
          </button>
        ) : null}
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={overdue}
            onChange={(e) => {
              setOverdue(e.target.checked);
              setPage(1);
            }}
          />
          Overdue only
        </label>
      </div>

      {!list.allowed ? (
        <NoAccess what="the service request queue" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.data.length === 0 ? (
        <EmptyState icon={ClipboardList} label={filtered ? "No requests match these filters." : "No requests yet."} />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Overdue</TableHead>
                <TableHead>Assignee</TableHead>
                <TableHead>Raised</TableHead>
                <TableHead>Due</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.title}</TableCell>
                  <TableCell>{typeNameById.get(r.requestTypeId) ?? "-"}</TableCell>
                  <TableCell>
                    <PriorityBadge priority={r.priority} />
                  </TableCell>
                  <TableCell>
                    <RequestStatusBadge status={r.status} />
                  </TableCell>
                  <TableCell>
                    <OverdueBadge overdue={r.isOverdue} />
                  </TableCell>
                  <TableCell>{r.assigneeUserId ? "Assigned" : "-"}</TableCell>
                  <TableCell>{formatDateTime(r.raisedAt)}</TableCell>
                  <TableCell>{dueLabel(r)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Link href={`/service-requests/${r.id}`} className="text-sm text-primary-600 underline">
                        Open
                      </Link>
                    </div>
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
