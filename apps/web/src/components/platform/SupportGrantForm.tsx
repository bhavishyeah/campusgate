"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui-ext/InlineError";
import { PlatformStepUpDialog } from "@/components/platform/PlatformStepUpDialog";
import {
  createSupportGrantSchema,
  type CreateSupportGrantValues,
} from "@/features/platform/schemas";
import { useCreateSupportGrant } from "@/features/platform/hooks";
import { PlatformStepUpError } from "@/features/platform/stepUp";
import { ApiError } from "@/lib/api";

type GrantFields = "institutionId" | "purpose" | "expiresAt";

/**
 * Create a support grant. The first submit carries no step-up token; a 401
 * "Step-up required" (PlatformStepUpError) opens <PlatformStepUpDialog
 * action="support_grant.create" />, and onToken re-runs the mutation WITH the
 * token — mirroring components/exams/ResultsTab.tsx runPublish. A 400
 * "Invalid body" is mapped to per-field rhf errors directly (NOT via
 * describeApiError). The step-up token is never stored or logged.
 */
export function SupportGrantForm({
  open,
  institutionId,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  /** Pre-selects the target institution when the list is filtered. */
  institutionId?: string;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}) {
  const create = useCreateSupportGrant();
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [formError, setFormError] = useState("");

  const form = useForm<CreateSupportGrantValues>({
    resolver: zodResolver(createSupportGrantSchema),
    defaultValues: {
      institutionId: institutionId ?? "",
      purpose: "",
      expiresAt: "",
    },
  });

  const reset = () => {
    form.reset({ institutionId: institutionId ?? "", purpose: "", expiresAt: "" });
    setFormError("");
    setStepUpOpen(false);
    create.reset();
  };

  function runCreate(stepUpToken?: string) {
    const values = form.getValues();
    setFormError("");
    // The datetime-local control yields a local wall-clock string; normalise to
    // ISO (UTC) so the server reads the same instant the operator picked.
    const parsed = Date.parse(values.expiresAt);
    const expiresAt = Number.isNaN(parsed)
      ? values.expiresAt
      : new Date(parsed).toISOString();
    create.mutate(
      {
        body: {
          institutionId: values.institutionId,
          purpose: values.purpose,
          expiresAt,
        },
        stepUpToken,
      },
      {
        onSuccess: () => {
          setStepUpOpen(false);
          onCreated?.();
          reset();
          onOpenChange(false);
        },
        onError: (err) => {
          if (err instanceof PlatformStepUpError) {
            setStepUpOpen(true);
            return;
          }
          if (err instanceof ApiError) {
            // 400 "Invalid body" → map the zod flatten to per-field errors
            // ourselves (describeApiError only reads err.data.error).
            if (err.status === 400 && err.data?.error === "Invalid body") {
              const fieldErrors: Record<string, string[] | undefined> =
                err.data?.details?.fieldErrors ?? {};
              let mappedAny = false;
              for (const key of ["institutionId", "purpose", "expiresAt"] as GrantFields[]) {
                const msgs = fieldErrors[key];
                if (msgs && msgs.length > 0) {
                  form.setError(key, { message: msgs[0] });
                  mappedAny = true;
                }
              }
              if (!mappedAny) {
                const formErrors: string[] = err.data?.details?.formErrors ?? [];
                setFormError(formErrors[0] ?? "Invalid request.");
              }
              return;
            }
            // 404 "Institution not found" verbatim.
            setFormError(err.message);
            return;
          }
          setFormError("Something went wrong.");
        },
      },
    );
  }

  const onSubmit = form.handleSubmit(() => runCreate());

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) reset();
          onOpenChange(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create support grant</DialogTitle>
            <DialogDescription>
              Grants a time-boxed, audited break-glass access to a tenant. This
              action needs a fresh authentication code.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="institutionId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Institution ID</FormLabel>
                    <FormControl>
                      <Input placeholder="inst_…" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="purpose"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Purpose</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Why this access is needed (recorded in the audit trail)."
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="expiresAt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Expires at</FormLabel>
                    <FormControl>
                      <Input type="datetime-local" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {formError && <InlineError message={formError} />}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    reset();
                    onOpenChange(false);
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={create.isPending}>
                  {create.isPending ? "Creating…" : "Create grant"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <PlatformStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        action="support_grant.create"
        onToken={(token) => runCreate(token)}
      />
    </>
  );
}
