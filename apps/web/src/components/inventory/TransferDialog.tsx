"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { PickerError, TextareaField, TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { UserPicker } from "@/components/inventory/UserPicker";
import { DepartmentPicker } from "@/components/inventory/DepartmentPicker";
import { useTransferAsset } from "@/features/inventory/hooks";
import { buildTransfer, transferSchema, type TransferValues } from "@/features/inventory/formSchemas";
import type { Asset, UserLookupItem } from "@/features/inventory/types";

/** Transfer custody to a user or department. Sets the asset to Assigned and appends a ledger row. */
export function TransferDialog({
  open,
  onOpenChange,
  asset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset: Asset;
}) {
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<UserLookupItem | null>(null);
  const transfer = useTransferAsset(asset.id, { toast: false });
  const form = useForm<z.input<typeof transferSchema>, unknown, TransferValues>({
    resolver: zodFormResolver(transferSchema),
    defaultValues: { toUserId: "", toDepartmentId: "", reason: "", transferredAt: "" },
  });
  const departmentId = form.watch("toDepartmentId");

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await transfer.mutateAsync(buildTransfer(values));
      toast.success("Asset transferred");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Transfer custody"
      description="Sets the asset to Assigned and appends a custody-ledger entry."
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Transfer"
      pending={transfer.isPending}
      error={error}
    >
      <UserPicker
        label="Transfer to user (name or email)"
        value={user}
        onChange={(u) => {
          setUser(u);
          form.setValue("toUserId", u?.id ?? "", { shouldValidate: form.formState.isSubmitted });
          if (u) form.setValue("toDepartmentId", "");
        }}
      />
      {!user ? (
        <DepartmentPicker
          label="Transfer to department (optional)"
          value={String(departmentId ?? "")}
          onChange={(id) => form.setValue("toDepartmentId", id, { shouldValidate: form.formState.isSubmitted })}
        />
      ) : null}
      <PickerError message={form.formState.errors.toUserId?.message as string | undefined} />
      <TextareaField control={form.control} name="reason" label="Reason (optional)" />
      <TextField control={form.control} name="transferredAt" label="Transferred at (optional)" type="datetime-local" />
    </FormDialog>
  );
}
