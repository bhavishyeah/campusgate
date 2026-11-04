"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { toast } from "sonner";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { FormDialog } from "@/components/forms/FormDialog";
import { SelectField, TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useCreateDriver, usePatchDriver } from "@/features/transport/hooks";
import {
  buildDriverCreate,
  buildDriverPatch,
  driverSchema,
  type DriverValues,
} from "@/features/transport/formSchemas";
import { driverStatusLabel, toOptions } from "@/features/transport/labels";
import type { Driver } from "@/features/transport/types";

const CONFLICTS = { "license number already exists": "licenseNo" };

export function DriverFormDialog({
  open,
  onOpenChange,
  driver,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  driver?: Driver;
}) {
  const [error, setError] = useState<string | null>(null);
  const create = useCreateDriver({ toast: false });
  const patch = usePatchDriver(driver?.id ?? "", { toast: false });
  const form = useForm<z.input<typeof driverSchema>, unknown, DriverValues>({
    resolver: zodFormResolver(driverSchema),
    defaultValues: {
      name: driver?.name ?? "",
      licenseNo: driver?.licenseNo ?? "",
      phone: driver?.phone ?? "",
      status: driver?.status ?? "ACTIVE",
    },
  });
  const { dirtyFields, isDirty } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      if (driver) {
        await patch.mutateAsync(buildDriverPatch(dirtyFields, values));
        toast.success("Driver updated");
      } else {
        await create.mutateAsync(buildDriverCreate(values));
        toast.success("Driver created");
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
      title={driver ? "Edit driver" : "Add driver"}
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel={driver ? "Save changes" : "Create driver"}
      pending={create.isPending || patch.isPending}
      error={error}
      disableSubmit={Boolean(driver) && !isDirty}
    >
      <TextField control={form.control} name="name" label="Name" />
      <TextField control={form.control} name="licenseNo" label="License number" />
      <TextField control={form.control} name="phone" label="Phone (optional)" />
      <SelectField control={form.control} name="status" label="Status" options={toOptions(driverStatusLabel)} />
    </FormDialog>
  );
}
