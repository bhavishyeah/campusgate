"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui-ext/ConfirmDialog";
import { InlineError } from "@/components/ui-ext/InlineError";
import { useStatus } from "@/features/service-requests/hooks";
import { describeApiError } from "@/lib/apiErrors";

/**
 * Status PATCH to IN_PROGRESS or PENDING_APPROVAL. "Send for approval" is only
 * offered by the caller when the type requiresApproval.
 */
export function StatusDialog({
  open,
  onOpenChange,
  requestId,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
  target: "IN_PROGRESS" | "PENDING_APPROVAL";
}) {
  const [error, setError] = useState<string | null>(null);
  const status = useStatus(requestId, { toast: false });
  const label = target === "IN_PROGRESS" ? "Mark in progress" : "Send for approval";

  async function onConfirm() {
    setError(null);
    try {
      await status.mutateAsync({ toStatus: target });
      toast.success(label);
      onOpenChange(false);
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  return (
    <ConfirmDialog
      open={open}
      title={label}
      description={
        target === "PENDING_APPROVAL"
          ? "This moves the request to Pending approval for an approver to decide."
          : "This moves the request to In progress."
      }
      confirmLabel={label}
      pending={status.isPending}
      onConfirm={() => void onConfirm()}
      onOpenChange={onOpenChange}
    >
      {error ? <InlineError message={error} /> : null}
    </ConfirmDialog>
  );
}
