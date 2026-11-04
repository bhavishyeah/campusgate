"use client";

import Link from "next/link";
import { ClipboardList } from "lucide-react";
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
import { useExamMarks } from "@/features/exams/hooks";
import { EXAM_PERM } from "@/features/exams/permissions";
import type { Exam } from "@/features/exams/types";
import { MarksCorrectionPanel } from "@/components/exams/MarksCorrectionPanel";

export function MarksTab({ exam }: { exam: Exam }) {
  const { data, isLoading, isError, error } = useExamMarks(exam.id);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Can permission={EXAM_PERM.marksEnter}>
          <Button asChild variant="outline">
            <Link href={`/exams/${exam.id}/marks`}>Enter marks</Link>
          </Button>
        </Can>
      </div>
      {isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : isError ? (
        <InlineError
          message={error instanceof ApiError ? error.message : "Failed to load marks."}
        />
      ) : !data || data.marks.length === 0 ? (
        <EmptyState icon={ClipboardList} label="No marks entered yet" />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Candidate ID</TableHead>
                <TableHead>Assessment ID</TableHead>
                <TableHead>Marks</TableHead>
                <TableHead>Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.marks.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{m.candidateId}</TableCell>
                  <TableCell>{m.assessmentId}</TableCell>
                  <TableCell>{m.marks}</TableCell>
                  <TableCell>
                    <Badge variant={m.changeType === "CORRECTED" ? "secondary" : "outline"}>
                      {m.changeType}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {exam.status === "MODERATION" && (
        <Can permission={EXAM_PERM.moderate}>
          <MarksCorrectionPanel examId={exam.id} marks={data?.marks ?? []} />
        </Can>
      )}
    </div>
  );
}
