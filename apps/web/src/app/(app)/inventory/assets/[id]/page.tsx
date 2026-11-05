"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Boxes } from "lucide-react";
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
import { AssetFormDialog } from "@/components/inventory/AssetFormDialog";
import { TransferDialog } from "@/components/inventory/TransferDialog";
import { MaintenanceCreateDialog } from "@/components/inventory/MaintenanceCreateDialog";
import { DisposeDialog } from "@/components/inventory/DisposeDialog";
import { StockMovementDialog } from "@/components/inventory/StockMovementDialog";
import { ApiError } from "@/lib/api";
import { readIdParam } from "@/lib/paging";
import { useAsset, useCategoryOptions, useMaintenance, useStockItem } from "@/features/inventory/hooks";
import { assetActions } from "@/features/inventory/transitions";
import { custodianLabel, isTerminalAsset, onHandLabel } from "@/features/inventory/format";
import { assetStatusLabel } from "@/features/inventory/labels";
import { formatMinor } from "@/features/inventory/money";
import { formatDate } from "@/features/hr/format";

type Dialog = "edit" | "transfer" | "maintenance" | "dispose" | "movement" | null;

export default function AssetDetailPage() {
  return (
    <RouteGuard requirePermission="inventory.view">
      <AssetDetailInner />
    </RouteGuard>
  );
}

function AssetDetailInner() {
  const params = useParams<{ id: string }>();
  const id = readIdParam(params.id) ?? "";
  const asset = useAsset(id);
  const categories = useCategoryOptions();
  const [dialog, setDialog] = useState<Dialog>(null);

  const category = (categories.data?.categories ?? []).find((c) => c.id === asset.data?.categoryId);
  const consumable = category?.kind === "CONSUMABLE";
  const stock = useStockItem(consumable ? id : "");
  const maintenance = useMaintenance({ assetId: id, page: 1 });

  const notFound = asset.isError && asset.error instanceof ApiError && asset.error.status === 404;

  return (
    <div className="space-y-6">
      <SectionNav items={INVENTORY_STAFF_NAV} />
      {!asset.allowed ? (
        <NoAccess what="this asset" />
      ) : asset.isLoading ? (
        <TableSkeleton />
      ) : notFound ? (
        <EmptyState icon={Boxes} label="Asset not found." />
      ) : asset.isError || !asset.data ? (
        <ErrorBlock error={asset.error} onRetry={() => void asset.refetch()} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">
                {asset.data.assetTag} - {asset.data.name}
              </h1>
              <div className="mt-1 flex items-center gap-2">
                <InventoryStatusBadge kind="asset" status={asset.data.status} />
                <span className="text-sm text-gray-500">{custodianLabel(asset.data)}</span>
              </div>
            </div>
            {!isTerminalAsset(asset.data.status) ? (
              <div className="flex flex-wrap gap-2">
                <Can permission="inventory.assets.manage">
                  <Button size="sm" variant="outline" onClick={() => setDialog("edit")}>
                    Edit
                  </Button>
                  {assetActions(asset.data.status).includes("TRANSFER") ? (
                    <Button size="sm" variant="outline" onClick={() => setDialog("transfer")}>
                      Transfer
                    </Button>
                  ) : null}
                </Can>
                {assetActions(asset.data.status).includes("MAINTENANCE") ? (
                  <Can permission="inventory.maintenance.manage">
                    <Button size="sm" variant="outline" onClick={() => setDialog("maintenance")}>
                      Open maintenance
                    </Button>
                  </Can>
                ) : null}
                {assetActions(asset.data.status).includes("DISPOSE") ? (
                  <Can permission="inventory.disposals.manage">
                    <Button size="sm" variant="destructive" onClick={() => setDialog("dispose")}>
                      Dispose
                    </Button>
                  </Can>
                ) : null}
              </div>
            ) : null}
          </div>

          {isTerminalAsset(asset.data.status) ? (
            <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
              This asset is {assetStatusLabel[asset.data.status]} and cannot be changed.
            </div>
          ) : null}

          <Card>
            <CardContent className="grid gap-3 p-4 sm:grid-cols-2">
              <Detail label="Category" value={category?.name ?? "-"} />
              <Detail label="Status" value={assetStatusLabel[asset.data.status] ?? asset.data.status} />
              <Detail label="Acquisition date" value={formatDate(asset.data.acquisitionDate)} />
              <Detail label="Acquisition cost" value={formatMinor(asset.data.acquisitionCost)} />
              <Detail label="Currency" value={asset.data.currency ?? "-"} />
              <Detail label="Location" value={asset.data.location ?? "-"} />
            </CardContent>
          </Card>

          {consumable ? (
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">Consumable stock</h2>
                    <p className="text-sm text-gray-500">
                      {stock.data ? `On-hand: ${onHandLabel(stock.data.stockItem)}` : "Loading stock..."}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Can permission="inventory.stock.manage">
                      <Button size="sm" variant="outline" onClick={() => setDialog("movement")} disabled={!stock.data}>
                        Record movement
                      </Button>
                    </Can>
                    <Link href={`/inventory/stock/${id}`} className="text-sm text-primary-600 underline self-center">
                      Open ledger
                    </Link>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <div>
            <h2 className="text-lg font-semibold text-gray-900">Maintenance history</h2>
            {maintenance.isLoading ? (
              <TableSkeleton />
            ) : maintenance.isError ? (
              <ErrorBlock error={maintenance.error} onRetry={() => void maintenance.refetch()} />
            ) : (maintenance.data?.requests.length ?? 0) === 0 ? (
              <p className="text-sm text-gray-500">No maintenance requests for this asset.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Issue</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Cost</TableHead>
                    <TableHead>Reported</TableHead>
                    <TableHead>Resolved</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {maintenance.data?.requests.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="max-w-xs truncate" title={r.issue}>
                        {r.issue}
                      </TableCell>
                      <TableCell>
                        <InventoryStatusBadge kind="maintenance" status={r.status} />
                      </TableCell>
                      <TableCell>{formatMinor(r.cost)}</TableCell>
                      <TableCell>{formatDate(r.createdAt)}</TableCell>
                      <TableCell>{formatDate(r.resolvedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          {dialog === "edit" ? (
            <Can permission="inventory.assets.manage">
              <AssetFormDialog open onOpenChange={() => setDialog(null)} asset={asset.data} />
            </Can>
          ) : null}
          {dialog === "transfer" ? (
            <Can permission="inventory.assets.manage">
              <TransferDialog open onOpenChange={() => setDialog(null)} asset={asset.data} />
            </Can>
          ) : null}
          {dialog === "maintenance" ? (
            <Can permission="inventory.maintenance.manage">
              <MaintenanceCreateDialog open onOpenChange={() => setDialog(null)} assetId={id} />
            </Can>
          ) : null}
          {dialog === "dispose" ? (
            <Can permission="inventory.disposals.manage">
              <DisposeDialog open onOpenChange={() => setDialog(null)} asset={asset.data} />
            </Can>
          ) : null}
          {dialog === "movement" && stock.data ? (
            <Can permission="inventory.stock.manage">
              <StockMovementDialog
                open
                onOpenChange={() => setDialog(null)}
                assetId={id}
                onHand={stock.data.stockItem.onHandQuantity}
              />
            </Can>
          ) : null}
        </>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-sm text-gray-900">{value}</p>
    </div>
  );
}
