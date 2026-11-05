"use client";

import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { toast } from "sonner";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { FormDialog } from "@/components/forms/FormDialog";
import { PickerError, SelectField, TextField, TextareaField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { Label } from "@/components/ui/label";
import { useUploadDocument } from "@/features/documents/hooks";
import { createDocumentFormSchema, type CreateDocumentValues } from "@/features/documents/formSchemas";
import { validateUploadSize } from "@/features/documents/upload";
import type { RetentionPolicy } from "@/features/documents/types";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/** New-document upload: real file input, client size/presence guard, raw-body POST. */
export function UploadDialog({
  open,
  onOpenChange,
  policies,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  policies: RetentionPolicy[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadDocument({ toast: false });

  const form = useForm<z.input<typeof createDocumentFormSchema>, unknown, CreateDocumentValues>({
    resolver: zodFormResolver(createDocumentFormSchema),
    defaultValues: { title: "", description: "", category: "", contentType: "", retentionPolicyId: "" },
  });

  function reset() {
    form.reset();
    setFile(null);
    setFileError(undefined);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setFileError(undefined);
    if (f) {
      form.setValue("contentType", f.type || DEFAULT_CONTENT_TYPE, { shouldValidate: form.formState.isSubmitted });
      if (form.getValues("title") === "") form.setValue("title", f.name);
    }
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    if (!file) {
      setFileError("Select a file to upload.");
      return;
    }
    const sizeCheck = validateUploadSize(file.size);
    if (!sizeCheck.ok) {
      setFileError(sizeCheck.message);
      return;
    }
    try {
      await upload.mutateAsync({
        file,
        meta: {
          title: values.title,
          filename: file.name,
          contentType: values.contentType,
          description: values.description,
          category: values.category,
          retentionPolicyId: values.retentionPolicyId || undefined,
        },
      });
      toast.success("Document uploaded");
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  const policyOptions = policies.map((p) => ({ value: p.id, label: p.name }));

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Upload document"
      description="Max 25 MiB. The file is sent to the server, which stores it securely."
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Upload"
      pendingLabel="Uploading…"
      pending={upload.isPending}
      error={error}
    >
      <div className="space-y-2">
        <Label htmlFor="documents-file">File</Label>
        <input
          id="documents-file"
          ref={inputRef}
          type="file"
          onChange={onFileChange}
          disabled={upload.isPending}
          className="block w-full text-sm text-gray-700 file:mr-3 file:rounded-md file:border-0 file:bg-primary-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-700"
        />
        <PickerError message={fileError} />
      </div>
      <TextField control={form.control} name="title" label="Title" />
      <TextField
        control={form.control}
        name="contentType"
        label="Content type"
        help="Seeded from the file; override if the browser guessed wrong."
      />
      <TextareaField control={form.control} name="description" label="Description (optional)" />
      <TextField control={form.control} name="category" label="Category (optional)" />
      {policyOptions.length > 0 ? (
        <SelectField
          control={form.control}
          name="retentionPolicyId"
          label="Retention policy (optional)"
          options={policyOptions}
          noneLabel="None"
        />
      ) : null}
    </FormDialog>
  );
}
