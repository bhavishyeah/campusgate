"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { FormDialog } from "@/components/forms/FormDialog";
import { TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useCreateAudit } from "@/features/inventory/hooks";
import { auditCreateSchema, buildAuditCreate, type AuditCreateValues } from "@/features/inventory/formSchemas";
import type { AuditSession } from "@/features/inventory/types";

/** Start a stock-take session. On success the caller navigates to the detail view. */
export function AuditCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (session: AuditSession) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const create = useCreateAudit({ toast: false });
  const form = useForm<z.input<typeof auditCreateSchema>, unknown, AuditCreateValues>({
    resolver: zodFormResolver(auditCreateSchema),
    defaultValues: { name: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const session = await create.mutateAsync(buildAuditCreate(values));
      onCreated(session);
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Start a stock-take"
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Start session"
      pending={create.isPending}
      error={error}
    >
      <TextField control={form.control} name="name" label="Session name" />
    </FormDialog>
  );
}
