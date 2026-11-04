"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { toast } from "sonner";
import { FormDialog } from "@/components/forms/FormDialog";
import { SelectField, TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useBuildingOptions, useCreateRoom, usePatchRoom } from "@/features/hostel/hooks";
import {
  buildRoomCreate,
  buildRoomPatch,
  roomCreateSchema,
  roomPatchSchema,
  type RoomCreateValues,
  type RoomPatchValues,
} from "@/features/hostel/formSchemas";
import { ROOM_STATUS_HELP, roomStatusLabel, toOptions } from "@/features/hostel/labels";
import type { RoomRow } from "@/features/hostel/types";

const CONFLICTS = {
  "room number already exists in building": "roomNumber",
  "capacity below current occupancy": "capacity",
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Create (no `room`) or edit (`room`) a room. */
export function RoomFormDialog({
  room,
  defaultBuildingId,
  ...props
}: Props & { room?: RoomRow; defaultBuildingId?: string }) {
  return room ? <RoomEdit room={room} {...props} /> : <RoomCreate defaultBuildingId={defaultBuildingId} {...props} />;
}

function RoomCreate({ open, onOpenChange, defaultBuildingId }: Props & { defaultBuildingId?: string }) {
  const [error, setError] = useState<string | null>(null);
  const buildings = useBuildingOptions();
  const form = useForm<z.input<typeof roomCreateSchema>, unknown, RoomCreateValues>({
    resolver: zodFormResolver(roomCreateSchema),
    defaultValues: { buildingId: defaultBuildingId ?? "", roomNumber: "", capacity: "", floor: "" },
  });
  const buildingId = form.watch("buildingId");
  const create = useCreateRoom(String(buildingId ?? ""), { toast: false });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await create.mutateAsync(buildRoomCreate(values));
      toast.success("Room created");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form, CONFLICTS));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add room"
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Create room"
      pending={create.isPending}
      error={error}
    >
      <SelectField
        control={form.control}
        name="buildingId"
        label="Building"
        options={(buildings.data?.buildings ?? []).map((b) => ({ value: b.id, label: b.name }))}
      />
      <TextField control={form.control} name="roomNumber" label="Room number" />
      <TextField control={form.control} name="capacity" label="Capacity (beds)" />
      <TextField control={form.control} name="floor" label="Floor (optional)" />
    </FormDialog>
  );
}

function RoomEdit({ open, onOpenChange, room }: Props & { room: RoomRow }) {
  const [error, setError] = useState<string | null>(null);
  const patch = usePatchRoom(room.id, { toast: false });
  const form = useForm<z.input<typeof roomPatchSchema>, unknown, RoomPatchValues>({
    resolver: zodFormResolver(roomPatchSchema),
    defaultValues: {
      roomNumber: room.roomNumber,
      capacity: String(room.capacity),
      floor: room.floor === null ? "" : String(room.floor),
      status: room.status,
    },
  });
  const { dirtyFields, isDirty } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await patch.mutateAsync(buildRoomPatch(dirtyFields, values));
      toast.success("Room updated");
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form, CONFLICTS));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit room ${room.roomNumber}`}
      description={room.building.name}
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel="Save changes"
      pending={patch.isPending}
      error={error}
      disableSubmit={!isDirty}
    >
      <TextField control={form.control} name="roomNumber" label="Room number" />
      <TextField control={form.control} name="capacity" label="Capacity (beds)" />
      <TextField control={form.control} name="floor" label="Floor (optional)" />
      <SelectField
        control={form.control}
        name="status"
        label="Status"
        options={toOptions(roomStatusLabel)}
        help={ROOM_STATUS_HELP}
      />
    </FormDialog>
  );
}
