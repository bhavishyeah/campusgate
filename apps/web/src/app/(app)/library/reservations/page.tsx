"use client";

import { useState } from "react";
import { BookMarked } from "lucide-react";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { Pagination } from "@/components/ui-ext/Pagination";
import { SectionNav, LIBRARY_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { FulfilDialog } from "@/components/library/FulfilDialog";
import { ReasonDialog } from "@/components/library/ReasonDialog";
import { describeApiError } from "@/lib/apiErrors";
import { LibraryStatusBadge } from "@/features/library/LibraryStatusBadge";
import { useCancelHold, useCollectReservation, useReservationQueue } from "@/features/library/hooks";
import type { ReservationListItem } from "@/features/library/types";

type Tab = "PENDING" | "FULFILLED" | "CANCELLED" | "EXPIRED";

export default function ReservationsPage() {
  return (
    <RouteGuard requirePermission="library.books.view">
      <ReservationsInner />
    </RouteGuard>
  );
}

function ReservationsInner() {
  const [tab, setTab] = useState<Tab>("PENDING");
  const [page, setPage] = useState(1);
  const [fulfilling, setFulfilling] = useState<ReservationListItem | null>(null);
  const [collecting, setCollecting] = useState<ReservationListItem | null>(null);
  const [cancelling, setCancelling] = useState<ReservationListItem | null>(null);

  const queue = useReservationQueue({ status: tab, page });
  const collect = useCollectReservation();
  const cancelHold = useCancelHold();

  // Hint only: the lowest queuePosition PENDING row per title in this page.
  const lowestByTitle = new Map<string, number>();
  for (const r of queue.data?.reservations ?? []) {
    if (r.status !== "PENDING") continue;
    const cur = lowestByTitle.get(r.bookTitleId);
    if (cur === undefined || r.queuePosition < cur) lowestByTitle.set(r.bookTitleId, r.queuePosition);
  }

  return (
    <div className="space-y-6">
      <SectionNav items={LIBRARY_STAFF_NAV} />

      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Reservations</h1>
        <p className="text-sm text-gray-500">Hold queue by title.</p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v as Tab);
          setPage(1);
        }}
      >
        <TabsList>
          <TabsTrigger value="PENDING">Pending</TabsTrigger>
          <TabsTrigger value="FULFILLED">Parked for pickup</TabsTrigger>
          <TabsTrigger value="CANCELLED">Cancelled</TabsTrigger>
          <TabsTrigger value="EXPIRED">Expired</TabsTrigger>
        </TabsList>
      </Tabs>

      {queue.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : queue.isError ? (
        <InlineError message={describeApiError(queue.error)} />
      ) : !queue.data || queue.data.reservations.length === 0 ? (
        <EmptyState icon={BookMarked} label="Nothing here" description="No reservations in this state." />
      ) : (
        <>
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Queue #</TableHead>
                  <TableHead>Student</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Reserved at</TableHead>
                  <TableHead>Parked copy</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queue.data.reservations.map((r) => {
                  const isHead = lowestByTitle.get(r.bookTitleId) === r.queuePosition;
                  return (
                    <TableRow key={r.id}>
                      <TableCell>{r.queuePosition}</TableCell>
                      <TableCell>
                        <div className="font-medium">{r.student.name}</div>
                        <div className="text-xs text-gray-500">{r.student.enrollmentNo ?? "—"}</div>
                      </TableCell>
                      <TableCell>{r.bookTitle.title}</TableCell>
                      <TableCell>{new Date(r.reservedAt).toLocaleString()}</TableCell>
                      <TableCell className="font-mono text-xs">{r.fulfilledByCopy?.accessionNumber ?? "—"}</TableCell>
                      <TableCell>
                        <LibraryStatusBadge kind="reservation" status={r.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Can permission="library.reservations.manage">
                          <div className="flex gap-2 justify-end">
                            {r.status === "PENDING" ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={!isHead}
                                title={isHead ? undefined : "Only the head of the queue can be allotted"}
                                onClick={() => setFulfilling(r)}
                              >
                                Allot copy
                              </Button>
                            ) : null}
                            {r.status === "FULFILLED" ? (
                              <Button variant="ghost" size="sm" onClick={() => setCollecting(r)}>
                                Issue parked copy
                              </Button>
                            ) : null}
                            {(r.status === "PENDING" || r.status === "FULFILLED") ? (
                              <Button variant="ghost" size="sm" onClick={() => setCancelling(r)}>
                                Cancel hold
                              </Button>
                            ) : null}
                          </div>
                        </Can>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <Pagination page={queue.data.page} pageSize={queue.data.pageSize} total={queue.data.total} onPage={setPage} />
        </>
      )}

      <Can permission="library.reservations.manage">
        {fulfilling ? (
          <FulfilDialog
            reservation={fulfilling}
            onOpenChange={(v) => {
              if (!v) setFulfilling(null);
            }}
          />
        ) : null}
        {collecting ? (
          <ReasonDialog
            open
            onOpenChange={(v) => {
              if (!v) setCollecting(null);
            }}
            title="Issue parked copy"
            description={`Creates a loan for ${collecting.student.name}.`}
            confirmLabel="Issue parked copy"
            hideField
            pending={collect.isPending}
            onConfirm={async () => {
              await collect.mutateAsync(collecting.id);
              toast.success("Loan created.");
            }}
          />
        ) : null}
        {cancelling ? (
          <ReasonDialog
            open
            onOpenChange={(v) => {
              if (!v) setCancelling(null);
            }}
            title="Cancel hold"
            description="Releases any parked copy back to availability."
            confirmLabel="Cancel hold"
            destructive
            pending={cancelHold.isPending}
            onConfirm={async (reason) => {
              await cancelHold.mutateAsync({ id: cancelling.id, reason: reason || undefined });
              toast.success("Hold cancelled.");
            }}
          />
        ) : null}
      </Can>
    </div>
  );
}
