"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { GraduationCap, Plus } from "lucide-react";
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
  usePrograms,
  useCreateProgram,
  type CreateProgramBody,
} from "@/features/academics/hooks";
import type { Program } from "@/features/academics/types";
import {
  createProgramSchema,
  type CreateProgramInput,
} from "@/features/academics/formSchemas";

const STATUS_VARIANT: Record<string, "outline" | "default" | "secondary"> = {
  ACTIVE: "default",
  INACTIVE: "secondary",
};

// Programs list wrapped in <RouteGuard> (authentication-only, no requirePermission
// per MUST-FIX 2). Create button gated by <Can permission="academics.programs.manage">
// (NOT academics.view per MUST-FIX 1).
export default function ProgramsPage() {
  return (
    <RouteGuard>
      <ProgramsInner />
    </RouteGuard>
  );
}

function ProgramsInner() {
  const { data, isLoading, isError, error } = usePrograms();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Programs</h1>
          <p className="text-sm text-gray-500">Manage academic programs.</p>
        </div>
        <Can permission="academics.programs.manage">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Create
          </Button>
        </Can>
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
              : "Failed to load programs."
          }
        />
      ) : !data || data.programs.length === 0 ? (
        <EmptyState
          icon={GraduationCap}
          label="No programs yet"
          description="Create a program to begin."
        />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.programs.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/academics/programs/${p.id}`}
                      className="text-primary-700 hover:underline"
                    >
                      {p.name}
                    </Link>
                  </TableCell>
                  <TableCell>{p.code}</TableCell>
                  <TableCell className="text-gray-600">
                    {p.duration} {p.durationUnit}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[p.status] ?? "outline"}>
                      {p.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateProgramDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function CreateProgramDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const createMutation = useCreateProgram();
  const form = useForm<CreateProgramInput>({
    resolver: zodResolver(createProgramSchema),
    defaultValues: {
      departmentId: "",
      name: "",
      code: "",
      duration: 1,
      durationUnit: "YEARS",
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const body: CreateProgramBody = {
      // departmentId is optional in the filter but required to create a program
      departmentId: values.departmentId,
      name: values.name,
      code: values.code,
      duration: values.duration,
      durationUnit: values.durationUnit,
    };
    createMutation.mutate(body, {
      onSuccess: () => {
        toast.success("Program created.");
        form.reset();
        onOpenChange(false);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 400) {
          form.setError("departmentId", {
            message: "Department not found.",
          });
        }
        if (err instanceof ApiError && err.status === 409) {
          form.setError("code", {
            message: "Program code already exists.",
          });
        }
      },
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create program</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="departmentId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Department ID</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. dept-abc123" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. B.Tech Computer Science" {...field} />
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
                    <Input placeholder="e.g. BTechCS" {...field} />
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
                    <Input type="number" min={1} {...field} />
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
                  <Select value={field.value} onValueChange={field.onChange}>
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
