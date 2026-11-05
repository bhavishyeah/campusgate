"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { TextareaField, TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useTransitionMaintenance } from "@/features/inventory/hooks";
import {
  buildMaintenanceTransition,
  maintenanceTransitionSchema,
  type MaintenanceTransitionValues,
} from "@/features/inventory/formSchemas";
import type { MaintenanceRow } from "@/features/inventory/types";

const LABELS: Record<string, string> = {
  IN_PROGRESS: "Mark in progress",
  RESOLVED: "Mark resolved",
  CANCELLED: "Cancel request",
};

/** Transition a maintenance request. Resolved/Cancelled are final. */
export function MaintenanceTransitionDialog({
  open,
  onOpenChange,
  request,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: MaintenanceRow;
  target: "IN_PROGRESS" | "RESOLVED" | "CANCELLED";
}) {
  const [error, setError] = useState<string | null>(null);
  const transition = useTransitionMaintenance(request.id, { toast: false });
  const form = useForm<z.input<typeof maintenanceTransitionSchema>, unknown, MaintenanceTransitionValues>({
    resolver: zodFormResolver(maintenanceTransitionSchema),
    defaultValues: { toStatus: target, cost: "", resolutionNote: "" },
  });
  const final = target === "RESOLVED" || target === "CANCELLED";

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await transition.mutateAsync(buildMaintenanceTransition(values));
      toast.success("Maintenance updated");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={LABELS[target]}
      description={final ? "Resolved and Cancelled are final." : undefined}
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel={LABELS[target]}
      destructive={target === "CANCELLED"}
      pending={transition.isPending}
      error={error}
    >
      <TextField control={form.control} name="cost" label="Cost (₹, optional)" />
      <TextareaField control={form.control} name="resolutionNote" label="Resolution note (optional)" />
    </FormDialog>
  );
}
