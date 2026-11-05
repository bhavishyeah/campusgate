"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { toast } from "sonner";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { FormDialog } from "@/components/forms/FormDialog";
import { PickerError, SelectField, TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { Label } from "@/components/ui/label";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { UserPicker } from "@/components/documents/UserPicker";
import { useCreateGrant } from "@/features/documents/hooks";
import { ACCESS_LEVEL_LABEL } from "@/features/documents/labels";
import { buildGrantBody, grantFormSchema, type GrantValues } from "@/features/documents/formSchemas";
import type { UserLookupItem } from "@/features/documents/types";

/**
 * Create a grant for a document the caller can MANAGE. The grantee is EITHER a
 * user (resolved via the documents-gated UserPicker) OR a department id. There
 * is no documents-gated department picker (api-contract note 7 — department
 * grants source from the tenant department list), so the department id is a
 * validated text input; the user path is the primary, picker-backed flow.
 */
export function GrantFormDialog({
  open,
  onOpenChange,
  documentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentId: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<UserLookupItem | null>(null);
  const create = useCreateGrant(documentId, { toast: false });

  const form = useForm<z.input<typeof grantFormSchema>, unknown, GrantValues>({
    resolver: zodFormResolver(grantFormSchema),
    defaultValues: { granteeType: "user", granteeUserId: "", granteeDepartmentId: "", accessLevel: "READ" },
  });
  const granteeType = form.watch("granteeType");

  function reset() {
    form.reset();
    setUser(null);
    setError(null);
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const conflicts = {
      "user not found": "granteeUserId" as const,
      "department not found": "granteeDepartmentId" as const,
    };
    try {
      await create.mutateAsync(buildGrantBody(values));
      toast.success("Access granted");
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form, conflicts));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Grant access"
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Grant access"
      pending={create.isPending}
      error={error}
    >
      <div className="space-y-2">
        <Label>Grantee</Label>
        <SimpleSelect
          ariaLabel="Grantee type"
          value={granteeType}
          onChange={(v) => {
            form.setValue("granteeType", v as "user" | "department");
            form.setValue("granteeUserId", "");
            form.setValue("granteeDepartmentId", "");
            setUser(null);
          }}
          options={[
            { value: "user", label: "A user" },
            { value: "department", label: "A department" },
          ]}
        />
      </div>

      {granteeType === "user" ? (
        <UserPicker
          value={user}
          onChange={(u) => {
            setUser(u);
            form.setValue("granteeUserId", u?.id ?? "", { shouldValidate: form.formState.isSubmitted });
          }}
        />
      ) : (
        <TextField
          control={form.control}
          name="granteeDepartmentId"
          label="Department id"
          help="Grant to every member whose department scope matches this id."
        />
      )}
      {/* The XOR message lands on granteeUserId regardless of the active path. */}
      <PickerError message={form.formState.errors.granteeUserId?.message as string | undefined} />

      <SelectField
        control={form.control}
        name="accessLevel"
        label="Access level"
        options={[
          { value: "READ", label: ACCESS_LEVEL_LABEL.READ },
          { value: "MANAGE", label: ACCESS_LEVEL_LABEL.MANAGE },
        ]}
      />
    </FormDialog>
  );
}
