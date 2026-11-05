"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { PickerError, TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { CategoryPicker } from "@/components/inventory/CategoryPicker";
import { UserPicker } from "@/components/inventory/UserPicker";
import { DepartmentPicker } from "@/components/inventory/DepartmentPicker";
import { useCreateAsset, usePatchAsset } from "@/features/inventory/hooks";
import {
  assetCreateSchema,
  assetPatchSchema,
  buildAssetCreate,
  buildAssetPatch,
  type AssetCreateValues,
  type AssetPatchValues,
} from "@/features/inventory/formSchemas";
import type { Asset, UserLookupItem } from "@/features/inventory/types";

/** Create (full form) and edit (name + location only — identity/money/custody are frozen). */
export function AssetFormDialog({
  open,
  onOpenChange,
  asset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset?: Asset;
}) {
  const editing = Boolean(asset);
  if (editing && asset) return <EditForm open={open} onOpenChange={onOpenChange} asset={asset} />;
  return <CreateForm open={open} onOpenChange={onOpenChange} />;
}

function CreateForm({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [custodian, setCustodian] = useState<UserLookupItem | null>(null);
  const create = useCreateAsset({ toast: false });
  const form = useForm<z.input<typeof assetCreateSchema>, unknown, AssetCreateValues>({
    resolver: zodFormResolver(assetCreateSchema),
    defaultValues: {
      assetTag: "",
      name: "",
      categoryId: "",
      acquisitionDate: "",
      acquisitionCost: "",
      currency: "",
      location: "",
      custodyUserId: "",
      custodyDepartmentId: "",
    },
  });
  const categoryId = form.watch("categoryId");
  const departmentId = form.watch("custodyDepartmentId");

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const conflicts = { "asset tag already exists": "assetTag" as const, "category not found": "categoryId" as const };
    try {
      await create.mutateAsync(buildAssetCreate(values));
      toast.success("Asset created");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form, conflicts));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New asset"
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Create asset"
      pending={create.isPending}
      error={error}
    >
      <TextField control={form.control} name="assetTag" label="Asset tag" />
      <TextField control={form.control} name="name" label="Name" />
      <CategoryPicker
        value={String(categoryId ?? "")}
        onChange={(id) => form.setValue("categoryId", id, { shouldValidate: form.formState.isSubmitted, shouldDirty: true })}
      />
      <PickerError message={form.formState.errors.categoryId?.message as string | undefined} />
      <TextField control={form.control} name="acquisitionDate" label="Acquisition date (optional)" type="date" />
      <TextField control={form.control} name="acquisitionCost" label="Acquisition cost (₹, optional)" />
      <TextField control={form.control} name="currency" label="Currency (optional, e.g. INR)" />
      <TextField control={form.control} name="location" label="Location (optional)" />
      <div className="space-y-2 rounded-md border border-gray-200 p-3">
        <p className="text-xs text-gray-500">
          Supplying a custodian sets the asset to Assigned; otherwise it starts In store. Choose a user or a department.
        </p>
        <UserPicker
          value={custodian}
          onChange={(u) => {
            setCustodian(u);
            form.setValue("custodyUserId", u?.id ?? "", { shouldDirty: true });
            if (u) form.setValue("custodyDepartmentId", "", { shouldDirty: true });
          }}
        />
        {!custodian ? (
          <DepartmentPicker
            value={String(departmentId ?? "")}
            onChange={(id) => form.setValue("custodyDepartmentId", id, { shouldDirty: true })}
          />
        ) : null}
      </div>
    </FormDialog>
  );
}

function EditForm({ open, onOpenChange, asset }: { open: boolean; onOpenChange: (open: boolean) => void; asset: Asset }) {
  const [error, setError] = useState<string | null>(null);
  const patch = usePatchAsset(asset.id, { toast: false });
  const form = useForm<z.input<typeof assetPatchSchema>, unknown, AssetPatchValues>({
    resolver: zodFormResolver(assetPatchSchema),
    defaultValues: { name: asset.name, location: asset.location ?? "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await patch.mutateAsync(buildAssetPatch(form.formState.dirtyFields, values));
      toast.success("Asset updated");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit asset"
      description="Identity, money and custody are frozen after create. Only name and location can change."
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Save changes"
      pending={patch.isPending}
      error={error}
      disableSubmit={!form.formState.isDirty}
    >
      <TextField control={form.control} name="name" label="Name" />
      <TextField control={form.control} name="location" label="Location (optional)" />
    </FormDialog>
  );
}
