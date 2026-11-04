"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { HOSTEL_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { OccupancyBar } from "@/components/hostel/OccupancyBar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { OPTION_PAGE_SIZE, useBuildingOptions, useOccupancy } from "@/features/hostel/hooks";
import { joinOccupancy, sumOccupancy } from "@/features/hostel/format";

export default function HostelDashboardPage() {
  return (
    <RouteGuard requirePermission="hostel.view">
      <Dashboard />
    </RouteGuard>
  );
}

function Dashboard() {
  const buildings = useBuildingOptions();
  const occupancy = useOccupancy();
  const rows = useMemo(
    () => joinOccupancy(buildings.data?.buildings ?? [], occupancy.data?.buildings ?? []),
    [buildings.data, occupancy.data],
  );
  const totals = useMemo(() => sumOccupancy(occupancy.data?.buildings ?? []), [occupancy.data]);
  const loading = buildings.isLoading || occupancy.isLoading;
  const failure = buildings.isError ? buildings : occupancy.isError ? occupancy : null;

  return (
    <div className="space-y-6">
      <SectionNav items={HOSTEL_STAFF_NAV} />
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Hostel occupancy</h1>
        <p className="text-sm text-gray-500">Beds per building, from the current active allocations.</p>
      </div>

      {!buildings.allowed ? (
        <NoAccess what="hostel occupancy" />
      ) : loading ? (
        <TableSkeleton />
      ) : failure ? (
        <ErrorBlock
          error={failure.error}
          onRetry={() => {
            void buildings.refetch();
            void occupancy.refetch();
          }}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Building2}
          label="No buildings yet."
          action={
            <Can permission="hostel.buildings.manage">
              <Link href="/hostel/buildings" className="text-sm text-primary-600 underline">
                Go to Buildings
              </Link>
            </Can>
          }
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["Total capacity", totals.capacity],
              ["Occupied", totals.occupied],
              ["Available", totals.available],
            ].map(([label, value]) => (
              <Card key={label}>
                <CardContent className="p-4">
                  <p className="text-sm text-gray-500">{label}</p>
                  <p className="text-2xl font-semibold text-gray-900">{value}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Building</TableHead>
                <TableHead>Capacity</TableHead>
                <TableHead>Occupied</TableHead>
                <TableHead>Available</TableHead>
                <TableHead>Occupancy</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>{r.capacity}</TableCell>
                  <TableCell>{r.occupied}</TableCell>
                  <TableCell>{r.available}</TableCell>
                  <TableCell>
                    <OccupancyBar occupied={r.occupied} capacity={r.capacity} />
                  </TableCell>
                  <TableCell>
                    {r.buildingId ? (
                      <Link href={`/hostel/rooms?buildingId=${encodeURIComponent(r.buildingId)}`} className="text-sm text-primary-600 underline">
                        View rooms
                      </Link>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {buildings.data && buildings.data.total > OPTION_PAGE_SIZE ? (
            <p className="text-xs text-gray-500">Showing the first {OPTION_PAGE_SIZE} buildings.</p>
          ) : null}
        </>
      )}
    </div>
  );
}
