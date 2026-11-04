"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";
import { useApproveLeave, useLeaveBalance, useRejectLeave } from "@/features/hr/hooks";
import { describeInsufficientBalance } from "@/features/hr/errors";
import { leaveReviewSchema, toReviewBody, type LeaveReviewValues } from "@/features/hr/formSchemas";
import { formatDate } from "@/features/hr/format";
import { displayName, leaveTypeLabel } from "@/features/hr/labels";
import type { LeaveQueueRow } from "@/features/hr/types";

/** Approve or reject a requested leave. Mount inside <Can hr.leave.manage>. */
export function LeaveReviewDialog({
  open,
  onOpenChange,
  application,
  mode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  application: LeaveQueueRow;
  mode: "approve" | "reject";
}) {
  const approve = useApproveLeave();
  const reject = useRejectLeave();
  const balance = useLeaveBalance(application.employeeId, application.periodYear, mode === "approve");
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const form = useForm<LeaveReviewValues>({
    resolver: zodResolver(leaveReviewSchema),
    defaultValues: { reviewNote: "" },
  });
  const pending = approve.isPending || reject.isPending;
  const approving = mode === "approve";
  const row = balance.data?.balances.find((b) => b.leaveType === application.leaveType);

  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    setDetail(null);
    const vars = { id: application.id, body: toReviewBody(values) };
    const callbacks = {
      onSuccess: () => {
        toast.success(approving ? "Leave approved." : "Leave rejected.");
        onOpenChange(false);
      },
      onError: (err: unknown) => {
        if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
          toast.error(describeApiError(err));
          onOpenChange(false);
          return;
        }
        setError(describeApiError(err));
        setDetail(err instanceof ApiError ? describeInsufficientBalance(err.data) : null);
      },
    };
    if (approving) approve.mutate(vars, callbacks);
    else reject.mutate(vars, callbacks);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{approving ? "Approve leave" : "Reject leave"}</DialogTitle>
          <DialogDescription>
            {displayName(application.employee)}: {leaveTypeLabel[application.leaveType] ?? application.leaveType},{" "}
            {formatDate(application.startDate)} to {formatDate(application.endDate)} ({application.days} day(s)).
          </DialogDescription>
        </DialogHeader>
        {approving ? (
          <p className="text-sm text-gray-700">
            {balance.isLoading
              ? "Loading balance…"
              : row
                ? `Remaining ${row.remaining} day(s) of ${row.entitlement}; this request needs ${application.days}.`
                : balance.isError
                  ? "The balance could not be loaded."
                  : "No balance is tracked for this leave type."}
          </p>
        ) : (
          <p className="text-sm text-gray-700">
            The employee will see this application as rejected. This cannot be undone.
          </p>
        )}
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-3">
            <FormField
              control={form.control}
              name="reviewNote"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note (optional)</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={3} maxLength={2100} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {error ? (
              <div className="space-y-1">
                <InlineError message={error} />
                {detail ? <p className="text-sm text-danger-700">{detail}</p> : null}
              </div>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" variant={approving ? "default" : "destructive"} disabled={pending}>
                {pending ? "Working…" : approving ? "Approve leave" : "Reject leave"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
