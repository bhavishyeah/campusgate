"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { useState } from "react";
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { InlineError } from "@/components/ui-ext/InlineError";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { describeApiError } from "@/lib/apiErrors";
import { useIssueOffer } from "@/features/admissions/hooks";
import { offerFormSchema, type OfferFormValues } from "@/features/admissions/formSchemas";
import type { ProgramRef } from "@/features/admissions/types";

export function IssueOfferDialog({
  open,
  onOpenChange,
  applicationId,
  programs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: string;
  programs: ProgramRef[];
}) {
  const issue = useIssueOffer(applicationId);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<OfferFormValues>({
    resolver: zodResolver(offerFormSchema),
    defaultValues: { offeredProgramId: programs[0]?.id ?? "", expiresAt: "" },
  });

  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    issue.mutate(
      {
        offeredProgramId: values.offeredProgramId,
        expiresAt: values.expiresAt ? new Date(values.expiresAt).toISOString() : undefined,
      },
      {
        onSuccess: () => {
          toast.success("Offer issued.");
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
          <DialogTitle>Issue offer</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-3">
            <FormField
              control={form.control}
              name="offeredProgramId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Program</FormLabel>
                  <SimpleSelect
                    ariaLabel="Program"
                    value={field.value}
                    onChange={field.onChange}
                    options={programs.map((p) => ({ value: p.id, label: p.name }))}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="expiresAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Expires at (optional)</FormLabel>
                  <Input type="datetime-local" {...field} />
                  <FormMessage />
                </FormItem>
              )}
            />
            {error ? <InlineError message={error} /> : null}
            <DialogFooter>
              <Button type="submit" disabled={issue.isPending || programs.length === 0}>
                {issue.isPending ? "Issuing…" : "Issue offer"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
