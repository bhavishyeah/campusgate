"use client";

import { useRouter } from "next/navigation";
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
import { describeApiError } from "@/lib/apiErrors";
import { useCreateTitle, usePatchTitle } from "@/features/library/hooks";
import {
  buildTitleCreate,
  buildTitlePatch,
  titleFormSchema,
  type TitleFormValues,
} from "@/features/library/formSchemas";
import type { BookTitle } from "@/features/library/types";
import { useState } from "react";

const FIELDS: { name: keyof TitleFormValues; label: string; max: number; inputMode?: "numeric" }[] = [
  { name: "title", label: "Title", max: 500 },
  { name: "author", label: "Author", max: 300 },
  { name: "publisher", label: "Publisher", max: 300 },
  { name: "isbn", label: "ISBN", max: 20 },
  { name: "category", label: "Category", max: 200 },
  { name: "edition", label: "Edition", max: 100 },
  { name: "publicationYear", label: "Publication year", max: 4, inputMode: "numeric" },
];

function defaults(t?: BookTitle): TitleFormValues {
  return {
    title: t?.title ?? "",
    author: t?.author ?? "",
    publisher: t?.publisher ?? "",
    isbn: t?.isbn ?? "",
    category: t?.category ?? "",
    edition: t?.edition ?? "",
    publicationYear: t?.publicationYear != null ? String(t.publicationYear) : "",
  };
}

/** Create (no `title`) or edit (with `title`) a catalogue title. Mount inside <Can library.books.manage>. */
export function TitleFormDialog({
  open,
  onOpenChange,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: BookTitle;
}) {
  const router = useRouter();
  const create = useCreateTitle();
  const patch = usePatchTitle(title?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const form = useForm<TitleFormValues>({
    resolver: zodResolver(titleFormSchema),
    defaultValues: defaults(title),
  });
  const pending = create.isPending || patch.isPending;

  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    if (title) {
      const body = buildTitlePatch(values, form.formState.dirtyFields);
      if (Object.keys(body).length === 0) {
        onOpenChange(false);
        return;
      }
      patch.mutate(body, {
        onSuccess: () => {
          toast.success("Title updated.");
          onOpenChange(false);
        },
        onError: (err) => setError(describeApiError(err)),
      });
      return;
    }
    create.mutate(buildTitleCreate(values), {
      onSuccess: (res) => {
        toast.success("Title created.");
        if (res.possibleDuplicate) {
          const dup = res.possibleDuplicate;
          toast.warning(`Possible duplicate of '${dup.title}'`, {
            action: { label: "View", onClick: () => router.push(`/library/titles/${dup.id}`) },
          });
        }
        form.reset(defaults());
        onOpenChange(false);
        router.push(`/library/titles/${res.title.id}`);
      },
      onError: (err) => setError(describeApiError(err)),
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title ? "Edit title" : "Add title"}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-3">
            {FIELDS.map((f) => (
              <FormField
                key={f.name}
                control={form.control}
                name={f.name}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{f.label}</FormLabel>
                    <FormControl>
                      <Input {...field} maxLength={f.max} inputMode={f.inputMode} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
            {error ? <InlineError message={error} /> : null}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : title ? "Save changes" : "Add title"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
