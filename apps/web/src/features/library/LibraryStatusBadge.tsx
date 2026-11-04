import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  copyStatusLabel,
  fineStatusLabel,
  loanStatusLabel,
  reservationStatusLabel,
  titleStatusLabel,
} from "./labels";

type Kind = "copy" | "loan" | "reservation" | "fine" | "title";

const LABELS: Record<Kind, Record<string, string>> = {
  copy: copyStatusLabel,
  loan: loanStatusLabel,
  reservation: reservationStatusLabel,
  fine: fineStatusLabel,
  title: titleStatusLabel,
};

const GOOD = new Set(["AVAILABLE", "RETURNED", "PAID", "ACTIVE_TITLE"]);
const BAD = new Set(["LOST", "DAMAGED", "OVERDUE", "WITHDRAWN", "EXPIRED"]);

function tone(kind: Kind, status: string): string {
  if (kind === "title" && status === "ACTIVE") return "bg-success-50 text-success-700 border-success-500";
  if (GOOD.has(status)) return "bg-success-50 text-success-700 border-success-500";
  if (BAD.has(status)) return "bg-danger-50 text-danger-700 border-danger-500";
  if (status === "FULFILLED") return "bg-primary-50 text-primary-700 border-primary-500";
  return "bg-warning-50 text-warning-600 border-warning-500";
}

/** Text label is ALWAYS rendered (never colour-only). */
export function LibraryStatusBadge({ kind, status }: { kind: Kind; status: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium", tone(kind, status))}>
      {LABELS[kind][status] ?? status}
    </Badge>
  );
}
