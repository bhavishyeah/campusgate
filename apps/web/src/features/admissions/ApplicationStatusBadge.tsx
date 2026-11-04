import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { applicationStatusLabel } from "./labels";
import type { ApplicationStatus } from "./types";

const GOOD = new Set<ApplicationStatus>(["ENROLLED", "ACCEPTED", "ELIGIBLE", "SHORTLISTED"]);
const BAD = new Set<ApplicationStatus>(["REJECTED", "WITHDRAWN"]);

function tone(status: ApplicationStatus): string {
  if (GOOD.has(status)) return "bg-success-50 text-success-700 border-success-500";
  if (BAD.has(status)) return "bg-danger-50 text-danger-700 border-danger-500";
  if (status === "OFFERED") return "bg-primary-50 text-primary-700 border-primary-500";
  return "bg-warning-50 text-warning-600 border-warning-500";
}

export function ApplicationStatusBadge({ status }: { status: ApplicationStatus }) {
  return (
    <Badge variant="outline" className={cn("font-medium", tone(status))}>
      {applicationStatusLabel[status] ?? status}
    </Badge>
  );
}
