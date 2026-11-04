"use client";

import { useState } from "react";
import { UserRound } from "lucide-react";
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
import { DriverFormDialog } from "@/components/transport/DriverFormDialog";
import { PAGE_SIZE, useDrivers } from "@/features/transport/hooks";
import { driverStatusLabel, toOptions } from "@/features/transport/labels";
import type { Driver } from "@/features/transport/types";

export default function DriversPage() {
  return (
    <RouteGuard requirePermission="transport.view">
      <DriversInner />
    </RouteGuard>
  );
}

function DriversInner() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<{ driver?: Driver } | null>(null);
  const list = useDrivers({ status: status || undefined, page });

  return (
    <div className="space-y-6">
      <SectionNav items={TRANSPORT_STAFF_NAV} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Drivers</h1>
          <p className="text-sm text-gray-500">Transport drivers.</p>
        </div>
        <Can permission="transport.drivers.manage">
          <Button onClick={() => setDialog({})}>Add driver</Button>
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
          options={toOptions(driverStatusLabel)}
        />
      </div>

      {!list.allowed ? (
        <NoAccess what="drivers" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.drivers.length === 0 ? (
        <EmptyState icon={UserRound} label={status ? "No drivers match this filter." : "No drivers yet."} />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>License</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.drivers.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">{d.name}</TableCell>
                  <TableCell>{d.licenseNo}</TableCell>
                  <TableCell>{d.phone ?? "-"}</TableCell>
                  <TableCell>
                    <TransportStatusBadge kind="driver" status={d.status} />
                  </TableCell>
                  <TableCell>
                    <Can permission="transport.drivers.manage">
                      <div className="flex justify-end">
                        <Button size="sm" variant="outline" onClick={() => setDialog({ driver: d })}>
                          Edit
                        </Button>
                      </div>
                    </Can>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination page={list.data.page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </>
      )}

      <Can permission="transport.drivers.manage">
        {dialog ? (
          <DriverFormDialog
            key={dialog.driver?.id ?? "new"}
            open
            onOpenChange={(o) => !o && setDialog(null)}
            driver={dialog.driver}
          />
        ) : null}
      </Can>
    </div>
  );
}
