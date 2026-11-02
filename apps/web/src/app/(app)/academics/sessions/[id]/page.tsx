"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
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
  useSession,
  useUpdateSession,
  useCreateTerm,
  useUpdateTerm,
  useActivateTerm,
  useCloseTerm,
  useSessionCalendar,
  type CreateSessionBody,
  type AddTermBody,
} from "@/features/academics/hooks";
import type {
  AcademicSession,
  AcademicTerm,
} from "@/features/academics/types";
import {
  createSessionSchema,
  addTermSchema,
  editTermSchema,
  type CreateSessionInput,
  type AddTermInput,
  type EditTermInput,
} from "@/features/academics/formSchemas";

const STATUS_VARIANT: Record<
  string,
  "outline" | "default" | "secondary" | "destructive"
> = {
  UPCOMING: "outline",
  ACTIVE: "default",
  CLOSED: "secondary",
};

export default function SessionDetailPage() {
  return (
    <RouteGuard>
      <SessionDetailInner />
    </RouteGuard>
  );
}

function SessionDetailInner() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, error } = useSession(id);
  const [editOpen, setEditOpen] = useState(false);
  const [addTermOpen, setAddTermOpen] = useState(false);
  const [editTermTarget, setEditTermTarget] = useState<AcademicTerm | null>(
    null,
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (isError) {
    return (
      <InlineError
        message={
          error instanceof ApiError
            ? error.message
            : "Failed to load session."
        }
      />
    );
  }
  if (!data) return null;

  const session = data.session;

  return (
    <div className="space-y-6">
      <Link
        href="/academics/sessions"
        className="text-sm text-gray-500 hover:underline"
      >
        ← Back to Sessions
      </Link>

      {/* Session header */}
      <div className="card p-6 space-y-2">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">
              {session.name}
            </h1>
            <p className="text-sm text-gray-500">Academic Session</p>
          </div>
          <Can permission="academics.sessions.manage">
            {session.status === "UPCOMING" && (
              <Button variant="outline" onClick={() => setEditOpen(true)}>
                Edit
              </Button>
            )}
          </Can>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <div>
            <span className="text-gray-500">Structure: </span>
            <Badge variant="outline">{session.structureType}</Badge>
          </div>
          <div>
            <span className="text-gray-500">Status: </span>
            <Badge variant={STATUS_VARIANT[session.status] ?? "outline"}>
              {session.status}
            </Badge>
          </div>
          <div>
            <span className="text-gray-500">Start: </span>
            <span className="text-gray-900">{session.startDate}</span>
          </div>
          <div>
            <span className="text-gray-500">End: </span>
            <span className="text-gray-900">{session.endDate}</span>
          </div>
        </div>
      </div>

      {/* Terms sub-section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Terms</h2>
          <Can permission="academics.sessions.manage">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddTermOpen(true)}
            >
              <Plus className="w-4 h-4 mr-1" /> Add Term
            </Button>
          </Can>
        </div>
        {!session.terms || session.terms.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            label="No terms yet"
            description="Add a term to this session."
          />
        ) : (
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Ordinal</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead>End</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {session.terms.map((term) => (
                  <TermRow
                    key={term.id}
                    term={term}
                    sessionId={id}
                    sessionStatus={session.status}
                    onEdit={() => setEditTermTarget(term)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Academic calendar preview */}
      <Can permission="academics.calendar.manage">
        <SessionCalendarPreview
          sessionId={id}
          startDate={session.startDate}
          endDate={session.endDate}
        />
      </Can>

      <EditSessionDialog
        sessionId={id}
        session={session}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      <AddTermDialog
        sessionId={id}
        open={addTermOpen}
        onOpenChange={setAddTermOpen}
      />
      <EditTermDialog
        target={editTermTarget}
        sessionId={id}
        onClose={() => setEditTermTarget(null)}
      />
    </div>
  );
}

function TermRow({
  term,
  sessionId,
  sessionStatus,
  onEdit,
}: {
  term: AcademicTerm;
  sessionId: string;
  sessionStatus: string;
  onEdit: () => void;
}) {
  const activateMutation = useActivateTerm(term.id, sessionId);
  const closeMutation = useCloseTerm(term.id, sessionId);

  return (
    <TableRow>
      <TableCell className="font-medium">
        <Link
          href={`/academics/sessions/${sessionId}/terms/${term.id}`}
          className="text-primary-700 hover:underline"
        >
          {term.name}
        </Link>
      </TableCell>
      <TableCell>{term.ordinal}</TableCell>
      <TableCell>
        <Badge variant={STATUS_VARIANT[term.status] ?? "outline"}>
          {term.status}
        </Badge>
      </TableCell>
      <TableCell className="text-gray-600">{term.startDate}</TableCell>
      <TableCell className="text-gray-600">{term.endDate}</TableCell>
      <TableCell className="text-right">
        <Can permission="academics.sessions.manage">
          <div className="flex gap-2 justify-end">
            {term.status === "UPCOMING" && sessionStatus === "ACTIVE" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={activateMutation.isPending}
                onClick={() =>
                  activateMutation.mutate(undefined, {
                    onSuccess: () => toast.success("Term activated."),
                  })
                }
              >
                Activate
              </Button>
            )}
            {term.status === "ACTIVE" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={closeMutation.isPending}
                onClick={() =>
                  closeMutation.mutate(undefined, {
                    onSuccess: () => toast.success("Term closed."),
                  })
                }
              >
                Close
              </Button>
            )}
            {term.status !== "CLOSED" && (
              <Button variant="ghost" size="sm" onClick={onEdit}>
                Edit
              </Button>
            )}
          </div>
        </Can>
      </TableCell>
    </TableRow>
  );
}

