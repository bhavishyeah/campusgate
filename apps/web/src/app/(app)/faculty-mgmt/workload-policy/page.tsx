"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { InlineError } from "@/components/ui-ext/InlineError";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { SectionNav, FACULTY_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { describeApiError } from "@/lib/apiErrors";
import { usePutWorkloadPolicy, useWorkloadPolicy } from "@/features/faculty/hooks";
import { workloadPolicySchema, type WorkloadPolicyValues } from "@/features/faculty/formSchemas";

export default function WorkloadPolicyPage() {
  return (
    <RouteGuard requirePermission="faculty.workload.manage">
      <WorkloadPolicyInner />
    </RouteGuard>
  );
}

function WorkloadPolicyInner() {
  const policy = useWorkloadPolicy();
  const put = usePutWorkloadPolicy();
  const [error, setError] = useState<string | null>(null);
  const current = policy.data?.policy ?? null;
  const form = useForm<WorkloadPolicyValues>({
    resolver: zodResolver(workloadPolicySchema),
    defaultValues: { maxWeeklyHours: "" },
  });

  useEffect(() => {
    form.reset({ maxWeeklyHours: current ? String(current.maxWeeklyHours) : "" });
  }, [current, form]);

  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    put.mutate(
      { maxWeeklyHours: Number(values.maxWeeklyHours.trim()) },
      {
        onSuccess: () => toast.success("Workload policy saved."),
        onError: (err) => setError(describeApiError(err)),
      },
    );
  });

  return (
    <div className="space-y-6">
      <SectionNav items={FACULTY_STAFF_NAV} />
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Workload policy</h1>
        <p className="text-sm text-gray-500">
          Applies to all faculty. Existing workload records are re-evaluated when next recomputed or edited.
        </p>
      </div>
      {!policy.allowed ? (
        <NoAccess what="the workload policy" />
      ) : policy.isLoading ? (
        <TableSkeleton />
      ) : policy.isError ? (
        <ErrorBlock error={policy.error} onRetry={() => void policy.refetch()} />
      ) : (
        <div className="card max-w-md space-y-4 p-4">
          <p className="text-sm text-gray-700">
            {current ? `Current maximum: ${current.maxWeeklyHours} h per week.` : "No limit is set."}
          </p>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-3">
              <FormField
                control={form.control}
                name="maxWeeklyHours"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Maximum weekly hours</FormLabel>
                    <FormControl>
                      <Input {...field} inputMode="numeric" maxLength={3} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {error ? <InlineError message={error} /> : null}
              <Can permission="faculty.workload.manage">
                <Button type="submit" disabled={put.isPending}>
                  {put.isPending ? "Saving…" : "Save policy"}
                </Button>
              </Can>
            </form>
          </Form>
        </div>
      )}
    </div>
  );
}
