"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCorrectMarks } from "@/features/exams/hooks";
import { examsKeys } from "@/features/exams/keys";
import { EXAM_PERM } from "@/features/exams/permissions";
import {
  correctionFormSchema,
  type CorrectionFormValues,
} from "@/features/exams/formSchemas";
import type { MarksRecord } from "@/features/exams/types";

export function MarksCorrectionPanel({
  examId,
  marks,
}: {
  examId: string;
  marks: MarksRecord[];
}) {
  const [target, setTarget] = useState<MarksRecord | null>(null);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">Moderation corrections</h3>
      <div className="card p-0 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Candidate ID</TableHead>
              <TableHead>Assessment ID</TableHead>
              <TableHead>Marks</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {marks.map((m) => (
              <TableRow key={m.id}>
                <TableCell>{m.candidateId}</TableCell>
                <TableCell>{m.assessmentId}</TableCell>
                <TableCell>{m.marks}</TableCell>
                <TableCell className="text-right">
                  <Can permission={EXAM_PERM.moderate}>
                    <Button variant="ghost" size="sm" onClick={() => setTarget(m)}>
                      Correct
                    </Button>
                  </Can>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {target && (
        <CorrectDialog examId={examId} record={target} onClose={() => setTarget(null)} />
      )}
    </div>
  );
}

function CorrectDialog({
  examId,
  record,
  onClose,
}: {
  examId: string;
  record: MarksRecord;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const correct = useCorrectMarks(examId);
  const form = useForm<CorrectionFormValues>({
    resolver: zodResolver(correctionFormSchema),
    defaultValues: { marks: record.marks, reason: "" },
  });

  const onSubmit = form.handleSubmit((v) => {
    correct.mutate(
      { recordId: record.id, marks: v.marks, reason: v.reason },
      {
        onSuccess: () => {
          toast.success("Marks corrected.");
          onClose();
        },
        onError: (err) => {
          if (err.status === 400) form.setError("marks", { message: err.message });
          else {
            toast.error(err.message);
            if (err.status === 409) {
              qc.invalidateQueries({ queryKey: examsKeys.exam(examId) });
              qc.invalidateQueries({ queryKey: examsKeys.marks(examId) });
            }
          }
        },
      },
    );
  });

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Correct marks</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="marks"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>New marks</FormLabel>
                  <FormControl>
                    <Input type="number" min={0} {...field} />
                  </FormControl>
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
                    <Textarea rows={3} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={correct.isPending}>
                {correct.isPending ? "Saving…" : "Save correction"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
