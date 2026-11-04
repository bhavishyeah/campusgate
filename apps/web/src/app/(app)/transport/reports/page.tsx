"use client";

import { useState } from "react";
import { BarChart3 } from "lucide-react";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { SectionNav, TRANSPORT_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { RosterTable } from "@/components/transport/RosterTable";
import { UtilizationTable } from "@/components/transport/UtilizationTable";
import { downloadRoster, useRoster, useRouteOptions, useUtilization } from "@/features/transport/hooks";
import { describeApiError } from "@/lib/apiErrors";

export default function TransportReportsPage() {
  return (
    <RouteGuard requirePermission="transport.view">
      <ReportsInner />
    </RouteGuard>
  );
}

function ReportsInner() {
  return (
    <div className="space-y-6">
      <SectionNav items={TRANSPORT_STAFF_NAV} />
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Reports</h1>
        <p className="text-sm text-gray-500">Route utilization and the active-enrollment roster.</p>
      </div>
      <Tabs defaultValue="utilization">
        <TabsList>
          <TabsTrigger value="utilization">Utilization</TabsTrigger>
          <TabsTrigger value="roster">Roster</TabsTrigger>
        </TabsList>
        <TabsContent value="utilization">
          <UtilizationTab />
        </TabsContent>
        <TabsContent value="roster">
          <RosterTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function UtilizationTab() {
  const q = useUtilization();
  if (!q.allowed) return <NoAccess what="the utilization report" />;
  if (q.isLoading) return <TableSkeleton />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />;
  const rows = q.data?.utilization ?? [];
  if (rows.length === 0) return <EmptyState icon={BarChart3} label="No routes yet." />;
  return <UtilizationTable rows={rows} />;
}

function RosterTab() {
  const [routeId, setRouteId] = useState("");
  const [exporting, setExporting] = useState(false);
  const routes = useRouteOptions();
  const roster = useRoster(routeId);

  async function onExport() {
    setExporting(true);
    try {
      await downloadRoster(routeId || undefined);
    } catch (err) {
      toast.error(describeApiError(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="w-56">
          <SimpleSelect
            ariaLabel="Route"
            value={routeId}
            onChange={setRouteId}
            noneLabel="All routes"
            placeholder="Route"
            options={(routes.data?.routes ?? []).map((r) => ({ value: r.id, label: `${r.code} - ${r.name}` }))}
          />
        </div>
        <Button variant="outline" disabled={exporting} onClick={() => void onExport()}>
          {exporting ? "Exporting..." : "Export XLSX"}
        </Button>
      </div>
      <p className="text-sm text-gray-500">Active enrollments.</p>
      {!roster.allowed ? (
        <NoAccess what="the roster" />
      ) : roster.isLoading ? (
        <TableSkeleton />
      ) : roster.isError ? (
        <ErrorBlock error={roster.error} onRetry={() => void roster.refetch()} />
      ) : (roster.data?.roster.length ?? 0) === 0 ? (
        <EmptyState icon={BarChart3} label="No active enrollments." />
      ) : (
        <RosterTable key={routeId} rows={roster.data?.roster ?? []} />
      )}
      <p className="text-xs text-gray-500">The export lists raw ids.</p>
    </div>
  );
}
