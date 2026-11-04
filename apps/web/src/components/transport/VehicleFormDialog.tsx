"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { toast } from "sonner";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { FormDialog } from "@/components/forms/FormDialog";
import { SelectField, TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useCreateVehicle, usePatchVehicle } from "@/features/transport/hooks";
import {
  buildVehicleCreate,
  buildVehiclePatch,
  vehicleSchema,
  type VehicleValues,
} from "@/features/transport/formSchemas";
import { toOptions, vehicleStatusLabel, vehicleTypeLabel } from "@/features/transport/labels";
import type { Vehicle } from "@/features/transport/types";

const CONFLICTS = {
  "registration number already exists": "registrationNo",
  "capacity below active enrollment": "seatCapacity",
};

export function VehicleFormDialog({
  open,
  onOpenChange,
  vehicle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vehicle?: Vehicle;
}) {
  const [error, setError] = useState<string | null>(null);
  const create = useCreateVehicle({ toast: false });
  const patch = usePatchVehicle(vehicle?.id ?? "", { toast: false });
  const form = useForm<z.input<typeof vehicleSchema>, unknown, VehicleValues>({
    resolver: zodFormResolver(vehicleSchema),
    defaultValues: {
      registrationNo: vehicle?.registrationNo ?? "",
      type: vehicle?.type ?? "",
      seatCapacity: vehicle ? String(vehicle.seatCapacity) : "",
      status: vehicle?.status ?? "ACTIVE",
    },
  });
  const { dirtyFields, isDirty } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      if (vehicle) {
        await patch.mutateAsync(buildVehiclePatch(dirtyFields, values));
        toast.success("Vehicle updated");
      } else {
        await create.mutateAsync(buildVehicleCreate(values));
        toast.success("Vehicle created");
      }
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form, CONFLICTS));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={vehicle ? "Edit vehicle" : "Add vehicle"}
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel={vehicle ? "Save changes" : "Create vehicle"}
      pending={create.isPending || patch.isPending}
      error={error}
      disableSubmit={Boolean(vehicle) && !isDirty}
    >
      <TextField control={form.control} name="registrationNo" label="Registration number" />
      <SelectField control={form.control} name="type" label="Type" options={toOptions(vehicleTypeLabel)} />
      <TextField control={form.control} name="seatCapacity" label="Seat capacity" />
      <SelectField
        control={form.control}
        name="status"
        label="Status"
        options={toOptions(vehicleStatusLabel)}
        help="A vehicle in Maintenance cannot be assigned to a route."
      />
    </FormDialog>
  );
}
