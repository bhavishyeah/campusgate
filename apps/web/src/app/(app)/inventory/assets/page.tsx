"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Boxes } from "lucide-react";
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
import { InventoryStatusBadge } from "@/components/inventory/StatusBadges";
import { AssetFormDialog } from "@/components/inventory/AssetFormDialog";
import { PAGE_SIZE, useAssets, useCategoryOptions } from "@/features/inventory/hooks";
import { custodianLabel } from "@/features/inventory/format";
import { assetStatusLabel, toOptions } from "@/features/inventory/labels";
import { formatMinor } from "@/features/inventory/money";
import { readIdParam, resolveKnownId } from "@/lib/paging";

export default function AssetsPage() {
  return (
    <RouteGuard requirePermission="inventory.view">
      <Suspense fallback={<TableSkeleton />}>
        <AssetsInner />
      </Suspense>
    </RouteGuard>
  );
}

const STATUS_OPTIONS = toOptions(assetStatusLabel);
const VALID_STATUS = new Set(Object.keys(assetStatusLabel));

function AssetsInner() {
  const params = useSearchParams();
  const [statusParam] = useState(() => {
    const s = params.get("status") ?? "";
    return VALID_STATUS.has(s) ? s : "";
  });
  const [status, setStatus] = useState(statusParam);
  const [categoryParam, setCategoryParam] = useState(() => readIdParam(params.get("categoryId")) ?? "");
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);

  const categories = useCategoryOptions();
  const categoryId = resolveKnownId(categoryParam || undefined, categories.data?.categories) ?? "";
  const list = useAssets({ status: status || undefined, categoryId: categoryId || undefined, page });
  const filtered = Boolean(status || categoryId);

  const categoryNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories.data?.categories ?? []) m.set(c.id, c.name);
    return m;
  }, [categories.data]);

  return (
    <div className="space-y-6">
      <SectionNav items={INVENTORY_STAFF_NAV} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Assets</h1>
          <p className="text-sm text-gray-500">Asset registry with lifecycle status and custody.</p>
        </div>
        <Can permission="inventory.assets.manage">
          <Button onClick={() => setDialogOpen(true)}>Add asset</Button>
        </Can>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="w-48">
          <SimpleSelect
            ariaLabel="Status"
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            noneLabel="All statuses"
            placeholder="Status"
            options={STATUS_OPTIONS}
          />
        </div>
        <div className="w-60">
          <SimpleSelect
            ariaLabel="Category"
            value={categoryId}
            onChange={(v) => {
              setCategoryParam(v);
              setPage(1);
            }}
            noneLabel="All categories"
            placeholder="Category"
            options={(categories.data?.categories ?? []).map((c) => ({ value: c.id, label: c.name }))}
          />
        </div>
      </div>

      {!list.allowed ? (
        <NoAccess what="inventory assets" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.assets.length === 0 ? (
        <EmptyState icon={Boxes} label={filtered ? "No assets match these filters." : "No assets yet."} />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset tag</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Custodian</TableHead>
                <TableHead>Acquisition cost</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.assets.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">{a.assetTag}</TableCell>
                  <TableCell>{a.name}</TableCell>
                  <TableCell>{categoryNameById.get(a.categoryId) ?? "-"}</TableCell>
                  <TableCell>
                    <InventoryStatusBadge kind="asset" status={a.status} />
                  </TableCell>
                  <TableCell>{custodianLabel(a)}</TableCell>
                  <TableCell>{formatMinor(a.acquisitionCost)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Link href={`/inventory/assets/${a.id}`} className="text-sm text-primary-600 underline">
                        Open
                      </Link>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination page={list.data.page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </>
      )}

      <Can permission="inventory.assets.manage">
        {dialogOpen ? <AssetFormDialog open onOpenChange={setDialogOpen} /> : null}
      </Can>
    </div>
  );
}
