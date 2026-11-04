"use client";

import { useState } from "react";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { HOSTEL_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { ActiveBadge } from "@/components/hostel/StatusBadges";
import { BuildingFormDialog } from "@/components/hostel/BuildingFormDialog";
import { PAGE_SIZE, useBuildings } from "@/features/hostel/hooks";
import { buildingTypeLabel } from "@/features/hostel/labels";
import type { BuildingRow } from "@/features/hostel/types";

export default function BuildingsPage() {
  return (
    <RouteGuard requirePermission="hostel.view">
      <BuildingsInner />
    </RouteGuard>
  );
}

function BuildingsInner() {
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<{ building?: BuildingRow } | null>(null);
  const list = useBuildings(page);

  return (
    <div className="space-y-6">
      <SectionNav items={HOSTEL_STAFF_NAV} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Buildings</h1>
          <p className="text-sm text-gray-500">Hostel buildings and their wardens.</p>
        </div>
        <Can permission="hostel.buildings.manage">
          <Button onClick={() => setDialog({})}>Add building</Button>
        </Can>
      </div>

      {!list.allowed ? (
        <NoAccess what="hostel buildings" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.buildings.length === 0 ? (
        <EmptyState icon={Building2} label="No buildings yet." />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Warden</TableHead>
                <TableHead>Rooms</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.buildings.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="font-medium">{b.name}</TableCell>
                  <TableCell>{buildingTypeLabel[b.type] ?? b.type}</TableCell>
                  <TableCell>{b.warden ? (b.warden.name ?? b.warden.email) : "-"}</TableCell>
                  <TableCell>{b.roomCount}</TableCell>
                  <TableCell>
                    <ActiveBadge active={b.isActive} />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Link
                        href={`/hostel/rooms?buildingId=${encodeURIComponent(b.id)}`}
                        className="inline-flex items-center text-sm text-primary-600 underline"
                      >
                        View rooms
                      </Link>
                      <Can permission="hostel.buildings.manage">
                        <Button size="sm" variant="outline" onClick={() => setDialog({ building: b })}>
                          Edit
                        </Button>
                      </Can>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination page={list.data.page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </>
      )}

      <Can permission="hostel.buildings.manage">
        {dialog ? (
          <BuildingFormDialog
            key={dialog.building?.id ?? "new"}
            open
            onOpenChange={(o) => !o && setDialog(null)}
            building={dialog.building}
          />
        ) : null}
      </Can>
    </div>
  );
}
