"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { InlineError } from "@/components/ui-ext/InlineError";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { describeApiError } from "@/lib/apiErrors";
import { useCreateQualification, useUpdateQualification } from "@/features/faculty/hooks";
import {
  buildQualificationCreate,
  buildQualificationPatch,
  qualificationPatchSchema,
  qualificationSchema,
  type QualificationFormValues,
} from "@/features/faculty/formSchemas";
import { QUALIFICATION_KIND_OPTIONS } from "@/features/faculty/labels";
import type { Qualification } from "@/features/faculty/types";

function defaults(q?: Qualification): QualificationFormValues {
  return {
    title: q?.title ?? "",
    kind: q?.kind ?? "DEGREE",
    issuingBody: q?.issuingBody ?? "",
    field: q?.field ?? "",
    year: q?.year != null ? String(q.year) : "",
    documentRef: q?.documentRef ?? "",
  };
}

/** Add (no `qualification`) or edit a qualification. Mount inside <Can faculty.qualifications.manage>. */
export function QualificationFormDialog({
  open,
  onOpenChange,
  facultyId,
  qualification,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facultyId: string;
  qualification?: Qualification;
}) {
  const create = useCreateQualification(facultyId);
  const update = useUpdateQualification(facultyId);
  const [error, setError] = useState<string | null>(null);
  const editing = Boolean(qualification);
  const form = useForm<QualificationFormValues>({
    resolver: zodResolver(qualificationSchema),
    defaultValues: defaults(qualification),
  });
  const pending = create.isPending || update.isPending;
  const patchBody = editing ? buildQualificationPatch(form.getValues(), form.formState.dirtyFields) : {};
  const nothingChanged = editing && !qualificationPatchSchema.safeParse(patchBody).success;

  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    if (qualification) {
      const body = buildQualificationPatch(values, form.formState.dirtyFields);
      update.mutate(
        { qid: qualification.id, body },
        {
          onSuccess: () => {
            toast.success("Qualification updated.");
            onOpenChange(false);
          },
          onError: (err) => setError(describeApiError(err)),
        },
      );
      return;
    }
    create.mutate(buildQualificationCreate(values), {
      onSuccess: () => {
        toast.success("Qualification added.");
        onOpenChange(false);
      },
      onError: (err) => setError(describeApiError(err)),
    });
  });

  const optional = (name: "issuingBody" | "field" | "documentRef", label: string, max: number, helper?: string) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input {...field} maxLength={max} />
          </FormControl>
          {helper ? <p className="text-xs text-gray-500">{helper}</p> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit qualification" : "Add qualification"}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-3">
            {editing ? <p className="text-xs text-gray-500">Leave blank to keep the current value.</p> : null}
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title</FormLabel>
                  <FormControl>
                    <Input {...field} maxLength={200} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <SimpleSelect
                    value={field.value}
                    onChange={field.onChange}
                    options={QUALIFICATION_KIND_OPTIONS}
                    ariaLabel="Type"
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            {optional("issuingBody", "Issuing body", 200)}
            {optional("field", "Field", 200)}
            <FormField
              control={form.control}
              name="year"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Year</FormLabel>
                  <FormControl>
                    <Input {...field} inputMode="numeric" maxLength={4} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {optional("documentRef", "Document reference", 2048, "A link or reference. File upload is not available.")}
            {error ? <InlineError message={error} /> : null}
            <DialogFooter>
              <Button type="submit" disabled={pending || nothingChanged}>
                {pending ? "Saving…" : editing ? "Save changes" : "Add qualification"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
