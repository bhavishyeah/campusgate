"use client";

import { useState } from "react";
import { MapPin } from "lucide-react";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { StopFormDialog } from "@/components/transport/StopFormDialog";
import { useStops } from "@/features/transport/hooks";
import { pickupOffsetLabel } from "@/features/transport/format";
import { slicePage } from "@/lib/paging";
import type { Stop } from "@/features/transport/types";

const SIZE = 50;

export function RouteStopsPanel({ routeId }: { routeId: string }) {
  const stops = useStops(routeId);
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<{ stop?: Stop } | null>(null);
  const all = stops.data?.stops ?? [];
  const nextSequence = all.reduce((m, s) => Math.max(m, s.sequence), 0) + 1;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Can permission="transport.routes.manage">
          <Button onClick={() => setDialog({})}>Add stop</Button>
        </Can>
      </div>
      {!stops.allowed ? (
        <NoAccess what="route stops" />
      ) : stops.isLoading ? (
        <TableSkeleton />
      ) : stops.isError ? (
        <ErrorBlock error={stops.error} onRetry={() => void stops.refetch()} />
      ) : all.length === 0 ? (
        <EmptyState icon={MapPin} label="No stops yet." />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Seq</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Landmark</TableHead>
                <TableHead>Pickup offset</TableHead>
                <TableHead>Coordinates</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {slicePage(all, page, SIZE).map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{s.sequence}</TableCell>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>{s.landmark ?? "-"}</TableCell>
                  <TableCell>{pickupOffsetLabel(s.pickupOffsetMinutes)}</TableCell>
                  <TableCell>
                    {s.latitude !== null && s.longitude !== null ? `${s.latitude}, ${s.longitude}` : "-"}
                  </TableCell>
                  <TableCell>
                    <Can permission="transport.routes.manage">
                      <div className="flex justify-end">
                        <Button size="sm" variant="outline" onClick={() => setDialog({ stop: s })}>
                          Edit
                        </Button>
                      </div>
                    </Can>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {all.length > SIZE ? <Pagination page={page} pageSize={SIZE} total={all.length} onPage={setPage} /> : null}
        </>
      )}
      <Can permission="transport.routes.manage">
        {dialog ? (
          <StopFormDialog
            key={dialog.stop?.id ?? "new"}
            open
            onOpenChange={(o) => !o && setDialog(null)}
            routeId={routeId}
            stop={dialog.stop}
            nextSequence={nextSequence}
          />
        ) : null}
      </Can>
    </div>
  );
}
