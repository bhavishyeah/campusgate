"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { TextareaField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useReject } from "@/features/service-requests/hooks";
import { buildReject, rejectSchema, type RejectValues } from "@/features/service-requests/formSchemas";

export function RejectDialog({
  open,
  onOpenChange,
  requestId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const reject = useReject(requestId, { toast: false });
  const form = useForm<z.input<typeof rejectSchema>, unknown, RejectValues>({
    resolver: zodFormResolver(rejectSchema),
    defaultValues: { reason: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await reject.mutateAsync(buildReject(values));
      toast.success("Request rejected");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Reject request"
      description="Rejecting is final."
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Reject"
      destructive
      pending={reject.isPending}
      error={error}
    >
      <TextareaField control={form.control} name="reason" label="Reason (optional)" />
    </FormDialog>
  );
}
