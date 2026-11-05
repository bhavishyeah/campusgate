"use client";

import { useState } from "react";
import Link from "next/link";
import { PackageSearch } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { INVENTORY_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { PAGE_SIZE, useStockItems } from "@/features/inventory/hooks";

export default function StockPage() {
  return (
    <RouteGuard requirePermission="inventory.view">
      <StockInner />
    </RouteGuard>
  );
}

function StockInner() {
  const [page, setPage] = useState(1);
  const list = useStockItems(page);

  return (
    <div className="space-y-6">
      <SectionNav items={INVENTORY_STAFF_NAV} />
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Consumable stock</h1>
        <p className="text-sm text-gray-500">On-hand quantities for consumable assets.</p>
      </div>

      {!list.allowed ? (
        <NoAccess what="inventory stock" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data || list.data.stockItems.length === 0 ? (
        <EmptyState icon={PackageSearch} label="No consumable stock items yet." />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset tag</TableHead>
                <TableHead>On-hand</TableHead>
                <TableHead>Reorder level</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.stockItems.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.assetTag ?? s.assetId}</TableCell>
                  <TableCell>{s.onHandQuantity}</TableCell>
                  <TableCell>{s.reorderLevel ?? "-"}</TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Link href={`/inventory/stock/${s.assetId}`} className="text-sm text-primary-600 underline">
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
    </div>
  );
}
