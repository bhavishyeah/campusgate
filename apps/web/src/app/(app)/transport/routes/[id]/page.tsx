"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Route as RouteIcon } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { SectionNav, TRANSPORT_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { TransportStatusBadge } from "@/components/transport/StatusBadges";
import { RouteAssignmentPanel } from "@/components/transport/RouteAssignmentPanel";
import { RouteSchedulesPanel } from "@/components/transport/RouteSchedulesPanel";
import { RouteStopsPanel } from "@/components/transport/RouteStopsPanel";
import { useRoute } from "@/features/transport/hooks";
import { formatFee } from "@/features/transport/money";
import { ApiError } from "@/lib/api";

export default function RouteDetailPage() {
  return (
    <RouteGuard requirePermission="transport.view">
      <RouteDetailInner />
    </RouteGuard>
  );
}

function RouteDetailInner() {
  const { id } = useParams<{ id: string }>();
  const route = useRoute(id);
  const notFound =
    route.error instanceof ApiError && route.error.status === 404 && route.error.data?.error === "route not found";

  return (
    <div className="space-y-6">
      <SectionNav items={TRANSPORT_STAFF_NAV} />
      <Link href="/transport" className="text-sm text-primary-600 underline">
        Back to routes
      </Link>
      {!route.allowed ? (
        <NoAccess what="this route" />
      ) : route.isLoading ? (
        <TableSkeleton />
      ) : notFound ? (
        <EmptyState icon={RouteIcon} label="Route not found." />
      ) : route.isError ? (
        <ErrorBlock error={route.error} onRetry={() => void route.refetch()} />
      ) : route.data ? (
        <>
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">
              {route.data.code} - {route.data.name}
            </h1>
            <p className="mt-1 flex items-center gap-2 text-sm text-gray-500">
              <TransportStatusBadge kind="route" status={route.data.status} />
              <span>Fee: {formatFee(route.data.feeAmount)}</span>
            </p>
          </div>
          <Tabs defaultValue="stops">
            <TabsList>
              <TabsTrigger value="stops">Stops</TabsTrigger>
              <TabsTrigger value="schedules">Schedules</TabsTrigger>
              <TabsTrigger value="assignment">Assignment</TabsTrigger>
            </TabsList>
            <TabsContent value="stops">
              <RouteStopsPanel routeId={route.data.id} />
            </TabsContent>
            <TabsContent value="schedules">
              <RouteSchedulesPanel routeId={route.data.id} />
            </TabsContent>
            {/* Radix mounts only the active tab, so the assignments query is lazy. */}
            <TabsContent value="assignment">
              <RouteAssignmentPanel routeId={route.data.id} />
            </TabsContent>
          </Tabs>
        </>
      ) : null}
    </div>
  );
}