function SessionCalendarPreview({
  sessionId,
  startDate,
  endDate,
}: {
  sessionId: string;
  startDate: string;
  endDate: string;
}) {
  const { data, isLoading, isError } = useSessionCalendar(
    sessionId,
    startDate,
    endDate,
  );

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold text-gray-900">
        Academic Calendar
      </h2>
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : isError ? (
        <InlineError message="Failed to load calendar entries." />
      ) : !data || data.length === 0 ? (
        <p className="text-sm text-gray-500">
          No special calendar entries for this session.
        </p>
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((day) => (
                <TableRow key={day.id}>
                  <TableCell className="font-medium">{day.date}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{day.dayType}</Badge>
                  </TableCell>
                  <TableCell className="text-gray-600">
                    {day.note ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-xs text-gray-400">
        Manage calendar entries from the Academic Calendar screen.
      </p>
    </div>
  );
}

function EditSessionDialog({
  sessionId,
  session,
  open,
  onOpenChange,
}: {
  sessionId: string;
  session: AcademicSession;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const updateMutation = useUpdateSession(sessionId);
  const form = useForm<CreateSessionInput>({
    resolver: zodResolver(createSessionSchema),
    defaultValues: {
      name: session.name,
      structureType: session.structureType,
      startDate: session.startDate,
      endDate: session.endDate,
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const body: Partial<CreateSessionBody> = {
      name: values.name,
      structureType: values.structureType,
      startDate: values.startDate,
      endDate: values.endDate,
    };
    updateMutation.mutate(body, {
      onSuccess: () => {
        toast.success("Session updated.");
        onOpenChange(false);
      },
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit session</DialogTitle>
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
                    <Input {...field} />
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
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function AddTermDialog({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const createMutation = useCreateTerm(sessionId);
  const form = useForm<AddTermInput>({
    resolver: zodResolver(addTermSchema),
    defaultValues: { name: "", ordinal: 1, startDate: "", endDate: "" },
  });

  const onSubmit = form.handleSubmit((values) => {
    const body: AddTermBody = {
      name: values.name,
      ordinal: values.ordinal,
      startDate: values.startDate,
      endDate: values.endDate,
    };
    createMutation.mutate(body, {
      onSuccess: () => {
        toast.success("Term added.");
        form.reset();
        onOpenChange(false);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409) {
          form.setError("ordinal", {
            message: "A term with this ordinal already exists.",
          });
        }
      },
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add term</DialogTitle>
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
                    <Input placeholder="e.g. Semester 1" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="ordinal"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ordinal</FormLabel>
                  <FormControl>
                    <Input type="number" min={1} {...field} />
                  </FormControl>
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
                {createMutation.isPending ? "Adding…" : "Add Term"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function EditTermDialog({
  target,
  sessionId,
  onClose,
}: {
  target: AcademicTerm | null;
  sessionId: string;
  onClose: () => void;
}) {
  return target ? (
    <EditTermDialogInner
      key={target.id}
      target={target}
      sessionId={sessionId}
      onClose={onClose}
    />
  ) : null;
}

function EditTermDialogInner({
  target,
  sessionId,
  onClose,
}: {
  target: AcademicTerm;
  sessionId: string;
  onClose: () => void;
}) {
  const updateMutation = useUpdateTerm(target.id, sessionId);
  const form = useForm<EditTermInput>({
    resolver: zodResolver(editTermSchema),
    defaultValues: {
      name: target.name,
      ordinal: target.ordinal,
      startDate: target.startDate,
      endDate: target.endDate,
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const body: Partial<AddTermBody> = {};
    if (values.name !== undefined) body.name = values.name;
    if (values.ordinal !== undefined) body.ordinal = values.ordinal;
    if (values.startDate !== undefined) body.startDate = values.startDate;
    if (values.endDate !== undefined) body.endDate = values.endDate;
    updateMutation.mutate(body, {
      onSuccess: () => {
        toast.success("Term updated.");
        onClose();
      },
    });
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit term</DialogTitle>
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
                    <Input {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="ordinal"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ordinal</FormLabel>
                  <FormControl>
                    <Input type="number" min={1} {...field} />
                  </FormControl>
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
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
