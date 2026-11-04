"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ClipboardList } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
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
import { ExamStatusBadge } from "@/components/exams/ExamStatusBadge";
import { ApiError } from "@/lib/api";
import {
  useEnterMarks,
  useExam,
  useExamAssessments,
  useExamCandidates,
  useExamMarks,
  type MarkEntry,
} from "@/features/exams/hooks";
import { examsKeys } from "@/features/exams/keys";
import { EXAM_PERM } from "@/features/exams/permissions";

const MAX_BATCH = 5000;

const cellKey = (assessmentId: string, candidateId: string) =>
  `${assessmentId}:${candidateId}`;

export default function MarksEntryPage() {
  return (
    <RouteGuard requirePermission={EXAM_PERM.marksEnter}>
      <MarksEntryInner />
    </RouteGuard>
  );
}

function MarksEntryInner() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const qc = useQueryClient();

  const exam = useExam(id);
  const assessments = useExamAssessments(id);
  const candidates = useExamCandidates(id);
  const marks = useExamMarks(id);
  const enter = useEnterMarks(id);

  // Local edits keyed by assessmentId:candidateId (string so empty is representable).
  const [edits, setEdits] = useState<Record<string, string>>({});

  const existing = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of marks.data?.marks ?? []) {
      map.set(cellKey(m.assessmentId, m.candidateId), m.marks);
    }
    return map;
  }, [marks.data]);

  const assessmentList = assessments.data?.assessments ?? [];
  const candidateList = candidates.data?.candidates ?? [];
  const maxByAssessment = useMemo(
    () => new Map(assessmentList.map((a) => [a.id, a.maxMarks])),
    [assessmentList],
  );

  const isLoading = exam.isLoading || assessments.isLoading || candidates.isLoading;
  if (isLoading) return <Skeleton className="h-24 w-full" />;

  // Faculty scope is server-side. A 403 on the reads, or nothing to show, means
  // the user has no assigned work for this exam: show an empty state, not an error.
  const forbidden = [exam.error, assessments.error, candidates.error].some(
    (e) => e instanceof ApiError && e.status === 403,
  );
  const hardError = [exam.error, assessments.error, candidates.error].find(
    (e) => e && !(e instanceof ApiError && e.status === 403),
  );
  if (hardError) {
    return (
      <InlineError
        message={hardError instanceof ApiError ? hardError.message : "Failed to load marks entry."}
      />
    );
  }
  if (forbidden || assessmentList.length === 0 || candidateList.length === 0) {
    return (
      <EmptyState
        icon={ClipboardList}
        label="No marks to enter"
        description="You have no assigned candidates or assessments for this exam."
        action={
          <Button asChild variant="outline">
            <Link href="/exams">Back to examinations</Link>
          </Button>
        }
      />
    );
  }

  const open = exam.data?.status === "MARKS_OPEN";

  function valueFor(assessmentId: string, candidateId: string): string {
    const key = cellKey(assessmentId, candidateId);
    if (key in edits) return edits[key];
    const e = existing.get(key);
    return e === undefined ? "" : String(e);
  }

  function invalidReason(assessmentId: string, raw: string): string | null {
    if (raw === "") return null;
    if (!/^\d+$/.test(raw)) return "Whole numbers only";
    const max = maxByAssessment.get(assessmentId);
    if (max !== undefined && Number(raw) > max) return `Max ${max}`;
    return null;
  }

  const hasInvalid = Object.entries(edits).some(([key, raw]) =>
    invalidReason(key.split(":")[0], raw) !== null,
  );

  function save(submit: boolean) {
    // Changed, non-empty cells only.
    const diff: MarkEntry[] = [];
    for (const [key, raw] of Object.entries(edits)) {
      if (raw === "") continue;
      const [assessmentId, candidateId] = key.split(":");
      const value = Number(raw);
      if (existing.get(key) === value) continue;
      diff.push({ assessmentId, candidateId, marks: value });
    }
    if (diff.length === 0) {
      toast.info("Nothing to save.");
      return;
    }
    if (diff.length > MAX_BATCH) {
      toast.error(`Too many changes at once (max ${MAX_BATCH}). Save a smaller batch.`);
      return;
    }
    enter.mutate(
      { marks: diff },
      {
        onSuccess: (r) => {
          toast.success(`Saved ${r.written} mark(s).`);
          setEdits({});
          if (submit) router.push(`/exams/${id}`);
        },
        onError: (err) => {
          if (err.status === 409) {
            toast.error("Marks are locked for this exam.");
            qc.invalidateQueries({ queryKey: examsKeys.exam(id) });
          } else {
            toast.error(err.message);
          }
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-gray-900">
            Marks entry{exam.data ? `: ${exam.data.name}` : ""}
          </h1>
          {exam.data && <ExamStatusBadge status={exam.data.status} />}
        </div>
        <Can permission={EXAM_PERM.marksEnter}>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!open || enter.isPending || hasInvalid}
              onClick={() => save(false)}
            >
              Save draft
            </Button>
            <Button disabled={!open || enter.isPending || hasInvalid} onClick={() => save(true)}>
              Submit
            </Button>
          </div>
        </Can>
      </div>

      {!open && (
        <InlineError message="Marks entry is only open while the exam is in MARKS OPEN status. The grid is read-only." />
      )}

      <div className="card p-0 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Candidate</TableHead>
              {assessmentList.map((a) => (
                <TableHead key={a.id}>
                  {a.name} <span className="text-gray-400">/ {a.maxMarks}</span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {candidateList.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.studentId}</TableCell>
                {assessmentList.map((a) => {
                  const value = valueFor(a.id, c.id);
                  const problem = invalidReason(a.id, value);
                  return (
                    <TableCell key={a.id}>
                      <Input
                        inputMode="numeric"
                        value={value}
                        disabled={!open}
                        aria-label={`${a.name} marks for ${c.studentId}`}
                        aria-invalid={problem !== null}
                        className={problem ? "border-red-500" : undefined}
                        onChange={(e) =>
                          setEdits((prev) => ({ ...prev, [cellKey(a.id, c.id)]: e.target.value }))
                        }
                      />
                      {problem && <p className="text-xs text-red-600 mt-1">{problem}</p>}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
