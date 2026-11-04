"use client";

import { useState } from "react";
import { BookOpen, UserX } from "lucide-react";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
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
import { SectionNav, LIBRARY_STUDENT_NAV } from "@/components/ui-ext/SectionNav";
import { describeApiError } from "@/lib/apiErrors";
import { useCatalogue, useReserveTitle, isNoStudentProfile } from "@/features/library/hooks";
import { useDebouncedValue } from "@/features/library/useDebouncedValue";

export default function StudentCataloguePage() {
  return (
    <RouteGuard requirePermission="library.view_own">
      <StudentCatalogueInner />
    </RouteGuard>
  );
}

function StudentCatalogueInner() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const debounced = useDebouncedValue(search, 300);
  const catalogue = useCatalogue({ q: debounced || undefined, page });
  const reserve = useReserveTitle();
  const [noProfile, setNoProfile] = useState(false);

  function onReserve(titleId: string) {
    reserve.mutate(titleId, {
      onSuccess: (r) => toast.success(`Reserved. Queue position ${r.queuePosition}`),
      onError: (err) => {
        if (isNoStudentProfile(err) && describeApiError(err) === "student not found") setNoProfile(true);
      },
    });
  }

  return (
    <div className="space-y-6">
      <SectionNav items={LIBRARY_STUDENT_NAV} />
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Browse catalogue</h1>
        <p className="text-sm text-gray-500">Search the library and reserve titles with no free copy.</p>
      </div>

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

      {noProfile ? (
        <EmptyState icon={UserX} label="No student record is linked to your account." />
      ) : catalogue.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : catalogue.isError ? (
        <InlineError message={describeApiError(catalogue.error)} />
      ) : !catalogue.data || catalogue.data.titles.length === 0 ? (
        <EmptyState icon={BookOpen} label="No titles found" description="Try a different search." />
      ) : (
        <>
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Author</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Available</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {catalogue.data.titles.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.title}</TableCell>
                    <TableCell>{t.author}</TableCell>
                    <TableCell>{t.category ?? "—"}</TableCell>
                    <TableCell>{t.availableCopies}</TableCell>
                    <TableCell className="text-right">
                      <Can permission="library.view_own">
                        <div className="flex flex-col items-end gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={t.availableCopies > 0 || reserve.isPending}
                            onClick={() => onReserve(t.id)}
                          >
                            Reserve
                          </Button>
                          {t.availableCopies > 0 ? (
                            <span className="text-xs text-gray-500">Copies available. Ask at the desk to borrow</span>
                          ) : null}
                        </div>
                      </Can>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination page={catalogue.data.page} pageSize={catalogue.data.pageSize} total={catalogue.data.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}
