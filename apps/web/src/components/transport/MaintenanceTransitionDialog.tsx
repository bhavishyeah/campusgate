"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { toast } from "sonner";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { FormDialog } from "@/components/forms/FormDialog";
import { TextField, TextareaField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useTransitionTransportMaintenance } from "@/features/transport/hooks";
import {
  buildTransportMaintenanceTransition,
  transportMaintenanceTransitionSchema,
  type TransportMaintenanceTransitionValues,
} from "@/features/transport/formSchemas";
import type { MaintenanceRow } from "@/features/transport/types";

type Target = "IN_PROGRESS" | "RESOLVED" | "CANCELLED";

const COPY: Record<Target, { title: string; submit: string; done: string; final: boolean }> = {
  IN_PROGRESS: { title: "Mark in progress", submit: "Mark in progress", done: "Marked in progress", final: false },
  RESOLVED: { title: "Mark resolved", submit: "Mark resolved", done: "Request resolved", final: true },
  CANCELLED: { title: "Cancel request", submit: "Cancel request", done: "Request cancelled", final: true },
};

/** Mark in progress, resolve or cancel, with optional cost (not on cancel) and note. */
export function MaintenanceTransitionDialog({
  open,
  onOpenChange,
  request,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: MaintenanceRow;
  target: Target;
}) {
  const [error, setError] = useState<string | null>(null);
  const transition = useTransitionTransportMaintenance(request.id, { toast: false });
  const form = useForm<z.input<typeof transportMaintenanceTransitionSchema>, unknown, TransportMaintenanceTransitionValues>({
    resolver: zodFormResolver(transportMaintenanceTransitionSchema),
    defaultValues: { toStatus: target, cost: "", resolutionNote: "" },
  });
  const copy = COPY[target];

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await transition.mutateAsync(buildTransportMaintenanceTransition(values));
      toast.success(copy.done);
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={copy.title}
      description={`${request.vehicle.registrationNo}: ${request.issue}.${copy.final ? ` ${target === "RESOLVED" ? "Resolved" : "Cancelled"} requests are final.` : ""}`}
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel={copy.submit}
      destructive={target === "CANCELLED"}
      pending={transition.isPending}
      error={error}
    >
      {target !== "CANCELLED" ? (
        <TextField control={form.control} name="cost" label="Cost in rupees (optional)" help="Leave blank if no cost is recorded." />
      ) : null}
      <TextareaField control={form.control} name="resolutionNote" label="Note (optional)" />
    </FormDialog>
  );
}
