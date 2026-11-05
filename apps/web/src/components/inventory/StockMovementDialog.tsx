"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { SelectField, TextareaField, TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useRecordMovement } from "@/features/inventory/hooks";
import { buildStockMovement, stockMovementSchema, type StockMovementValues } from "@/features/inventory/formSchemas";
import { stockKindLabel, toOptions } from "@/features/inventory/labels";

const KIND_OPTIONS = toOptions(stockKindLabel);

/** Record a signed stock movement. ISSUE reduces on-hand (server refuses below 0). */
export function StockMovementDialog({
  open,
  onOpenChange,
  assetId,
  onHand,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId: string;
  onHand: number;
}) {
  const [error, setError] = useState<string | null>(null);
  const record = useRecordMovement(assetId, { toast: false });
  const form = useForm<z.input<typeof stockMovementSchema>, unknown, StockMovementValues>({
    resolver: zodFormResolver(stockMovementSchema),
    defaultValues: { kind: "", quantity: "", reason: "" },
  });
  const kind = form.watch("kind");

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const res = await record.mutateAsync(buildStockMovement(values));
      toast.success(`Movement recorded. On-hand: ${res.onHandQuantity}`);
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Record stock movement"
      description={`Current on-hand: ${onHand}.`}
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Record movement"
      pending={record.isPending}
      error={error}
    >
      <SelectField control={form.control} name="kind" label="Kind" options={KIND_OPTIONS} />
      <TextField
        control={form.control}
        name="quantity"
        label="Quantity (signed)"
        type="number"
        help={
          String(kind) === "ISSUE"
            ? "This reduces on-hand; a movement that would drive on-hand below 0 is refused (insufficient stock)."
            : "RECEIPT > 0, ISSUE < 0, ADJUSTMENT != 0."
        }
      />
      <TextareaField control={form.control} name="reason" label="Reason (optional)" />
    </FormDialog>
  );
}
