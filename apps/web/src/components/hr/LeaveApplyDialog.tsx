"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { InlineError } from "@/components/ui-ext/InlineError";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { describeApiError } from "@/lib/apiErrors";
import { leaveApplySchema, toLeaveBody, type LeaveApplyValues } from "@/features/hr/formSchemas";
import { inclusiveDays } from "@/features/hr/format";
import { leaveTypeLabel, toOptions } from "@/features/hr/labels";

/**
 * Leave application form used for staff-on-behalf and self-service. The caller
 * injects the submit function (so the right endpoint is used) and mounts it
 * inside the matching <Can>.
 */
export function LeaveApplyDialog({
  open,
  onOpenChange,
  title,
  submit,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submit: (body: Record<string, unknown>) => Promise<unknown>;
  pending: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const form = useForm<LeaveApplyValues>({
    resolver: zodResolver(leaveApplySchema),
    defaultValues: { leaveType: "CASUAL", startDate: "", endDate: "", reason: "" },
  });
  const start = form.watch("startDate");
  const end = form.watch("endDate");
  const days = inclusiveDays(start, end);

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await submit(toLeaveBody(values));
      toast.success("Leave request submitted.");
      onOpenChange(false);
    } catch (err) {
      setError(describeApiError(err));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-3">
            <FormField
              control={form.control}
              name="leaveType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Leave type</FormLabel>
                  <SimpleSelect
                    ariaLabel="Leave type"
                    value={field.value}
                    onChange={field.onChange}
                    options={toOptions(leaveTypeLabel)}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="startDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Start date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="endDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>End date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <p className="text-sm text-gray-600">
              Days (calculated by the server on submit): {days === null ? "-" : `${days} day(s)`}
            </p>
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={3} maxLength={2100} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {error ? <InlineError message={error} /> : null}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "Submitting…" : "Submit request"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
