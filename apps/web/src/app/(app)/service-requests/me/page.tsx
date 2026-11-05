"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ListChecks } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { RequestStatusBadge, OverdueBadge } from "@/components/service-requests/StatusBadges";
import { PriorityBadge } from "@/components/service-requests/PriorityBadge";
import { PAGE_SIZE, useActiveTypes, useMyRequests } from "@/features/service-requests/hooks";
import { requestStatusLabel, toOptions } from "@/features/service-requests/labels";
import { dueLabel } from "@/features/service-requests/format";
import { formatDateTime } from "@/features/hr/format";
import { readIdParam } from "@/lib/paging";

export default function MyRequestsPage() {
  return (
    <RouteGuard requirePermission="service_requests.request_own">
      <Suspense fallback={<TableSkeleton />}>
        <MyRequestsInner />
      </Suspense>
    </RouteGuard>
  );
}

const STATUS_OPTIONS = toOptions(requestStatusLabel);
const VALID_STATUS = new Set(Object.keys(requestStatusLabel));

function MyRequestsInner() {
  const params = useSearchParams();
  const [status, setStatus] = useState(() => {
    const s = params.get("status") ?? "";
    return VALID_STATUS.has(s) ? s : "";
  });
  const [requestTypeId, setRequestTypeId] = useState(() => readIdParam(params.get("requestTypeId")) ?? "");
  const [page, setPage] = useState(1);

  // Requester uses the active-type catalogue (never the staff /types).
  const types = useActiveTypes();
  const list = useMyRequests({ status: status || undefined, requestTypeId: requestTypeId || undefined, page });
  const typeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of types.data?.types ?? []) m.set(t.id, t.name);
    return m;
  }, [types.data]);
  const filtered = Boolean(status || requestTypeId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">My requests</h1>
          <p className="text-sm text-gray-500">Requests you have raised.</p>
        </div>
        <Link href="/service-requests/raise">
          <Button>Raise a request</Button>
        </Link>
      </div>
      <div className="flex flex-wrap gap-3">
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
          <SimpleSelect
            ariaLabel="Type"
            value={requestTypeId}
            onChange={(v) => {
              setRequestTypeId(v);
              setPage(1);
            }}
            noneLabel="All types"
            placeholder="Type"
            options={(types.data?.types ?? []).map((t) => ({ value: t.id, label: `${t.category} · ${t.name}` }))}
          />
        </div>
      </div>

      {!list.allowed ? (
        <NoAccess what="your requests" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.data.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          label={filtered ? "No requests match these filters." : "You haven't raised any requests yet."}
          action={
            <Link href="/service-requests/raise" className="text-sm text-primary-600 underline">
              Raise a request
            </Link>
          }
        />
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
                  <TableCell>{formatDateTime(r.raisedAt)}</TableCell>
                  <TableCell>{dueLabel(r)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Link href={`/service-requests/me/${r.id}`} className="text-sm text-primary-600 underline">
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
