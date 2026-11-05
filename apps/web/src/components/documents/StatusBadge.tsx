import { Badge } from "@/components/ui/badge";
import { DOC_STATUS_LABEL } from "@/features/documents/labels";
import type { DocStatus } from "@/features/documents/types";

const VARIANT: Record<DocStatus, "default" | "secondary" | "destructive" | "outline"> = {
  ACTIVE: "default",
  ARCHIVED: "secondary",
  PURGE_PENDING: "outline",
  PURGED: "destructive",
};

export function StatusBadge({ status }: { status: DocStatus }) {
  return <Badge variant={VARIANT[status]}>{DOC_STATUS_LABEL[status]}</Badge>;
}
