"use client";

import { useState } from "react";
import { CalendarClock } from "lucide-react";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { ScheduleFormDialog } from "@/components/transport/ScheduleFormDialog";
import { useSchedules, useStops } from "@/features/transport/hooks";
import { scheduleTimes, scheduleWhen } from "@/features/transport/format";
import { slicePage } from "@/lib/paging";
import type { Schedule } from "@/features/transport/types";

const SIZE = 50;

export function RouteSchedulesPanel({ routeId }: { routeId: string }) {
  const schedules = useSchedules(routeId);
  const stops = useStops(routeId);
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<{ schedule?: Schedule } | null>(null);
  const all = schedules.data?.schedules ?? [];
  const stopName = new Map((stops.data?.stops ?? []).map((s) => [s.id, s.name]));

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Can permission="transport.routes.manage">
          <Button onClick={() => setDialog({})}>Add schedule</Button>
        </Can>
      </div>
      {!schedules.allowed ? (
        <NoAccess what="route schedules" />
      ) : schedules.isLoading ? (
        <TableSkeleton />
      ) : schedules.isError ? (
        <ErrorBlock error={schedules.error} onRetry={() => void schedules.refetch()} />
      ) : all.length === 0 ? (
        <EmptyState icon={CalendarClock} label="No schedules yet." />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Times</TableHead>
                <TableHead>Stop</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {slicePage(all, page, SIZE).map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{scheduleWhen(s)}</TableCell>
                  <TableCell>{scheduleTimes(s)}</TableCell>
                  <TableCell>{s.stopId ? (stopName.get(s.stopId) ?? "Another stop") : "All stops"}</TableCell>
                  <TableCell>
                    <Can permission="transport.routes.manage">
                      <div className="flex justify-end">
                        <Button size="sm" variant="outline" onClick={() => setDialog({ schedule: s })}>
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
          <ScheduleFormDialog
            key={dialog.schedule?.id ?? "new"}
            open
            onOpenChange={(o) => !o && setDialog(null)}
            routeId={routeId}
            schedule={dialog.schedule}
          />
        ) : null}
      </Can>
    </div>
  );
}
