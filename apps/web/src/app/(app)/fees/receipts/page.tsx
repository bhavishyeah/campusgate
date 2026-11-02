"use client";

import { Receipt as ReceiptIcon } from "lucide-react";
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
import { useReceipts } from "@/features/fees/hooks";

export default function ReceiptsPage() {
  const { data, isLoading, isError, error } = useReceipts();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Receipts</h1>
        <p className="text-sm text-gray-500">Issued receipts, newest first.</p>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : isError ? (
        <InlineError
          message={
            error instanceof ApiError ? error.message : "Failed to load receipts."
          }
        />
      ) : !data || data.receipts.length === 0 ? (
        <EmptyState
          icon={ReceiptIcon}
          label="No receipts yet"
          description="Receipts are issued once payments are captured."
        />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Receipt #</TableHead>
                <TableHead className="text-right">Sequence</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Issued</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.receipts.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.receiptNumber}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.sequence}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatPaise(r.amountPaise)}
                  </TableCell>
                  <TableCell className="text-gray-600">
                    {new Date(r.issuedAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
