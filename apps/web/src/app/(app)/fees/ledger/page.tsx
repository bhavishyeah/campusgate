"use client";

import { useState } from "react";
import { BookOpen } from "lucide-react";
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
import { useStudentLedger } from "@/features/fees/hooks";

export default function LedgerPage() {
  const [input, setInput] = useState("");
  const [studentId, setStudentId] = useState("");
  const ledger = useStudentLedger(studentId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Student Ledger</h1>
        <p className="text-sm text-gray-500">
          Look up a student&apos;s charges and outstanding balance.
        </p>
      </div>

      <form
        className="flex items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setStudentId(input.trim());
        }}
      >
        <div className="flex-1 max-w-sm">
          <Label htmlFor="studentId">Student ID</Label>
          <Input
            id="studentId"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Enter a student id"
          />
        </div>
        <Button type="submit" disabled={!input.trim()}>
          Load
        </Button>
      </form>

      {!studentId ? (
        <EmptyState
          icon={BookOpen}
          label="No student selected"
          description="Enter a student id to view their ledger."
        />
      ) : ledger.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : ledger.isError ? (
        <InlineError
          message={
            ledger.error instanceof ApiError && ledger.error.status === 404
              ? "No student found for that id."
              : ledger.error instanceof ApiError
                ? ledger.error.message
                : "Failed to load the ledger."
          }
        />
      ) : ledger.data ? (
        <div className="space-y-4">
          <div className="card flex items-center justify-between">
            <span className="text-sm text-gray-600">Total outstanding</span>
            <span className="text-xl font-semibold tabular-nums text-gray-900">
              {formatPaise(ledger.data.outstandingPaise)}
            </span>
          </div>

          {ledger.data.charges.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              label="No charges"
              description="This student has no posted charges."
            />
          ) : (
            <div className="card p-0 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ledger.data.charges.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.category}</TableCell>
                      <TableCell className="text-gray-600">
                        {c.description}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatPaise(c.amountPaise)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatPaise(c.outstandingPaise)}
                      </TableCell>
                      <TableCell>
                        <FeeStatusBadge status={c.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
