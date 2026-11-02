"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, ScanSearch } from "lucide-react";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { ApiError } from "@/lib/api";
import { formatPaise } from "@/lib/money";
import { FeeStatusBadge } from "@/features/fees/FeeStatusBadge";
import {
  useReconciliation,
  useRunReconciliation,
  type ReconciliationQuery,
} from "@/features/fees/hooks";

export default function ReconciliationPage() {
  const [query, setQuery] = useState<ReconciliationQuery>({
    thresholdMinutes: 30,
    page: 1,
    pageSize: 20,
  });
  const recon = useReconciliation(query);
  const runRecon = useRunReconciliation();

  const onRun = () => {
    runRecon.mutate(
      { thresholdMinutes: query.thresholdMinutes },
      {
        onSuccess: (summary) => {
          toast.success(
            `Scanned ${summary.scanned} · captured ${summary.captured} · failed ${summary.failed} · still open ${summary.stillOpen}`,
          );
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">
            Reconciliation
          </h1>
          <p className="text-sm text-gray-500">
            Stuck payment transactions and a manual reconciliation sweep.
          </p>
        </div>
        <Can permission="fees.collect">
          <Button onClick={onRun} disabled={runRecon.isPending}>
            {runRecon.isPending && (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            )}
            {runRecon.isPending ? "Running…" : "Run"}
          </Button>
        </Can>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="threshold">Threshold (minutes)</Label>
          <Input
            id="threshold"
            type="number"
            min={1}
            className="w-40"
            value={query.thresholdMinutes}
            onChange={(e) =>
              setQuery((q) => ({
                ...q,
                thresholdMinutes: Number(e.target.value) || 1,
                page: 1,
              }))
            }
          />
        </div>
        <div>
          <Label htmlFor="page">Page</Label>
          <Input
            id="page"
            type="number"
            min={1}
            className="w-28"
            value={query.page}
            onChange={(e) =>
              setQuery((q) => ({ ...q, page: Number(e.target.value) || 1 }))
            }
          />
        </div>
        <div>
          <Label htmlFor="pageSize">Page size</Label>
          <Input
            id="pageSize"
            type="number"
            min={1}
            max={100}
            className="w-28"
            value={query.pageSize}
            onChange={(e) =>
              setQuery((q) => ({
                ...q,
                pageSize: Number(e.target.value) || 20,
                page: 1,
              }))
            }
          />
        </div>
      </div>

      {recon.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : recon.isError ? (
        <InlineError
          message={
            recon.error instanceof ApiError
              ? recon.error.message
              : "Failed to load reconciliation data."
          }
        />
      ) : !recon.data || recon.data.stuck.length === 0 ? (
        <EmptyState
          icon={ScanSearch}
          label="No stuck payments"
          description="No transactions are stuck past the threshold."
        />
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-gray-500">
            {recon.data.total} stuck transaction(s) past{" "}
            {recon.data.thresholdMinutes} minutes.
          </p>
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Order ID</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recon.data.stuck.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.studentId}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPaise(s.amountPaise)}
                    </TableCell>
                    <TableCell>
                      <FeeStatusBadge status={s.status} />
                    </TableCell>
                    <TableCell className="text-gray-600 font-mono text-xs">
                      {s.razorpayOrderId}
                    </TableCell>
                    <TableCell className="text-gray-600">
                      {new Date(s.createdAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
