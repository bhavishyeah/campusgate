"use client";

import Link from "next/link";
import { Boxes } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { INVENTORY_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { useRegister, useLowStock, useDisposals } from "@/features/inventory/hooks";

export default function InventoryDashboardPage() {
  return (
    <RouteGuard requirePermission="inventory.view">
      <Dashboard />
    </RouteGuard>
  );
}

function Dashboard() {
  const register = useRegister();
  const lowStock = useLowStock();
  const disposals = useDisposals();
  const loading = register.isLoading || lowStock.isLoading || disposals.isLoading;
  const failure = register.isError ? register : lowStock.isError ? lowStock : disposals.isError ? disposals : null;

  const cards: { label: string; value: number; href: string }[] = [
    { label: "Assets in register", value: register.data?.register.length ?? 0, href: "/inventory/assets" },
    { label: "Low-stock items", value: lowStock.data?.lowStock.length ?? 0, href: "/inventory/reports" },
    { label: "Disposals", value: disposals.data?.disposals.length ?? 0, href: "/inventory/reports" },
  ];

  return (
    <div className="space-y-6">
      <SectionNav items={INVENTORY_STAFF_NAV} />
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Inventory</h1>
        <p className="text-sm text-gray-500">Assets, consumable stock, maintenance and stock-take audits.</p>
      </div>

      {!register.allowed ? (
        <NoAccess what="inventory" />
      ) : loading ? (
        <TableSkeleton />
      ) : failure ? (
        <ErrorBlock
          error={failure.error}
          onRetry={() => {
            void register.refetch();
            void lowStock.refetch();
            void disposals.refetch();
          }}
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            {cards.map((c) => (
              <Link key={c.label} href={c.href}>
                <Card className="transition-colors hover:bg-gray-50">
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{c.label}</p>
                    <p className="text-2xl font-semibold text-gray-900">{c.value}</p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            {[
              ["Categories", "/inventory/categories"],
              ["Assets", "/inventory/assets"],
              ["Maintenance", "/inventory/maintenance"],
              ["Stock", "/inventory/stock"],
              ["Audits", "/inventory/audits"],
              ["Reports", "/inventory/reports"],
            ].map(([label, href]) => (
              <Link key={href} href={href} className="text-primary-600 underline">
                {label}
              </Link>
            ))}
          </div>
          {cards.every((c) => c.value === 0) ? <EmptyState icon={Boxes} label="No inventory data yet." /> : null}
        </>
      )}
    </div>
  );
}
