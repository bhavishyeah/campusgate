"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ScrollText } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { useAccessLog } from "@/features/documents/hooks";
import { readIdParam } from "@/lib/paging";

export default function AccessLogPage() {
  return (
    <RouteGuard requirePermission="documents.audit.view">
      <AccessLogInner />
    </RouteGuard>
  );
}

function AccessLogInner() {
  const params = useParams<{ id: string }>();
  const id = readIdParam(params.id) ?? "";
  const log = useAccessLog(id);

  return (
    <div className="space-y-6">
      <Link href={`/documents/${id}`} className="text-sm text-primary-600 underline">
        ← Back to document
      </Link>
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Access log</h1>
        <p className="text-sm text-gray-500">Append-only ledger of access events for this document.</p>
      </div>

      {!log.allowed ? (
        <NoAccess what="this access log" />
      ) : log.isLoading ? (
        <TableSkeleton />
      ) : log.isError ? (
        <ErrorBlock error={log.error} onRetry={() => void log.refetch()} />
      ) : !log.data || log.data.length === 0 ? (
        <EmptyState icon={ScrollText} label="No access events recorded." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Version</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {log.data.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{new Date(row.createdAt).toLocaleString()}</TableCell>
                <TableCell className="font-medium">{row.action}</TableCell>
                <TableCell>{row.actorUserId ?? "-"}</TableCell>
                <TableCell>{row.versionId ?? "-"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
