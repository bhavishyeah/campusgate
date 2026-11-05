"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { FormDialog } from "@/components/forms/FormDialog";
import { PickerError, SelectField, TextareaField, TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { AssetPicker } from "@/components/inventory/AssetPicker";
import { useAddAuditLine, useStockItems } from "@/features/inventory/hooks";
import { auditLineSchema, buildAuditLine, type AuditLineValues } from "@/features/inventory/formSchemas";
import type { AuditLine } from "@/features/inventory/types";

const REF_OPTIONS = [
  { value: "asset", label: "Asset" },
  { value: "stock", label: "Stock item" },
];

/** Append a line referencing exactly one of an asset or a stock item. */
export function AuditLineDialog({
  open,
  onOpenChange,
  sessionId,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  onAdded: (line: AuditLine) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const add = useAddAuditLine(sessionId, { toast: false });
  const form = useForm<z.input<typeof auditLineSchema>, unknown, AuditLineValues>({
    resolver: zodFormResolver(auditLineSchema),
    defaultValues: { ref: "asset", assetId: "", stockItemId: "", expectedQuantity: "", foundQuantity: "", note: "" },
  });
  const ref = form.watch("ref");
  const assetId = form.watch("assetId");
  const stockItemId = form.watch("stockItemId");
  const stock = useStockItems(1);

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const line = await add.mutateAsync(buildAuditLine(values));
      onAdded(line);
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add audit line"
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Add line"
      pending={add.isPending}
      error={error}
    >
      <SelectField control={form.control} name="ref" label="Reference type" options={REF_OPTIONS} />
      {String(ref) === "asset" ? (
        <>
          <AssetPicker
            value={String(assetId ?? "")}
            onChange={(id) => form.setValue("assetId", id, { shouldValidate: form.formState.isSubmitted })}
          />
          <PickerError message={form.formState.errors.assetId?.message as string | undefined} />
        </>
      ) : (
        <>
          <SimpleSelect
            ariaLabel="Stock item"
            value={String(stockItemId ?? "")}
            onChange={(id) => form.setValue("stockItemId", id, { shouldValidate: form.formState.isSubmitted })}
            placeholder={stock.isLoading ? "Loading..." : "Select a stock item"}
            options={(stock.data?.stockItems ?? []).map((s) => ({
              value: s.id,
              label: s.assetTag ? `${s.assetTag} (on-hand ${s.onHandQuantity})` : `${s.id} (on-hand ${s.onHandQuantity})`,
            }))}
          />
          <PickerError message={form.formState.errors.assetId?.message as string | undefined} />
        </>
      )}
      <TextField control={form.control} name="expectedQuantity" label="Expected quantity (optional)" type="number" />
      <TextField control={form.control} name="foundQuantity" label="Found quantity (optional)" type="number" />
      <TextareaField control={form.control} name="note" label="Note (optional)" />
    </FormDialog>
  );
}
