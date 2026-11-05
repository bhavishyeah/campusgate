"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { PickerError, SelectField, TextField } from "@/components/forms/Fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { handleServerError } from "@/components/forms/serverErrors";
import { useCreateField, usePatchField } from "@/features/service-requests/hooks";
import {
  buildFieldCreate,
  buildFieldPatch,
  fieldCreateSchema,
  fieldPatchSchema,
  type FieldCreateValues,
  type FieldPatchValues,
} from "@/features/service-requests/formSchemas";
import { fieldTypeLabel, toOptions } from "@/features/service-requests/labels";
import type { FieldDef } from "@/features/service-requests/types";

const TYPE_OPTIONS = toOptions(fieldTypeLabel);

export function FieldFormDialog({
  open,
  onOpenChange,
  typeId,
  field,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  typeId: string;
  field?: FieldDef;
}) {
  const editing = Boolean(field);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<string[]>(field?.options ?? [""]);
  const create = useCreateField(typeId, { toast: false });
  const patch = usePatchField(typeId, { toast: false });
  const schema = editing ? fieldPatchSchema : fieldCreateSchema;

  const form = useForm<z.input<typeof schema>, unknown, FieldCreateValues | FieldPatchValues>({
    resolver: zodFormResolver(schema),
    defaultValues: {
      fieldKey: field?.fieldKey ?? "",
      label: field?.label ?? "",
      dataType: field?.dataType ?? "",
      required: field?.required ?? false,
      sortOrder: field?.sortOrder != null ? String(field.sortOrder) : "",
      options: field?.options ?? [],
    },
  });
  const dataType = form.watch("dataType");

  function syncOptions(next: string[]) {
    setOptions(next);
    form.setValue("options", next, { shouldValidate: form.formState.isSubmitted, shouldDirty: true });
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const conflicts = { "field key already exists for this type": "fieldKey" as const };
    try {
      if (editing && field) {
        await patch.mutateAsync({ fid: field.id, body: buildFieldPatch(form.formState.dirtyFields, values as FieldPatchValues) });
        toast.success("Field updated");
      } else {
        await create.mutateAsync(buildFieldCreate(values as FieldCreateValues));
        toast.success("Field added");
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
      title={editing ? "Edit field" : "Add field"}
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel={editing ? "Save changes" : "Add field"}
      pending={create.isPending || patch.isPending}
      error={error}
      disableSubmit={editing && !form.formState.isDirty}
    >
      <TextField control={form.control} name="fieldKey" label="Field key" help="Letters, digits, underscore." />
      <TextField control={form.control} name="label" label="Label" />
      <SelectField
        control={form.control}
        name="dataType"
        label="Data type"
        options={TYPE_OPTIONS}
        onValueChange={() => form.trigger("options")}
      />
      <CheckboxRow
        label="Required"
        checked={Boolean(form.watch("required"))}
        onChange={(c) => form.setValue("required", c, { shouldDirty: true })}
      />
      <TextField control={form.control} name="sortOrder" label="Sort order (optional)" type="number" />
      {String(dataType) === "SELECT" ? (
        <div className="space-y-2">
          <Label>Options</Label>
          {options.map((opt, i) => (
            <div key={i} className="flex gap-2">
              <Input
                value={opt}
                onChange={(e) => syncOptions(options.map((o, j) => (j === i ? e.target.value : o)))}
                maxLength={200}
              />
              <Button type="button" variant="outline" size="sm" onClick={() => syncOptions(options.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => syncOptions([...options, ""])}>
            Add option
          </Button>
          <PickerError message={form.formState.errors.options?.message as string | undefined} />
        </div>
      ) : null}
    </FormDialog>
  );
}

function CheckboxRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (c: boolean) => void }) {
  const id = `cb-${label.replace(/\s+/g, "-")}`;
  return (
    <div className="flex items-center gap-2">
      <input id={id} type="checkbox" className="h-4 w-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
}
