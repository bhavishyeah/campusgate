"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { PickerError } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { UserPicker } from "@/components/service-requests/UserPicker";
import { useAssign } from "@/features/service-requests/hooks";
import { assignSchema, buildAssign, type AssignValues } from "@/features/service-requests/formSchemas";
import type { UserLookupItem } from "@/features/service-requests/types";

export function AssignDialog({
  open,
  onOpenChange,
  requestId,
  reassign,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
  reassign?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState<UserLookupItem | null>(null);
  const assign = useAssign(requestId, { toast: false });
  const form = useForm<z.input<typeof assignSchema>, unknown, AssignValues>({
    resolver: zodFormResolver(assignSchema),
    defaultValues: { assigneeUserId: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await assign.mutateAsync(buildAssign(values));
      toast.success(reassign ? "Request reassigned" : "Request assigned");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={reassign ? "Reassign request" : "Assign request"}
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel={reassign ? "Reassign" : "Assign"}
      pending={assign.isPending}
      error={error}
    >
      <UserPicker
        value={agent}
        onChange={(u) => {
          setAgent(u);
          form.setValue("assigneeUserId", u?.id ?? "", { shouldValidate: form.formState.isSubmitted });
        }}
      />
      <PickerError message={form.formState.errors.assigneeUserId?.message as string | undefined} />
    </FormDialog>
  );
}
