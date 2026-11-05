"use client";

import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { toast } from "sonner";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { FormDialog } from "@/components/forms/FormDialog";
import { PickerError, TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { Label } from "@/components/ui/label";
import { useUploadVersion } from "@/features/documents/hooks";
import { newVersionFormSchema, type NewVersionValues } from "@/features/documents/formSchemas";
import { validateUploadSize } from "@/features/documents/upload";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/** Upload a new version of an existing (ACTIVE, MANAGE-able) document. */
export function NewVersionDialog({
  open,
  onOpenChange,
  documentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentId: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadVersion(documentId, { toast: false });

  const form = useForm<z.input<typeof newVersionFormSchema>, unknown, NewVersionValues>({
    resolver: zodFormResolver(newVersionFormSchema),
    defaultValues: { contentType: "" },
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
    if (f) form.setValue("contentType", f.type || DEFAULT_CONTENT_TYPE, { shouldValidate: form.formState.isSubmitted });
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
      await upload.mutateAsync({ file, meta: { filename: file.name, contentType: values.contentType } });
      toast.success("New version uploaded");
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Upload new version"
      description="Max 25 MiB. Appends a new version; older versions stay available."
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Upload version"
      pendingLabel="Uploading…"
      pending={upload.isPending}
      error={error}
    >
      <div className="space-y-2">
        <Label htmlFor="documents-version-file">File</Label>
        <input
          id="documents-version-file"
          ref={inputRef}
          type="file"
          onChange={onFileChange}
          disabled={upload.isPending}
          className="block w-full text-sm text-gray-700 file:mr-3 file:rounded-md file:border-0 file:bg-primary-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-700"
        />
        <PickerError message={fileError} />
      </div>
      <TextField
        control={form.control}
        name="contentType"
        label="Content type"
        help="Seeded from the file; override if the browser guessed wrong."
      />
    </FormDialog>
  );
}
