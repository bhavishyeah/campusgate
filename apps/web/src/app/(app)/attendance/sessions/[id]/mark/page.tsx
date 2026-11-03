"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { ClipboardList } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ApiError } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAttendanceSession,
  useMarkAttendance,
  useSubmitSession,
  useSubmitCorrection,
} from "@/features/attendance/hooks";
import { attendanceKeys } from "@/features/attendance/keys";
import type { AttendanceRecord, AttendanceStatus } from "@/features/attendance/types";
import {
  submitCorrectionSchema,
  type SubmitCorrectionInput,
} from "@/features/attendance/formSchemas";

const STATUSES: AttendanceStatus[] = ["PRESENT", "ABSENT", "LATE", "EXCUSED"];

export default function MarkAttendancePage() {
  return (
    <RouteGuard>
      <MarkAttendanceInner />
    </RouteGuard>
  );
}

function MarkAttendanceInner() {
  const params = useParams();
  const router = useRouter();
  const qc = useQueryClient();
  const id = Array.isArray(params.id) ? params.id[0] : params.id ?? "";

  const { data: session, isLoading, isError, error } = useAttendanceSession(id);
  const markMutation = useMarkAttendance(id);
  const submitMutation = useSubmitSession(id);

  const [marks, setMarks] = useState<Record<string, string>>({});
  const [isDirty, setIsDirty] = useState(false);
  const [correctionTarget, setCorrectionTarget] = useState<AttendanceRecord | null>(null);

  // Initialise marks from server records on first load
  useEffect(() => {
    if (session?.records) {
      const initial: Record<string, string> = {};
      session.records.forEach((r) => { initial[r.studentId] = r.status; });
      setMarks(initial);
      setIsDirty(false);
    }
  // Re-run only when session id changes, not every poll
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  function handleToggle(studentId: string, status: string) {
    setMarks((prev) => ({ ...prev, [studentId]: status }));
    setIsDirty(true);
  }

  function handleSave() {
    const records = Object.entries(marks).map(([studentId, status]) => ({ studentId, status }));
    markMutation.mutate(
      { records },
      {
        onSuccess: () => {
          toast.success("Marks saved.");
          setIsDirty(false);
        },
        onError: (err) => {
          if (err instanceof ApiError) {
            if (err.status === 403) {
              toast.error("You are not assigned to this session.");
            } else if (err.status === 409) {
              toast.error("Session is no longer open.");
              qc.invalidateQueries({ queryKey: attendanceKeys.session(id) });
            }
          }
        },
      },
    );
  }

  function handleSubmit() {
    submitMutation.mutate(undefined, {
      onSuccess: () => {
        toast.success("Session submitted.");
        router.push("/attendance/sessions");
      },
    });
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
      </div>
    );
  }

  if (isError) {
    return (
      <InlineError
        message={error instanceof ApiError ? error.message : "Failed to load session."}
      />
    );
  }

  if (!session) {
    return <EmptyState icon={ClipboardList} label="Session not found" />;
  }

  const records = session.records ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Mark Attendance</h1>
          <p className="text-sm text-gray-500">Session: {session.id} — {session.date}</p>
        </div>
        <Badge variant={session.status === "OPEN" ? "default" : "secondary"}>
          {session.status}
        </Badge>
      </div>

      {records.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          label="No students"
          description="No student records found for this session."
        />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Student ID</TableHead>
                <Can permission="attendance.mark" fallback={<TableHead>Status</TableHead>}>
                  <TableHead>Mark</TableHead>
                </Can>
                {/* Correction column — only shown when session is no longer OPEN */}
                {session.status !== "OPEN" && (
                  <Can permission="attendance.mark">
                    <TableHead>Correction</TableHead>
                  </Can>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((record) => (
                <TableRow key={record.id}>
                  <TableCell className="font-mono text-xs">{record.studentId}</TableCell>
                  <Can
                    permission="attendance.mark"
                    fallback={
                      <TableCell>
                        <Badge variant="outline">{record.status}</Badge>
                      </TableCell>
                    }
                  >
                    <TableCell>
                      <div className="flex gap-1">
                        {STATUSES.map((status) => (
                          <Button
                            key={status}
                            variant="outline"
                            size="sm"
                            disabled={session.status !== "OPEN"}
                            className={marks[record.studentId] === status ? "bg-primary-100 border-primary-400 font-semibold" : ""}
                            onClick={() => handleToggle(record.studentId, status)}
                          >
                            {status.charAt(0)}
                          </Button>
                        ))}
                      </div>
                    </TableCell>
                  </Can>
                  {/* Request correction — available on SUBMITTED or FINALIZED sessions */}
                  {session.status !== "OPEN" && (
                    <Can permission="attendance.mark">
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setCorrectionTarget(record)}
                        >
                          Request correction
                        </Button>
                      </TableCell>
                    </Can>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex gap-3 items-center">
        <Can permission="attendance.mark">
          <Button
            onClick={handleSave}
            disabled={!isDirty || markMutation.isPending}
            variant="outline"
          >
            {markMutation.isPending ? "Saving…" : "Save Marks"}
          </Button>
        </Can>

        {session.status === "OPEN" && (
          <Can permission="attendance.mark">
            <div className="flex flex-col gap-1">
              {isDirty && (
                <p className="text-xs text-amber-600">
                  You have unsaved changes — save marks before submitting.
                </p>
              )}
              <Button
                onClick={handleSubmit}
                disabled={submitMutation.isPending}
              >
                {submitMutation.isPending ? "Submitting…" : "Submit Session"}
              </Button>
            </div>
          </Can>
        )}
      </div>

      {correctionTarget && (
        <SubmitCorrectionDialog
          record={correctionTarget}
          open={correctionTarget !== null}
          onOpenChange={(v) => { if (!v) setCorrectionTarget(null); }}
        />
      )}
    </div>
  );
}

/**
 * Dialog for faculty to submit an attendance correction request.
 * Gated on attendance.mark; visible per-row for SUBMITTED and FINALIZED sessions.
 */
function SubmitCorrectionDialog({
  record,
  open,
  onOpenChange,
}: {
  record: AttendanceRecord;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const submitMutation = useSubmitCorrection();

  const form = useForm<SubmitCorrectionInput>({
    resolver: zodResolver(submitCorrectionSchema),
    defaultValues: {
      attendanceRecordId: record.id,
      requestedStatus: "PRESENT",
      reason: "",
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    submitMutation.mutate(
      {
        attendanceRecordId: values.attendanceRecordId,
        requestedStatus: values.requestedStatus,
        reason: values.reason,
      },
      {
        onSuccess: () => {
          toast.success("Correction request submitted.");
          form.reset();
          onOpenChange(false);
        },
        onError: (err) => {
          if (err instanceof ApiError) {
            if (err.status === 409) {
              toast.error("A pending correction already exists for this record.");
            } else {
              toast.error(err.message);
            }
          }
        },
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request attendance correction</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="text-sm text-gray-500">
              Student: <span className="font-mono">{record.studentId}</span>
              {" "}— Current status: <Badge variant="outline">{record.status}</Badge>
            </div>
            <FormField
              control={form.control}
              name="requestedStatus"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Requested status</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select status" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(["PRESENT", "ABSENT", "LATE", "EXCUSED"] as const).map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Explain why the attendance record needs correction…"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitMutation.isPending}>
                {submitMutation.isPending ? "Submitting…" : "Submit request"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
