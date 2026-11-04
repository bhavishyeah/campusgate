"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FileCheck } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { useMyResult } from "@/features/exams/hooks";
import { EXAM_PERM } from "@/features/exams/permissions";
import { formatPercent } from "@/features/exams/ids";

export default function ResultDetailPage() {
  return (
    <RouteGuard requirePermission={EXAM_PERM.viewOwn}>
      <ResultDetailInner />
    </RouteGuard>
  );
}

function ResultDetailInner() {
  const params = useParams<{ examId: string }>();
  const { data, isLoading, isError, error } = useMyResult(params.examId);

  if (isLoading) return <Skeleton className="h-24 w-full" />;

  if (isError) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <EmptyState
          icon={FileCheck}
          label="Result not available"
          description="There is no published result for this exam."
          action={
            <Button asChild variant="outline">
              <Link href="/exams/my-results">Back to my results</Link>
            </Button>
          }
        />
      );
    }
    return (
      <InlineError
        message={error instanceof ApiError ? error.message : "Failed to load result."}
      />
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-semibold text-gray-900">Result</h1>
        <Badge variant="outline">v{data.version}</Badge>
      </div>
      <div className="card p-0 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Subject ID</TableHead>
              <TableHead>Percent</TableHead>
              <TableHead>Grade</TableHead>
              <TableHead>Grade points</TableHead>
              <TableHead>Passed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.snapshots.map((s) => (
              <TableRow key={s.subjectId}>
                <TableCell>{s.subjectId}</TableCell>
                <TableCell>{formatPercent(s.percentBps)}%</TableCell>
                <TableCell>{s.gradeLabel}</TableCell>
                <TableCell>{s.gradePoints}</TableCell>
                <TableCell>{s.passed ? "Yes" : "No"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
