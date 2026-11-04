"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
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
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { InlineError } from "@/components/ui-ext/InlineError";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { SectionNav, HR_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { describeApiError } from "@/lib/apiErrors";
import { useLeavePolicies, usePutLeavePolicy } from "@/features/hr/hooks";
import { leavePolicySchema, toPolicyBody, type LeavePolicyValues } from "@/features/hr/formSchemas";
import { accrualRuleLabel, LEAVE_TYPES, leaveTypeLabel, toOptions } from "@/features/hr/labels";
import type { LeavePolicy, LeaveType } from "@/features/hr/types";

export default function LeavePoliciesPage() {
  return (
    <RouteGuard requirePermission="hr.leave.manage">
      <LeavePoliciesInner />
    </RouteGuard>
  );
}

function LeavePoliciesInner() {
  const policies = useLeavePolicies();
  const [editing, setEditing] = useState<{ leaveType: LeaveType; policy?: LeavePolicy } | null>(null);
  const byType = new Map((policies.data?.leavePolicies ?? []).map((p) => [p.leaveType, p]));

  return (
    <div className="space-y-6">
      <SectionNav items={HR_STAFF_NAV} />
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Leave policies</h1>
        <p className="text-sm text-gray-500">Only active policies produce balances.</p>
      </div>
      {!policies.allowed ? (
        <NoAccess what="leave policies" />
      ) : policies.isLoading ? (
        <TableSkeleton />
      ) : policies.isError ? (
        <ErrorBlock error={policies.error} onRetry={() => void policies.refetch()} />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Leave type</TableHead>
                <TableHead>Annual quota (days)</TableHead>
                <TableHead>Accrual rule</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {LEAVE_TYPES.map((t) => {
                const p = byType.get(t);
                return (
                  <TableRow key={t}>
                    <TableCell className="font-medium">{leaveTypeLabel[t]}</TableCell>
                    <TableCell>{p ? p.annualQuotaDays : "Not configured"}</TableCell>
                    <TableCell>{p ? (accrualRuleLabel[p.accrualRule] ?? p.accrualRule) : "-"}</TableCell>
                    <TableCell>
                      {p ? <Badge variant="outline">{p.active ? "Active" : "Inactive"}</Badge> : "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Can permission="hr.leave.manage">
                        <Button variant="outline" size="sm" onClick={() => setEditing({ leaveType: t, policy: p })}>
                          {p ? "Edit" : "Set policy"}
                        </Button>
                      </Can>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <Can permission="hr.leave.manage">
        {editing ? (
          <PolicyDialog
            key={editing.leaveType}
            leaveType={editing.leaveType}
            policy={editing.policy}
            onOpenChange={(o) => !o && setEditing(null)}
          />
        ) : null}
      </Can>
    </div>
  );
}

function PolicyDialog({
  leaveType,
  policy,
  onOpenChange,
}: {
  leaveType: LeaveType;
  policy?: LeavePolicy;
  onOpenChange: (open: boolean) => void;
}) {
  const put = usePutLeavePolicy();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<LeavePolicyValues>({
    resolver: zodResolver(leavePolicySchema),
    defaultValues: {
      annualQuotaDays: policy ? String(policy.annualQuotaDays) : "0",
      accrualRule: policy?.accrualRule ?? "ANNUAL_LUMP_SUM",
      active: policy?.active ?? true,
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    put.mutate(
      { leaveType, body: toPolicyBody(values) },
      {
        onSuccess: () => {
          toast.success("Leave policy saved.");
          onOpenChange(false);
        },
        onError: (err) => setError(describeApiError(err)),
      },
    );
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{leaveTypeLabel[leaveType]} leave policy</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-3">
            <FormField
              control={form.control}
              name="annualQuotaDays"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Annual quota (days)</FormLabel>
                  <FormControl>
                    <Input {...field} inputMode="numeric" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="accrualRule"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Accrual rule</FormLabel>
                  <SimpleSelect
                    ariaLabel="Accrual rule"
                    value={field.value}
                    onChange={field.onChange}
                    options={toOptions(accrualRuleLabel)}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex items-center gap-2">
              <input id="policy-active" type="checkbox" className="h-4 w-4" {...form.register("active")} />
              <Label htmlFor="policy-active">Active</Label>
            </div>
            {error ? <InlineError message={error} /> : null}
            <DialogFooter>
              <Button type="submit" disabled={put.isPending}>
                {put.isPending ? "Saving…" : "Save policy"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
