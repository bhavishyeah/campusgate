import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  attendanceStatusLabel,
  contractStatusLabel,
  employeeStatusLabel,
  leaveStatusLabel,
} from "@/features/hr/labels";

type Kind = "employee" | "contract" | "leave" | "attendance";

const LABELS: Record<Kind, Record<string, string>> = {
  employee: employeeStatusLabel,
  contract: contractStatusLabel,
  leave: leaveStatusLabel,
  attendance: attendanceStatusLabel,
};

const GOOD = new Set(["ACTIVE", "APPROVED", "PRESENT"]);
const BAD = new Set(["TERMINATED", "REJECTED", "ABSENT"]);
const MUTED = new Set(["INACTIVE", "ENDED", "SUPERSEDED", "CANCELLED"]);

function tone(status: string): string {
  if (GOOD.has(status)) return "bg-success-50 text-success-700 border-success-500";
  if (BAD.has(status)) return "bg-danger-50 text-danger-700 border-danger-500";
  if (MUTED.has(status)) return "bg-gray-100 text-gray-600 border-gray-300";
  return "bg-warning-50 text-warning-600 border-warning-500";
}

/** The text label is always rendered (never colour-only). */
export function HrStatusBadge({ kind, status }: { kind: Kind; status: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium", tone(status))}>
      {LABELS[kind][status] ?? status}
    </Badge>
  );
}
