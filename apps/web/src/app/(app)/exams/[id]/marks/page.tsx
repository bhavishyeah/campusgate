"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ClipboardList } from "lucide-react";
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
import { useCan } from "@/lib/authz";
import { useEnterMarks, useMarksSheet, type MarkEntry } from "@/features/exams/hooks";
import { EXAM_PERM } from "@/features/exams/permissions";
import type { ExaminationStatus } from "@/features/exams/types";

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

function BackButton() {
  return (
    <Button asChild variant="outline">
      <Link href="/exams">Back to examinations</Link>
    </Button>
  );
}

function MarksEntryInner() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const allowed = useCan(EXAM_PERM.marksEnter);

  const sheet = useMarksSheet(id);
  const enter = useEnterMarks(id);

  // Local edits keyed by assessmentId:candidateId (string so empty is representable).
  const [edits, setEdits] = useState<Record<string, string>>({});

  const data = sheet.data;

  // Existing marks and the set of editable (in-scope) pairs, from the sheet only.
  const { existing, inScope } = useMemo(() => {
    const ex = new Map<string, number>();
    const scope = new Set<string>();
    for (const row of data?.rows ?? []) {
      for (const c of row.cells) {
        const key = cellKey(c.assessmentId, row.candidateId);
        scope.add(key);
        if (c.marks !== null) ex.set(key, c.marks);
      }
    }
    return { existing: ex, inScope: scope };
  }, [data]);

  const maxByAssessment = useMemo(
    () => new Map((data?.assessments ?? []).map((a) => [a.id, a.maxMarks])),
    [data],
  );

  if (!allowed) {
    return (
      <EmptyState
        icon={ClipboardList}
        label="You do not have access to this view"
        description="Marks entry requires the marks-entry permission."
        action={<BackButton />}
      />
    );
  }
  if (sheet.isLoading) return <Skeleton className="h-24 w-full" />;
  if (sheet.isError) {
    const status = sheet.error instanceof ApiError ? sheet.error.status : 0;
    if (status === 403) {
      return (
        <EmptyState
          icon={ClipboardList}
          label="You do not have access to this view"
          description="You are not assigned as a faculty member for this exam."
          action={<BackButton />}
        />
      );
    }
    return (
      <InlineError
        message={sheet.error instanceof ApiError ? sheet.error.message : "Failed to load marks entry."}
      />
    );
  }
  if (!data || data.assessments.length === 0 || data.rows.length === 0) {
    return (
      <EmptyState
        icon={ClipboardList}
        label="No marks to enter for you in this exam"
        description="You have no assigned candidates or assessments for this exam."
        action={<BackButton />}
      />
    );
  }

  const open = data.editable;
  const assessmentList = data.assessments;

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

  // There is NO separate "submit" step in the backend: marks stay editable until
  // staff move the exam to MARKS_LOCKED. So the two buttons are "Save" and
  // "Save & close" (same PUT; close just navigates back afterwards).
  function save(close: boolean) {
    // Changed, non-empty, in-scope cells only.
    const diff: MarkEntry[] = [];
    for (const [key, raw] of Object.entries(edits)) {
      if (raw === "" || !inScope.has(key)) continue;
      const [assessmentId, candidateId] = key.split(":");
      const value = Number(raw);
      if (existing.get(key) === value) continue;
      diff.push({ assessmentId, candidateId, marks: value });
    }
    if (diff.length === 0) {
      if (close) router.push("/exams");
      else toast.info("Nothing to save.");
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
          toast.success(`Saved ${r.written} mark(s). They stay editable until the exam is locked.`);
          setEdits({});
          if (close) router.push("/exams");
        },
        onError: (err) => {
          if (err.status === 409) {
            toast.error("Marks are locked for this exam.");
            void sheet.refetch();
          } else if (err.status === 403) {
            toast.error("You are not assigned to enter this mark");
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
          <h1 className="text-2xl font-semibold text-gray-900">Marks entry: {data.exam.name}</h1>
          <ExamStatusBadge status={data.exam.status as ExaminationStatus} />
        </div>
        <Can permission={EXAM_PERM.marksEnter}>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!open || enter.isPending || hasInvalid}
              onClick={() => save(false)}
            >
              Save
            </Button>
            <Button disabled={!open || enter.isPending || hasInvalid} onClick={() => save(true)}>
              Save &amp; close
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
            {data.rows.map((row) => (
              <TableRow key={row.candidateId}>
                <TableCell className="font-medium">
                  {row.studentName}
                  <span className="block text-xs text-gray-500">{row.enrollmentNo}</span>
                </TableCell>
                {assessmentList.map((a) => {
                  const key = cellKey(a.id, row.candidateId);
                  if (!inScope.has(key)) {
                    return (
                      <TableCell key={a.id} aria-label="Not assigned to you">
                        <span className="text-gray-400">—</span>
                      </TableCell>
                    );
                  }
                  const value = valueFor(a.id, row.candidateId);
                  const problem = invalidReason(a.id, value);
                  return (
                    <TableCell key={a.id}>
                      <Input
                        inputMode="numeric"
                        value={value}
                        disabled={!open}
                        aria-label={`${a.name} marks for ${row.studentName}`}
                        aria-invalid={problem !== null}
                        className={problem ? "border-red-500" : undefined}
                        onChange={(e) =>
                          setEdits((prev) => ({ ...prev, [key]: e.target.value }))
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
