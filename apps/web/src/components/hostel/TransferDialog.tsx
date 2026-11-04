"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { PickerError } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { RoomPicker } from "@/components/hostel/RoomPicker";
import { useTransfer } from "@/features/hostel/hooks";
import { buildTransfer, transferSchema, type TransferValues } from "@/features/hostel/formSchemas";
import { roomLabel, studentLabel } from "@/features/hostel/format";
import type { AllocationRow } from "@/features/hostel/types";

export function TransferDialog({
  open,
  onOpenChange,
  allocation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allocation: AllocationRow;
}) {
  const [error, setError] = useState<string | null>(null);
  const transfer = useTransfer(allocation.id, { toast: false });
  const form = useForm<z.input<typeof transferSchema>, unknown, TransferValues>({
    resolver: zodFormResolver(transferSchema),
    defaultValues: { toRoomId: "" },
  });
  const toRoomId = form.watch("toRoomId");

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await transfer.mutateAsync(buildTransfer(values));
      toast.success("Student transferred");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Transfer student"
      description={`Moves ${studentLabel(allocation.student)} from ${roomLabel(allocation.room)} to the room you choose. The current allocation becomes Transferred and a new active allocation is created. This cannot be undone.`}
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Transfer"
      pending={transfer.isPending}
      error={error}
    >
      <RoomPicker
        value={String(toRoomId ?? "")}
        status="AVAILABLE"
        disableFull
        disabledRoomId={allocation.roomId}
        initialBuildingId={allocation.room.building.id}
        onChange={(id) => {
          form.setValue("toRoomId", id, { shouldValidate: form.formState.isSubmitted });
        }}
      />
      <PickerError message={form.formState.errors.toRoomId?.message as string | undefined} />
    </FormDialog>
  );
}
