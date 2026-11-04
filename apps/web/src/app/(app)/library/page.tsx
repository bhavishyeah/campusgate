"use client";

import { useState } from "react";
import Link from "next/link";
import { BookOpen, Plus } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { TitleFormDialog } from "@/components/library/TitleFormDialog";
import { describeApiError } from "@/lib/apiErrors";
import { formatRupeeDecimal } from "@/features/library/format";
import { LibraryStatusBadge } from "@/features/library/LibraryStatusBadge";
import { useDebouncedValue } from "@/features/library/useDebouncedValue";
import { useLibrarySummary, useTitles } from "@/features/library/hooks";

export default function LibraryCataloguePage() {
  return (
    <RouteGuard requirePermission="library.books.view">
      <LibraryCatalogueInner />
    </RouteGuard>
  );
}

function LibraryCatalogueInner() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const debounced = useDebouncedValue(search, 300);
  const summary = useLibrarySummary();
  const titles = useTitles({ q: debounced || undefined, page });

  return (
    <div className="space-y-6">
      <SectionNav items={LIBRARY_STAFF_NAV} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Library catalogue</h1>
          <p className="text-sm text-gray-500">Titles, copies and availability.</p>
        </div>
        <Can permission="library.books.manage">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Add title
          </Button>
        </Can>
      </div>

      {summary.allowed ? (
        summary.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : summary.isError ? (
          <InlineError message={describeApiError(summary.error)} />
        ) : summary.data ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
            <SummaryStat label="Titles" value={summary.data.totalTitles} />
            <SummaryStat label="Copies" value={summary.data.totalCopies} />
            <SummaryStat label="Active loans" value={summary.data.activeLoans} />
            <SummaryStat label="Overdue" value={summary.data.overdueLoans} />
            <SummaryStat label="Pending reservations" value={summary.data.pendingReservations} />
            <SummaryStat label="Outstanding fines" value={formatRupeeDecimal(summary.data.outstandingFinesTotal)} />
          </div>
        ) : null
      ) : null}

      <Input
        placeholder="Search title, author or ISBN"
        value={search}
        maxLength={300}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
        className="max-w-md"
      />

      {titles.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : titles.isError ? (
        <InlineError message={describeApiError(titles.error)} />
      ) : !titles.data || titles.data.titles.length === 0 ? (
        <EmptyState icon={BookOpen} label="No titles found" description="Try a different search or add a title." />
      ) : (
        <>
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Author</TableHead>
                  <TableHead>ISBN</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Available</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {titles.data.titles.map((t) => (
                  <TableRow key={t.id} className="cursor-pointer">
                    <TableCell className="font-medium">
                      <Link href={`/library/titles/${t.id}`}>{t.title}</Link>
                    </TableCell>
                    <TableCell>{t.author}</TableCell>
                    <TableCell>{t.isbn ?? "—"}</TableCell>
                    <TableCell>{t.category ?? "—"}</TableCell>
                    <TableCell>{t.availableCopies}</TableCell>
                    <TableCell>
                      <LibraryStatusBadge kind="title" status={t.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination page={titles.data.page} pageSize={titles.data.pageSize} total={titles.data.total} onPage={setPage} />
        </>
      )}

      <Can permission="library.books.manage">
        {createOpen ? <TitleFormDialog open onOpenChange={setCreateOpen} /> : null}
      </Can>
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-medium text-gray-500">{label}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-lg font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}
