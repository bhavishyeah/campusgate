"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { InlineError } from "@/components/ui-ext/InlineError";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { describeApiError } from "@/lib/apiErrors";
import { useAddDocument } from "@/features/admissions/hooks";
import { documentFormSchema, type DocumentFormValues } from "@/features/admissions/formSchemas";

export function AddDocumentDialog({
  open,
  onOpenChange,
  applicationId,
  requiredDocTypes,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: string;
  requiredDocTypes: string[];
}) {
  const add = useAddDocument(applicationId);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<DocumentFormValues>({
    resolver: zodResolver(documentFormSchema),
    defaultValues: { docType: requiredDocTypes[0] ?? "", reference: "", fileName: "" },
  });

  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    add.mutate(
      {
        docType: values.docType.trim(),
        reference: values.reference.trim(),
        fileName: values.fileName.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Document added.");
          form.reset({ docType: requiredDocTypes[0] ?? "", reference: "", fileName: "" });
          onOpenChange(false);
        },
        onError: (err) => setError(describeApiError(err)),
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add document link / reference</DialogTitle>
          <DialogDescription>Paste a link or reference to the document. File upload is not available.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-3">
            <FormField
              control={form.control}
              name="docType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Document type</FormLabel>
                  {requiredDocTypes.length > 0 ? (
                    <SimpleSelect
                      ariaLabel="Document type"
                      value={field.value}
                      onChange={field.onChange}
                      options={requiredDocTypes.map((d) => ({ value: d, label: d }))}
                    />
                  ) : (
                    <FormControl>
                      <Input {...field} maxLength={100} />
                    </FormControl>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="reference"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reference</FormLabel>
                  <FormControl><Input {...field} maxLength={2000} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="fileName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>File name (optional)</FormLabel>
                  <FormControl><Input {...field} maxLength={300} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {error ? <InlineError message={error} /> : null}
            <DialogFooter>
              <Button type="submit" disabled={add.isPending}>
                {add.isPending ? "Saving…" : "Add document"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
