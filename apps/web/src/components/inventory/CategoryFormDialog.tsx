"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { SelectField, TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useCreateCategory, usePatchCategory } from "@/features/inventory/hooks";
import {
  ASSET_KINDS,
  buildCategoryCreate,
  buildCategoryPatch,
  categoryCreateSchema,
  categoryPatchSchema,
  type CategoryCreateValues,
  type CategoryPatchValues,
} from "@/features/inventory/formSchemas";
import { assetKindLabel, toOptions } from "@/features/inventory/labels";
import type { Category } from "@/features/inventory/types";

const KIND_OPTIONS = toOptions(assetKindLabel);

export function CategoryFormDialog({
  open,
  onOpenChange,
  category,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  category?: Category;
}) {
  const editing = Boolean(category);
  const [error, setError] = useState<string | null>(null);
  const create = useCreateCategory({ toast: false });
  const patch = usePatchCategory(category?.id ?? "", { toast: false });
  const schema = editing ? categoryPatchSchema : categoryCreateSchema;

  const form = useForm<z.input<typeof schema>, unknown, CategoryCreateValues | CategoryPatchValues>({
    resolver: zodFormResolver(schema),
    defaultValues: {
      name: category?.name ?? "",
      code: category?.code ?? "",
      kind: category?.kind ?? "",
      depreciationMethod: category?.depreciationMethod ?? "",
      usefulLifeMonths: category?.usefulLifeMonths != null ? String(category.usefulLifeMonths) : "",
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const conflicts = { "category code already exists": "code" as const };
    try {
      if (editing && category) {
        await patch.mutateAsync(buildCategoryPatch(form.formState.dirtyFields, values as CategoryPatchValues));
        toast.success("Category updated");
      } else {
        await create.mutateAsync(buildCategoryCreate(values as CategoryCreateValues));
        toast.success("Category created");
      }
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form, conflicts));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? "Edit category" : "New category"}
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel={editing ? "Save changes" : "Create category"}
      pending={create.isPending || patch.isPending}
      error={error}
      disableSubmit={editing && !form.formState.isDirty}
    >
      <TextField control={form.control} name="name" label="Name" />
      <TextField control={form.control} name="code" label="Code" />
      <SelectField
        control={form.control}
        name="kind"
        label="Kind"
        options={KIND_OPTIONS}
        help="Changing kind does not create or remove a stock item."
      />
      <TextField control={form.control} name="depreciationMethod" label="Depreciation method (optional)" />
      <TextField control={form.control} name="usefulLifeMonths" label="Useful life (months, optional)" type="number" />
    </FormDialog>
  );
}
