"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { zodFormResolver } from "@/components/forms/zodFormResolver";
import { FormDialog } from "@/components/forms/FormDialog";
import { SelectField, TextField } from "@/components/forms/Fields";
import { handleServerError } from "@/components/forms/serverErrors";
import { useCreateSchedule, usePatchSchedule, useStops } from "@/features/transport/hooks";
import {
  buildScheduleCreate,
  buildSchedulePatch,
  scheduleSchema,
  type ScheduleValues,
} from "@/features/transport/formSchemas";
import { dayOfWeekLabel, toOptions } from "@/features/transport/labels";
import { stopLabel } from "@/features/transport/format";
import { formatMinute, toDateInput } from "@/features/hr/format";
import type { Schedule } from "@/features/transport/types";

export function ScheduleFormDialog({
  open,
  onOpenChange,
  routeId,
  schedule,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  routeId: string;
  schedule?: Schedule;
}) {
  const [error, setError] = useState<string | null>(null);
  const stops = useStops(routeId);
  const create = useCreateSchedule(routeId, { toast: false });
  const patch = usePatchSchedule(routeId, { toast: false });
  const form = useForm<z.input<typeof scheduleSchema>, unknown, ScheduleValues>({
    resolver: zodFormResolver(scheduleSchema),
    defaultValues: {
      mode: schedule?.date && !schedule.dayOfWeek ? "date" : "weekly",
      dayOfWeek: schedule?.dayOfWeek ?? "",
      date: schedule?.date ? toDateInput(schedule.date) : "",
      stopId: schedule?.stopId ?? "",
      departureTime: schedule ? formatMinute(schedule.departureTime) : "",
      arrivalTime: schedule?.arrivalTime === null || schedule?.arrivalTime === undefined ? "" : formatMinute(schedule.arrivalTime),
    },
  });
  const { dirtyFields, isDirty } = form.formState;
  const mode = form.watch("mode");

  function setMode(next: "weekly" | "date") {
    form.setValue("mode", next, { shouldDirty: true });
    // The unused value is cleared so exactly one of dayOfWeek/date is validated and sent.
    if (next === "weekly") form.setValue("date", "", { shouldDirty: true });
    else form.setValue("dayOfWeek", "", { shouldDirty: true });
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      if (schedule) {
        await patch.mutateAsync({ scheduleId: schedule.id, body: buildSchedulePatch(dirtyFields, values) });
        toast.success("Schedule updated");
      } else {
        await create.mutateAsync(buildScheduleCreate(values));
        toast.success("Schedule added");
      }
      onOpenChange(false);
    } catch (err) {
      setError(handleServerError(err, form));
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={schedule ? "Edit schedule" : "Add schedule"}
      form={form}
      onSubmit={() => void onSubmit()}
      submitLabel={schedule ? "Save changes" : "Add schedule"}
      pending={create.isPending || patch.isPending}
      error={error}
      disableSubmit={Boolean(schedule) && !isDirty}
    >
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Repeats</legend>
        <div className="flex gap-4">
          <div className="flex items-center gap-2">
            <input id="sched-weekly" type="radio" name="sched-mode" checked={mode === "weekly"} onChange={() => setMode("weekly")} />
            <Label htmlFor="sched-weekly">Repeats weekly</Label>
          </div>
          <div className="flex items-center gap-2">
            <input id="sched-date" type="radio" name="sched-mode" checked={mode === "date"} onChange={() => setMode("date")} />
            <Label htmlFor="sched-date">One date</Label>
          </div>
        </div>
      </fieldset>
      {mode === "weekly" ? (
        <SelectField control={form.control} name="dayOfWeek" label="Day of week" options={toOptions(dayOfWeekLabel)} />
      ) : (
        <TextField control={form.control} name="date" label="Date" type="date" />
      )}
      <SelectField
        control={form.control}
        name="stopId"
        label="Stop"
        noneLabel="All stops"
        options={(stops.data?.stops ?? []).map((s) => ({ value: s.id, label: stopLabel(s) }))}
      />
      <TextField control={form.control} name="departureTime" label="Departure time" type="time" />
      <TextField control={form.control} name="arrivalTime" label="Arrival time (optional)" type="time" />
    </FormDialog>
  );
}
