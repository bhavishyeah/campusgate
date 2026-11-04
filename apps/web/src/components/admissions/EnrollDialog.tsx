"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { useState } from "react";
import { Can } from "@/components/auth/Can";
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
import { useAuthStore } from "@/stores/auth";
import { can } from "@/lib/authz";
import { ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";
import { useAdmissionLookups, useEnroll } from "@/features/admissions/hooks";
import { enrollFormSchema, type EnrollFormValues } from "@/features/admissions/formSchemas";

const IDENTITY_HINT = /identity|enrollment|already exists|different/i;

/**
 * Enrolls an ACCEPTED application. Errors are rendered verbatim and inline
 * (409 identity/duplicate messages emphasised); the dialog stays open.
 */
export function EnrollDialog({
  open,
  onOpenChange,
  applicationId,
  needsSession,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: string;
  /** True when the campaign has no intake session, so the officer may pick one. */
  needsSession: boolean;
}) {
  const enroll = useEnroll(applicationId);
  const permissions = useAuthStore((s) => s.permissions);
  const canPickSession = needsSession && can("admissions.campaigns.manage", permissions);
  const [error, setError] = useState<{ text: string; identity: boolean } | null>(null);
  const form = useForm<EnrollFormValues>({
    resolver: zodResolver(enrollFormSchema),
    defaultValues: { enrollmentNo: "", academicSessionId: "" },
  });

  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    enroll.mutate(
      {
        enrollmentNo: values.enrollmentNo.trim(),
        academicSessionId: values.academicSessionId || undefined,
      },
      {
        onSuccess: (res) => {
          toast.success(res.created ? "Student record created" : "Linked to an existing student record");
          onOpenChange(false);
        },
        onError: (err) => {
          let text = describeApiError(err);
          if (err instanceof ApiError && err.status === 422 && text.startsWith("No intake session") && !canPickSession) {
            text = `${text}. Ask a campaign manager to set the intake session.`;
          }
          setError({ text, identity: err instanceof ApiError && err.status === 409 && IDENTITY_HINT.test(text) });
        },
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enroll applicant</DialogTitle>
          <DialogDescription>Enrolling creates a student record for this applicant.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-3">
            <FormField
              control={form.control}
              name="enrollmentNo"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Enrollment number</FormLabel>
                  <FormControl><Input {...field} maxLength={100} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {needsSession ? (
              <Can permission="admissions.campaigns.manage">
                <SessionField form={form} />
              </Can>
            ) : null}
            {error ? (
              <div className="space-y-1">
                <InlineError message={error.text} />
                {error.identity ? (
                  <p className="text-sm font-medium text-danger-700">
                    Check the enrollment number and the applicant identity, then try again.
                  </p>
                ) : null}
              </div>
            ) : null}
            <DialogFooter>
              <Button type="submit" disabled={enroll.isPending}>
                {enroll.isPending ? "Enrolling…" : "Enroll applicant"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/** Mounted only inside <Can campaigns.manage> so the lookups call never fires without access. */
function SessionField({ form }: { form: ReturnType<typeof useForm<EnrollFormValues>> }) {
  const lookups = useAdmissionLookups();
  return (
    <FormField
      control={form.control}
      name="academicSessionId"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Academic session</FormLabel>
          <SimpleSelect
            ariaLabel="Academic session"
            value={field.value}
            onChange={field.onChange}
            placeholder={lookups.isLoading ? "Loading…" : "Select a session"}
            options={(lookups.data?.sessions ?? []).map((s) => ({ value: s.id, label: s.name }))}
          />
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
