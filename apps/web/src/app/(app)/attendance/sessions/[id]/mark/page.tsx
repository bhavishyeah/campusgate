"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ClipboardList } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
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
} from "@/features/attendance/hooks";
import { attendanceKeys } from "@/features/attendance/keys";
import type { AttendanceStatus } from "@/features/attendance/types";

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
                            className={marks[record.studentId] === status ? "bg-primary-100 border-primary-400 font-semibold" : ""}
                            onClick={() => handleToggle(record.studentId, status)}
                          >
                            {status.charAt(0)}
                          </Button>
                        ))}
                      </div>
                    </TableCell>
                  </Can>
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
    </div>
  );
}
