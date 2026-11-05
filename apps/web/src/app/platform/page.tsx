"use client";

import { useEffect } from "react";
import { Building2, Users, ArrowLeftRight } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Skeleton } from "@/components/ui/skeleton";
import { InlineError } from "@/components/ui-ext/InlineError";
import { useMfaGate } from "@/components/platform/MfaEnrollmentGate";
import { useStats } from "@/features/platform/hooks";
import { PLATFORM_PERM } from "@/features/platform/permissions";
import { describeApiError } from "@/lib/apiErrors";

/** Super-admin landing: platform-wide stat cards. */
function DashboardInner() {
  const stats = useStats();
  const { reportError } = useMfaGate();

  // Route the query error through the MFA gate so a 403 "MFA enrollment
  // required" shows enrollment instead of a generic error.
  useEffect(() => {
    if (stats.error) reportError(stats.error);
  }, [stats.error, reportError]);

  if (stats.isLoading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold text-gray-900">Platform dashboard</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (stats.isError) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold text-gray-900">Platform dashboard</h2>
        <InlineError message={describeApiError(stats.error)} />
      </div>
    );
  }

  const data = stats.data;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900">Platform dashboard</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard
          icon={<Building2 className="h-5 w-5 text-gray-400" />}
          title="Institutions"
          value={data?.institutions.total ?? 0}
          detail={`Active: ${data?.institutions.active ?? 0} · Suspended: ${
            data?.institutions.suspended ?? 0
          }`}
        />
        <StatCard
          icon={<Users className="h-5 w-5 text-gray-400" />}
          title="Users"
          value={data?.users.total ?? 0}
          detail={`Students: ${data?.users.students ?? 0}`}
        />
        <StatCard
          icon={<ArrowLeftRight className="h-5 w-5 text-gray-400" />}
          title="Movement"
          value={data?.movement.totalPasses ?? 0}
          detail={`Currently outside: ${data?.movement.currentlyOutside ?? 0}`}
        />
      </div>
    </div>
  );
}

function StatCard({
  icon,
  title,
  value,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  value: number;
  detail: string;
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{title}</p>
        {icon}
      </div>
      <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
      <p className="mt-1 text-xs text-gray-500">{detail}</p>
    </div>
  );
}

export default function PlatformPage() {
  return (
    <RouteGuard requirePermission={PLATFORM_PERM.analyticsView}>
      <DashboardInner />
    </RouteGuard>
  );
}
