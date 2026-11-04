"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { TextField, TextareaField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useApplyMyLeave } from "@/features/hostel/hooks";
import { buildLeaveApply, leaveApplySchema, type LeaveApplyValues } from "@/features/hostel/formSchemas";

export function LeaveApplyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [error, setError] = useState<string | null>(null);
  const apply = useApplyMyLeave({ toast: false });
  const form = useForm<z.input<typeof leaveApplySchema>, unknown, LeaveApplyValues>({
    resolver: zodFormResolver(leaveApplySchema),
    defaultValues: { fromDate: "", toDate: "", reason: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await apply.mutateAsync(buildLeaveApply(values));
      toast.success("Leave application submitted");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Apply for hostel leave"
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Submit"
      pending={apply.isPending}
      error={error}
    >
      <TextField control={form.control} name="fromDate" label="From" type="date" />
      <TextField control={form.control} name="toDate" label="To" type="date" />
      <TextareaField control={form.control} name="reason" label="Reason" />
    </FormDialog>
  );
}
