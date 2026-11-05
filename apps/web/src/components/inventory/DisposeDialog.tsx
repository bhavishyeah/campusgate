"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { SelectField, TextareaField, TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useDisposeAsset } from "@/features/inventory/hooks";
import { buildDispose, disposeSchema, type DisposeValues } from "@/features/inventory/formSchemas";
import { disposalMethodLabel, terminalStatusLabel, toOptions } from "@/features/inventory/labels";
import type { Asset } from "@/features/inventory/types";

const METHOD_OPTIONS = toOptions(disposalMethodLabel);
const TERMINAL_OPTIONS = toOptions(terminalStatusLabel);

/** Dispose an asset (irreversible — the asset becomes terminal). */
export function DisposeDialog({
  open,
  onOpenChange,
  asset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset: Asset;
}) {
  const [error, setError] = useState<string | null>(null);
  const dispose = useDisposeAsset(asset.id, { toast: false });
  const form = useForm<z.input<typeof disposeSchema>, unknown, DisposeValues>({
    resolver: zodFormResolver(disposeSchema),
    defaultValues: { terminalStatus: "", method: "", proceeds: "", currency: "", reason: "", disposedAt: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await dispose.mutateAsync(buildDispose(values));
      toast.success("Asset disposed");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Dispose asset"
      description="This is irreversible; the asset becomes terminal and cannot be changed."
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Dispose"
      destructive
      pending={dispose.isPending}
      error={error}
    >
      <SelectField control={form.control} name="terminalStatus" label="Terminal status" options={TERMINAL_OPTIONS} />
      <SelectField control={form.control} name="method" label="Method" options={METHOD_OPTIONS} />
      <TextField control={form.control} name="proceeds" label="Proceeds (₹, optional)" />
      <TextField control={form.control} name="currency" label="Currency (optional)" />
      <TextareaField control={form.control} name="reason" label="Reason (optional)" />
      <TextField control={form.control} name="disposedAt" label="Disposed at (optional)" type="date" />
    </FormDialog>
  );
}
