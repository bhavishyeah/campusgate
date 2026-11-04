"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { TextareaField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useApproveLeave, useRejectLeave } from "@/features/hostel/hooks";
import { buildDecision, decisionSchema, type DecisionValues } from "@/features/hostel/formSchemas";
import { studentLabel } from "@/features/hostel/format";
import { formatDate } from "@/features/hr/format";
import type { LeaveRow } from "@/features/hostel/types";

export function DecisionDialog({
  open,
  onOpenChange,
  application,
  mode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  application: LeaveRow;
  mode: "approve" | "reject";
}) {
  const [error, setError] = useState<string | null>(null);
  const approve = useApproveLeave({ toast: false });
  const reject = useRejectLeave({ toast: false });
  const form = useForm<z.input<typeof decisionSchema>, unknown, DecisionValues>({
    resolver: zodFormResolver(decisionSchema),
    defaultValues: { decisionNote: "" },
  });
  const approving = mode === "approve";
  const pending = approve.isPending || reject.isPending;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const vars = { id: application.id, body: buildDecision(values) };
      if (approving) await approve.mutateAsync(vars);
      else await reject.mutateAsync(vars);
      toast.success(approving ? "Leave approved" : "Leave rejected");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={approving ? "Approve leave" : "Reject leave"}
      description={`${studentLabel(application.student)}, ${formatDate(application.fromDate)} to ${formatDate(application.toDate)}. ${
        approving
          ? "The student will see this application as approved. This cannot be undone."
          : "The student will see this application as rejected. This cannot be undone."
      }`}
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel={approving ? "Approve" : "Reject"}
      destructive={!approving}
      pending={pending}
      error={error}
    >
      <TextareaField control={form.control} name="decisionNote" label="Note (optional)" />
    </FormDialog>
  );
}
