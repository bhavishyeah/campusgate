"use client";

import { useState } from "react";
import { toast } from "sonner";
import { FileBarChart } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { SERVICE_REQUESTS_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { RequestStatusBadge } from "@/components/service-requests/StatusBadges";
import {
  downloadExport,
  useFeedbackReport,
  useOverdueReport,
  useSlaReport,
  useTypes,
  useVolumeReport,
} from "@/features/service-requests/hooks";
import { volumeJoin } from "@/features/service-requests/format";
import { formatDateTime } from "@/features/hr/format";
import { slicePage } from "@/lib/paging";
import { describeApiError } from "@/lib/apiErrors";
import type { RequestRow } from "@/features/service-requests/types";

const TABS = ["overdue", "volume", "sla", "feedback"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { overdue: "Overdue", volume: "Volume", sla: "SLA", feedback: "Feedback" };
const SLICE = 50;

export default function ReportsPage() {
  return (
    <RouteGuard requirePermission="service_requests.view">
      <ReportsInner />
    </RouteGuard>
  );
}

function ReportsInner() {
  const [tab, setTab] = useState<Tab>("overdue");
  const [downloading, setDownloading] = useState(false);

  async function onExport() {
    setDownloading(true);
    try {
      await downloadExport();
    } catch (err) {
      toast.error(describeApiError(err));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionNav items={SERVICE_REQUESTS_STAFF_NAV} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Reports</h1>
          <p className="text-sm text-gray-500">The export lists raw ids.</p>
        </div>
        <Can permission="service_requests.view">
          <Button variant="outline" disabled={downloading} onClick={() => void onExport()}>
            {downloading ? "Exporting..." : "Export XLSX"}
          </Button>
        </Can>
      </div>
      <nav aria-label="Report tabs" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1 rounded-full text-sm font-medium ${
              tab === t ? "bg-primary-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </nav>

      {tab === "overdue" ? <OverdueTab /> : null}
      {tab === "volume" ? <VolumeTab /> : null}
      {tab === "sla" ? <SlaTab /> : null}
      {tab === "feedback" ? <FeedbackTab /> : null}
    </div>
  );
}

function OverdueTab() {
  const [atRiskHours, setAtRiskHours] = useState(24);
  const [input, setInput] = useState("24");
  const [overduePage, setOverduePage] = useState(1);
  const [atRiskPage, setAtRiskPage] = useState(1);
  const q = useOverdueReport(atRiskHours);

  function apply() {
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= 8760) setAtRiskHours(n);
    else setAtRiskHours(24);
  }

  if (!q.allowed) return <NoAccess what="the overdue report" />;
  if (q.isLoading) return <TableSkeleton />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />;

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div className="w-40">
          <label className="text-xs text-gray-500">At-risk hours</label>
          <Input type="number" value={input} onChange={(e) => setInput(e.target.value)} />
        </div>
        <Button variant="outline" size="sm" onClick={apply}>
          Apply
        </Button>
      </div>
      <RequestTable title="Overdue" rows={q.data?.overdue ?? []} page={overduePage} setPage={setOverduePage} />
      <RequestTable title="At risk" rows={q.data?.atRisk ?? []} page={atRiskPage} setPage={setAtRiskPage} />
    </div>
  );
}

function RequestTable({ title, rows, page, setPage }: { title: string; rows: RequestRow[]; page: number; setPage: (p: number) => void }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">None.</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Due</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {slicePage(rows, page, SLICE).map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.title}</TableCell>
                  <TableCell>
                    <RequestStatusBadge status={r.status} />
                  </TableCell>
                  <TableCell>{formatDateTime(r.dueAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination page={page} pageSize={SLICE} total={rows.length} onPage={setPage} />
        </>
      )}
    </div>
  );
}

function VolumeTab() {
  const [page, setPage] = useState(1);
  const q = useVolumeReport();
  const types = useTypes();
  if (!q.allowed) return <NoAccess what="the volume report" />;
  if (q.isLoading) return <TableSkeleton />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />;
  const rows = volumeJoin(q.data?.data ?? [], types.data ?? []);
  if (rows.length === 0) return <EmptyState icon={FileBarChart} label="No volume data." />;
  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Type</TableHead>
            <TableHead>Count</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {slicePage(rows, page, SLICE).map((r) => (
            <TableRow key={r.requestTypeId}>
              <TableCell className="font-medium">{r.name}</TableCell>
              <TableCell>{r.count}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Pagination page={page} pageSize={SLICE} total={rows.length} onPage={setPage} />
    </div>
  );
}

function SlaTab() {
  const q = useSlaReport();
  if (!q.allowed) return <NoAccess what="the SLA report" />;
  if (q.isLoading) return <TableSkeleton />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <StatCard label="Total resolved" value={String(q.data?.totalResolved ?? 0)} />
      <StatCard label="Within SLA" value={String(q.data?.withinSla ?? 0)} />
      <StatCard label="Compliance" value={q.data?.compliancePct != null ? `${q.data.compliancePct}%` : "-"} />
    </div>
  );
}

function FeedbackTab() {
  const q = useFeedbackReport();
  if (!q.allowed) return <NoAccess what="the feedback report" />;
  if (q.isLoading) return <TableSkeleton />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <StatCard label="Feedback count" value={String(q.data?.count ?? 0)} />
      <StatCard label="Average rating" value={q.data?.averageRating != null ? String(q.data.averageRating) : "-"} />
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-sm text-gray-500">{label}</p>
        <p className="text-2xl font-semibold text-gray-900">{value}</p>
      </CardContent>
    </Card>
  );
}
