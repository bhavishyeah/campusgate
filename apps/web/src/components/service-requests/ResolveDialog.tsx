"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { TextareaField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useResolve } from "@/features/service-requests/hooks";
import { buildResolve, resolveSchema, type ResolveValues } from "@/features/service-requests/formSchemas";

export function ResolveDialog({
  open,
  onOpenChange,
  requestId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const resolve = useResolve(requestId, { toast: false });
  const form = useForm<z.input<typeof resolveSchema>, unknown, ResolveValues>({
    resolver: zodFormResolver(resolveSchema),
    defaultValues: { resolutionNote: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await resolve.mutateAsync(buildResolve(values));
      toast.success("Request resolved");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Resolve request"
      description="This marks the request Resolved."
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Resolve"
      pending={resolve.isPending}
      error={error}
    >
      <TextareaField control={form.control} name="resolutionNote" label="Resolution note" />
    </FormDialog>
  );
}
