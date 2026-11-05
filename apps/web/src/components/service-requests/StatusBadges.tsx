import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { BAD_STATUSES, GOOD_STATUSES, MUTED_STATUSES, requestStatusLabel } from "@/features/service-requests/labels";

function tone(status: string): string {
  if (GOOD_STATUSES.has(status)) return "bg-success-50 text-success-700 border-success-500";
  if (BAD_STATUSES.has(status)) return "bg-danger-50 text-danger-700 border-danger-500";
  if (MUTED_STATUSES.has(status)) return "bg-gray-100 text-gray-600 border-gray-300";
  return "bg-warning-50 text-warning-600 border-warning-500";
}

export function RequestStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium", tone(status))}>
      {requestStatusLabel[status] ?? status}
    </Badge>
  );
}

export function OverdueBadge({ overdue }: { overdue: boolean }) {
  if (!overdue) return null;
  return (
    <Badge variant="outline" className="font-medium bg-danger-50 text-danger-700 border-danger-500">
      Overdue
    </Badge>
  );
}
