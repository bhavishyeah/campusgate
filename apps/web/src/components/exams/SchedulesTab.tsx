"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { CalendarClock, Plus } from "lucide-react";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ApiError } from "@/lib/api";
import {
  useAddSchedule,
  useAllocateCandidates,
  useExamSchedules,
} from "@/features/exams/hooks";
import { EXAM_PERM } from "@/features/exams/permissions";
import { scheduleFormSchema, type ScheduleFormValues } from "@/features/exams/formSchemas";
import { formatDateTime, parseIdList } from "@/features/exams/ids";

export function SchedulesTab({ examId }: { examId: string }) {
  const { data, isLoading, isError, error } = useExamSchedules(examId);
  const [addOpen, setAddOpen] = useState(false);
  const [allocateFor, setAllocateFor] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Can permission={EXAM_PERM.manage}>
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Add schedule
          </Button>
        </Can>
      </div>
      {isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : isError ? (
        <InlineError
          message={error instanceof ApiError ? error.message : "Failed to load schedules."}
        />
      ) : !data || data.schedules.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          label="No schedules yet"
          description="Add a schedule for each subject."
        />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Subject ID</TableHead>
                <TableHead>Room</TableHead>
                <TableHead>Capacity</TableHead>
                <TableHead>Starts</TableHead>
                <TableHead>Ends</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.schedules.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{s.subjectId}</TableCell>
                  <TableCell>{s.room}</TableCell>
                  <TableCell>{s.roomCapacity}</TableCell>
                  <TableCell>{formatDateTime(s.startsAt)}</TableCell>
                  <TableCell>{formatDateTime(s.endsAt)}</TableCell>
                  <TableCell className="text-right">
                    <Can permission={EXAM_PERM.candidatesManage}>
                      <Button variant="ghost" size="sm" onClick={() => setAllocateFor(s.id)}>
                        Allocate
                      </Button>
                    </Can>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <AddScheduleDialog examId={examId} open={addOpen} onOpenChange={setAddOpen} />
      {allocateFor && (
        <AllocateDialog
          examId={examId}
          scheduleId={allocateFor}
          onClose={() => setAllocateFor(null)}
        />
      )}
    </div>
  );
}

function AddScheduleDialog({
  examId,
  open,
  onOpenChange,
}: {
  examId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const add = useAddSchedule(examId);
  const form = useForm<ScheduleFormValues>({
    resolver: zodResolver(scheduleFormSchema),
    defaultValues: { subjectId: "", room: "", roomCapacity: 30, startsAt: "", endsAt: "" },
  });

  const onSubmit = form.handleSubmit((v) => {
    add.mutate(
      {
        subjectId: v.subjectId,
        room: v.room,
        roomCapacity: v.roomCapacity,
        startsAt: new Date(v.startsAt).toISOString(),
        endsAt: new Date(v.endsAt).toISOString(),
      },
      {
        onSuccess: () => {
          toast.success("Schedule added.");
          form.reset();
          onOpenChange(false);
        },
        onError: (err) => {
          if (err.status === 409) form.setError("subjectId", { message: err.message });
          else toast.error(err.message);
        },
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add schedule</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="subjectId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Subject ID</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="room"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Room</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="roomCapacity"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Room capacity</FormLabel>
                  <FormControl>
                    <Input type="number" min={1} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="startsAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Starts</FormLabel>
                  <FormControl>
                    <Input type="datetime-local" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="endsAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ends</FormLabel>
                  <FormControl>
                    <Input type="datetime-local" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={add.isPending}>
                {add.isPending ? "Saving…" : "Add"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function AllocateDialog({
  examId,
  scheduleId,
  onClose,
}: {
  examId: string;
  scheduleId: string;
  onClose: () => void;
}) {
  const allocate = useAllocateCandidates(examId, scheduleId);
  const [text, setText] = useState("");
  const ids = parseIdList(text);
  const valid = ids.length >= 1 && ids.length <= 1000;

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Allocate candidates</DialogTitle>
          <DialogDescription>
            Candidate IDs, separated by commas or new lines (1 to 1000).
          </DialogDescription>
        </DialogHeader>
        <Label htmlFor="allocate-ids">Candidate IDs</Label>
        <Textarea
          id="allocate-ids"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
        />
        <p className="text-xs text-gray-500">{ids.length} selected</p>
        <DialogFooter>
          <Button
            disabled={!valid || allocate.isPending}
            onClick={() =>
              allocate.mutate(
                { candidateIds: ids },
                {
                  onSuccess: (r) => {
                    toast.success(`Allocated ${r.allocated}. Room occupancy: ${r.occupied}.`);
                    onClose();
                  },
                },
              )
            }
          >
            {allocate.isPending ? "Allocating…" : "Allocate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
