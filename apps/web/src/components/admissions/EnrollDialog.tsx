"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import Link from "next/link";
import { useEffect, useState } from "react";
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
  FormDescription,
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
import {
  useAdmissionLookups,
  useEnroll,
  useEnrollPreview,
  type EnrollEmailOutcome,
  type EnrollResult,
} from "@/features/admissions/hooks";
import { enrollFormSchema, type EnrollFormValues } from "@/features/admissions/formSchemas";

const IDENTITY_HINT = /identity|enrollment|already exists|different/i;

const EMAIL_LINE: Record<EnrollEmailOutcome, string> = {
  SENT: "An email was sent to the student.",
  SKIPPED_NOT_CONFIGURED: "No email was sent because email is not configured. Use Resend invite on the Users page if the student needs an activation link.",
  SKIPPED_BUDGET: "No email was sent because the daily email limit is reached. Use Resend invite on the Users page later.",
  FAILED: "The email could not be sent. Use Resend invite on the Users page.",
};

/**
 * Enrolls an ACCEPTED application: previews what will happen (student record,
 * student access, email), lets the officer accept or edit the suggested
 * enrollment number, then shows the resulting student. Errors are rendered
 * verbatim and inline (409 identity/duplicate messages emphasised); the dialog
 * stays open.
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
  const preview = useEnrollPreview(applicationId, open);
  const permissions = useAuthStore((s) => s.permissions);
  const canPickSession = needsSession && can("admissions.campaigns.manage", permissions);
  const [error, setError] = useState<{ text: string; identity: boolean } | null>(null);
  const [result, setResult] = useState<EnrollResult | null>(null);
  const form = useForm<EnrollFormValues>({
    resolver: zodResolver(enrollFormSchema),
    defaultValues: { enrollmentNo: "", academicSessionId: "" },
  });

  const suggestion = preview.data?.suggestedEnrollmentNo ?? "";
  useEffect(() => {
    if (suggestion && !form.formState.isDirty) form.setValue("enrollmentNo", suggestion);
  }, [suggestion, form]);

  const willCreate = preview.data?.willCreateProfile ?? true;
  const previewError = preview.isError ? describeApiError(preview.error) : null;

  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    const typed = values.enrollmentNo.trim();
    // The suggestion is only a preview: when it is untouched the server allocates at commit.
    const sendNumber = willCreate && typed !== "" && typed !== suggestion;
    enroll.mutate(
      {
        ...(sendNumber ? { enrollmentNo: typed } : {}),
        academicSessionId: values.academicSessionId || undefined,
      },
      {
        onSuccess: (res) => {
          toast.success(res.created ? "Student record created" : "Linked to an existing student record");
          setResult(res);
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

  if (result) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Applicant enrolled</DialogTitle>
            <DialogDescription>The student record is ready and student access is granted.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm" role="status">
            <p>
              Enrollment number: <span className="font-medium">{result.enrollmentNo}</span>
            </p>
            <Can permission="students.view">
              <p>
                <Link href={`/sis/students/${result.studentProfileId}`} className="text-primary-700 underline">
                  Open student record
                </Link>
              </p>
            </Can>
            <p className="text-gray-700">{EMAIL_LINE[result.email]}</p>
          </div>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const data = preview.data;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enroll applicant</DialogTitle>
          <DialogDescription>Enrolling turns this applicant into a student. This will:</DialogDescription>
        </DialogHeader>
        <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
          <li>{willCreate ? "Create the student record." : "Link the applicant's existing student record."}</li>
          <li>Grant student access, so they can use the student portal.</li>
          <li>
            {data?.emailConfigured === false
              ? "Not send an email, because email is not configured."
              : data?.hasPassword === false
                ? "Email the student an enrollment notice that includes an activation link."
                : "Email the student an enrollment notice."}
          </li>
        </ul>
        {data?.student ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm rounded-md border border-gray-200 px-3 py-2">
            <dt className="text-gray-500">Name</dt>
            <dd>{data.student.name || "—"}</dd>
            <dt className="text-gray-500">Program</dt>
            <dd>{data.student.programName}</dd>
            <dt className="text-gray-500">Department</dt>
            <dd>{data.student.departmentName ?? "—"}</dd>
            <dt className="text-gray-500">Session</dt>
            <dd>{data.student.sessionName ?? "—"}</dd>
          </dl>
        ) : null}
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-3">
            {previewError ? <InlineError message={previewError} /> : null}
            {willCreate ? (
              <FormField
                control={form.control}
                name="enrollmentNo"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Enrollment number</FormLabel>
                    <FormControl><Input {...field} maxLength={100} /></FormControl>
                    <FormDescription>
                      Suggested from the program and year. Leave it blank to generate one when you confirm. The number
                      is final only once saved.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <p className="text-sm">
                Enrollment number: <span className="font-medium">{data?.existingEnrollmentNo ?? "—"}</span>{" "}
                <span className="text-gray-500">(existing record)</span>
              </p>
            )}
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
              <Button type="submit" disabled={enroll.isPending || preview.isLoading || preview.isError}>
                {enroll.isPending ? "Enrolling…" : "Confirm and enroll"}
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
