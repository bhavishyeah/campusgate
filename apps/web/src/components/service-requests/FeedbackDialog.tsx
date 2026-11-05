"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { SelectField, TextareaField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useMyFeedback } from "@/features/service-requests/hooks";
import { buildFeedback, feedbackSchema, type FeedbackValues } from "@/features/service-requests/formSchemas";

const RATING_OPTIONS = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }));

export function FeedbackDialog({
  open,
  onOpenChange,
  requestId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const feedback = useMyFeedback(requestId, { toast: false });
  const form = useForm<z.input<typeof feedbackSchema>, unknown, FeedbackValues>({
    resolver: zodFormResolver(feedbackSchema),
    defaultValues: { rating: "", comment: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await feedback.mutateAsync(buildFeedback(values));
      toast.success("Feedback submitted");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Leave feedback"
      description="You can submit feedback once per request."
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Submit feedback"
      pending={feedback.isPending}
      error={error}
    >
      <SelectField control={form.control} name="rating" label="Rating (1-5)" options={RATING_OPTIONS} />
      <TextareaField control={form.control} name="comment" label="Comment (optional)" />
    </FormDialog>
  );
}
