"use client";

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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { InlineError } from "@/components/ui-ext/InlineError";
import { describeApiError } from "@/lib/apiErrors";

/**
 * Confirm dialog with an optional free-text note/reason (max 2000). The caller
 * runs the mutation in `onConfirm`; a rejected promise keeps the dialog open
 * and its message is rendered inline.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  fieldLabel = "Note (optional)",
  destructive,
  pending,
  onConfirm,
  extra,
  errorOverrides,
  hideField,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  fieldLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: (text: string) => Promise<unknown> | void;
  extra?: React.ReactNode;
  errorOverrides?: Record<string, string>;
  /** Confirm-only dialog (no note field). */
  hideField?: boolean;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const tooLong = text.trim().length > 2000;

  async function confirm() {
    setError(null);
    try {
      await onConfirm(text.trim());
      setText("");
      onOpenChange(false);
    } catch (err) {
      setError(describeApiError(err, errorOverrides));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setText("");
          setError(null);
        }
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {extra}
        {hideField ? null : (
          <div className="space-y-2">
            <Label htmlFor="reason-dialog-text">{fieldLabel}</Label>
            <Textarea
              id="reason-dialog-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={2100}
              rows={3}
            />
            {tooLong ? <p className="text-sm text-danger-700">Max 2000 characters.</p> : null}
          </div>
        )}
        {error ? <InlineError message={error} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={confirm}
            disabled={pending || tooLong}
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
