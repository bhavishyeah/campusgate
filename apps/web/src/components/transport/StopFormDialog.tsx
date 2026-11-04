"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { toast } from "sonner";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { FormDialog } from "@/components/forms/FormDialog";
import { TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useCreateStop, usePatchStop } from "@/features/transport/hooks";
import { buildStopCreate, buildStopPatch, stopSchema, type StopValues } from "@/features/transport/formSchemas";
import type { Stop } from "@/features/transport/types";

const CONFLICTS = { "stop sequence already exists on route": "sequence" };

export function StopFormDialog({
  open,
  onOpenChange,
  routeId,
  stop,
  nextSequence,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  routeId: string;
  stop?: Stop;
  nextSequence: number;
}) {
  const [error, setError] = useState<string | null>(null);
  const create = useCreateStop(routeId, { toast: false });
  const patch = usePatchStop(routeId, { toast: false });
  const form = useForm<z.input<typeof stopSchema>, unknown, StopValues>({
    resolver: zodFormResolver(stopSchema),
    defaultValues: {
      name: stop?.name ?? "",
      sequence: String(stop?.sequence ?? nextSequence),
      landmark: stop?.landmark ?? "",
      latitude: stop?.latitude === null || stop?.latitude === undefined ? "" : String(stop.latitude),
      longitude: stop?.longitude === null || stop?.longitude === undefined ? "" : String(stop.longitude),
      pickupOffsetMinutes:
        stop?.pickupOffsetMinutes === null || stop?.pickupOffsetMinutes === undefined ? "" : String(stop.pickupOffsetMinutes),
    },
  });
  const { dirtyFields, isDirty } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      if (stop) {
        await patch.mutateAsync({ stopId: stop.id, body: buildStopPatch(dirtyFields, values) });
        toast.success("Stop updated");
      } else {
        await create.mutateAsync(buildStopCreate(values));
        toast.success("Stop added");
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
      title={stop ? "Edit stop" : "Add stop"}
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel={stop ? "Save changes" : "Add stop"}
      pending={create.isPending || patch.isPending}
      error={error}
      disableSubmit={Boolean(stop) && !isDirty}
    >
      <TextField control={form.control} name="name" label="Name" />
      <TextField control={form.control} name="sequence" label="Sequence" />
      <TextField control={form.control} name="landmark" label="Landmark (optional)" />
      <TextField control={form.control} name="latitude" label="Latitude (optional)" />
      <TextField control={form.control} name="longitude" label="Longitude (optional)" />
      <TextField control={form.control} name="pickupOffsetMinutes" label="Pickup offset in minutes (optional)" />
    </FormDialog>
  );
}
