"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { PickerError, TextareaField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { RoomPicker } from "@/components/hostel/RoomPicker";
import { useCreateMaintenance } from "@/features/hostel/hooks";
import {
  buildMaintenanceCreate,
  maintenanceCreateSchema,
  type MaintenanceCreateValues,
} from "@/features/hostel/formSchemas";

export function MaintenanceCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const create = useCreateMaintenance({ toast: false });
  const form = useForm<z.input<typeof maintenanceCreateSchema>, unknown, MaintenanceCreateValues>({
    resolver: zodFormResolver(maintenanceCreateSchema),
    defaultValues: { roomId: "", issue: "" },
  });
  const roomId = form.watch("roomId");

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await create.mutateAsync(buildMaintenanceCreate(values));
      toast.success("Maintenance request created");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New maintenance request"
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Create request"
      pending={create.isPending}
      error={error}
    >
      <RoomPicker
        value={String(roomId ?? "")}
        onChange={(id) => form.setValue("roomId", id, { shouldValidate: form.formState.isSubmitted })}
      />
      <PickerError message={form.formState.errors.roomId?.message as string | undefined} />
      <TextareaField control={form.control} name="issue" label="Issue" />
    </FormDialog>
  );
}
