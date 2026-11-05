"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { PackageSearch } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { INVENTORY_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { InventoryStatusBadge } from "@/components/inventory/StatusBadges";
import { StockMovementDialog } from "@/components/inventory/StockMovementDialog";
import { ApiError } from "@/lib/api";
import { readIdParam } from "@/lib/paging";
import { useStockItem } from "@/features/inventory/hooks";
import { onHandLabel } from "@/features/inventory/format";
import { formatDateTime } from "@/features/hr/format";

export default function StockDetailPage() {
  return (
    <RouteGuard requirePermission="inventory.view">
      <StockDetailInner />
    </RouteGuard>
  );
}

function StockDetailInner() {
  const params = useParams<{ assetId: string }>();
  const assetId = readIdParam(params.assetId) ?? "";
  const stock = useStockItem(assetId);
  const [open, setOpen] = useState(false);
  const notFound = stock.isError && stock.error instanceof ApiError && stock.error.status === 404;

  return (
    <div className="space-y-6">
      <SectionNav items={INVENTORY_STAFF_NAV} />
      {!stock.allowed ? (
        <NoAccess what="this stock item" />
      ) : stock.isLoading ? (
        <TableSkeleton />
      ) : notFound ? (
        <EmptyState icon={PackageSearch} label="Stock item not found." />
      ) : stock.isError || !stock.data ? (
        <ErrorBlock error={stock.error} onRetry={() => void stock.refetch()} />
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <h1 className="text-2xl font-semibold text-gray-900">
                  {stock.data.stockItem.assetTag ?? stock.data.stockItem.assetId}
                </h1>
                <p className="text-sm text-gray-500">On-hand: {onHandLabel(stock.data.stockItem)}</p>
              </div>
              <Can permission="inventory.stock.manage">
                <Button onClick={() => setOpen(true)}>Record movement</Button>
              </Can>
            </CardContent>
          </Card>

          <div>
            <h2 className="text-lg font-semibold text-gray-900">Movement ledger</h2>
            {stock.data.movements.length === 0 ? (
              <p className="text-sm text-gray-500">No movements recorded yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Quantity</TableHead>
                    <TableHead>Balance after</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stock.data.movements.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>{formatDateTime(m.createdAt)}</TableCell>
                      <TableCell>
                        <InventoryStatusBadge kind="stock" status={m.kind} />
                      </TableCell>
                      <TableCell>{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</TableCell>
                      <TableCell>{m.balanceAfter}</TableCell>
                      <TableCell>{m.reason ?? "-"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          {open ? (
            <Can permission="inventory.stock.manage">
              <StockMovementDialog
                open
                onOpenChange={setOpen}
                assetId={assetId}
                onHand={stock.data.stockItem.onHandQuantity}
              />
            </Can>
          ) : null}
        </>
      )}
    </div>
  );
}
