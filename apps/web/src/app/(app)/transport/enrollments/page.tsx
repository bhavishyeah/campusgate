"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Users } from "lucide-react";
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
import { SectionNav, TRANSPORT_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { TransportStatusBadge } from "@/components/transport/StatusBadges";
import { EnrollDialog } from "@/components/transport/EnrollDialog";
import {
  PAGE_SIZE,
  useEndEnrollment,
  useEnrollments,
  useRouteOptions,
  useSuspendEnrollment,
} from "@/features/transport/hooks";
import { stopLabel } from "@/features/transport/format";
import { enrollmentStatusLabel, toOptions } from "@/features/transport/labels";
import { enrollmentActions } from "@/features/transport/transitions";
import { formatDate } from "@/features/hr/format";
import { describeApiError } from "@/lib/apiErrors";
import { readIdParam, resolveKnownId } from "@/lib/paging";
import type { EnrollmentRow } from "@/features/transport/types";

export default function EnrollmentsPage() {
  return (
    <RouteGuard requirePermission="transport.view">
      <Suspense fallback={<TableSkeleton />}>
        <EnrollmentsInner />
      </Suspense>
    </RouteGuard>
  );
}

type Dialog = { kind: "enroll" } | { kind: "suspend" | "end"; row: EnrollmentRow };

function EnrollmentsInner() {
  const params = useSearchParams();
  const [routeParam, setRouteParam] = useState(() => readIdParam(params.get("routeId")) ?? "");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const routes = useRouteOptions();
  const routeId = resolveKnownId(routeParam || undefined, routes.data?.routes) ?? "";
  const list = useEnrollments({ routeId: routeId || undefined, status: status || undefined, page });

  return (
    <div className="space-y-6">
      <SectionNav items={TRANSPORT_STAFF_NAV} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Enrollments</h1>
          <p className="text-sm text-gray-500">Students enrolled on transport routes.</p>
        </div>
        <Can permission="transport.enrollments.manage">
          <Button onClick={() => setDialog({ kind: "enroll" })}>Enroll student</Button>
        </Can>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="w-56">
          <SimpleSelect
            ariaLabel="Route"
            value={routeId}
            onChange={(v) => {
              setRouteParam(v);
              setPage(1);
            }}
            noneLabel="All routes"
            placeholder="Route"
            options={(routes.data?.routes ?? []).map((r) => ({ value: r.id, label: `${r.code} - ${r.name}` }))}
          />
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
            options={toOptions(enrollmentStatusLabel)}
          />
        </div>
      </div>

      {!list.allowed ? (
        <NoAccess what="transport enrollments" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.enrollments.length === 0 ? (
        <EmptyState icon={Users} label={routeId || status ? "No enrollments match these filters." : "No enrollments yet."} />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Student</TableHead>
                <TableHead>Route</TableHead>
                <TableHead>Stop</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Enrolled</TableHead>
                <TableHead>Ended</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.enrollments.map((e) => {
                const actions = enrollmentActions(e.status);
                return (
                  <TableRow key={e.id}>
                    <TableCell className="font-medium">
                      {e.student.name}
                      {e.student.enrollmentNo ? ` (${e.student.enrollmentNo})` : ""}
                    </TableCell>
                    <TableCell>
                      {e.route.code} - {e.route.name}
                    </TableCell>
                    <TableCell>{stopLabel(e.stop)}</TableCell>
                    <TableCell>
                      <TransportStatusBadge kind="enrollment" status={e.status} />
                    </TableCell>
                    <TableCell>{formatDate(e.enrolledAt)}</TableCell>
                    <TableCell>{formatDate(e.endedAt)}</TableCell>
                    <TableCell>
                      {actions.length > 0 ? (
                        <Can permission="transport.enrollments.manage">
                          <div className="flex justify-end gap-2">
                            {actions.includes("suspend") ? (
                              <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "suspend", row: e })}>
                                Suspend
                              </Button>
                            ) : null}
                            {actions.includes("end") ? (
                              <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "end", row: e })}>
                                End
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

      <Can permission="transport.enrollments.manage">
        {dialog?.kind === "enroll" ? (
          <EnrollDialog open onOpenChange={(o) => !o && setDialog(null)} defaultRouteId={routeId || undefined} />
        ) : null}
        {dialog && dialog.kind !== "enroll" ? (
          <EnrollmentConfirm key={`${dialog.row.id}-${dialog.kind}`} kind={dialog.kind} row={dialog.row} onClose={() => setDialog(null)} />
        ) : null}
      </Can>
    </div>
  );
}

function EnrollmentConfirm({
  kind,
  row,
  onClose,
}: {
  kind: "suspend" | "end";
  row: EnrollmentRow;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const suspend = useSuspendEnrollment({ toast: false });
  const end = useEndEnrollment({ toast: false });
  const suspending = kind === "suspend";
  const pending = suspend.isPending || end.isPending;

  async function confirm() {
    setError(null);
    try {
      if (suspending) await suspend.mutateAsync(row.id);
      else await end.mutateAsync(row.id);
      toast.success(suspending ? "Enrollment suspended" : "Enrollment ended");
      onClose();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  return (
    <ConfirmDialog
      open
      title={suspending ? "Suspend enrollment" : "End enrollment"}
      description={
        suspending
          ? "Suspend this enrollment? The student stops seeing it and it no longer counts toward route capacity. There is no resume: a suspended enrollment can only be ended."
          : "End this enrollment? This cannot be undone."
      }
      confirmLabel={suspending ? "Suspend" : "End enrollment"}
      destructive={!suspending}
      pending={pending}
      onConfirm={() => void confirm()}
      onOpenChange={(o) => !o && onClose()}
    >
      {error ? <InlineError message={error} /> : null}
    </ConfirmDialog>
  );
}
