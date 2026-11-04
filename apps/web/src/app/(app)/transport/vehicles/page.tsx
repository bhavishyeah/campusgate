"use client";

import { useState } from "react";
import { Bus } from "lucide-react";
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
import { VehicleFormDialog } from "@/components/transport/VehicleFormDialog";
import { PAGE_SIZE, useVehicles } from "@/features/transport/hooks";
import { toOptions, vehicleStatusLabel, vehicleTypeLabel } from "@/features/transport/labels";
import type { Vehicle } from "@/features/transport/types";

export default function VehiclesPage() {
  return (
    <RouteGuard requirePermission="transport.view">
      <VehiclesInner />
    </RouteGuard>
  );
}

function VehiclesInner() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<{ vehicle?: Vehicle } | null>(null);
  const list = useVehicles({ status: status || undefined, page });

  return (
    <div className="space-y-6">
      <SectionNav items={TRANSPORT_STAFF_NAV} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Vehicles</h1>
          <p className="text-sm text-gray-500">The transport fleet.</p>
        </div>
        <Can permission="transport.vehicles.manage">
          <Button onClick={() => setDialog({})}>Add vehicle</Button>
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
          options={toOptions(vehicleStatusLabel)}
        />
      </div>

      {!list.allowed ? (
        <NoAccess what="vehicles" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.vehicles.length === 0 ? (
        <EmptyState icon={Bus} label={status ? "No vehicles match this filter." : "No vehicles yet."} />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Registration</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Seats</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.vehicles.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-medium">{v.registrationNo}</TableCell>
                  <TableCell>{vehicleTypeLabel[v.type] ?? v.type}</TableCell>
                  <TableCell>{v.seatCapacity}</TableCell>
                  <TableCell>
                    <TransportStatusBadge kind="vehicle" status={v.status} />
                  </TableCell>
                  <TableCell>
                    <Can permission="transport.vehicles.manage">
                      <div className="flex justify-end">
                        <Button size="sm" variant="outline" onClick={() => setDialog({ vehicle: v })}>
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

      <Can permission="transport.vehicles.manage">
        {dialog ? (
          <VehicleFormDialog
            key={dialog.vehicle?.id ?? "new"}
            open
            onOpenChange={(o) => !o && setDialog(null)}
            vehicle={dialog.vehicle}
          />
        ) : null}
      </Can>
    </div>
  );
}
