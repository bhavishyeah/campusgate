"use client";

import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui-ext/InlineError";
import { describeApiError } from "@/lib/apiErrors";
import { isModuleInactiveError } from "@/features/hr/errors";

/** Failed-load panel: module-inactive notice, else the described error with a Retry button. */
export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (isModuleInactiveError(error)) {
    return <InlineError message="This module isn't enabled for your institution." />;
  }
  return (
    <div className="space-y-2">
      <InlineError message={describeApiError(error)} />
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function TableSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-12 w-full animate-pulse rounded-md bg-gray-100" />
      ))}
    </div>
  );
}
