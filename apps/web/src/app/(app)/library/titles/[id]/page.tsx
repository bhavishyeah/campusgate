"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { BookOpen, Plus } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
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
import { SectionNav, LIBRARY_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { CopyActionsMenu } from "@/components/library/CopyActionsMenu";
import { CopyFormDialog } from "@/components/library/CopyFormDialog";
import { TitleFormDialog } from "@/components/library/TitleFormDialog";
import { IssueLoanDialog } from "@/components/library/IssueLoanDialog";
import { ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";
import { LibraryStatusBadge } from "@/features/library/LibraryStatusBadge";
import { copyConditionLabel } from "@/features/library/labels";
import { useTitle } from "@/features/library/hooks";
import type { BookCopy } from "@/features/library/types";

export default function TitleDetailPage() {
  return (
    <RouteGuard requirePermission="library.books.view">
      <TitleDetailInner />
    </RouteGuard>
  );
}

function TitleDetailInner() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const title = useTitle(id);
  const [editOpen, setEditOpen] = useState(false);
  const [addCopyOpen, setAddCopyOpen] = useState(false);
  const [issueCopy, setIssueCopy] = useState<BookCopy | null>(null);

  if (title.isLoading) {
    return (
      <div className="space-y-6">
        <SectionNav items={LIBRARY_STAFF_NAV} />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (title.isError) {
    if (title.error instanceof ApiError && title.error.status === 404) {
      return (
        <div className="space-y-6">
          <SectionNav items={LIBRARY_STAFF_NAV} />
          <EmptyState icon={BookOpen} label="Not found" description="This title does not exist." />
        </div>
      );
    }
    return (
      <div className="space-y-6">
        <SectionNav items={LIBRARY_STAFF_NAV} />
        <InlineError message={describeApiError(title.error)} />
      </div>
    );
  }

  const t = title.data;
  if (!t) return null;
  const withdrawn = t.status === "WITHDRAWN";

  return (
    <div className="space-y-6">
      <SectionNav items={LIBRARY_STAFF_NAV} />

      {withdrawn ? (
        <div role="status" className="bg-warning-50 border border-warning-500 text-warning-600 px-4 py-3 rounded-lg text-sm">
          This title is withdrawn.
        </div>
      ) : null}

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{t.title}</h1>
          <p className="text-sm text-gray-500">
            {t.author}
            {t.category ? ` · ${t.category}` : ""}
            {t.edition ? ` · Ed. ${t.edition}` : ""}
            {t.publicationYear ? ` · ${t.publicationYear}` : ""}
          </p>
          <p className="text-sm text-gray-500">ISBN: {t.isbn ?? "—"}</p>
          <p className="text-sm text-gray-700 mt-1">
            {t.availableCopies} of {t.copies.length} copies available
          </p>
        </div>
        <div className="flex gap-2">
          <Can permission="library.books.manage">
            <Button variant="outline" disabled={withdrawn} onClick={() => setEditOpen(true)}>
              Edit title
            </Button>
            <Button disabled={withdrawn} onClick={() => setAddCopyOpen(true)}>
              <Plus className="w-4 h-4 mr-1" /> Add copy
            </Button>
          </Can>
        </div>
      </div>

      {t.copies.length === 0 ? (
        <EmptyState icon={BookOpen} label="No copies yet" description="Add a copy to start circulating this title." />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Accession</TableHead>
                <TableHead>Shelf</TableHead>
                <TableHead>Condition</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Acquired</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {t.copies.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-mono text-xs">{c.accessionNumber}</TableCell>
                  <TableCell>{c.shelfLocation ?? "—"}</TableCell>
                  <TableCell>{copyConditionLabel[c.condition]}</TableCell>
                  <TableCell>
                    <LibraryStatusBadge kind="copy" status={c.status} />
                  </TableCell>
                  <TableCell>{c.acquiredAt ? new Date(c.acquiredAt).toLocaleDateString() : "—"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-2 justify-end">
                      {c.status === "AVAILABLE" ? (
                        <Can permission="library.issue">
                          <Button variant="ghost" size="sm" onClick={() => setIssueCopy(c)}>
                            Issue to student
                          </Button>
                        </Can>
                      ) : null}
                      <CopyActionsMenu copy={c} titleId={t.id} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Can permission="library.books.manage">
        {editOpen ? <TitleFormDialog open onOpenChange={setEditOpen} title={t} /> : null}
        {addCopyOpen ? <CopyFormDialog open onOpenChange={setAddCopyOpen} titleId={t.id} /> : null}
      </Can>
      <Can permission="library.issue">
        {issueCopy ? (
          <IssueLoanDialog
            open
            onOpenChange={(v) => {
              if (!v) setIssueCopy(null);
            }}
            copy={{ id: issueCopy.id, accessionNumber: issueCopy.accessionNumber, titleLabel: t.title }}
          />
        ) : null}
      </Can>
    </div>
  );
}
