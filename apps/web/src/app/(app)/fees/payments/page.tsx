"use client";

import { CreditCard } from "lucide-react";
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
import { usePayments } from "@/features/fees/hooks";

export default function PaymentsPage() {
  const { data, isLoading, isError, error } = usePayments();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Payments</h1>
        <p className="text-sm text-gray-500">
          The latest payment transactions.
        </p>
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
            error instanceof ApiError ? error.message : "Failed to load payments."
          }
        />
      ) : !data || data.payments.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          label="No payments yet"
          description="Payment transactions appear here once students pay."
        />
      ) : (
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
              {data.payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.studentId}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatPaise(p.amountPaise)}
                  </TableCell>
                  <TableCell>
                    <FeeStatusBadge status={p.status} />
                  </TableCell>
                  <TableCell className="text-gray-600 font-mono text-xs">
                    {p.razorpayOrderId}
                  </TableCell>
                  <TableCell className="text-gray-600">
                    {new Date(p.createdAt).toLocaleString()}
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
