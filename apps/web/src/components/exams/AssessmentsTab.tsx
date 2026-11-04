"use client";

import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { ListChecks, Plus } from "lucide-react";
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
import { useExamAssessments, useUpsertAssessment } from "@/features/exams/hooks";
import { EXAM_PERM } from "@/features/exams/permissions";
import {
  assessmentFormSchema,
  type AssessmentFormValues,
} from "@/features/exams/formSchemas";
import type { Assessment } from "@/features/exams/types";
import {
  AssessmentWeightInput,
  WeightTotalChip,
  projectWeight,
} from "@/components/exams/AssessmentWeightInput";

interface DialogState {
  /** Subject the dialog operates on; null for a fresh "add" with free subject entry. */
  subjectId: string | null;
  editing: Assessment | null;
}

export function AssessmentsTab({ examId }: { examId: string }) {
  const { data, isLoading, isError, error } = useExamAssessments(examId);
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const bySubject = useMemo(() => {
    const map = new Map<string, Assessment[]>();
    for (const a of data?.assessments ?? []) {
      map.set(a.subjectId, [...(map.get(a.subjectId) ?? []), a]);
    }
    return map;
  }, [data]);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Can permission={EXAM_PERM.manage}>
          <Button onClick={() => setDialog({ subjectId: null, editing: null })}>
            <Plus className="w-4 h-4 mr-1" /> Add assessment
          </Button>
        </Can>
      </div>
      {isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : isError ? (
        <InlineError
          message={error instanceof ApiError ? error.message : "Failed to load assessments."}
        />
      ) : bySubject.size === 0 ? (
        <EmptyState
          icon={ListChecks}
          label="No assessments yet"
          description="Add assessment components for each subject. Weights per subject total 100."
        />
      ) : (
        Array.from(bySubject.entries()).map(([subjectId, items]) => {
          const sum = items.reduce((acc, a) => acc + a.weight, 0);
          return (
            <div key={subjectId} className="card p-0 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3">
                <p className="text-sm font-medium text-gray-900">Subject {subjectId}</p>
                <WeightTotalChip total={sum} />
              </div>
              {sum < 100 && (
                <p className="px-4 pb-2 text-xs text-amber-700">
                  Weights total {sum}% — assessments should sum to 100% before marks open
                </p>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Max marks</TableHead>
                    <TableHead>Weight</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>{a.name}</TableCell>
                      <TableCell>{a.maxMarks}</TableCell>
                      <TableCell>{a.weight}</TableCell>
                      <TableCell className="text-right">
                        <Can permission={EXAM_PERM.manage}>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDialog({ subjectId, editing: a })}
                          >
                            Edit
                          </Button>
                        </Can>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          );
        })
      )}
      {dialog && (
        <AssessmentDialog
          examId={examId}
          state={dialog}
          assessments={data?.assessments ?? []}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function AssessmentDialog({
  examId,
  state,
  assessments,
  onClose,
}: {
  examId: string;
  state: DialogState;
  assessments: Assessment[];
  onClose: () => void;
}) {
  const upsert = useUpsertAssessment(examId);
  const editing = state.editing;
  const form = useForm<AssessmentFormValues>({
    resolver: zodResolver(assessmentFormSchema),
    defaultValues: {
      subjectId: editing?.subjectId ?? state.subjectId ?? "",
      name: editing?.name ?? "",
      maxMarks: editing?.maxMarks ?? 100,
      weight: editing?.weight ?? 1,
    },
  });

  const subjectId = form.watch("subjectId");
  const weight = Number(form.watch("weight"));
  const existingSum = useMemo(
    () =>
      assessments.filter((a) => a.subjectId === subjectId).reduce((acc, a) => acc + a.weight, 0),
    [assessments, subjectId],
  );
  const originalWeight = editing?.weight ?? 0;
  const projected = projectWeight(existingSum, originalWeight, Number.isFinite(weight) ? weight : 0);
  const overLimit = projected > 100;

  useEffect(() => {
    form.clearErrors("weight");
  }, [weight, form]);

  const onSubmit = form.handleSubmit((v) => {
    const handlers = {
      onSuccess: () => {
        toast.success(editing ? "Assessment updated." : "Assessment added.");
        onClose();
      },
      onError: (err: ApiError) => {
        if (err.status === 400) form.setError("weight", { message: err.message });
        else if (err.status === 409) form.setError("name", { message: err.message });
        else toast.error(err.message);
      },
    };
    if (editing) {
      upsert.mutate(
        {
          assessmentId: editing.id,
          patch: { name: v.name, maxMarks: v.maxMarks, weight: v.weight },
        },
        handlers,
      );
    } else {
      upsert.mutate(
        { subjectId: v.subjectId, name: v.name, maxMarks: v.maxMarks, weight: v.weight },
        handlers,
      );
    }
  });

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit assessment" : "Add assessment"}</DialogTitle>
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
                    <Input {...field} disabled={Boolean(editing)} />
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
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="maxMarks"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Max marks</FormLabel>
                  <FormControl>
                    <Input type="number" min={1} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="weight"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Weight</FormLabel>
                  <AssessmentWeightInput
                    value={String(field.value)}
                    onChange={field.onChange}
                    existingSum={existingSum}
                    originalWeight={originalWeight}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={upsert.isPending || overLimit}>
                {upsert.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
