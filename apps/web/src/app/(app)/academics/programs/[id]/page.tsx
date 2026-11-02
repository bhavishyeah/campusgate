"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { z } from "zod";
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
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ApiError } from "@/lib/api";
import {
  useProgram,
  useUpdateProgram,
  type PatchProgramBody,
} from "@/features/academics/hooks";
import type { Program, ProgramStatus, DurationUnit } from "@/features/academics/types";

const STATUS_VARIANT: Record<string, "outline" | "default" | "secondary"> = {
  ACTIVE: "default",
  INACTIVE: "secondary",
};

// EditProgram form schema. All fields optional; status + durationUnit enums.
const editProgramSchema = z.object({
  name: z.string().max(120).optional(),
  code: z.string().max(20).optional(),
  duration: z.number({ coerce: true }).int().min(1).optional(),
  durationUnit: z.enum(["YEARS", "SEMESTERS", "MONTHS"]).optional(),
  departmentId: z.string().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

interface EditProgramInput {
  name?: string;
  code?: string;
  duration?: number;
  durationUnit?: DurationUnit;
  departmentId?: string;
  status?: ProgramStatus;
}

export default function ProgramDetailPage() {
  return (
    <RouteGuard>
      <ProgramDetailInner />
    </RouteGuard>
  );
}

function ProgramDetailInner() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, error } = useProgram(id);
  const [editOpen, setEditOpen] = useState(false);

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
          error instanceof ApiError ? error.message : "Failed to load program."
        }
      />
    );
  }
  if (!data) return null;

  const program = data.program;

  return (
    <div className="space-y-6">
      <Link
        href="/academics/programs"
        className="text-sm text-gray-500 hover:underline"
      >
        ← Back to Programs
      </Link>

      {/* Program info card */}
      <div className="card p-6 space-y-2">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">
              {program.name}
            </h1>
            <p className="text-sm text-gray-500">{program.code}</p>
          </div>
          {/* Edit gated by academics.programs.manage (NOT academics.view per MUST-FIX 1) */}
          <Can permission="academics.programs.manage">
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              Edit
            </Button>
          </Can>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <div>
            <span className="text-gray-500">Duration: </span>
            <span className="text-gray-900">
              {program.duration} {program.durationUnit}
            </span>
          </div>
          <div>
            <span className="text-gray-500">Department: </span>
            <span className="text-gray-900">{program.departmentId}</span>
          </div>
          <div>
            <span className="text-gray-500">Status: </span>
            <Badge variant={STATUS_VARIANT[program.status] ?? "outline"}>
              {program.status}
            </Badge>
          </div>
        </div>
      </div>

      {/* Courses & Subjects placeholder — class_course module scope, not yet active */}
      <div className="card p-4 text-sm text-gray-500">
        Courses and subjects are managed under Class &amp; Course Management. That
        module is not yet active for this institution.
      </div>

      <EditProgramDialog
        program={program}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
    </div>
  );
}

function EditProgramDialog({
  program,
  open,
  onOpenChange,
}: {
  program: Program;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const updateMutation = useUpdateProgram(program.id);
  const form = useForm<EditProgramInput>({
    resolver: zodResolver(editProgramSchema),
    defaultValues: {
      name: program.name,
      code: program.code,
      duration: program.duration,
      durationUnit: program.durationUnit,
      departmentId: program.departmentId,
      status: program.status,
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const body: PatchProgramBody = {};
    if (values.name !== undefined) body.name = values.name;
    if (values.code !== undefined) body.code = values.code;
    if (values.duration !== undefined) body.duration = values.duration;
    if (values.durationUnit !== undefined) body.durationUnit = values.durationUnit;
    if (values.departmentId !== undefined) body.departmentId = values.departmentId;
    if (values.status !== undefined) body.status = values.status;
    updateMutation.mutate(body, {
      onSuccess: () => {
        toast.success("Program updated.");
        onOpenChange(false);
      },
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit program</DialogTitle>
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
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Code</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="duration"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Duration</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={1}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="durationUnit"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Duration Unit</FormLabel>
                  <Select
                    value={field.value ?? "YEARS"}
                    onValueChange={field.onChange}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="YEARS">Years</SelectItem>
                      <SelectItem value="SEMESTERS">Semesters</SelectItem>
                      <SelectItem value="MONTHS">Months</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="departmentId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Department ID</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select
                    value={field.value ?? "ACTIVE"}
                    onValueChange={field.onChange}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="ACTIVE">Active</SelectItem>
                      <SelectItem value="INACTIVE">Inactive</SelectItem>
                    </SelectContent>
                  </Select>
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

