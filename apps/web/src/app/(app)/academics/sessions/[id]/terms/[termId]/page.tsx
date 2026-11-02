"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ApiError } from "@/lib/api";
import { useSession } from "@/features/academics/hooks";

const STATUS_VARIANT: Record<
  string,
  "outline" | "default" | "secondary" | "destructive"
> = {
  UPCOMING: "outline",
  ACTIVE: "default",
  CLOSED: "secondary",
};

// Term detail page wrapped in <RouteGuard> (authentication-only, no
// requirePermission per MUST-FIX 6). A term is a detail view of a session.
export default function TermDetailPage() {
  return (
    <RouteGuard>
      <TermDetailInner />
    </RouteGuard>
  );
}

function TermDetailInner() {
  const { id, termId } = useParams<{ id: string; termId: string }>();
  const { data, isLoading, isError, error } = useSession(id);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (isError) {
    return (
      <InlineError
        message={
          error instanceof ApiError ? error.message : "Failed to load term."
        }
      />
    );
  }
  if (!data) return null;

  const term = data.session.terms?.find((t) => t.id === termId);
  if (!term) {
    return (
      <InlineError message="Term not found in this session." />
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/academics/sessions/${id}`}
        className="text-sm text-gray-500 hover:underline"
      >
        ← Back to Session
      </Link>

      {/* A term — note: "A term", not "An term" (per LOW item) */}
      <div className="card p-6 space-y-2">
        <h1 className="text-2xl font-semibold text-gray-900">{term.name}</h1>
        <p className="text-sm text-gray-500">A term in {data.session.name}</p>
        <div className="flex flex-wrap gap-4 text-sm">
          <div>
            <span className="text-gray-500">Status: </span>
            <Badge variant={STATUS_VARIANT[term.status] ?? "outline"}>
              {term.status}
            </Badge>
          </div>
          <div>
            <span className="text-gray-500">Ordinal: </span>
            <span className="text-gray-900">{term.ordinal}</span>
          </div>
          <div>
            <span className="text-gray-500">Start Date: </span>
            <span className="text-gray-900">{term.startDate}</span>
          </div>
          <div>
            <span className="text-gray-500">End Date: </span>
            <span className="text-gray-900">{term.endDate}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
