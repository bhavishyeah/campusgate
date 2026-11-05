"use client";

import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { FormDialog } from "@/components/forms/FormDialog";
import { PickerError, SelectField, TextareaField, TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { Button } from "@/components/ui/button";
import { AssetPicker } from "@/components/inventory/AssetPicker";
import { useAddAuditLine, useStockItemOptions } from "@/features/inventory/hooks";
import { mergeStockPages, stockOptionLabel } from "@/features/inventory/format";
import { auditLineSchema, buildAuditLine, type AuditLineValues } from "@/features/inventory/formSchemas";
import type { AuditLine, StockItem } from "@/features/inventory/types";

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

  // Stock picker: OPTION_PAGE_SIZE per page with "Load more" so every stock item
  // is reachable on an audit line (mirrors AssetPicker's page accumulation).
  const [stockPage, setStockPage] = useState(1);
  const [loadedStock, setLoadedStock] = useState<StockItem[]>([]);
  const stock = useStockItemOptions(stockPage);
  useEffect(() => {
    const data = stock.data;
    if (!data || stock.isPlaceholderData) return;
    setLoadedStock((prev) => mergeStockPages(prev, data.stockItems));
  }, [stock.data, stock.isPlaceholderData]);
  const stockTotal = stock.data && !stock.isPlaceholderData ? stock.data.total : undefined;
  const stockHasMore = stockTotal !== undefined && loadedStock.length < stockTotal;
  const stockOptions = useMemo(
    () => loadedStock.map((s) => ({ value: s.id, label: stockOptionLabel(s) })),
    [loadedStock],
  );

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
            options={stockOptions}
          />
          {stockHasMore ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={stock.isFetching}
              onClick={() => setStockPage((p) => p + 1)}
            >
              {stock.isFetching ? "Loading..." : "Load more"}
            </Button>
          ) : null}
          <PickerError message={form.formState.errors.assetId?.message as string | undefined} />
        </>
      )}
      <TextField control={form.control} name="expectedQuantity" label="Expected quantity (optional)" type="number" />
      <TextField control={form.control} name="foundQuantity" label="Found quantity (optional)" type="number" />
      <TextareaField control={form.control} name="note" label="Note (optional)" />
    </FormDialog>
  );
}
