"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
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
  DialogDescription,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ApiError } from "@/lib/api";
import { useStudent, useDeactivateStudent } from "@/features/sis/hooks";
import type { DeactivationStatus } from "@/features/sis/types";
import {
  deactivateStudentSchema,
  type DeactivateStudentInput,
} from "@/features/sis/formSchemas";

const STATUS_VARIANT: Record<
  string,
  "outline" | "default" | "secondary" | "destructive"
> = {
  ACTIVE: "default",
  SUSPENDED: "destructive",
  WITHDRAWN: "secondary",
  GRADUATED: "outline",
  ON_LEAVE: "secondary",
};

// Graduate does not require a reason; the others do (reason optional but
// surfaced as an input).
const REASON_REQUIRED: Record<DeactivationStatus, boolean> = {
  SUSPENDED: true,
  WITHDRAWN: true,
  GRADUATED: false,
  ON_LEAVE: true,
};

const STATUS_LABELS: Record<DeactivationStatus, string> = {
  SUSPENDED: "Suspend",
  WITHDRAWN: "Withdraw",
  GRADUATED: "Graduate",
  ON_LEAVE: "Place on Leave",
};

// Student detail wrapped in <RouteGuard> (authentication-only, no requirePermission
// per MUST-FIX 2). Status actions gated by <Can permission="students.deactivate">.
export default function StudentDetailPage() {
  return (
    <RouteGuard>
      <StudentDetailInner />
    </RouteGuard>
  );
}

function StudentDetailInner() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, error } = useStudent(id);
  const [pendingStatus, setPendingStatus] = useState<DeactivationStatus | null>(
    null,
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <InlineError
        message={
          error instanceof ApiError
            ? error.message
            : "Failed to load student."
        }
      />
    );
  }
  if (!data) return null;

  const student = data;

  return (
    <div className="space-y-6">
      <Link href="/sis/students" className="text-sm text-gray-500 hover:underline">
        ← Students
      </Link>

      {/* Profile card */}
      <div className="card p-6 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">
              {student.name}
            </h1>
            <p className="text-sm text-gray-500">{student.email}</p>
          </div>
          <Badge variant={STATUS_VARIANT[student.status] ?? "outline"}>
            {student.status}
          </Badge>
        </div>

        <div className="card p-0 overflow-hidden">
          <Table>
            <TableBody>
              <ProfileRow label="Enrollment No" value={student.enrollmentNo} />
              <ProfileRow
                label="Roll Number"
                value={student.rollNumber ?? "—"}
              />
              <ProfileRow
                label="Program"
                value={student.structuredProgram?.name ?? "—"}
              />
              <ProfileRow
                label="Department"
                value={student.department?.name ?? student.departmentId}
              />
              <ProfileRow
                label="Semester"
                value={String(student.semester)}
              />
              <ProfileRow
                label="Section"
                value={student.section ?? "—"}
              />
              <ProfileRow
                label="Admission Date"
                value={student.admissionDate ?? "—"}
              />
              <ProfileRow
                label="Current Session"
                value={student.academicSession?.name ?? "—"}
              />
              <ProfileRow
                label="Current Term"
                value={student.currentTerm?.name ?? "—"}
              />
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Status actions — Can-gated on students.deactivate, shown only when ACTIVE */}
      <Can permission="students.deactivate">
        {student.status === "ACTIVE" && (
          <div className="card p-6 space-y-3">
            <h2 className="text-lg font-semibold text-gray-900">
              Change Status
            </h2>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(STATUS_LABELS) as DeactivationStatus[]).map((s) => (
                <Button
                  key={s}
                  variant="outline"
                  onClick={() => setPendingStatus(s)}
                >
                  {STATUS_LABELS[s]}
                </Button>
              ))}
            </div>
          </div>
        )}
      </Can>

      <StatusActionDialog
        studentId={id}
        status={pendingStatus}
        onClose={() => setPendingStatus(null)}
      />
    </div>
  );
}

function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <TableRow>
      <TableHead className="w-1/3 text-gray-500 font-normal">{label}</TableHead>
      <TableCell className="font-medium text-gray-900">{value}</TableCell>
    </TableRow>
  );
}

function StatusActionDialog({
  studentId,
  status,
  onClose,
}: {
  studentId: string;
  status: DeactivationStatus | null;
  onClose: () => void;
}) {
  const deactivateMutation = useDeactivateStudent(studentId);
  const needsReason = status ? REASON_REQUIRED[status] : false;

  const form = useForm<DeactivateStudentInput>({
    resolver: zodResolver(deactivateStudentSchema),
    defaultValues: { status: status ?? "SUSPENDED", reason: "" },
  });

  // Keep the status field in sync with the pending action each time it opens.
  useEffect(() => {
    if (status) form.setValue("status", status);
  }, [status, form]);

  const onSubmit = form.handleSubmit((values) => {
    const body = { status: values.status, reason: values.reason || undefined };
    deactivateMutation.mutate(body, {
      onSuccess: () => {
        toast.success("Student status updated.");
        form.reset();
        onClose();
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 400) {
          form.setError("status", { message: err.message });
        }
      },
    });
  });

  if (!status) return null;

  return (
    <Dialog open={status !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm {STATUS_LABELS[status].toLowerCase()}</DialogTitle>
          <DialogDescription>
            {needsReason
              ? "Provide a reason for this status change (optional)."
              : "Confirm this status change."}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <input type="hidden" {...form.register("status")} />
            {needsReason && (
              <FormField
                control={form.control}
                name="reason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reason (optional)</FormLabel>
                    <FormControl>
                      <textarea
                        {...field}
                        maxLength={500}
                        rows={3}
                        className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
                        placeholder="Reason for this status change…"
                        value={field.value ?? ""}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <DialogFooter>
              <Button type="submit" disabled={deactivateMutation.isPending}>
                {deactivateMutation.isPending ? "Saving…" : "Confirm"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
