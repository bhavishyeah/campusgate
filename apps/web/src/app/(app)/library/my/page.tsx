"use client";

import { useState } from "react";
import { BookOpen, UserX } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Badge } from "@/components/ui/badge";
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
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { SectionNav, LIBRARY_STUDENT_NAV } from "@/components/ui-ext/SectionNav";
import { ReasonDialog } from "@/components/library/ReasonDialog";
import { describeApiError } from "@/lib/apiErrors";
import { formatRupeeDecimal } from "@/features/library/format";
import { LibraryStatusBadge } from "@/features/library/LibraryStatusBadge";
import { fineReasonLabel } from "@/features/library/labels";
import {
  isNoStudentProfile,
  useCancelMyReservation,
  useMyFines,
  useMyLoanHistory,
  useMyLoans,
  useMyReservations,
} from "@/features/library/hooks";
import type { MyReservation } from "@/features/library/types";

type Tab = "loans" | "reservations" | "history" | "fines";

export default function MyLibraryPage() {
  return (
    <RouteGuard requirePermission="library.view_own">
      <MyLibraryInner />
    </RouteGuard>
  );
}

function MyLibraryInner() {
  const [tab, setTab] = useState<Tab>("loans");
  return (
    <div className="space-y-6">
      <SectionNav items={LIBRARY_STUDENT_NAV} />
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">My library</h1>
        <p className="text-sm text-gray-500">Your loans, reservations, history and fines.</p>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="loans">My loans</TabsTrigger>
          <TabsTrigger value="reservations">Reservations</TabsTrigger>
          <TabsTrigger value="history">Loan history</TabsTrigger>
          <TabsTrigger value="fines">Fines</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "loans" ? <LoansTab /> : null}
      {tab === "reservations" ? <ReservationsTab /> : null}
      {tab === "history" ? <HistoryTab /> : null}
      {tab === "fines" ? <FinesTab /> : null}
    </div>
  );
}

/** Shared loading/error/no-profile/no-access ordering for each tab. */
function TabState<T>({
  query,
  what,
  isEmpty,
  emptyLabel,
  children,
}: {
  query: UseQueryResult<T> & { allowed: boolean };
  what: string;
  isEmpty: (data: T) => boolean;
  emptyLabel: string;
  children: (data: T) => React.ReactNode;
}) {
  if (!query.allowed) return <NoAccess what={what} />;
  if (query.isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    if (isNoStudentProfile(query.error)) {
      return <EmptyState icon={UserX} label="No student record is linked to your account." />;
    }
    return (
      <div className="space-y-2">
        <InlineError message={describeApiError(query.error)} />
        <Button variant="outline" size="sm" onClick={() => query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!query.data || isEmpty(query.data)) {
    return <EmptyState icon={BookOpen} label={emptyLabel} />;
  }
  return <div className="card p-0 overflow-hidden">{children(query.data)}</div>;
}

function daysText(dueDate: string): string {
  const days = Math.ceil((new Date(dueDate).getTime() - Date.now()) / 86_400_000);
  return days >= 0 ? `${days} day(s) left` : `${-days} day(s) overdue`;
}

function LoansTab() {
  const loans = useMyLoans();
  return (
    <TabState query={loans} what="your loans" isEmpty={(d) => d.loans.length === 0} emptyLabel="No active loans">
      {(d) => (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Author</TableHead>
              <TableHead>Issued</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.loans.map((l) => {
              const overdue = l.status === "OVERDUE" || (l.status === "ACTIVE" && new Date(l.dueDate).getTime() < Date.now());
              return (
                <TableRow key={l.id}>
                  <TableCell className="font-medium">{l.bookCopy.bookTitle.title}</TableCell>
                  <TableCell>{l.bookCopy.bookTitle.author}</TableCell>
                  <TableCell>{new Date(l.issueDate).toLocaleDateString()}</TableCell>
                  <TableCell>
                    {new Date(l.dueDate).toLocaleDateString()}
                    <div className="text-xs text-gray-500">{daysText(l.dueDate)}</div>
                  </TableCell>
                  <TableCell>
                    {overdue ? (
                      <Badge variant="outline" className="bg-danger-50 text-danger-700 border-danger-500">
                        Overdue
                      </Badge>
                    ) : (
                      <LibraryStatusBadge kind="loan" status={l.status} />
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </TabState>
  );
}

function ReservationsTab() {
  const reservations = useMyReservations();
  const cancel = useCancelMyReservation();
  const [target, setTarget] = useState<MyReservation | null>(null);
  return (
    <>
      <TabState
        query={reservations}
        what="your reservations"
        isEmpty={(d) => d.reservations.length === 0}
        emptyLabel="No reservations"
      >
        {(d) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Queue position</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.reservations.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.bookTitle.title}</TableCell>
                  <TableCell>{r.queuePosition}</TableCell>
                  <TableCell>
                    <LibraryStatusBadge kind="reservation" status={r.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    {r.status === "PENDING" ? (
                      <Can permission="library.view_own">
                        <Button variant="ghost" size="sm" onClick={() => setTarget(r)}>
                          Cancel reservation
                        </Button>
                      </Can>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TabState>
      <Can permission="library.view_own">
        {target ? (
          <ReasonDialog
            open
            onOpenChange={(v) => {
              if (!v) setTarget(null);
            }}
            title="Cancel reservation"
            description={`Cancel your reservation for ${target.bookTitle.title}.`}
            confirmLabel="Cancel reservation"
            destructive
            hideField
            pending={cancel.isPending}
            onConfirm={async () => {
              await cancel.mutateAsync(target.id);
              toast.success("Reservation cancelled.");
            }}
          />
        ) : null}
      </Can>
    </>
  );
}

function HistoryTab() {
  const history = useMyLoanHistory();
  return (
    <TabState query={history} what="your loan history" isEmpty={(d) => d.loans.length === 0} emptyLabel="No past loans">
      {(d) => (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Issued</TableHead>
              <TableHead>Returned</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.loans.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="font-medium">{l.bookCopy.bookTitle.title}</TableCell>
                <TableCell>{new Date(l.issueDate).toLocaleDateString()}</TableCell>
                <TableCell>{l.returnDate ? new Date(l.returnDate).toLocaleDateString() : "—"}</TableCell>
                <TableCell>
                  <LibraryStatusBadge kind="loan" status={l.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </TabState>
  );
}

function FinesTab() {
  const fines = useMyFines();
  return (
    <TabState query={fines} what="your fines" isEmpty={(d) => d.fines.length === 0} emptyLabel="No fines">
      {(d) => (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reason</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.fines.map((f) => (
              <TableRow key={f.id}>
                <TableCell>{fineReasonLabel[f.reason]}</TableCell>
                <TableCell className="tabular-nums">{formatRupeeDecimal(f.amount)}</TableCell>
                <TableCell>
                  <LibraryStatusBadge kind="fine" status={f.status} />
                </TableCell>
                <TableCell>{new Date(f.createdAt).toLocaleDateString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </TabState>
  );
}
