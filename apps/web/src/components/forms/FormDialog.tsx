"use client";

import type { FieldValues, UseFormReturn } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { InlineError } from "@/components/ui-ext/InlineError";

/**
 * Shared dialog shell for react-hook-form dialogs: inline server error, stays open on failure.
 * The caller owns submit (it maps server field conflicts with setError) and closing on success.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  form,
  onSubmit,
  submitLabel,
  pendingLabel = "Saving...",
  pending,
  error,
  disableSubmit,
  destructive,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  form: any;
  onSubmit: () => void;
  submitLabel: string;
  pendingLabel?: string;
  pending: boolean;
  error: string | null;
  disableSubmit?: boolean;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <Form {...(form as UseFormReturn<FieldValues>)}>
          <form onSubmit={onSubmit} className="space-y-3">
            {children}
            {error ? <InlineError message={error} /> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={pending || disableSubmit}>
                {pending ? pendingLabel : submitLabel}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
