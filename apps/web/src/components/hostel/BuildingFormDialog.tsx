"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { FormDialog } from "@/components/forms/FormDialog";
import { SelectField, TextField } from "@/components/forms/Fields";
import { handleServerError, isServerFault } from "@/components/forms/serverErrors";
import { WardenPicker } from "@/components/hostel/WardenPicker";
import { useBuildingOptions, useCreateBuilding, usePatchBuilding } from "@/features/hostel/hooks";
import {
  DUPLICATE_BUILDING_MESSAGE,
  BUILDING_TYPES,
  buildBuildingCreate,
  buildBuildingPatch,
  buildingSchema,
  hasDuplicateBuildingName,
  type BuildingValues,
} from "@/features/hostel/formSchemas";
import { buildingTypeLabel, toOptions } from "@/features/hostel/labels";
import type { BuildingRow, UserLookupItem } from "@/features/hostel/types";

type FormIn = z.input<typeof buildingSchema>;

export function BuildingFormDialog({
  open,
  onOpenChange,
  building,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  building?: BuildingRow;
}) {
  const edit = Boolean(building);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const [warden, setWarden] = useState<UserLookupItem | null>(building?.warden ?? null);
  const options = useBuildingOptions();
  const create = useCreateBuilding({ toast: false });
  const patch = usePatchBuilding(building?.id ?? "", { toast: false });
  const form = useForm<FormIn, unknown, BuildingValues>({
    resolver: zodFormResolver(buildingSchema),
    defaultValues: {
      name: building?.name ?? "",
      type: building?.type ?? "",
      wardenUserId: building?.wardenUserId ?? "",
      isActive: building?.isActive ?? true,
    },
  });
  const { dirtyFields, isDirty } = form.formState;
  const name = form.watch("name");
  const isActive = form.watch("isActive");
  const duplicate = hasDuplicateBuildingName(
    String(name ?? ""),
    options.data?.buildings ?? [],
    options.data?.total ?? Number.POSITIVE_INFINITY,
    building?.id,
  );
  const pending = create.isPending || patch.isPending;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    setHint(false);
    if (duplicate) {
      form.setError("name", { type: "client", message: DUPLICATE_BUILDING_MESSAGE });
      return;
    }
    try {
      if (building) {
        await patch.mutateAsync(buildBuildingPatch(dirtyFields, values));
        toast.success("Building updated");
      } else {
        await create.mutateAsync(buildBuildingCreate(values));
        toast.success("Building created");
      }
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
      if (isServerFault(err)) setHint(true);
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={edit ? "Edit building" : "Add building"}
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel={edit ? "Save changes" : "Create building"}
      pending={pending}
      error={error}
      disableSubmit={(edit && !isDirty) || duplicate}
    >
      <TextField control={form.control} name="name" label="Name" />
      {duplicate ? (
        <p role="alert" className="text-[0.8rem] font-medium text-destructive">
          {DUPLICATE_BUILDING_MESSAGE}
        </p>
      ) : null}
      <SelectField
        control={form.control}
        name="type"
        label="Type"
        options={toOptions(buildingTypeLabel).filter((o) => (BUILDING_TYPES as readonly string[]).includes(o.value))}
        help="Informational. Allocation does not check it against the student."
      />
      <WardenPicker
        value={warden}
        onChange={(u) => {
          setWarden(u);
          form.setValue("wardenUserId", u?.id ?? "", { shouldDirty: true });
        }}
      />
      <div className="flex items-center gap-2">
        <input
          id="building-active"
          type="checkbox"
          className="h-4 w-4"
          checked={Boolean(isActive)}
          onChange={(e) => form.setValue("isActive", e.target.checked, { shouldDirty: true })}
        />
        <Label htmlFor="building-active">Active</Label>
      </div>
      {hint ? (
        <p className="text-xs text-gray-600">If this name is already used by another building, choose a different one.</p>
      ) : null}
    </FormDialog>
  );
}
