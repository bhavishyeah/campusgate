"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DoorOpen } from "lucide-react";
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
import { RoomFormDialog } from "@/components/hostel/RoomFormDialog";
import { PAGE_SIZE, useBuildingOptions, useRooms } from "@/features/hostel/hooks";
import { roomStatusLabel, toOptions } from "@/features/hostel/labels";
import { readIdParam, resolveKnownId } from "@/lib/paging";
import type { RoomRow } from "@/features/hostel/types";

export default function RoomsPage() {
  return (
    <RouteGuard requirePermission="hostel.view">
      <Suspense fallback={<TableSkeleton />}>
        <RoomsInner />
      </Suspense>
    </RouteGuard>
  );
}

function RoomsInner() {
  const params = useSearchParams();
  const [buildingParam, setBuildingParam] = useState(() => readIdParam(params.get("buildingId")) ?? "");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<{ room?: RoomRow } | null>(null);
  const buildings = useBuildingOptions();
  // An unknown id (stale link) shows as "All" and is not sent.
  const buildingId = resolveKnownId(buildingParam || undefined, buildings.data?.buildings) ?? "";
  const list = useRooms({ buildingId: buildingId || undefined, status: status || undefined, page });
  const filtered = Boolean(buildingId || status);

  return (
    <div className="space-y-6">
      <SectionNav items={HOSTEL_STAFF_NAV} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Rooms</h1>
          <p className="text-sm text-gray-500">Room status is set by staff and is not calculated from occupancy.</p>
        </div>
        <Can permission="hostel.buildings.manage">
          <Button onClick={() => setDialog({})}>Add room</Button>
        </Can>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="w-52">
          <SimpleSelect
            ariaLabel="Building"
            value={buildingId}
            onChange={(v) => {
              setBuildingParam(v);
              setPage(1);
            }}
            noneLabel="All buildings"
            placeholder="Building"
            options={(buildings.data?.buildings ?? []).map((b) => ({ value: b.id, label: b.name }))}
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
            options={toOptions(roomStatusLabel)}
          />
        </div>
      </div>

      {!list.allowed ? (
        <NoAccess what="hostel rooms" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.rooms.length === 0 ? (
        <EmptyState
          icon={DoorOpen}
          label={filtered ? "No rooms match these filters." : "No rooms yet. Add a building first."}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Building</TableHead>
                <TableHead>Room</TableHead>
                <TableHead>Floor</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Capacity</TableHead>
                <TableHead>Occupied</TableHead>
                <TableHead>Available</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.rooms.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.building.name}</TableCell>
                  <TableCell className="font-medium">{r.roomNumber}</TableCell>
                  <TableCell>{r.floor ?? "-"}</TableCell>
                  <TableCell>
                    <HostelStatusBadge kind="room" status={r.status} />
                  </TableCell>
                  <TableCell>{r.occupancy.capacity}</TableCell>
                  <TableCell>{r.occupancy.occupied}</TableCell>
                  <TableCell>{r.occupancy.available}</TableCell>
                  <TableCell>
                    <Can permission="hostel.buildings.manage">
                      <div className="flex justify-end">
                        <Button size="sm" variant="outline" onClick={() => setDialog({ room: r })}>
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

      <Can permission="hostel.buildings.manage">
        {dialog ? (
          <RoomFormDialog
            key={dialog.room?.id ?? "new"}
            open
            onOpenChange={(o) => !o && setDialog(null)}
            room={dialog.room}
            defaultBuildingId={buildingId || undefined}
          />
        ) : null}
      </Can>
    </div>
  );
}
