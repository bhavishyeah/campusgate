"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { PickerError, TextareaField, TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { AssetPicker } from "@/components/inventory/AssetPicker";
import { UserPicker } from "@/components/inventory/UserPicker";
import { useOpenMaintenance } from "@/features/inventory/hooks";
import {
  buildMaintenanceCreate,
  maintenanceCreateSchema,
  type MaintenanceCreateValues,
} from "@/features/inventory/formSchemas";
import type { UserLookupItem } from "@/features/inventory/types";

/**
 * Open a maintenance request. When `assetId` is given (asset detail) the asset is
 * fixed; otherwise an AssetPicker chooses it. Opening sets the asset to In maintenance.
 */
export function MaintenanceCreateDialog({
  open,
  onOpenChange,
  assetId: fixedAssetId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [assetId, setAssetId] = useState(fixedAssetId ?? "");
  const [assignee, setAssignee] = useState<UserLookupItem | null>(null);
  const create = useOpenMaintenance(assetId, { toast: false });
  const form = useForm<z.input<typeof maintenanceCreateSchema>, unknown, MaintenanceCreateValues>({
    resolver: zodFormResolver(maintenanceCreateSchema),
    defaultValues: { issue: "", assigneeUserId: "", cost: "" },
  });
  const [assetError, setAssetError] = useState<string | undefined>(undefined);

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    if (assetId === "") {
      setAssetError("Required");
      return;
    }
    setAssetError(undefined);
    try {
      await create.mutateAsync(buildMaintenanceCreate(values));
      toast.success("Maintenance request opened");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Open maintenance request"
      description="Opening maintenance sets the asset to In maintenance."
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Open request"
      pending={create.isPending}
      error={error}
    >
      {fixedAssetId ? null : (
        <>
          <AssetPicker value={assetId} onChange={(id) => { setAssetId(id); setAssetError(undefined); }} />
          <PickerError message={assetError} />
        </>
      )}
      <TextareaField control={form.control} name="issue" label="Issue" />
      <UserPicker
        label="Assignee (optional, name or email)"
        value={assignee}
        onChange={(u) => {
          setAssignee(u);
          form.setValue("assigneeUserId", u?.id ?? "");
        }}
      />
      <TextField control={form.control} name="cost" label="Cost (₹, optional)" />
    </FormDialog>
  );
}
