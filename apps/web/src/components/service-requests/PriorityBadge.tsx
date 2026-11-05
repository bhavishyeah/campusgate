import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { priorityLabel } from "@/features/service-requests/labels";

function tone(p: string): string {
  if (p === "URGENT") return "bg-danger-50 text-danger-700 border-danger-500";
  if (p === "HIGH") return "bg-warning-50 text-warning-600 border-warning-500";
  if (p === "LOW") return "bg-gray-100 text-gray-600 border-gray-300";
  return "bg-primary-50 text-primary-700 border-primary-500";
}

export function PriorityBadge({ priority }: { priority: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium", tone(priority))}>
      {priorityLabel[priority] ?? priority}
    </Badge>
  );
}
