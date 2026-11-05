"use client";

import { PackageSearch } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { InventoryStatusBadge } from "@/components/inventory/StatusBadges";
import { useMyAssets } from "@/features/inventory/hooks";

export default function MyAssetsPage() {
  return (
    <RouteGuard requirePermission="inventory.view_own">
      <MyAssetsInner />
    </RouteGuard>
  );
}

function MyAssetsInner() {
  const list = useMyAssets();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">My assets</h1>
        <p className="text-sm text-gray-500">Assets currently in your custody.</p>
      </div>

      {!list.allowed ? (
        <NoAccess what="your assets" />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : (list.data?.assets.length ?? 0) === 0 ? (
        <EmptyState icon={PackageSearch} label="No assets are in your custody." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Asset tag</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Location</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data?.assets.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium">{a.assetTag}</TableCell>
                <TableCell>{a.name}</TableCell>
                <TableCell>
                  <InventoryStatusBadge kind="asset" status={a.status} />
                </TableCell>
                <TableCell>{a.location ?? "-"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
