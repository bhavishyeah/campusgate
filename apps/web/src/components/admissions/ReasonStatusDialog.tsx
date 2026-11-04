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
import type { ApplicationStatus } from "@/features/admissions/types";

/** Confirm dialog for a staff status change / withdraw, with the honesty copy from the plan. */
export function ReasonStatusDialog({
  open,
  onOpenChange,
  title,
  target,
  currentStatus,
  destructive,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  target?: ApplicationStatus;
  currentStatus?: ApplicationStatus;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setError(null);
    try {
      await onConfirm(reason.trim());
      setReason("");
      onOpenChange(false);
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setReason("");
          setError(null);
        }
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {target === "REJECTED" ? (
            <DialogDescription>
              This is final; the application cannot be reopened.
              {currentStatus === "OFFERED" || currentStatus === "ACCEPTED"
                ? " An issued or accepted offer will not be cancelled automatically."
                : ""}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reason-status-reason">Reason (optional)</Label>
          <Textarea
            id="reason-status-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={2000}
            rows={3}
          />
        </div>
        {error ? <InlineError message={error} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant={destructive ? "destructive" : "default"} onClick={confirm} disabled={pending}>
            {pending ? "Working…" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
