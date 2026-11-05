"use client";

import { useState } from "react";
import { toast } from "sonner";
import { FileBarChart } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { INVENTORY_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { InventoryStatusBadge } from "@/components/inventory/StatusBadges";
import {
  downloadRegister,
  useCustody,
  useDisposals,
  useLowStock,
  useRegister,
} from "@/features/inventory/hooks";
import { custodianLabel, onHandLabel } from "@/features/inventory/format";
import { assetStatusLabel, disposalMethodLabel } from "@/features/inventory/labels";
import { formatMinor } from "@/features/inventory/money";
import { formatDate } from "@/features/hr/format";
import { slicePage } from "@/lib/paging";
import { describeApiError } from "@/lib/apiErrors";

const TABS = ["register", "custody", "low-stock", "disposals"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  register: "Register",
  custody: "Custody",
  "low-stock": "Low stock",
  disposals: "Disposals",
};
const SLICE = 50;

export default function ReportsPage() {
  return (
    <RouteGuard requirePermission="inventory.view">
      <ReportsInner />
    </RouteGuard>
  );
}

function ReportsInner() {
  const [tab, setTab] = useState<Tab>("register");
  const [page, setPage] = useState(1);

  return (
    <div className="space-y-6">
      <SectionNav items={INVENTORY_STAFF_NAV} />
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Reports</h1>
        <p className="text-sm text-gray-500">The register export lists raw ids.</p>
      </div>
      <nav aria-label="Report tabs" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => {
              setTab(t);
              setPage(1);
            }}
            className={`px-3 py-1 rounded-full text-sm font-medium ${
              tab === t ? "bg-primary-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </nav>

      {tab === "register" ? <RegisterTab page={page} setPage={setPage} /> : null}
      {tab === "custody" ? <CustodyTab page={page} setPage={setPage} /> : null}
      {tab === "low-stock" ? <LowStockTab page={page} setPage={setPage} /> : null}
      {tab === "disposals" ? <DisposalsTab page={page} setPage={setPage} /> : null}
    </div>
  );
}

interface TabProps {
  page: number;
  setPage: (p: number) => void;
}

function RegisterTab({ page, setPage }: TabProps) {
  const q = useRegister();
  const [downloading, setDownloading] = useState(false);
  const rows = q.data?.register ?? [];

  async function onExport() {
    setDownloading(true);
    try {
      await downloadRegister();
    } catch (err) {
      toast.error(describeApiError(err));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Can permission="inventory.view">
          <Button variant="outline" disabled={downloading} onClick={() => void onExport()}>
            {downloading ? "Exporting..." : "Export XLSX"}
          </Button>
        </Can>
      </div>
      {!q.allowed ? (
        <NoAccess what="the register report" />
      ) : q.isLoading ? (
        <TableSkeleton />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={FileBarChart} label="No assets in the register." />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset tag</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Custodian</TableHead>
                <TableHead>Acquisition cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {slicePage(rows, page, SLICE).map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">{a.assetTag}</TableCell>
                  <TableCell>{a.name}</TableCell>
                  <TableCell>
                    <InventoryStatusBadge kind="asset" status={a.status} />
                  </TableCell>
                  <TableCell>{custodianLabel(a)}</TableCell>
                  <TableCell>{formatMinor(a.acquisitionCost)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination page={page} pageSize={SLICE} total={rows.length} onPage={setPage} />
          <p className="text-xs text-gray-500">The export lists raw ids.</p>
        </>
      )}
    </div>
  );
}

function CustodyTab({ page, setPage }: TabProps) {
  const q = useCustody();
  const rows = q.data?.custody ?? [];
  return (
    <ReportTable
      allowed={q.allowed}
      loading={q.isLoading}
      error={q.isError ? q.error : null}
      onRetry={() => void q.refetch()}
      empty={rows.length === 0}
      emptyLabel="No assets currently have a custodian."
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Asset tag</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Custodian</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {slicePage(rows, page, SLICE).map((a) => (
            <TableRow key={a.id}>
              <TableCell className="font-medium">{a.assetTag}</TableCell>
              <TableCell>{a.name}</TableCell>
              <TableCell>{assetStatusLabel[a.status] ?? a.status}</TableCell>
              <TableCell>{custodianLabel(a)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Pagination page={page} pageSize={SLICE} total={rows.length} onPage={setPage} />
    </ReportTable>
  );
}

function LowStockTab({ page, setPage }: TabProps) {
  const q = useLowStock();
  const rows = q.data?.lowStock ?? [];
  return (
    <ReportTable
      allowed={q.allowed}
      loading={q.isLoading}
      error={q.isError ? q.error : null}
      onRetry={() => void q.refetch()}
      empty={rows.length === 0}
      emptyLabel="No items are at or below their reorder level."
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Asset tag</TableHead>
            <TableHead>On-hand</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {slicePage(rows, page, SLICE).map((s) => (
            <TableRow key={s.id}>
              <TableCell className="font-medium">{s.assetTag ?? s.assetId}</TableCell>
              <TableCell>{onHandLabel(s)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Pagination page={page} pageSize={SLICE} total={rows.length} onPage={setPage} />
    </ReportTable>
  );
}

function DisposalsTab({ page, setPage }: TabProps) {
  const q = useDisposals();
  const rows = q.data?.disposals ?? [];
  return (
    <ReportTable
      allowed={q.allowed}
      loading={q.isLoading}
      error={q.isError ? q.error : null}
      onRetry={() => void q.refetch()}
      empty={rows.length === 0}
      emptyLabel="No disposals recorded."
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Terminal status</TableHead>
            <TableHead>Method</TableHead>
            <TableHead>Proceeds</TableHead>
            <TableHead>Disposed at</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {slicePage(rows, page, SLICE).map((d) => (
            <TableRow key={d.id}>
              <TableCell>{assetStatusLabel[d.terminalStatus] ?? d.terminalStatus}</TableCell>
              <TableCell>{disposalMethodLabel[d.method] ?? d.method}</TableCell>
              <TableCell>{formatMinor(d.proceeds)}</TableCell>
              <TableCell>{formatDate(d.disposedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Pagination page={page} pageSize={SLICE} total={rows.length} onPage={setPage} />
    </ReportTable>
  );
}

function ReportTable({
  allowed,
  loading,
  error,
  onRetry,
  empty,
  emptyLabel,
  children,
}: {
  allowed: boolean;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  empty: boolean;
  emptyLabel: string;
  children: React.ReactNode;
}) {
  if (!allowed) return <NoAccess what="this report" />;
  if (loading) return <TableSkeleton />;
  if (error) return <ErrorBlock error={error} onRetry={onRetry} />;
  if (empty) return <EmptyState icon={FileBarChart} label={emptyLabel} />;
  return <div className="space-y-3">{children}</div>;
}
