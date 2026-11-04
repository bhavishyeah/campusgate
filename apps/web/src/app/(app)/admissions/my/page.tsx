"use client";

import Link from "next/link";
import { FileText, Megaphone } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { describeApiError } from "@/lib/apiErrors";
import { ApplicationStatusBadge } from "@/features/admissions/ApplicationStatusBadge";
import { useMyApplications, useOpenCampaigns } from "@/features/admissions/hooks";

export default function MyAdmissionsPage() {
  return (
    <RouteGuard requirePermission="admissions.view_own">
      <MyAdmissionsInner />
    </RouteGuard>
  );
}

function MyAdmissionsInner() {
  const mine = useMyApplications();
  const open = useOpenCampaigns(1);
  const applications = mine.data?.applications ?? [];
  const byCampaign = new Map(applications.map((a) => [a.campaignId, a]));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">My application</h1>
        <p className="text-sm text-gray-500">Apply to an open campaign and follow your application.</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-900">My applications</h2>
        {!mine.allowed ? (
          <NoAccess what="your applications" />
        ) : mine.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : mine.isError ? (
          <InlineError message={describeApiError(mine.error)} />
        ) : applications.length === 0 ? (
          <EmptyState icon={FileText} label="No applications yet" description="Choose an open campaign below to start." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {applications.map((a) => (
              <Card key={a.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{a.campaign?.name ?? "Campaign"}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="text-gray-600">
                    {a.program?.name ?? "Program"} · {a.applicationNumber}
                  </div>
                  <div className="flex items-center justify-between">
                    {a.status === "ENROLLED" ? (
                      <span className="font-medium text-success-700">Enrolled</span>
                    ) : (
                      <ApplicationStatusBadge status={a.status} />
                    )}
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`/admissions/my/${a.id}`}>Open</Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-900">Open for applications</h2>
        {!open.allowed ? (
          <NoAccess what="open campaigns" />
        ) : open.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : open.isError ? (
          <InlineError message={describeApiError(open.error)} />
        ) : !open.data || open.data.campaigns.length === 0 ? (
          <EmptyState icon={Megaphone} label="No campaigns are open right now" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {open.data.campaigns.map((c) => {
              const existing = byCampaign.get(c.id);
              return (
                <Card key={c.id}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">{c.name}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <div className="text-gray-600">Programs: {c.programs.map((p) => p.name).join(", ") || "—"}</div>
                    {c.closeAt ? (
                      <div className="text-xs text-gray-500">Closes {new Date(c.closeAt).toLocaleString()}</div>
                    ) : null}
                    <Can permission="admissions.view_own">
                      <Button size="sm" asChild>
                        <Link href={existing ? `/admissions/my/${existing.id}` : `/admissions/apply/${c.id}`}>
                          {existing ? "Continue" : "Apply"}
                        </Link>
                      </Button>
                    </Can>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
