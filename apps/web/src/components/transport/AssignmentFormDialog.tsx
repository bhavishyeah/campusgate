"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { toast } from "sonner";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { FormDialog } from "@/components/forms/FormDialog";
import { SelectField, TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { OPTION_PAGE_SIZE, useCreateAssignment, useDriverOptions, useVehicleOptions } from "@/features/transport/hooks";
import { assignmentSchema, buildAssignment, type AssignmentValues } from "@/features/transport/formSchemas";
import { vehicleTypeLabel } from "@/features/transport/labels";

export function AssignmentFormDialog({
  open,
  onOpenChange,
  routeId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  routeId: string;
}) {
  const [error, setError] = useState<string | null>(null);
  // MAINTENANCE vehicles are not listed: the server rejects them.
  const vehicles = useVehicleOptions("ACTIVE");
  const drivers = useDriverOptions();
  const create = useCreateAssignment(routeId, { toast: false });
  const form = useForm<z.input<typeof assignmentSchema>, unknown, AssignmentValues>({
    resolver: zodFormResolver(assignmentSchema),
    defaultValues: { vehicleId: "", driverId: "", effectiveFrom: "", effectiveTo: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await create.mutateAsync(buildAssignment(values));
      toast.success("Vehicle and driver assigned");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Assign vehicle and driver"
      description="The route capacity becomes this vehicle's seat capacity."
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Assign"
      pending={create.isPending}
      error={error}
    >
      <SelectField
        control={form.control}
        name="vehicleId"
        label="Vehicle"
        options={(vehicles.data?.vehicles ?? []).map((v) => ({
          value: v.id,
          label: `${v.registrationNo} (${vehicleTypeLabel[v.type] ?? v.type}, ${v.seatCapacity} seats)`,
        }))}
        help={vehicles.data && vehicles.data.total > OPTION_PAGE_SIZE ? `Showing the first ${OPTION_PAGE_SIZE} vehicles.` : undefined}
      />
      <SelectField
        control={form.control}
        name="driverId"
        label="Driver"
        options={(drivers.data?.drivers ?? []).map((d) => ({ value: d.id, label: `${d.name} (${d.licenseNo})` }))}
        help={drivers.data && drivers.data.total > OPTION_PAGE_SIZE ? `Showing the first ${OPTION_PAGE_SIZE} drivers.` : undefined}
      />
      <TextField control={form.control} name="effectiveFrom" label="Effective from" type="date" />
      <TextField control={form.control} name="effectiveTo" label="Effective to (optional)" type="date" />
    </FormDialog>
  );
}
