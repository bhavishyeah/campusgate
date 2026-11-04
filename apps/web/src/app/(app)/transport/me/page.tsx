"use client";

import { Bus } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { useMyEnrollments, useMyFees, useMyRoutes, useMySchedules } from "@/features/transport/hooks";
import { pickupOffsetLabel, scheduleTimes, scheduleWhen, stopLabel } from "@/features/transport/format";
import { formatFee } from "@/features/transport/money";

export default function MyTransportPage() {
  return (
    <RouteGuard requirePermission="transport.view_own">
      <MyTransportInner />
    </RouteGuard>
  );
}

function MyTransportInner() {
  const enrollments = useMyEnrollments();
  const routes = useMyRoutes();
  const schedules = useMySchedules();
  const fees = useMyFees();
  const failed = [enrollments, routes, schedules, fees].find((q) => q.isError);
  const loading = [enrollments, routes, schedules, fees].some((q) => q.isLoading);

  const myEnrollments = enrollments.data?.enrollments ?? [];
  const mySchedules = schedules.data?.schedules ?? [];
  const myFees = fees.data?.fees ?? [];
  const routeName = new Map((routes.data?.routes ?? []).map((r) => [r.id, `${r.code} - ${r.name}`]));
  const stopById = new Map(myEnrollments.map((e) => [e.stop.id, e.stop.name]));
  const empty = myEnrollments.length === 0 && mySchedules.length === 0 && myFees.length === 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">My transport</h1>
        <p className="text-sm text-gray-500">Your route, stop, schedule and fee.</p>
      </div>

      {!enrollments.allowed ? (
        <NoAccess what="your transport" />
      ) : loading ? (
        <TableSkeleton />
      ) : failed ? (
        <ErrorBlock
          error={failed.error}
          onRetry={() => {
            void enrollments.refetch();
            void routes.refetch();
            void schedules.refetch();
            void fees.refetch();
          }}
        />
      ) : empty ? (
        <EmptyState
          icon={Bus}
          label="You're not enrolled on a transport route."
          description="Only active enrollments are shown."
        />
      ) : (
        <>
          <section className="space-y-2">
            <h2 className="text-lg font-medium text-gray-900">My routes</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {myEnrollments.map((e) => (
                <Card key={e.id}>
                  <CardContent className="space-y-1 p-4 text-sm">
                    <p className="font-medium text-gray-900">
                      {e.route.code} - {e.route.name}
                    </p>
                    <p>
                      <span className="text-gray-500">Stop: </span>
                      {stopLabel(e.stop)}
                    </p>
                    <p>
                      <span className="text-gray-500">Landmark: </span>
                      {e.stop.landmark ?? "-"}
                    </p>
                    <p>
                      <span className="text-gray-500">Pickup offset: </span>
                      {pickupOffsetLabel(e.stop.pickupOffsetMinutes)}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-medium text-gray-900">Schedule</h2>
            {mySchedules.length === 0 ? (
              <p className="text-sm text-gray-500">No schedules yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Route</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead>Times</TableHead>
                    <TableHead>Stop</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mySchedules.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>{routeName.get(s.routeId) ?? "-"}</TableCell>
                      <TableCell>{scheduleWhen(s)}</TableCell>
                      <TableCell>{scheduleTimes(s)}</TableCell>
                      <TableCell>{s.stopId ? (stopById.get(s.stopId) ?? "Another stop") : "All stops"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-medium text-gray-900">Fees</h2>
            {myFees.length === 0 ? (
              <p className="text-sm text-gray-500">No fees.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Route</TableHead>
                    <TableHead>Fee</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {myFees.map((f) => (
                    <TableRow key={f.routeId}>
                      <TableCell>
                        {f.code} - {f.name}
                      </TableCell>
                      <TableCell>{formatFee(f.feeAmount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <p className="text-xs text-gray-500">Informational. This fee is not billed through Fees.</p>
          </section>
        </>
      )}
    </div>
  );
}
