"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { TextareaField } from "@/components/forms/Fields";
import { InlineError } from "@/components/ui-ext/InlineError";
import { handleServerError } from "@/components/forms/serverErrors";
import { buildComment, commentSchema, type CommentValues } from "@/features/service-requests/formSchemas";
import type { ApiError } from "@/lib/api";
import type { UseMutationResult } from "@tanstack/react-query";

/** Inline comment box. The caller supplies the comment mutation (staff or self). */
export function CommentForm({
  mutation,
}: {
  mutation: UseMutationResult<unknown, ApiError, Record<string, unknown>>;
}) {
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.input<typeof commentSchema>, unknown, CommentValues>({
    resolver: zodFormResolver(commentSchema),
    defaultValues: { body: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await mutation.mutateAsync(buildComment(values));
      toast.success("Comment added");
      form.reset({ body: "" });
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <Form {...form}>
      <form onSubmit={(e) => void onSubmit(e)} className="space-y-2">
        <TextareaField control={form.control} name="body" label="Add a comment" />
        {error ? <InlineError message={error} /> : null}
        <Button type="submit" size="sm" disabled={mutation.isPending}>
          {mutation.isPending ? "Posting..." : "Post comment"}
        </Button>
      </form>
    </Form>
  );
}
