"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { TextareaField, TextField } from "@/components/forms/Fields";
import { Label } from "@/components/ui/label";
import { handleServerError } from "@/components/forms/serverErrors";
import { useCreateType, usePatchType } from "@/features/service-requests/hooks";
import {
  buildTypeCreate,
  buildTypePatch,
  typeCreateSchema,
  typePatchSchema,
  type TypeCreateValues,
  type TypePatchValues,
} from "@/features/service-requests/formSchemas";
import type { RequestType } from "@/features/service-requests/types";

export function TypeFormDialog({
  open,
  onOpenChange,
  type,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type?: RequestType;
}) {
  const editing = Boolean(type);
  const [error, setError] = useState<string | null>(null);
  const create = useCreateType({ toast: false });
  const patch = usePatchType(type?.id ?? "", { toast: false });
  const schema = editing ? typePatchSchema : typeCreateSchema;

  const form = useForm<z.input<typeof schema>, unknown, TypeCreateValues | TypePatchValues>({
    resolver: zodFormResolver(schema),
    defaultValues: {
      name: type?.name ?? "",
      code: type?.code ?? "",
      category: type?.category ?? "",
      description: type?.description ?? "",
      defaultAssigneeRole: type?.defaultAssigneeRole ?? "",
      defaultAssigneeDepartmentId: type?.defaultAssigneeDepartmentId ?? "",
      slaTargetHours: type ? String(type.slaTargetHours) : "",
      requiresApproval: type?.requiresApproval ?? false,
      isActive: type?.isActive ?? true,
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const conflicts = { "request type code already exists": "code" as const };
    try {
      if (editing && type) {
        await patch.mutateAsync(buildTypePatch(form.formState.dirtyFields, values as TypePatchValues));
        toast.success("Type updated");
      } else {
        await create.mutateAsync(buildTypeCreate(values as TypeCreateValues));
        toast.success("Type created");
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
      title={editing ? "Edit request type" : "New request type"}
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel={editing ? "Save changes" : "Create type"}
      pending={create.isPending || patch.isPending}
      error={error}
      disableSubmit={editing && !form.formState.isDirty}
    >
      <TextField control={form.control} name="name" label="Name" />
      <TextField control={form.control} name="code" label="Code" help="Uppercase letters, digits, underscore." />
      <TextField control={form.control} name="category" label="Category" />
      <TextareaField control={form.control} name="description" label="Description (optional)" />
      <TextField
        control={form.control}
        name="defaultAssigneeRole"
        label="Default assignee role (optional)"
        help="Advisory routing hint; it is not validated against real roles."
      />
      <TextField control={form.control} name="slaTargetHours" label="SLA target hours" type="number" />
      <CheckboxRow
        label="Requires approval"
        checked={Boolean(form.watch("requiresApproval"))}
        onChange={(c) => form.setValue("requiresApproval", c, { shouldDirty: true })}
      />
      <CheckboxRow
        label="Active"
        checked={Boolean(form.watch("isActive"))}
        onChange={(c) => form.setValue("isActive", c, { shouldDirty: true })}
      />
    </FormDialog>
  );
}

function CheckboxRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (c: boolean) => void }) {
  const id = `cb-${label.replace(/\s+/g, "-")}`;
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="checkbox"
        className="h-4 w-4"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
}
