import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Status badge for fee charges / payment transactions / receipts. The text
 * label is ALWAYS present (never color-only) for accessibility.
 */
type FeeStatus =
  | "PAID"
  | "CAPTURED"
  | "PENDING"
  | "CREATED"
  | "AUTHORIZED"
  | "PARTIALLY_PAID"
  | "FAILED"
  | string;

function toneFor(status: FeeStatus): string {
  switch (status) {
    case "PAID":
    case "CAPTURED":
      return "bg-success-50 text-success-700 border-success-500";
    case "PARTIALLY_PAID":
      return "bg-primary-50 text-primary-700 border-primary-500";
    case "FAILED":
      return "bg-danger-50 text-danger-700 border-danger-500";
    case "PENDING":
    case "CREATED":
    case "AUTHORIZED":
    default:
      return "bg-warning-50 text-warning-600 border-warning-500";
  }
}

const LABELS: Record<string, string> = {
  PAID: "Paid",
  CAPTURED: "Captured",
  PENDING: "Pending",
  CREATED: "Created",
  AUTHORIZED: "Authorized",
  PARTIALLY_PAID: "Partially paid",
  FAILED: "Failed",
};

export function FeeStatusBadge({ status }: { status: FeeStatus }) {
  return (
    <Badge variant="outline" className={cn("font-medium", toneFor(status))}>
      {LABELS[status] ?? status}
    </Badge>
  );
}
