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
import { Input } from "@/components/ui/input";
import { InlineError } from "@/components/ui-ext/InlineError";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { describeApiError } from "@/lib/apiErrors";
import { useCorrectAttendance, useRecordAttendance, useShifts } from "@/features/hr/hooks";
import {
  attendanceCorrectSchema,
  toCorrectBody,
  toRecordBody,
  type AttendanceCorrectValues,
} from "@/features/hr/formSchemas";
import { formatDate } from "@/features/hr/format";
import { attendanceSourceLabel, attendanceStatusLabel, toOptions } from "@/features/hr/labels";
import type { AttendanceRow } from "@/features/hr/types";

/**
 * Record (no `existing`) or correct (with `existing`) one day's attendance.
 * The date is fixed and read-only. Mount inside <Can hr.attendance.manage>.
 */
export function AttendanceRecordDialog({
  open,
  onOpenChange,
  employeeId,
  employeeLabel,
  date,
  existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employeeId: string;
  employeeLabel: string;
  date: string;
  existing?: AttendanceRow | null;
}) {
  const correcting = Boolean(existing);
  const record = useRecordAttendance(employeeId);
  const correct = useCorrectAttendance(employeeId);
  const shifts = useShifts();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<AttendanceCorrectValues>({
    resolver: zodResolver(attendanceCorrectSchema),
    defaultValues: {
      status: existing?.status ?? "PRESENT",
      source: existing?.source ?? "MANUAL",
      shiftId: existing?.shiftId ?? "",
      reason: "",
    },
  });
  const pending = record.isPending || correct.isPending;

  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    const callbacks = {
      onSuccess: () => {
        toast.success(correcting ? "Attendance corrected." : "Attendance recorded.");
        onOpenChange(false);
      },
      onError: (err: unknown) => setError(describeApiError(err)),
    };
    if (correcting) correct.mutate({ date, body: toCorrectBody(values) }, callbacks);
    else record.mutate(toRecordBody(date, values), callbacks);
  });

  const activeShifts = (shifts.data?.shifts ?? []).filter((s) => s.active || s.id === existing?.shiftId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{correcting ? "Correct attendance" : "Record attendance"}</DialogTitle>
          <DialogDescription>
            {employeeLabel}, {formatDate(date)}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="attendance-date" className="text-sm font-medium">
                Date
              </label>
              <Input id="attendance-date" type="date" value={date} readOnly disabled />
            </div>
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <SimpleSelect
                    ariaLabel="Status"
                    value={field.value}
                    onChange={field.onChange}
                    options={toOptions(attendanceStatusLabel)}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="source"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Source</FormLabel>
                  <SimpleSelect
                    ariaLabel="Source"
                    value={field.value}
                    onChange={field.onChange}
                    options={toOptions(attendanceSourceLabel)}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="shiftId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Shift</FormLabel>
                  <SimpleSelect
                    ariaLabel="Shift"
                    value={field.value}
                    onChange={field.onChange}
                    noneLabel="No shift"
                    options={activeShifts.map((s) => ({ value: s.id, label: s.name }))}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            {correcting ? (
              <FormField
                control={form.control}
                name="reason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reason (optional)</FormLabel>
                    <FormControl>
                      <Input {...field} maxLength={2100} />
                    </FormControl>
                    <p className="text-xs text-gray-500">The previous value is kept in the attendance history.</p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : null}
            {error ? <InlineError message={error} /> : null}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : correcting ? "Save correction" : "Record attendance"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
