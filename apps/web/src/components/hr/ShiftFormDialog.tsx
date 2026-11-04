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
import { Label } from "@/components/ui/label";
import { InlineError } from "@/components/ui-ext/InlineError";
import { describeApiError } from "@/lib/apiErrors";
import { useCreateShift, usePatchShift } from "@/features/hr/hooks";
import { shiftSchema, toShiftBody, toShiftPatch, type ShiftFormValues } from "@/features/hr/formSchemas";
import { formatMinute } from "@/features/hr/format";
import type { Shift } from "@/features/hr/types";

/** Add (no `shift`) or edit a shift. Mount inside <Can hr.attendance.manage>. */
export function ShiftFormDialog({
  open,
  onOpenChange,
  shift,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shift?: Shift;
}) {
  const editing = Boolean(shift);
  const create = useCreateShift();
  const patch = usePatchShift();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<ShiftFormValues>({
    resolver: zodResolver(shiftSchema),
    defaultValues: {
      name: shift?.name ?? "",
      startTime: shift ? formatMinute(shift.startMinute) : "09:00",
      endTime: shift ? formatMinute(shift.endMinute) : "17:00",
      active: shift?.active ?? true,
    },
  });
  const pending = create.isPending || patch.isPending;
  const nothingChanged = editing && Object.keys(toShiftPatch(form.getValues(), form.formState.dirtyFields)).length === 0;

  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    const callbacks = {
      onSuccess: () => {
        toast.success(editing ? "Shift updated." : "Shift added.");
        onOpenChange(false);
      },
      onError: (err: unknown) => {
        const msg = describeApiError(err);
        setError(msg);
        if (msg === "shift name already exists") form.setError("name", { message: msg });
      },
    };
    if (shift) patch.mutate({ id: shift.id, body: toShiftPatch(values, form.formState.dirtyFields) }, callbacks);
    else create.mutate(toShiftBody(values), callbacks);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit shift" : "Add shift"}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-3">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} maxLength={200} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="startTime"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Start time</FormLabel>
                  <FormControl>
                    <Input type="time" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="endTime"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>End time</FormLabel>
                  <FormControl>
                    <Input type="time" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex items-center gap-2">
              <input id="shift-active" type="checkbox" className="h-4 w-4" {...form.register("active")} />
              <Label htmlFor="shift-active">Active</Label>
            </div>
            {error ? <InlineError message={error} /> : null}
            <DialogFooter>
              <Button type="submit" disabled={pending || nothingChanged}>
                {pending ? "Saving…" : editing ? "Save changes" : "Add shift"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
