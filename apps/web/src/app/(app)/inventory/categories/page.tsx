"use client";

import { useState } from "react";
import { FolderTree } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { INVENTORY_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { CategoryFormDialog } from "@/components/inventory/CategoryFormDialog";
import { PAGE_SIZE, useCategories } from "@/features/inventory/hooks";
import { assetKindLabel, toOptions } from "@/features/inventory/labels";
import type { Category } from "@/features/inventory/types";

export default function CategoriesPage() {
  return (
    <RouteGuard requirePermission="inventory.view">
      <CategoriesInner />
    </RouteGuard>
  );
}

function CategoriesInner() {
  const [kind, setKind] = useState("");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<{ category?: Category } | null>(null);
  const list = useCategories({ kind: kind || undefined, page });

  return (
    <div className="space-y-6">
      <SectionNav items={INVENTORY_STAFF_NAV} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Categories</h1>
          <p className="text-sm text-gray-500">Asset categories with optional depreciation metadata.</p>
        </div>
        <Can permission="inventory.categories.manage">
          <Button onClick={() => setDialog({})}>New category</Button>
        </Can>
      </div>
      <div className="w-44">
        <SimpleSelect
          ariaLabel="Kind"
          value={kind}
          onChange={(v) => {
            setKind(v);
            setPage(1);
          }}
          noneLabel="All kinds"
          placeholder="Kind"
          options={toOptions(assetKindLabel)}
        />
      </div>

      {!list.allowed ? (
        <NoAccess what="inventory categories" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.categories.length === 0 ? (
        <EmptyState icon={FolderTree} label={kind ? "No categories match this filter." : "No categories yet."} />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Depreciation method</TableHead>
                <TableHead>Useful life (months)</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.categories.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.code}</TableCell>
                  <TableCell>{c.name}</TableCell>
                  <TableCell>{assetKindLabel[c.kind] ?? c.kind}</TableCell>
                  <TableCell>{c.depreciationMethod ?? "-"}</TableCell>
                  <TableCell>{c.usefulLifeMonths ?? "-"}</TableCell>
                  <TableCell>
                    <Can permission="inventory.categories.manage">
                      <div className="flex justify-end">
                        <Button size="sm" variant="outline" onClick={() => setDialog({ category: c })}>
                          Edit
                        </Button>
                      </div>
                    </Can>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination page={list.data.page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </>
      )}

      <Can permission="inventory.categories.manage">
        {dialog ? (
          <CategoryFormDialog
            key={dialog.category?.id ?? "new"}
            open
            onOpenChange={(o) => !o && setDialog(null)}
            category={dialog.category}
          />
        ) : null}
      </Can>
    </div>
  );
}
