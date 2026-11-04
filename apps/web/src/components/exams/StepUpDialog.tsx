"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
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
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ApiError } from "@/lib/api";
import { useStepUp } from "@/features/exams/useStepUp";
import { toastError } from "@/features/exams/hooks";

const STEP_UP_ACTION = "exams.results.publish";

const codeSchema = z.object({
  code: z.string().min(1, "Enter your authentication code"),
});
type CodeValues = z.infer<typeof codeSchema>;

export function StepUpDialog({
  open,
  onOpenChange,
  onToken,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Called with the minted step-up token; the caller retries the request. */
  onToken: (token: string) => void;
}) {
  const stepUp = useStepUp();
  const [notEnrolled, setNotEnrolled] = useState(false);
  const form = useForm<CodeValues>({
    resolver: zodResolver(codeSchema),
    defaultValues: { code: "" },
  });

  const onSubmit = form.handleSubmit(async ({ code }) => {
    try {
      const token = await stepUp.mutateAsync({ code, action: STEP_UP_ACTION });
      form.reset();
      onToken(token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        if (err.message === "MFA not enrolled") {
          setNotEnrolled(true);
          return;
        }
        if (err.message === "Invalid code") {
          form.setError("code", { message: "Invalid code. Try again." });
          return;
        }
      }
      toastError(err);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm it&apos;s you</DialogTitle>
          <DialogDescription>
            Publishing results needs a fresh authentication code. Enter the 6-digit
            code from your authenticator app, or a recovery code.
          </DialogDescription>
        </DialogHeader>
        {notEnrolled && (
          <InlineError message="MFA is not enrolled for your account. Set up an authenticator app from your account security settings first, then try again." />
        )}
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Authentication code</FormLabel>
                  <FormControl>
                    <Input
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      disabled={notEnrolled}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={stepUp.isPending || notEnrolled}>
                {stepUp.isPending ? "Verifying…" : "Verify"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
