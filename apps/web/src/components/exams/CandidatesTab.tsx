"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Users, Plus } from "lucide-react";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
import {
  useExamCandidates,
  useRegisterCandidate,
  useRegisterSupplementary,
} from "@/features/exams/hooks";
import { EXAM_PERM } from "@/features/exams/permissions";
import { formatDateTime, parseIdList } from "@/features/exams/ids";
import type { Exam } from "@/features/exams/types";

export function CandidatesTab({ exam }: { exam: Exam }) {
  const { data, isLoading, isError, error } = useExamCandidates(exam.id);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [suppOpen, setSuppOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <Can permission={EXAM_PERM.candidatesManage}>
          <Button onClick={() => setRegisterOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Register
          </Button>
          {exam.type === "SUPPLEMENTARY" && (
            <Button variant="outline" onClick={() => setSuppOpen(true)}>
              Supplementary register
            </Button>
          )}
        </Can>
      </div>
      {isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : isError ? (
        <InlineError
          message={error instanceof ApiError ? error.message : "Failed to load candidates."}
        />
      ) : !data || data.candidates.length === 0 ? (
        <EmptyState icon={Users} label="No candidates registered" />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Student ID</TableHead>
                <TableHead>Candidate ID</TableHead>
                <TableHead>Seat</TableHead>
                <TableHead>Registered</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.candidates.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{c.studentId}</TableCell>
                  <TableCell>{c.id}</TableCell>
                  <TableCell>{c.seatNo ?? "—"}</TableCell>
                  <TableCell>{formatDateTime(c.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <RegisterDialog examId={exam.id} open={registerOpen} onOpenChange={setRegisterOpen} />
      <SupplementaryDialog examId={exam.id} open={suppOpen} onOpenChange={setSuppOpen} />
    </div>
  );
}

function RegisterDialog({
  examId,
  open,
  onOpenChange,
}: {
  examId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const register = useRegisterCandidate(examId);
  const [text, setText] = useState("");
  const ids = parseIdList(text);
  const valid = ids.length >= 1 && ids.length <= 5000;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register candidates</DialogTitle>
          <DialogDescription>
            Student IDs, separated by commas or new lines (1 to 5000). Duplicates are skipped.
          </DialogDescription>
        </DialogHeader>
        <Label htmlFor="register-ids">Student IDs</Label>
        <Textarea id="register-ids" value={text} onChange={(e) => setText(e.target.value)} rows={6} />
        <p className="text-xs text-gray-500">{ids.length} entered</p>
        <DialogFooter>
          <Button
            disabled={!valid || register.isPending}
            onClick={() =>
              register.mutate(
                { studentIds: ids },
                {
                  onSuccess: (r) => {
                    toast.success(`Registered ${r.registered} candidate(s).`);
                    setText("");
                    onOpenChange(false);
                  },
                },
              )
            }
          >
            {register.isPending ? "Registering…" : "Register"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SupplementaryDialog({
  examId,
  open,
  onOpenChange,
}: {
  examId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const register = useRegisterSupplementary(examId);
  const [subjects, setSubjects] = useState("");
  const [students, setStudents] = useState("");
  const subjectIds = parseIdList(subjects);
  const studentIds = parseIdList(students);
  const valid =
    subjectIds.length >= 1 && subjectIds.length <= 1000 && studentIds.length <= 5000;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Supplementary registration</DialogTitle>
          <DialogDescription>
            Leave students empty to register every eligible student.
          </DialogDescription>
        </DialogHeader>
        <Label htmlFor="supp-subjects">Subject IDs (1 to 1000)</Label>
        <Textarea id="supp-subjects" value={subjects} onChange={(e) => setSubjects(e.target.value)} rows={3} />
        <Label htmlFor="supp-students">Student IDs (optional, up to 5000)</Label>
        <Textarea id="supp-students" value={students} onChange={(e) => setStudents(e.target.value)} rows={3} />
        <DialogFooter>
          <Button
            disabled={!valid || register.isPending}
            onClick={() =>
              register.mutate(
                { subjectIds, ...(studentIds.length > 0 ? { studentIds } : {}) },
                {
                  onSuccess: (r) => {
                    toast.success(`Registered ${r.registered} of ${r.eligibleCount} eligible.`);
                    onOpenChange(false);
                  },
                },
              )
            }
          >
            {register.isPending ? "Registering…" : "Register"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
