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
import { Textarea } from "@/components/ui/textarea";
import { InlineError } from "@/components/ui-ext/InlineError";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { describeApiError } from "@/lib/apiErrors";
import { useCreateContract, useSupersedeContract } from "@/features/hr/hooks";
import { contractFormSchema, toContractBody, type ContractFormValues } from "@/features/hr/formSchemas";
import { toDateInput } from "@/features/hr/format";
import { contractTypeLabel, toOptions } from "@/features/hr/labels";
import { paiseToRupeeInput } from "@/features/hr/money";
import type { Contract } from "@/features/hr/types";

function defaults(c?: Contract): ContractFormValues {
  return {
    contractType: c?.contractType ?? "PERMANENT",
    startDate: c ? toDateInput(c.startDate) : "",
    endDate: c?.endDate ? toDateInput(c.endDate) : "",
    salary: c?.salaryAmount != null ? paiseToRupeeInput(c.salaryAmount) : "",
    terms: c?.termsMetadata ? JSON.stringify(c.termsMetadata, null, 2) : "",
  };
}

/** Create a contract, or supersede `supersede` with a new version. Mount inside <Can hr.contracts.manage>. */
export function ContractFormDialog({
  open,
  onOpenChange,
  employeeId,
  supersede,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employeeId: string;
  supersede?: Contract;
}) {
  const create = useCreateContract(employeeId);
  const sup = useSupersedeContract(employeeId);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<ContractFormValues>({
    resolver: zodResolver(contractFormSchema),
    defaultValues: defaults(supersede),
  });
  const pending = create.isPending || sup.isPending;

  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    const body = toContractBody(values);
    const callbacks = {
      onSuccess: () => {
        toast.success(supersede ? "Contract superseded." : "Contract added.");
        onOpenChange(false);
      },
      onError: (err: unknown) => setError(describeApiError(err)),
    };
    if (supersede) sup.mutate({ contractId: supersede.id, body }, callbacks);
    else create.mutate(body, callbacks);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{supersede ? "Supersede contract" : "Add contract"}</DialogTitle>
          {supersede ? (
            <DialogDescription>Creates a new active contract and marks this one as superseded.</DialogDescription>
          ) : null}
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-3">
            <FormField
              control={form.control}
              name="contractType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Contract type</FormLabel>
                  <SimpleSelect
                    ariaLabel="Contract type"
                    value={field.value}
                    onChange={field.onChange}
                    options={toOptions(contractTypeLabel)}
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
                  <FormLabel>End date (optional)</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="salary"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Salary (optional)</FormLabel>
                  <FormControl>
                    <Input {...field} inputMode="decimal" />
                  </FormControl>
                  <p className="text-xs text-gray-500">Amount in rupees (INR).</p>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="terms"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Terms (optional JSON object)</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={5} className="font-mono text-xs" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {error ? <InlineError message={error} /> : null}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : supersede ? "Supersede contract" : "Add contract"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
