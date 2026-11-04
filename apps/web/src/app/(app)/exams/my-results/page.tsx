"use client";

import Link from "next/link";
import { FileCheck } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ApiError } from "@/lib/api";
import { useMyResults, useMyResultsHistory } from "@/features/exams/hooks";
import { EXAM_PERM } from "@/features/exams/permissions";
import { formatDateTime } from "@/features/exams/ids";

export default function MyResultsPage() {
  return (
    <RouteGuard requirePermission={EXAM_PERM.viewOwn}>
      <MyResultsInner />
    </RouteGuard>
  );
}

function MyResultsInner() {
  const { data, isLoading, isError, error } = useMyResults();
  const history = useMyResultsHistory();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">My Results</h1>
        <p className="text-sm text-gray-500">Your latest published examination results.</p>
      </div>

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : isError ? (
        <InlineError
          message={error instanceof ApiError ? error.message : "Failed to load results."}
        />
      ) : !data || data.results.length === 0 ? (
        <EmptyState
          icon={FileCheck}
          label="No published results yet"
          description="Results appear here once they are published."
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {data.results.map((r) => {
            const passed = r.snapshots.filter((s) => s.passed).length;
            return (
              <Link
                key={r.examId}
                href={`/exams/my-results/${r.examId}`}
                className="card p-4 block hover:bg-gray-50"
              >
                <div className="flex items-center justify-between">
                  <p className="font-medium text-gray-900">Exam {r.examId}</p>
                  <Badge variant="outline">v{r.version}</Badge>
                </div>
                <p className="mt-2 text-sm text-gray-500">
                  {r.snapshots.length} subject(s), {passed} passed
                </p>
              </Link>
            );
          })}
        </div>
      )}

      {history.data && history.data.history.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-gray-900">History</h2>
          <ul className="space-y-2">
            {history.data.history.map((h) => (
              <li key={`${h.examId}-${h.version}`} className="card p-4">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-gray-900">{h.examName ?? h.examId}</p>
                  <span className="text-xs text-gray-500">{formatDateTime(h.publishedAt)}</span>
                </div>
                <p className="text-sm text-gray-500">
                  {h.examType ?? "Exam"} · {h.subjects.length} subject(s)
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
