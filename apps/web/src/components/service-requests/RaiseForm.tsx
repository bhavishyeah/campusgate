"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { SelectField, TextareaField, TextField } from "@/components/forms/Fields";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { DynamicFieldInput } from "@/components/service-requests/DynamicFieldInput";
import { handleServerError } from "@/components/forms/serverErrors";
import { useRaise, useTypeFields } from "@/features/service-requests/hooks";
import { buildRaise, raiseSchema, type RaiseValues } from "@/features/service-requests/formSchemas";
import { fieldValueErrors } from "@/features/service-requests/errors";
import { fieldDefSort } from "@/features/service-requests/format";
import { priorityLabel, toOptions } from "@/features/service-requests/labels";
import type { ActiveType } from "@/features/service-requests/types";

const PRIORITY_OPTIONS = toOptions(priorityLabel);

/** The raise form for a chosen active type. Renders the type's dynamic fields. */
export function RaiseForm({ type, onBack }: { type: ActiveType; onBack: () => void }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const fields = useTypeFields(type.id);
  const raise = useRaise({ toast: false });

  const form = useForm<z.input<typeof raiseSchema>, unknown, RaiseValues>({
    resolver: zodFormResolver(raiseSchema),
    defaultValues: { requestTypeId: type.id, title: "", description: "", priority: "NORMAL" },
  });

  const sorted = fieldDefSort(fields.data ?? []);

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    setFieldErrors({});
    // Client-side required check for dynamic fields (common case never round-trips).
    const missing: Record<string, string> = {};
    for (const f of sorted) {
      if (f.required && (fieldValues[f.fieldKey] === undefined || fieldValues[f.fieldKey] === "")) {
        missing[f.fieldKey] = "Required";
      }
    }
    if (Object.keys(missing).length > 0) {
      setFieldErrors(missing);
      return;
    }
    try {
      await raise.mutateAsync(buildRaise(values, sorted, fieldValues));
      toast.success("Request raised");
      router.push("/service-requests/me");
    } catch (err) {
      const tokens = fieldValueErrors(err);
      if (tokens) {
        setFieldErrors(tokens);
        return;
      }
      setError(handleServerError(err, form));
    }
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{type.name}</h2>
          {type.description ? <p className="text-sm text-gray-500">{type.description}</p> : null}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          Choose another type
        </Button>
      </div>

      <Form {...form}>
        <form onSubmit={(e) => void onSubmit(e)} className="space-y-3">
          <TextField control={form.control} name="title" label="Title" />
          <TextareaField control={form.control} name="description" label="Description (optional)" />
          <SelectField control={form.control} name="priority" label="Priority" options={PRIORITY_OPTIONS} />

          {fields.isLoading ? (
            <TableSkeleton />
          ) : fields.isError ? (
            <ErrorBlock error={fields.error} onRetry={() => void fields.refetch()} />
          ) : (
            sorted.map((f) => (
              <DynamicFieldInput
                key={f.id}
                field={f}
                value={fieldValues[f.fieldKey] ?? ""}
                onChange={(v) => setFieldValues((prev) => ({ ...prev, [f.fieldKey]: v }))}
                error={fieldErrors[f.fieldKey]}
              />
            ))
          )}

          {error ? <InlineError message={error} /> : null}
          <Button type="submit" disabled={raise.isPending}>
            {raise.isPending ? "Submitting..." : "Submit request"}
          </Button>
        </form>
      </Form>
    </div>
  );
}
