"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { SelectField, TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useRecordCheck } from "@/features/hostel/hooks";
import { buildCheckEvent, checkEventSchema, type CheckEventValues } from "@/features/hostel/formSchemas";
import { checkEventLabel, toOptions } from "@/features/hostel/labels";
import { studentLabel } from "@/features/hostel/format";
import type { AllocationRow } from "@/features/hostel/types";

export function CheckEventDialog({
  open,
  onOpenChange,
  allocation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allocation: AllocationRow;
}) {
  const [error, setError] = useState<string | null>(null);
  const record = useRecordCheck(allocation.id, { toast: false });
  const form = useForm<z.input<typeof checkEventSchema>, unknown, CheckEventValues>({
    resolver: zodFormResolver(checkEventSchema),
    defaultValues: { eventType: "", occurredAt: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await record.mutateAsync(buildCheckEvent(values));
      toast.success("Check event recorded");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Record check-in/out"
      description={studentLabel(allocation.student)}
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Record"
      pending={record.isPending}
      error={error}
    >
      <SelectField control={form.control} name="eventType" label="Event type" options={toOptions(checkEventLabel)} />
      <TextField control={form.control} name="occurredAt" label="Time (optional)" type="datetime-local" help="Leave blank to use the current time." />
      <p className="text-xs text-gray-500">Check events are append-only and cannot be edited.</p>
    </FormDialog>
  );
}
