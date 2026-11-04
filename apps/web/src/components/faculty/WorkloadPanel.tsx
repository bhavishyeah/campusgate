import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/features/hr/format";
import { formatHours, utilization } from "@/features/faculty/workload";
import type { WorkloadResult, WorkloadRow } from "@/features/faculty/types";

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-lg font-semibold text-gray-900">{value}</dd>
    </div>
  );
}

/** Figures for one term's workload row, plus the counts from the last recompute/patch result. */
export function WorkloadPanel({ row, lastResult }: { row: WorkloadRow; lastResult?: WorkloadResult | null }) {
  const u = utilization(row);
  const unestimated = lastResult?.unestimatedSubjectIds?.length ?? 0;
  const excluded = lastResult?.excludedAssignmentIds?.length ?? 0;
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Figure label="Teaching hours" value={formatHours(row.teachingHours)} />
        <Figure label="Non-teaching hours" value={formatHours(row.nonTeachingHours)} />
        <Figure label="Total" value={formatHours(u.total)} />
        <Figure label="Policy maximum" value={u.max === null ? "Not capped" : formatHours(u.max)} />
      </dl>
      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
        {u.over ? (
          <Badge variant="outline" className="border-danger-500 bg-danger-50 text-danger-700">
            Over policy
          </Badge>
        ) : null}
        {row.overrideReason ? <span>Override reason: {row.overrideReason}</span> : null}
        <span>Last reconciled: {formatDateTime(row.lastReconciledAt)}</span>
      </div>
      {unestimated > 0 ? (
        <p role="status" className="rounded-md border border-warning-500 bg-warning-50 px-3 py-2 text-sm text-warning-600">
          {unestimated} subject(s) have no contact-hours estimate and were not counted.
        </p>
      ) : null}
      {excluded > 0 ? (
        <p role="status" className="rounded-md border border-warning-500 bg-warning-50 px-3 py-2 text-sm text-warning-600">
          {excluded} assignment(s) were excluded.
        </p>
      ) : null}
    </div>
  );
}
