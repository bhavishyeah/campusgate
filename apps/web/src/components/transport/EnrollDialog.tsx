"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { toast } from "sonner";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { FormDialog } from "@/components/forms/FormDialog";
import { PickerError, SelectField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { StudentPicker } from "@/components/transport/StudentPicker";
import { useEnroll, useRouteOptions, useStops } from "@/features/transport/hooks";
import { buildEnrollment, enrollmentSchema, type EnrollmentValues } from "@/features/transport/formSchemas";
import { stopLabel } from "@/features/transport/format";
import type { StudentLookupItem } from "@/features/transport/types";

export function EnrollDialog({
  open,
  onOpenChange,
  defaultRouteId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultRouteId?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [student, setStudent] = useState<StudentLookupItem | null>(null);
  const routes = useRouteOptions();
  const enroll = useEnroll({ toast: false });
  const form = useForm<z.input<typeof enrollmentSchema>, unknown, EnrollmentValues>({
    resolver: zodFormResolver(enrollmentSchema),
    defaultValues: { studentId: "", routeId: defaultRouteId ?? "", stopId: "" },
  });
  const routeId = String(form.watch("routeId") ?? "");
  const stops = useStops(routeId || undefined);

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await enroll.mutateAsync(buildEnrollment(values));
      toast.success("Student enrolled");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Enroll student"
      description="The route needs an active vehicle assignment and a free seat."
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Enroll"
      pending={enroll.isPending}
      error={error}
    >
      <StudentPicker
        value={student}
        onChange={(s) => {
          setStudent(s);
          form.setValue("studentId", s?.id ?? "", { shouldValidate: form.formState.isSubmitted });
        }}
      />
      <PickerError message={form.formState.errors.studentId?.message as string | undefined} />
      <SelectField
        control={form.control}
        name="routeId"
        label="Route"
        options={(routes.data?.routes ?? [])
          .filter((r) => r.status === "ACTIVE")
          .map((r) => ({ value: r.id, label: `${r.code} - ${r.name}` }))}
        onValueChange={() => form.setValue("stopId", "")}
      />
      <SelectField
        control={form.control}
        name="stopId"
        label="Stop"
        disabled={!routeId}
        options={(stops.data?.stops ?? []).map((s) => ({ value: s.id, label: stopLabel(s) }))}
      />
    </FormDialog>
  );
}
