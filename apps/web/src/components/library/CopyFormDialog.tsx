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
import { ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";
import { useAddCopy, usePatchCopy } from "@/features/library/hooks";
import {
  buildCopyCreate,
  buildCopyPatch,
  copyFormSchema,
  type CopyFormValues,
} from "@/features/library/formSchemas";
import { copyConditionLabel } from "@/features/library/labels";
import type { BookCopy } from "@/features/library/types";

function defaults(c?: BookCopy): CopyFormValues {
  return {
    accessionNumber: c?.accessionNumber ?? "",
    shelfLocation: c?.shelfLocation ?? "",
    condition: c?.condition ?? "GOOD",
    acquiredAt: c?.acquiredAt ? c.acquiredAt.slice(0, 10) : "",
  };
}

/** Add a copy (no `copy`) or edit shelf/condition/acquired date. Status is never editable here. */
export function CopyFormDialog({
  open,
  onOpenChange,
  titleId,
  copy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titleId: string;
  copy?: BookCopy;
}) {
  const add = useAddCopy(titleId);
  const patch = usePatchCopy(titleId);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<CopyFormValues>({
    resolver: zodResolver(copyFormSchema),
    defaultValues: defaults(copy),
  });
  const pending = add.isPending || patch.isPending;

  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    if (copy) {
      const body = buildCopyPatch(values, form.formState.dirtyFields);
      if (Object.keys(body).length === 0) {
        onOpenChange(false);
        return;
      }
      patch.mutate(
        { id: copy.id, body },
        {
          onSuccess: () => {
            toast.success("Copy updated.");
            onOpenChange(false);
          },
        },
      );
      return;
    }
    add.mutate(buildCopyCreate(values), {
      onSuccess: () => {
        toast.success("Copy added.");
        form.reset(defaults());
        onOpenChange(false);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409 && err.data?.error === "accession number already exists") {
          form.setError("accessionNumber", { message: "This accession number already exists." });
          return;
        }
        setError(describeApiError(err));
      },
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy ? "Edit copy" : "Add copy"}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-3">
            {!copy ? (
              <FormField
                control={form.control}
                name="accessionNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Accession number</FormLabel>
                    <FormControl><Input {...field} maxLength={100} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : null}
            <FormField
              control={form.control}
              name="shelfLocation"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Shelf location</FormLabel>
                  <FormControl><Input {...field} maxLength={200} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="condition"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Condition</FormLabel>
                  <SimpleSelect
                    ariaLabel="Condition"
                    value={field.value}
                    onChange={field.onChange}
                    options={Object.entries(copyConditionLabel).map(([value, label]) => ({ value, label }))}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="acquiredAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Acquired on</FormLabel>
                  <FormControl><Input type="date" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {error ? <InlineError message={error} /> : null}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : copy ? "Save changes" : "Add copy"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
