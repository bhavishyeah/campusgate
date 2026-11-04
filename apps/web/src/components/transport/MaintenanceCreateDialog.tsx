"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { toast } from "sonner";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { FormDialog } from "@/components/forms/FormDialog";
import { SelectField, TextField, TextareaField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { OPTION_PAGE_SIZE, useCreateTransportMaintenance, useVehicleOptions } from "@/features/transport/hooks";
import {
  buildTransportMaintenanceCreate,
  transportMaintenanceCreateSchema,
  type TransportMaintenanceCreateValues,
} from "@/features/transport/formSchemas";
import { vehicleTypeLabel } from "@/features/transport/labels";

export function MaintenanceCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  // Every vehicle, whatever its status.
  const vehicles = useVehicleOptions();
  const create = useCreateTransportMaintenance({ toast: false });
  const form = useForm<z.input<typeof transportMaintenanceCreateSchema>, unknown, TransportMaintenanceCreateValues>({
    resolver: zodFormResolver(transportMaintenanceCreateSchema),
    defaultValues: { vehicleId: "", issue: "", cost: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await create.mutateAsync(buildTransportMaintenanceCreate(values));
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
      description="Creating a request does not change the vehicle's status. Set the vehicle to Maintenance from Vehicles."
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Create request"
      pending={create.isPending}
      error={error}
    >
      <SelectField
        control={form.control}
        name="vehicleId"
        label="Vehicle"
        options={(vehicles.data?.vehicles ?? []).map((v) => ({
          value: v.id,
          label: `${v.registrationNo} (${vehicleTypeLabel[v.type] ?? v.type})`,
        }))}
        help={vehicles.data && vehicles.data.total > OPTION_PAGE_SIZE ? `Showing the first ${OPTION_PAGE_SIZE} vehicles.` : undefined}
      />
      <TextareaField control={form.control} name="issue" label="Issue" />
      <TextField control={form.control} name="cost" label="Cost in rupees (optional)" help="Leave blank if no cost is recorded." />
    </FormDialog>
  );
}
