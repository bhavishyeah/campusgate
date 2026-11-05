"use client";

import { ScrollText } from "lucide-react";
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
import { useAuditEvents } from "@/features/platform/hooks";
import type { AuditScope } from "@/features/platform/keys";
import { ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";

/**
 * Renders the newest `limit` audit events (limit-based, no cursor/offset). A
 * 403 "Grant access denied" surfaces inline (no logout); an empty set shows an
 * empty state. The query is disabled until the parent's filters are valid.
 */
export function AuditTable({
  scope,
  grantId,
  limit,
  enabled,
}: {
  scope: AuditScope;
  grantId: string | null;
  limit: number;
  enabled: boolean;
}) {
  const events = useAuditEvents(scope, grantId, limit, enabled);

  if (!enabled) {
    return (
      <EmptyState
        icon={ScrollText}
        label="Set your filters to load events."
      />
    );
  }

  if (events.isLoading) return <Skeleton className="h-40 w-full" />;

  if (events.isError) {
    const err = events.error;
    if (
      err instanceof ApiError &&
      err.status === 403 &&
      err.data?.error === "Grant access denied"
    ) {
      return <InlineError message="Grant access denied" />;
    }
    return <InlineError message={describeApiError(err)} />;
  }

  const rows = events.data?.events ?? [];
  if (rows.length === 0) {
    return <EmptyState icon={ScrollText} label="No audit events." />;
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-500">most recent {limit} events</p>
      <div className="card p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Timestamp</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Institution</TableHead>
              <TableHead>Actor</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((ev) => (
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
                  {ev.institutionId ?? "platform"}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {ev.actorUserId ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
