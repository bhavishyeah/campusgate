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
import { Label } from "@/components/ui/label";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";
import { usePatchWorkload } from "@/features/faculty/hooks";
import { describeWorkloadExceeded } from "@/features/faculty/errors";
import { buildWorkloadPatch, workloadEditSchema, type WorkloadEditValues } from "@/features/faculty/formSchemas";
import type { WorkloadRow } from "@/features/faculty/types";

/** Edit non-teaching hours and the policy override for one term. Mount inside <Can faculty.workload.manage>. */
export function WorkloadEditDialog({
  open,
  onOpenChange,
  facultyId,
  termId,
  termName,
  row,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facultyId: string;
  termId: string;
  termName: string;
  row?: WorkloadRow;
}) {
  const patch = usePatchWorkload(facultyId);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const form = useForm<WorkloadEditValues>({
    resolver: zodResolver(workloadEditSchema),
    defaultValues: {
      nonTeachingHours: String(row?.nonTeachingHours ?? 0),
      override: Boolean(row?.overrideReason),
      overrideReason: row?.overrideReason ?? "",
    },
  });
  const override = form.watch("override");

  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    setDetail(null);
    patch.mutate(
      { termId, body: buildWorkloadPatch(values) },
      {
        onSuccess: () => {
          toast.success("Workload updated.");
          onOpenChange(false);
        },
        onError: (err) => {
          setError(describeApiError(err));
          setDetail(err instanceof ApiError ? describeWorkloadExceeded(err.data) : null);
        },
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit workload</DialogTitle>
          <DialogDescription>
            {termName}. Saving also recomputes teaching hours from active primary assignments.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-3">
            <FormField
              control={form.control}
              name="nonTeachingHours"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Non-teaching hours per week</FormLabel>
                  <FormControl>
                    <Input {...field} inputMode="numeric" maxLength={3} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex items-center gap-2">
              <input
                id="workload-override"
                type="checkbox"
                className="h-4 w-4"
                {...form.register("override")}
              />
              <Label htmlFor="workload-override">Override policy limit</Label>
            </div>
            {override ? (
              <FormField
                control={form.control}
                name="overrideReason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Override reason</FormLabel>
                    <FormControl>
                      <Input {...field} maxLength={500} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : null}
            {error ? (
              <div className="space-y-1">
                <InlineError message={error} />
                {detail ? <p className="text-sm text-danger-700">{detail}</p> : null}
              </div>
            ) : null}
            <DialogFooter>
              <Button type="submit" disabled={patch.isPending}>
                {patch.isPending ? "Saving…" : "Save workload"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
