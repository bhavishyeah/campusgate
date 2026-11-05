"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { CalendarDays, Plus } from "lucide-react";
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
import {
  useSessions,
  useCreateSession,
  useActivateSession,
  useCloseSession,
  type CreateSessionBody,
} from "@/features/academics/hooks";
import type { AcademicSession } from "@/features/academics/types";
import { formatDate } from "@/features/academics/format";
import {
  createSessionSchema,
  type CreateSessionInput,
} from "@/features/academics/formSchemas";

// Status badge color map
const STATUS_VARIANT: Record<
  string,
  "outline" | "default" | "secondary" | "destructive"
> = {
  UPCOMING: "outline",
  ACTIVE: "default",
  CLOSED: "secondary",
};

const STATUS_TABS = ["ALL", "UPCOMING", "ACTIVE", "CLOSED"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

// RouteGuard with no requirePermission — authentication-only guard.
// Action buttons inside are still gated by <Can> with specific permissions.
export default function AcademicSessionsPage() {
  return (
    <RouteGuard>
      <AcademicSessionsInner />
    </RouteGuard>
  );
}

function AcademicSessionsInner() {
  const [createOpen, setCreateOpen] = useState(false);
  const [statusTab, setStatusTab] = useState<StatusTab>("ALL");
  const [handoverTarget, setHandoverTarget] = useState<string | null>(null);

  const statusFilter = statusTab === "ALL" ? undefined : statusTab;
  const { data, isLoading, isError, error } = useSessions(statusFilter);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">
            Academic Sessions
          </h1>
          <p className="text-sm text-gray-500">
            Manage academic sessions and their terms.
          </p>
        </div>
        <Can permission="academics.sessions.manage">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Create
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
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : isError ? (
        <InlineError
          message={
            error instanceof ApiError
              ? error.message
              : "Failed to load academic sessions."
          }
        />
      ) : !data || data.sessions.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          label="No sessions yet"
          description="Create an academic session to begin."
        />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Structure</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Start Date</TableHead>
                <TableHead>End Date</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  onHandover={(id) => setHandoverTarget(id)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateSessionDialog open={createOpen} onOpenChange={setCreateOpen} />

      {/* Handover confirmation dialog: active session exists, offer to close it */}
      <Dialog
        open={handoverTarget !== null}
        onOpenChange={(v) => { if (!v) setHandoverTarget(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Active session exists</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            An active session exists. Close it and activate this one?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHandoverTarget(null)}>
              Cancel
            </Button>
            <HandoverConfirmButton
              targetId={handoverTarget}
              onDone={() => setHandoverTarget(null)}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SessionRow({
  session,
  onHandover,
}: {
  session: AcademicSession;
  onHandover: (id: string) => void;
}) {
  const activateMutation = useActivateSession(session.id);
  const closeMutation = useCloseSession(session.id);

  function handleActivate() {
    activateMutation.mutate(
      {},
      {
        onSuccess: () => toast.success("Session activated."),
        onError: (err) => {
          if (
            err instanceof ApiError &&
            err.status === 409 &&
            String(err.data?.error ?? "").includes("active session exists")
          ) {
            onHandover(session.id);
          }
          // other errors are toasted by the hook's onError
        },
      },
    );
  }

  function handleClose() {
    closeMutation.mutate(undefined, {
      onSuccess: () => toast.success("Session closed."),
    });
  }

  return (
    <TableRow>
      <TableCell className="font-medium">
        <Link
          href={`/academics/sessions/${session.id}`}
          className="text-primary-700 hover:underline"
        >
          {session.name}
        </Link>
      </TableCell>
      <TableCell>
        <Badge variant="outline">{session.structureType}</Badge>
      </TableCell>
      <TableCell>
        <Badge variant={STATUS_VARIANT[session.status] ?? "outline"}>
          {session.status}
        </Badge>
      </TableCell>
      <TableCell className="text-gray-600">{formatDate(session.startDate)}</TableCell>
      <TableCell className="text-gray-600">{formatDate(session.endDate)}</TableCell>
      <TableCell className="text-right">
        <Can permission="academics.sessions.manage">
          <div className="flex gap-2 justify-end">
            {session.status === "UPCOMING" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={activateMutation.isPending}
                onClick={handleActivate}
              >
                Activate
              </Button>
            )}
            {session.status === "ACTIVE" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={closeMutation.isPending}
                onClick={handleClose}
              >
                Close
              </Button>
            )}
          </div>
        </Can>
      </TableCell>
    </TableRow>
  );
}

/** Separate component so the hook binding is always for a real id. */
function HandoverConfirmButton({
  targetId,
  onDone,
}: {
  targetId: string | null;
  onDone: () => void;
}) {
  const activateMutation = useActivateSession(targetId ?? "");

  function handleConfirm() {
    if (!targetId) return;
    activateMutation.mutate(
      { handover: true },
      {
        onSuccess: () => {
          toast.success("Session activated with handover.");
          onDone();
        },
      },
    );
  }

  return (
    <Button
      onClick={handleConfirm}
      disabled={activateMutation.isPending}
    >
      {activateMutation.isPending ? "Activating…" : "Activate with Handover"}
    </Button>
  );
}

function CreateSessionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const createMutation = useCreateSession();
  const form = useForm<CreateSessionInput>({
    resolver: zodResolver(createSessionSchema),
    defaultValues: {
      name: "",
      structureType: "SEMESTER",
      startDate: "",
      endDate: "",
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const body: CreateSessionBody = {
      name: values.name,
      structureType: values.structureType,
      startDate: values.startDate,
      endDate: values.endDate,
    };
    createMutation.mutate(body, {
      onSuccess: () => {
        toast.success("Session created.");
        form.reset();
        onOpenChange(false);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409) {
          form.setError("name", {
            message: "Session name already exists.",
          });
        }
      },
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create academic session</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. 2025-26 Academic Year" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="structureType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Structure Type</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="SEMESTER">Semester</SelectItem>
                      <SelectItem value="TRIMESTER">Trimester</SelectItem>
                      <SelectItem value="ANNUAL">Annual</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="startDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Start Date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="endDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>End Date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
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
