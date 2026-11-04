"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { PickerError } from "@/components/forms/Fields";
import { FormDialog } from "@/components/forms/FormDialog";
import { handleServerError } from "@/components/forms/serverErrors";
import { RoomPicker } from "@/components/hostel/RoomPicker";
import { StudentPicker } from "@/components/hostel/StudentPicker";
import { useAllocate } from "@/features/hostel/hooks";
import { allocateSchema, buildAllocate, type AllocateValues } from "@/features/hostel/formSchemas";
import type { StudentLookupItem } from "@/features/hostel/types";

export function AllocateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [student, setStudent] = useState<StudentLookupItem | null>(null);
  const allocate = useAllocate({ toast: false });
  const form = useForm<z.input<typeof allocateSchema>, unknown, AllocateValues>({
    resolver: zodFormResolver(allocateSchema),
    defaultValues: { roomId: "", studentId: "" },
  });
  const roomId = form.watch("roomId");

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await allocate.mutateAsync(buildAllocate(values));
      toast.success("Student allocated");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Allocate student"
      description="Only Available rooms with a free bed can be chosen."
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Allocate"
      pending={allocate.isPending}
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
      <RoomPicker
        value={String(roomId ?? "")}
        status="AVAILABLE"
        disableFull
        onChange={(id) => form.setValue("roomId", id, { shouldValidate: form.formState.isSubmitted })}
      />
      <PickerError message={form.formState.errors.roomId?.message as string | undefined} />
    </FormDialog>
  );
}
