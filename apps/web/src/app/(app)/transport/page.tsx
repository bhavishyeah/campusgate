"use client";

import { useState } from "react";
import Link from "next/link";
import { Route as RouteIcon } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { SectionNav, TRANSPORT_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { TransportStatusBadge } from "@/components/transport/StatusBadges";
import { RouteFormDialog } from "@/components/transport/RouteFormDialog";
import { PAGE_SIZE, useRoutes, useUtilization } from "@/features/transport/hooks";
import { utilizationLabel } from "@/features/transport/format";
import { formatFee } from "@/features/transport/money";
import { routeStatusLabel, toOptions } from "@/features/transport/labels";
import type { Route } from "@/features/transport/types";

export default function TransportRoutesPage() {
  return (
    <RouteGuard requirePermission="transport.view">
      <RoutesInner />
    </RouteGuard>
  );
}

function RoutesInner() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<{ route?: Route } | null>(null);
  const list = useRoutes({ status: status || undefined, page });
  const utilization = useUtilization();
  const byRoute = new Map((utilization.data?.utilization ?? []).map((u) => [u.routeId, u]));

  return (
    <div className="space-y-6">
      <SectionNav items={TRANSPORT_STAFF_NAV} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Routes</h1>
          <p className="text-sm text-gray-500">Transport routes, fees and capacity.</p>
        </div>
        <Can permission="transport.routes.manage">
          <Button onClick={() => setDialog({})}>Add route</Button>
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
          options={toOptions(routeStatusLabel)}
        />
      </div>

      {!list.allowed ? (
        <NoAccess what="transport routes" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.routes.length === 0 ? (
        <EmptyState icon={RouteIcon} label={status ? "No routes match this filter." : "No routes yet."} />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Fee</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Enrolled / capacity</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.routes.map((r) => {
                const u = byRoute.get(r.id);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.code}</TableCell>
                    <TableCell>{r.name}</TableCell>
                    <TableCell>{formatFee(r.feeAmount)}</TableCell>
                    <TableCell>
                      <TransportStatusBadge kind="route" status={r.status} />
                    </TableCell>
                    <TableCell>{u ? utilizationLabel(u) : "-"}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Link
                          href={`/transport/routes/${encodeURIComponent(r.id)}`}
                          className="inline-flex items-center text-sm text-primary-600 underline"
                        >
                          Open
                        </Link>
                        <Can permission="transport.routes.manage">
                          <Button size="sm" variant="outline" onClick={() => setDialog({ route: r })}>
                            Edit
                          </Button>
                        </Can>
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

      <Can permission="transport.routes.manage">
        {dialog ? (
          <RouteFormDialog
            key={dialog.route?.id ?? "new"}
            open
            onOpenChange={(o) => !o && setDialog(null)}
            route={dialog.route}
          />
        ) : null}
      </Can>
    </div>
  );
}
