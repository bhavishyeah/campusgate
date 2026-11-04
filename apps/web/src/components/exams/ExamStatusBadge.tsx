import { Badge } from "@/components/ui/badge";
import type { ExaminationStatus } from "@/features/exams/types";

const STATUS_VARIANT: Record<
  ExaminationStatus,
  "outline" | "default" | "secondary" | "destructive"
> = {
  DRAFT: "outline",
  SCHEDULED: "secondary",
  MARKS_OPEN: "default",
  MARKS_LOCKED: "secondary",
  MODERATION: "secondary",
  APPROVED: "default",
  PUBLISHED: "default",
};

export function ExamStatusBadge({ status }: { status: ExaminationStatus }) {
  return (
    <Badge variant={STATUS_VARIANT[status] ?? "outline"}>
      {status.replace("_", " ")}
    </Badge>
  );
}
