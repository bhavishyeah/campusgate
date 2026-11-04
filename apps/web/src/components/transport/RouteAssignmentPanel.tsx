"use client";

import { useState } from "react";
import { Truck } from "lucide-react";
import { toast } from "sonner";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDialog } from "@/components/ui-ext/ConfirmDialog";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { InlineError } from "@/components/ui-ext/InlineError";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { TransportStatusBadge } from "@/components/transport/StatusBadges";
import { AssignmentFormDialog } from "@/components/transport/AssignmentFormDialog";
import { useAssignments, useEndAssignment } from "@/features/transport/hooks";
import { vehicleTypeLabel } from "@/features/transport/labels";
import { assignmentActions } from "@/features/transport/transitions";
import { formatDate } from "@/features/hr/format";
import { describeApiError } from "@/lib/apiErrors";
import type { AssignmentRow } from "@/features/transport/types";

export function RouteAssignmentPanel({ routeId }: { routeId: string }) {
  const list = useAssignments(routeId);
  const [assignOpen, setAssignOpen] = useState(false);
  const [ending, setEnding] = useState<AssignmentRow | null>(null);
  const all = list.data?.assignments ?? [];
  const current = all.find((a) => a.status === "ACTIVE") ?? null;
  const history = all.filter((a) => a.status !== "ACTIVE");

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Can permission="transport.assignments.manage">
          <Button
            disabled={Boolean(current)}
            title={current ? "End the current assignment first" : undefined}
            onClick={() => setAssignOpen(true)}
          >
            Assign vehicle and driver
          </Button>
        </Can>
      </div>
      {!list.allowed ? (
        <NoAccess what="route assignments" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : all.length === 0 ? (
        <EmptyState icon={Truck} label="No vehicle has been assigned to this route." />
      ) : (
        <>
          {current ? (
            <Card>
              <CardContent className="space-y-1 p-4 text-sm">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-gray-900">Current assignment</p>
                  {assignmentActions(current.status).length > 0 ? (
                    <Can permission="transport.assignments.manage">
                      <Button size="sm" variant="outline" onClick={() => setEnding(current)}>
                        End assignment
                      </Button>
                    </Can>
                  ) : null}
                </div>
                <p>
                  <span className="text-gray-500">Vehicle: </span>
                  {current.vehicle.registrationNo} ({vehicleTypeLabel[current.vehicle.type] ?? current.vehicle.type},{" "}
                  {current.vehicle.seatCapacity} seats)
                </p>
                <p>
                  <span className="text-gray-500">Driver: </span>
                  {current.driver.name}, {current.driver.licenseNo}
                  {current.driver.phone ? `, ${current.driver.phone}` : ""}
                </p>
                <p>
                  <span className="text-gray-500">Effective from: </span>
                  {formatDate(current.effectiveFrom)}
                </p>
                <p className="text-xs text-gray-500">Route capacity = this vehicle&apos;s seat capacity.</p>
              </CardContent>
            </Card>
          ) : (
            <p className="text-sm text-gray-600">This route has no active vehicle assignment.</p>
          )}
          {history.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Vehicle</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Effective from</TableHead>
                  <TableHead>Effective to</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>{a.vehicle.registrationNo}</TableCell>
                    <TableCell>{a.driver.name}</TableCell>
                    <TableCell>{formatDate(a.effectiveFrom)}</TableCell>
                    <TableCell>{formatDate(a.effectiveTo)}</TableCell>
                    <TableCell>
                      <TransportStatusBadge kind="assignment" status={a.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </>
      )}
      <Can permission="transport.assignments.manage">
        {assignOpen ? <AssignmentFormDialog open onOpenChange={setAssignOpen} routeId={routeId} /> : null}
        {ending ? (
          <EndAssignmentConfirm key={ending.id} routeId={routeId} assignment={ending} onClose={() => setEnding(null)} />
        ) : null}
      </Can>
    </div>
  );
}

function EndAssignmentConfirm({
  routeId,
  assignment,
  onClose,
}: {
  routeId: string;
  assignment: AssignmentRow;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const end = useEndAssignment(routeId, { toast: false });

  async function confirm() {
    setError(null);
    try {
      await end.mutateAsync(assignment.id);
      toast.success("Assignment ended");
      onClose();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  return (
    <ConfirmDialog
      open
      title="End assignment"
      description="End this assignment? The route will have no active vehicle, and new enrollments on it will be refused until a vehicle is assigned. Existing enrollments are not changed."
      confirmLabel="End assignment"
      destructive
      pending={end.isPending}
      onConfirm={() => void confirm()}
      onOpenChange={(o) => !o && onClose()}
    >
      {error ? <InlineError message={error} /> : null}
    </ConfirmDialog>
  );
}
