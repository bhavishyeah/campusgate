"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCan } from "@/lib/authz";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { FileCheck, Plus } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ExamStatusBadge } from "@/components/exams/ExamStatusBadge";
import { ApiError } from "@/lib/api";
import { useExams, useCreateExam } from "@/features/exams/hooks";
import { EXAM_PERM } from "@/features/exams/permissions";
import {
  createExamFormSchema,
  type CreateExamFormValues,
} from "@/features/exams/formSchemas";
import { usePrograms, useSession, useSessions } from "@/features/academics/hooks";

export default function ExamsListPage() {
  const router = useRouter();
  const canView = useCan(EXAM_PERM.view);
  const canViewOwn = useCan(EXAM_PERM.viewOwn);
  // Students hold only view_own; the nav entry points here, so send them to their results.
  const redirect = !canView && canViewOwn;

  useEffect(() => {
    if (redirect) router.replace("/exams/my-results");
  }, [redirect, router]);

  if (redirect) return null;
  return (
    <RouteGuard requirePermission={EXAM_PERM.view}>
      <ExamsListInner />
    </RouteGuard>
  );
}

function ExamsListInner() {
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading, isError, error } = useExams();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Examinations</h1>
          <p className="text-sm text-gray-500">Schedule, mark and publish examinations.</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/exams/grading">Grading schemes</Link>
          </Button>
          <Can permission={EXAM_PERM.manage}>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="w-4 h-4 mr-1" /> Create
            </Button>
          </Can>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : isError ? (
        <InlineError
          message={error instanceof ApiError ? error.message : "Failed to load examinations."}
        />
      ) : !data || data.examinations.length === 0 ? (
        <EmptyState
          icon={FileCheck}
          label="No examinations yet"
          description="Create an examination to begin."
        />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Program ID</TableHead>
                <TableHead>Session ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.examinations.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium">
                    <Link href={`/exams/${e.id}`} className="text-primary-700 hover:underline">
                      {e.name}
                    </Link>
                  </TableCell>
                  <TableCell>{e.type}</TableCell>
                  <TableCell>
                    <ExamStatusBadge status={e.status} />
                  </TableCell>
                  <TableCell>{e.programId}</TableCell>
                  <TableCell>{e.academicSessionId}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateExamDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function CreateExamDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const create = useCreateExam();
  const sessions = useSessions();
  const programs = usePrograms();
  const exams = useExams();
  const form = useForm<CreateExamFormValues>({
    resolver: zodResolver(createExamFormSchema),
    defaultValues: {
      academicSessionId: "",
      academicTermId: "",
      programId: "",
      name: "",
      type: "MIDTERM",
      parentExaminationId: "",
    },
  });

  const sessionId = form.watch("academicSessionId");
  const type = form.watch("type");
  const sessionDetail = useSession(sessionId);
  const terms = sessionDetail.data?.session.terms ?? [];

  const onSubmit = form.handleSubmit((v) => {
    create.mutate(
      {
        academicSessionId: v.academicSessionId,
        academicTermId: v.academicTermId,
        programId: v.programId,
        name: v.name,
        type: v.type,
        ...(v.type === "SUPPLEMENTARY" && v.parentExaminationId
          ? { parentExaminationId: v.parentExaminationId }
          : {}),
      },
      {
        onSuccess: () => {
          toast.success("Examination created.");
          form.reset();
          onOpenChange(false);
        },
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create examination</DialogTitle>
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
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="MIDTERM">Midterm</SelectItem>
                      <SelectItem value="FINAL">Final</SelectItem>
                      <SelectItem value="INTERNAL">Internal</SelectItem>
                      <SelectItem value="SUPPLEMENTARY">Supplementary</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="academicSessionId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Academic session</FormLabel>
                  {sessions.data ? (
                    <Select
                      value={field.value}
                      onValueChange={(v) => {
                        field.onChange(v);
                        form.setValue("academicTermId", "");
                      }}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a session" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {sessions.data.sessions.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <FormControl>
                      <Input placeholder="Session ID" {...field} />
                    </FormControl>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="academicTermId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Term</FormLabel>
                  {sessionDetail.data ? (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a term" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {terms.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <FormControl>
                      <Input placeholder="Term ID" {...field} />
                    </FormControl>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="programId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Program</FormLabel>
                  {programs.data ? (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a program" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {programs.data.programs.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <FormControl>
                      <Input placeholder="Program ID" {...field} />
                    </FormControl>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            {type === "SUPPLEMENTARY" && (
              <FormField
                control={form.control}
                name="parentExaminationId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Parent examination</FormLabel>
                    <Select value={field.value ?? ""} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select the exam being repeated" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(exams.data?.examinations ?? []).map((e) => (
                          <SelectItem key={e.id} value={e.id}>
                            {e.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <DialogFooter>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
