"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeftRight } from "lucide-react";
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
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { SectionNav, LIBRARY_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { IssueLoanDialog } from "@/components/library/IssueLoanDialog";
import { ReasonDialog } from "@/components/library/ReasonDialog";
import { describeApiError } from "@/lib/apiErrors";
import { LibraryStatusBadge } from "@/features/library/LibraryStatusBadge";
import {
  useLoans,
  useMarkLoanLost,
  useRenewLoan,
  useReturnLoan,
  useRunOverdueSweep,
} from "@/features/library/hooks";
import type { LoanListItem } from "@/features/library/types";

type Tab = "ACTIVE" | "OVERDUE" | "CLOSED";

export default function CirculationPage() {
  return (
    <RouteGuard requirePermission="library.books.view">
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <CirculationInner />
      </Suspense>
    </RouteGuard>
  );
}

function overdueDays(dueDate: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(dueDate).getTime()) / 86_400_000));
}

function CirculationInner() {
  const searchParams = useSearchParams();
  const studentId = searchParams.get("studentId") ?? undefined;
  const [tab, setTab] = useState<Tab>("ACTIVE");
  const [closedStatus, setClosedStatus] = useState<"RETURNED" | "LOST">("RETURNED");
  const [page, setPage] = useState(1);
  const [issueOpen, setIssueOpen] = useState(false);
  const [sweepOpen, setSweepOpen] = useState(false);
  const [returning, setReturning] = useState<LoanListItem | null>(null);
  const [losing, setLosing] = useState<LoanListItem | null>(null);

  const loans = useLoans({
    status: tab === "ACTIVE" ? "ACTIVE" : tab === "CLOSED" ? closedStatus : undefined,
    overdue: tab === "OVERDUE",
    studentId,
    page,
  });
  const renew = useRenewLoan();
  const returnMut = useReturnLoan();
  const lostMut = useMarkLoanLost();
  const sweep = useRunOverdueSweep();

  return (
    <div className="space-y-6">
      <SectionNav items={LIBRARY_STAFF_NAV} />

      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Circulation</h1>
          <p className="text-sm text-gray-500">
            Issue, return and renew loans.
            {studentId ? " Filtered to one student." : ""}
          </p>
          {studentId ? (
            <Link href="/library/circulation" className="text-sm text-primary-700 underline">
              Clear student filter
            </Link>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Can permission="library.books.view">
            <Button variant="outline" onClick={() => setSweepOpen(true)}>
              Run overdue sweep
            </Button>
          </Can>
          <Can permission="library.issue">
            <Button onClick={() => setIssueOpen(true)}>Issue a copy</Button>
          </Can>
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v as Tab);
          setPage(1);
        }}
      >
        <TabsList>
          <TabsTrigger value="ACTIVE">Active</TabsTrigger>
          <TabsTrigger value="OVERDUE">Overdue</TabsTrigger>
          <TabsTrigger value="CLOSED">Returned / Lost</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "CLOSED" ? (
        <div className="max-w-[12rem]">
          <SimpleSelect
            ariaLabel="Closed loan status"
            value={closedStatus}
            onChange={(v) => {
              setClosedStatus(v as "RETURNED" | "LOST");
              setPage(1);
            }}
            options={[
              { value: "RETURNED", label: "Returned" },
              { value: "LOST", label: "Lost" },
            ]}
          />
        </div>
      ) : null}

      {!loans.allowed ? (
        <NoAccess what="loans" />
      ) : loans.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : loans.isError ? (
        <div className="space-y-2">
          <InlineError message={describeApiError(loans.error)} />
          <Button variant="outline" size="sm" onClick={() => loans.refetch()}>
            Retry
          </Button>
        </div>
      ) : !loans.data || loans.data.loans.length === 0 ? (
        <EmptyState icon={ArrowLeftRight} label="No loans" description="Nothing to show for this view." />
      ) : (
        <>
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Accession</TableHead>
                  <TableHead>Issued</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Renewals</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loans.data.loans.map((l) => {
                  const open = l.status === "ACTIVE" || l.status === "OVERDUE";
                  return (
                    <TableRow key={l.id}>
                      <TableCell>
                        <div className="font-medium">{l.student.name}</div>
                        <div className="text-xs text-gray-500">{l.student.enrollmentNo ?? "—"}</div>
                      </TableCell>
                      <TableCell>{l.bookCopy.bookTitle.title}</TableCell>
                      <TableCell className="font-mono text-xs">{l.bookCopy.accessionNumber}</TableCell>
                      <TableCell>{new Date(l.issueDate).toLocaleDateString()}</TableCell>
                      <TableCell>{new Date(l.dueDate).toLocaleDateString()}</TableCell>
                      <TableCell>{l.renewalCount}</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <LibraryStatusBadge kind="loan" status={l.status} />
                          {l.isOverdue ? (
                            <span className="text-xs text-danger-700">
                              Overdue by {overdueDays(l.dueDate)} day(s)
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {open ? (
                          <Can permission="library.return">
                            <div className="flex gap-2 justify-end">
                              <Button variant="ghost" size="sm" onClick={() => setReturning(l)}>
                                Return
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={l.status === "OVERDUE" || renew.isPending}
                                title={
                                  l.status === "OVERDUE"
                                    ? "Renewal is only available for loans that are not marked overdue"
                                    : undefined
                                }
                                onClick={() => renew.mutate(l.id, { onSuccess: () => toast.success("Loan renewed.") })}
                              >
                                Renew
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => setLosing(l)}>
                                Mark lost
                              </Button>
                            </div>
                          </Can>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <Pagination page={loans.data.page} pageSize={loans.data.pageSize} total={loans.data.total} onPage={setPage} />
        </>
      )}

      <Can permission="library.issue">
        {issueOpen ? <IssueLoanDialog open onOpenChange={setIssueOpen} /> : null}
      </Can>

      <Can permission="library.return">
        {returning ? (
          <ReasonDialog
            open
            onOpenChange={(v) => {
              if (!v) setReturning(null);
            }}
            title="Return this copy"
            description={`${returning.bookCopy.bookTitle.title} from ${returning.student.name}.`}
            confirmLabel="Return copy"
            hideField
            pending={returnMut.isPending}
            onConfirm={async () => {
              const res = await returnMut.mutateAsync(returning.id);
              toast.success(`Returned. ${res.overdueDays} day(s) overdue.`);
              if (res.fineId) toast.info("A fine was recorded.");
            }}
          />
        ) : null}
        {losing ? (
          <ReasonDialog
            open
            onOpenChange={(v) => {
              if (!v) setLosing(null);
            }}
            title="Mark copy as lost"
            description="Mark this copy as lost. This may create a fine."
            confirmLabel="Mark lost"
            destructive
            pending={lostMut.isPending}
            onConfirm={async (note) => {
              const res = await lostMut.mutateAsync({ id: losing.id, note: note || undefined });
              toast.success(res.fineId ? "Marked lost. A fine was recorded." : "Marked lost.");
            }}
          />
        ) : null}
      </Can>

      <Can permission="library.books.view">
        <ReasonDialog
          open={sweepOpen}
          onOpenChange={setSweepOpen}
          title="Run overdue sweep"
          description="Updates overdue loans, expires stale holds and sends reminders."
          confirmLabel="Run sweep"
          hideField
          pending={sweep.isPending}
          onConfirm={async () => {
            const res = await sweep.mutateAsync();
            toast.success(`${res.overdueCount} overdue, ${res.reminded} reminded`);
          }}
        />
      </Can>
    </div>
  );
}
