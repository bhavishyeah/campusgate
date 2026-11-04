"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { ConfirmDialog } from "@/components/ui-ext/ConfirmDialog";
import { InlineError } from "@/components/ui-ext/InlineError";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { UserPicker } from "@/components/hr/UserPicker";
import { describeApiError } from "@/lib/apiErrors";
import { useCreateEmployee, useHrLookups, usePatchEmployee } from "@/features/hr/hooks";
import {
  buildEmployeeCreate,
  buildEmployeePatch,
  employeeCreateSchema,
  employeeEditSchema,
  type EmployeeFormValues,
} from "@/features/hr/formSchemas";
import { toDateInput } from "@/features/hr/format";
import { employeeStatusLabel, employmentTypeLabel, toOptions } from "@/features/hr/labels";
import { employeeStatusOptions } from "@/features/hr/transitions";
import type { EmployeeDetail, UserLookupItem } from "@/features/hr/types";

function defaults(e?: EmployeeDetail): EmployeeFormValues {
  return {
    userId: e?.userId ?? "",
    employeeNo: e?.employeeNo ?? "",
    designation: e?.designation ?? "",
    employmentType: e?.employmentType ?? "PERMANENT",
    departmentId: e?.departmentId ?? "",
    joiningDate: e ? toDateInput(e.joiningDate) : "",
    status: e?.status ?? "ACTIVE",
  };
}

const CONFLICT_MESSAGES = new Set(["employee already exists", "employeeNo already exists"]);

/** Create (no `employee`) or edit an employee. Mount inside <Can hr.employees.manage>. */
export function EmployeeFormDialog({
  open,
  onOpenChange,
  employee,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee?: EmployeeDetail;
}) {
  const router = useRouter();
  const editing = Boolean(employee);
  const create = useCreateEmployee();
  const patch = usePatchEmployee(employee?.id ?? "");
  const lookups = useHrLookups();
  const [error, setError] = useState<string | null>(null);
  const [pickedUser, setPickedUser] = useState<UserLookupItem | null>(null);
  const [pendingValues, setPendingValues] = useState<EmployeeFormValues | null>(null);

  const form = useForm<EmployeeFormValues>({
    resolver: zodResolver(editing ? employeeEditSchema : employeeCreateSchema),
    defaultValues: defaults(employee),
  });
  const pending = create.isPending || patch.isPending;
  const patchBody = editing ? buildEmployeePatch(form.getValues(), form.formState.dirtyFields) : {};
  const nothingChanged = editing && Object.keys(patchBody).length === 0;

  function run(values: EmployeeFormValues) {
    setError(null);
    const onError = (err: unknown) => {
      const msg = describeApiError(err);
      setError(msg);
      if (CONFLICT_MESSAGES.has(msg)) form.setError("employeeNo", { message: "Check the employee number" });
    };
    if (employee) {
      patch.mutate(buildEmployeePatch(values, form.formState.dirtyFields), {
        onSuccess: () => {
          toast.success("Employee updated.");
          onOpenChange(false);
        },
        onError,
      });
      return;
    }
    create.mutate(buildEmployeeCreate(values), {
      onSuccess: (res) => {
        toast.success("Employee created. The Employee role was assigned to this user.");
        onOpenChange(false);
        router.push(`/hr/employees/${res.id}`);
      },
      onError,
    });
  }

  const onSubmit = form.handleSubmit((values) => {
    const terminating = values.status === "TERMINATED" && (!editing || Boolean(form.formState.dirtyFields.status));
    if (terminating) {
      setPendingValues(values);
      return;
    }
    run(values);
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit employee" : "Add employee"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-3">
              {editing ? (
                <p className="text-sm text-gray-600">
                  User: {employee?.user.name ?? employee?.user.email}. The linked user cannot be changed.
                </p>
              ) : (
                <UserPicker
                  selected={pickedUser}
                  onSelect={(u) => {
                    setPickedUser(u);
                    form.setValue("userId", u?.id ?? "", { shouldValidate: true });
                  }}
                  error={form.formState.errors.userId?.message}
                />
              )}
              <FormField
                control={form.control}
                name="employeeNo"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Employee number</FormLabel>
                    <FormControl>
                      <Input {...field} maxLength={64} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="designation"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Designation</FormLabel>
                    <FormControl>
                      <Input {...field} maxLength={200} />
                    </FormControl>
                    {editing ? <p className="text-xs text-gray-500">Leave unchanged to keep the current value.</p> : null}
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="employmentType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Employment type</FormLabel>
                    <SimpleSelect
                      ariaLabel="Employment type"
                      value={field.value}
                      onChange={field.onChange}
                      options={toOptions(employmentTypeLabel)}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="departmentId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Department</FormLabel>
                    <SimpleSelect
                      ariaLabel="Department"
                      value={field.value}
                      onChange={field.onChange}
                      noneLabel="No department"
                      options={(lookups.data?.departments ?? []).map((d) => ({ value: d.id, label: d.name }))}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="joiningDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Joining date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
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
                      options={employeeStatusOptions().map((s) => ({ value: s, label: employeeStatusLabel[s] }))}
                    />
                    <p className="text-xs text-gray-500">Terminated employees are excluded from the attendance roster.</p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {error ? <InlineError message={error} /> : null}
              <DialogFooter>
                <Button type="submit" disabled={pending || nothingChanged}>
                  {pending ? "Saving…" : editing ? "Save changes" : "Add employee"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={pendingValues !== null}
        onOpenChange={(o) => {
          if (!o) setPendingValues(null);
        }}
        title="Mark as terminated"
        description="Mark this employee as terminated? They will no longer appear in the attendance roster."
        confirmLabel="Mark as terminated"
        destructive
        pending={pending}
        onConfirm={() => {
          const v = pendingValues;
          setPendingValues(null);
          if (v) run(v);
        }}
      />
    </>
  );
}
