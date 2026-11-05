"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ScrollText } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ConfirmDialog } from "@/components/ui-ext/ConfirmDialog";
import { BreakGlassWarning } from "@/components/platform/BreakGlassWarning";
import { useBreakGlassOverview, useSupportGrants } from "@/features/platform/hooks";
import { PLATFORM_PERM } from "@/features/platform/permissions";
import type { SupportGrant } from "@/features/platform/types";
import { ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";

function OverviewInner({ grantId }: { grantId: string }) {
  // Self-sufficient resolution (design C.6.5): resolve the grant from the list
  // client-side rather than a by-id read, which keeps the audited break-glass
  // fetch gated behind an explicit confirmation.
  const grantsQuery = useSupportGrants();
  const grant = useMemo<SupportGrant | undefined>(
    () => grantsQuery.data?.find((g) => g.id === grantId),
    [grantsQuery.data, grantId],
  );

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const overview = useBreakGlassOverview(grantId, confirmed);

  if (grantsQuery.isLoading) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (grantsQuery.isError) {
    return <InlineError message={describeApiError(grantsQuery.error)} />;
  }
  if (!grant) {
    return <NoAccess what="this support grant" />;
  }

  const institutionLabel = grant.institutionId;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href="/platform/support-grants"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Support grants
        </Link>
        <h2 className="text-2xl font-bold text-gray-900">Break-glass overview</h2>
      </div>

      <BreakGlassWarning purpose={grant.purpose} institutionLabel={institutionLabel} />

      {!confirmed ? (
        <div className="card">
          <p className="text-sm text-gray-600">
            Opening this view performs an audited read of the tenant&apos;s recent
            audit events and movement passes.
          </p>
          <Button className="mt-4" onClick={() => setConfirmOpen(true)}>
            Open audited view
          </Button>
        </div>
      ) : (
        <OverviewBody overview={overview} />
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Confirm break-glass access"
        description={`You are about to read tenant data for institution ${institutionLabel}. Purpose: ${grant.purpose}. This access is audited.`}
        confirmLabel="I understand, proceed"
        destructive
        onConfirm={() => {
          setConfirmed(true);
          setConfirmOpen(false);
        }}
        onOpenChange={setConfirmOpen}
      />
    </div>
  );
}

function OverviewBody({
  overview,
}: {
  overview: ReturnType<typeof useBreakGlassOverview>;
}) {
  if (overview.isLoading) return <Skeleton className="h-40 w-full" />;

  if (overview.isError) {
    const err = overview.error;
    if (err instanceof ApiError) {
      // 403 denials: inline forbidden with the exact server message, no logout.
      if (
        err.status === 403 &&
        (err.data?.error === "Break-glass access denied" ||
          err.data?.error === "Institution suspended")
      ) {
        return <InlineError message={err.data.error} />;
      }
      // 500 "Audit write failed": canned message + note the access was aborted.
      if (err.status >= 500) {
        return (
          <div className="space-y-2">
            <InlineError message={describeApiError(err)} />
            <p className="text-sm text-gray-500">
              The audited access could not be recorded, so it was aborted and no
              tenant data was returned.
            </p>
          </div>
        );
      }
    }
    return <InlineError message={describeApiError(err)} />;
  }

  const data = overview.data;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-lg font-semibold text-gray-900">Recent audit events</h3>
        {data.auditEvents.length === 0 ? (
          <EmptyState icon={ScrollText} label="No audit events." />
        ) : (
          <div className="card p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Actor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.auditEvents.map((ev) => (
                  <TableRow key={ev.id}>
                    <TableCell className="text-xs">
                      {new Date(ev.timestamp).toLocaleString()}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{ev.action}</TableCell>
                    <TableCell>
                      <Badge
                        variant={ev.outcome === "SUCCESS" ? "default" : "destructive"}
                      >
                        {ev.outcome}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {ev.actorUserId ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-lg font-semibold text-gray-900">Recent passes</h3>
        <p className="text-sm text-gray-500">
          {data.passes.length} recent movement pass
          {data.passes.length === 1 ? "" : "es"}.
        </p>
      </section>
    </div>
  );
}

export default function SupportGrantOverviewPage() {
  const params = useParams();
  const raw = params?.id;
  const id = Array.isArray(raw) ? raw[0] : raw;

  if (!id) return <NoAccess what="this support grant" />;

  return (
    <RouteGuard requirePermission={PLATFORM_PERM.supportGrant}>
      <OverviewInner grantId={id} />
    </RouteGuard>
  );
}
