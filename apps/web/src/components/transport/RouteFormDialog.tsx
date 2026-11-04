"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { toast } from "sonner";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { FormDialog } from "@/components/forms/FormDialog";
import { SelectField, TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useCreateRoute, usePatchRoute } from "@/features/transport/hooks";
import {
  buildRouteCreate,
  buildRoutePatch,
  routeSchema,
  type RouteValues,
} from "@/features/transport/formSchemas";
import { paiseToRupeeInput } from "@/features/transport/money";
import { routeStatusLabel, toOptions } from "@/features/transport/labels";
import type { Route } from "@/features/transport/types";

const CONFLICTS = { "route code already exists": "code" };

export function RouteFormDialog({
  open,
  onOpenChange,
  route,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  route?: Route;
}) {
  const [error, setError] = useState<string | null>(null);
  const create = useCreateRoute({ toast: false });
  const patch = usePatchRoute(route?.id ?? "", { toast: false });
  const form = useForm<z.input<typeof routeSchema>, unknown, RouteValues>({
    resolver: zodFormResolver(routeSchema),
    defaultValues: {
      name: route?.name ?? "",
      code: route?.code ?? "",
      // A stored zero prefills blank so an untouched field is neither dirty nor sent.
      feeAmount: route?.feeAmount ? paiseToRupeeInput(route.feeAmount) : "",
      status: route?.status ?? "ACTIVE",
    },
  });
  const { dirtyFields, isDirty } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      if (route) {
        await patch.mutateAsync(buildRoutePatch(dirtyFields, values));
        toast.success("Route updated");
      } else {
        await create.mutateAsync(buildRouteCreate(values));
        toast.success("Route created");
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
      title={route ? "Edit route" : "Add route"}
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel={route ? "Save changes" : "Create route"}
      pending={create.isPending || patch.isPending}
      error={error}
      disableSubmit={Boolean(route) && !isDirty}
    >
      <TextField control={form.control} name="name" label="Name" />
      <TextField control={form.control} name="code" label="Code" />
      <TextField
        control={form.control}
        name="feeAmount"
        label="Fee in rupees (optional)"
        help="Optional. Informational: this fee is not billed through Fees. Leave blank for no fee."
      />
      <SelectField control={form.control} name="status" label="Status" options={toOptions(routeStatusLabel)} />
    </FormDialog>
  );
}
