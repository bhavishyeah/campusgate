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
import { describeApiError } from "@/lib/apiErrors";
import { useSetInterview } from "@/features/admissions/hooks";
import { interviewFormSchema, type InterviewFormValues } from "@/features/admissions/formSchemas";

export function InterviewDialog({
  open,
  onOpenChange,
  applicationId,
  currentInterviewAt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: string;
  currentInterviewAt: string | null;
}) {
  const setInterview = useSetInterview(applicationId);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<InterviewFormValues>({
    resolver: zodResolver(interviewFormSchema),
    defaultValues: { interviewAt: currentInterviewAt ? currentInterviewAt.slice(0, 16) : "" },
  });

  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    setInterview.mutate(
      { interviewAt: new Date(values.interviewAt).toISOString() },
      {
        onSuccess: () => {
          toast.success("Interview time saved.");
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
          <DialogTitle>Set interview</DialogTitle>
          <DialogDescription>Saves the interview time. Does not change status.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-3">
            <FormField
              control={form.control}
              name="interviewAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Interview time</FormLabel>
                  <FormControl><Input type="datetime-local" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {error ? <InlineError message={error} /> : null}
            <DialogFooter>
              <Button type="submit" disabled={setInterview.isPending}>
                {setInterview.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
