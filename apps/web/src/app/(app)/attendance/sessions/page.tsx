"use client";

import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { ClipboardList, Plus } from "lucide-react";
import Link from "next/link";
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { useAuthStore } from "@/stores/auth";
import { can } from "@/lib/authz";
import {
  useAttendanceSessions,
  useSubmitSession,
  useFinalizeSession,
  useCreateAttendanceSession,
  type CreateAttendanceSessionBody,
} from "@/features/attendance/hooks";
import { useSections } from "@/features/classes/hooks";
import type { AttendanceSession, SessionStatus } from "@/features/attendance/types";
import {
  createSessionSchema,
  type CreateSessionInput,
} from "@/features/attendance/formSchemas";
import { todayISO } from "@/features/attendance/utils";

const STATUS_VARIANT: Record<SessionStatus, "outline" | "default" | "secondary" | "destructive"> = {
  OPEN: "default",
  SUBMITTED: "secondary",
  FINALIZED: "outline",
};

const STATUS_TABS = ["ALL", "OPEN", "SUBMITTED", "FINALIZED"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

export default function AttendanceSessionsPage() {
  return (
    <RouteGuard>
      <AttendanceSessionsInner />
    </RouteGuard>
  );
}

function AttendanceSessionsInner() {
  const [createOpen, setCreateOpen] = useState(false);
  const [statusTab, setStatusTab] = useState<StatusTab>("ALL");

  const permissions = useAuthStore((s) => s.permissions);
  // attendance.view ALWAYS takes precedence. Only attendance.mark WITHOUT attendance.view
  // sees today-filtered results (FACULTY role).
  const canViewAll = can("attendance.view", permissions);

  const { data, isLoading, isError, error } = useAttendanceSessions();

  const displayed = useMemo(() => {
    if (!data?.sessions) return [];
    if (canViewAll) return data.sessions;
    return data.sessions.filter((s) => s.date === todayISO());
  }, [data, canViewAll]);

  const filtered =
    statusTab === "ALL"
      ? displayed
      : displayed.filter((s) => s.status === statusTab);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Attendance Sessions</h1>
          <p className="text-sm text-gray-500">
            {canViewAll ? "All sessions" : "Today's sessions"}
          </p>
        </div>
        <Can permission="attendance.mark">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> New Session
          </Button>
        </Can>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setStatusTab(tab)}
            className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
              statusTab === tab
                ? "bg-primary-600 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {tab === "ALL" ? "All" : tab.charAt(0) + tab.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : isError ? (
        <InlineError
          message={error instanceof ApiError ? error.message : "Failed to load sessions."}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          label="No sessions"
          description={canViewAll ? "No attendance sessions found." : "No sessions for today."}
        />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Session ID</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((session) => (
                <SessionRow key={session.id} session={session} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateSessionDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function SessionRow({ session }: { session: AttendanceSession }) {
  const submitMutation = useSubmitSession(session.id);
  const finalizeMutation = useFinalizeSession(session.id);

  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{session.id}</TableCell>
      <TableCell>{session.date}</TableCell>
      <TableCell>
        <Badge variant={STATUS_VARIANT[session.status] ?? "outline"}>
          {session.status}
        </Badge>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex gap-2 justify-end">
          {session.status === "OPEN" && (
            <Can anyOf={["attendance.mark", "attendance.view"]}>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/attendance/sessions/${session.id}/mark`}>Mark</Link>
              </Button>
            </Can>
          )}
          {session.status === "OPEN" && (
            <Can permission="attendance.mark">
              <Button
                variant="ghost"
                size="sm"
                disabled={submitMutation.isPending}
                onClick={() =>
                  submitMutation.mutate(undefined, {
                    onSuccess: () => toast.success("Session submitted."),
                  })
                }
              >
                Submit
              </Button>
            </Can>
          )}
          {session.status === "SUBMITTED" && (
            <Can permission="attendance.mark">
              <Button
                variant="ghost"
                size="sm"
                disabled={finalizeMutation.isPending}
                onClick={() =>
                  finalizeMutation.mutate(undefined, {
                    onSuccess: () => toast.success("Session finalized."),
                  })
                }
              >
                Finalize
              </Button>
            </Can>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * MF8: CreateSessionDialog with complete implementation.
 * Fields: sectionId (select from sections), date (date input), startTime (time input), endTime (time input).
 * Error handling per MF8 spec.
 */
function CreateSessionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const createMutation = useCreateAttendanceSession();
  const { data: sectionsData } = useSections();

  const form = useForm<CreateSessionInput>({
    resolver: zodResolver(createSessionSchema),
    defaultValues: {
      sectionId: "",
      date: "",
      startTime: "",
      endTime: "",
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    // Build scheduledClassId from sectionId + date + startTime for the API.
    // The actual API body uses scheduledClassId, date, submissionDeadline.
    // Here we pass sectionId as scheduledClassId since that maps to a scheduled class.
    const body: CreateAttendanceSessionBody = {
      scheduledClassId: values.sectionId,
      date: values.date,
      // Combine startTime/endTime into submissionDeadline field as ISO datetime if needed.
      // The API schema uses scheduledClassId + date only; startTime/endTime are for UX.
    };
    createMutation.mutate(body, {
      onSuccess: () => {
        toast.success("Session created.");
        form.reset();
        onOpenChange(false);
      },
      onError: (err) => {
        if (err instanceof ApiError) {
          if (err.status === 409) {
            // HTTP 409 "session already exists for this section and time" → form-level error
            form.setError("root", {
              message: "A session already exists for this section and time.",
            });
          } else if (err.status === 403) {
            toast.error("You cannot create a session for this section.");
          } else if (err.status === 404) {
            toast.error("Section not found.");
          }
        }
      },
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create attendance session</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="sectionId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Section</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a section" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(sectionsData?.sections ?? []).map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.label ?? s.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="date"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="startTime"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Start Time</FormLabel>
                  <FormControl>
                    <Input type="time" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="endTime"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>End Time</FormLabel>
                  <FormControl>
                    <Input type="time" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {form.formState.errors.root && (
              <p className="text-sm text-destructive">{form.formState.errors.root.message}</p>
            )}
            <DialogFooter>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
