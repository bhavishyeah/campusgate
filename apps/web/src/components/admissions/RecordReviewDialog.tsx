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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { InlineError } from "@/components/ui-ext/InlineError";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { describeApiError } from "@/lib/apiErrors";
import { useRecordReview } from "@/features/admissions/hooks";
import { reviewFormSchema, type ReviewFormValues } from "@/features/admissions/formSchemas";
import { reviewDecisionLabel } from "@/features/admissions/labels";

export function RecordReviewDialog({
  open,
  onOpenChange,
  applicationId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: string;
}) {
  const record = useRecordReview(applicationId);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<ReviewFormValues>({
    resolver: zodResolver(reviewFormSchema),
    defaultValues: { decision: "NOTE", notes: "" },
  });

  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    record.mutate(
      { decision: values.decision, notes: values.notes.trim() || undefined },
      {
        onSuccess: () => {
          toast.success("Review recorded.");
          form.reset({ decision: "NOTE", notes: "" });
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
          <DialogTitle>Record review</DialogTitle>
          <DialogDescription>Records an opinion. It does not change the application&apos;s status.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-3">
            <FormField
              control={form.control}
              name="decision"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Decision</FormLabel>
                  <SimpleSelect
                    ariaLabel="Decision"
                    value={field.value}
                    onChange={field.onChange}
                    options={Object.entries(reviewDecisionLabel).map(([value, label]) => ({ value, label }))}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes (optional)</FormLabel>
                  <Textarea {...field} maxLength={4000} rows={4} />
                  <FormMessage />
                </FormItem>
              )}
            />
            {error ? <InlineError message={error} /> : null}
            <DialogFooter>
              <Button type="submit" disabled={record.isPending}>
                {record.isPending ? "Saving…" : "Record review"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
