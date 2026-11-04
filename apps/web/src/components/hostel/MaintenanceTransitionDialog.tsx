"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { TextareaField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useTransitionMaintenance } from "@/features/hostel/hooks";
import {
  buildMaintenanceTransition,
  maintenanceTransitionSchema,
  type MaintenanceTransitionValues,
} from "@/features/hostel/formSchemas";
import { roomLabel } from "@/features/hostel/format";
import type { MaintenanceRow } from "@/features/hostel/types";

/** Resolve or Cancel with an optional note. Both are final. */
export function MaintenanceTransitionDialog({
  open,
  onOpenChange,
  request,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: MaintenanceRow;
  target: "RESOLVED" | "CANCELLED";
}) {
  const [error, setError] = useState<string | null>(null);
  const transition = useTransitionMaintenance(request.id, { toast: false });
  const form = useForm<z.input<typeof maintenanceTransitionSchema>, unknown, MaintenanceTransitionValues>({
    resolver: zodFormResolver(maintenanceTransitionSchema),
    defaultValues: { toStatus: target, resolutionNote: "" },
  });
  const resolving = target === "RESOLVED";

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await transition.mutateAsync(buildMaintenanceTransition(values));
      toast.success(resolving ? "Request resolved" : "Request cancelled");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={resolving ? "Mark resolved" : "Cancel request"}
      description={`${roomLabel(request.room)}: ${request.issue}. ${resolving ? "Resolved" : "Cancelled"} requests are final.`}
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel={resolving ? "Mark resolved" : "Cancel request"}
      destructive={!resolving}
      pending={transition.isPending}
      error={error}
    >
      <TextareaField control={form.control} name="resolutionNote" label="Resolution note (optional)" />
    </FormDialog>
  );
}
