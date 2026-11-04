"use client";

import { useState } from "react";
import { toast } from "sonner";
import { BarChart3, Download, FileText } from "lucide-react";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  downloadFile,
  StepUpRequiredError,
  toastError,
  useExamDistribution,
  useExamResults,
  useExamRollups,
  usePublishExam,
} from "@/features/exams/hooks";
import { EXAM_PERM } from "@/features/exams/permissions";
import { formatPercent } from "@/features/exams/ids";
import { StepUpDialog } from "@/components/exams/StepUpDialog";

export function ResultsTab({ examId }: { examId: string }) {
  const results = useExamResults(examId);
  const distribution = useExamDistribution(examId);
  const rollups = useExamRollups(examId);
  const publish = usePublishExam(examId);

  const [reason, setReason] = useState("");
  const [publishOpen, setPublishOpen] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);

  const latestVersion = results.data?.latestVersion ?? null;
  const needsReason = latestVersion !== null && latestVersion >= 1;

  function runPublish(stepUpToken?: string) {
    publish.mutate(
      { reason: needsReason ? reason : undefined, stepUpToken },
      {
        onSuccess: (r) => {
          toast.success(`Published version ${r.version} (${r.snapshotCount} results).`);
          setPublishOpen(false);
          setStepUpOpen(false);
          setReason("");
        },
        onError: (err) => {
          if (err instanceof StepUpRequiredError) {
            setStepUpOpen(true);
            return;
          }
          if (err instanceof ApiError) toast.error(err.message);
          else toastError(err);
        },
      },
    );
  }

  async function exportXlsx() {
    try {
      await downloadFile(`/api/exams/${examId}/results.xlsx`, `exam-${examId}-results.xlsx`);
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={exportXlsx}>
          <Download className="w-4 h-4 mr-1" /> Export XLSX
        </Button>
        <Can permission={EXAM_PERM.publish}>
          <Button onClick={() => setPublishOpen(true)}>Publish</Button>
        </Can>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <SummaryCard
          title="Passed"
          value={distribution.data ? String(distribution.data.passed) : "—"}
        />
        <SummaryCard
          title="Failed"
          value={distribution.data ? String(distribution.data.failed) : "—"}
        />
        <SummaryCard
          title="Latest version"
          value={latestVersion !== null ? String(latestVersion) : "—"}
          icon={<BarChart3 className="w-4 h-4 text-gray-400" />}
        />
      </div>

      {distribution.data && Object.keys(distribution.data.gradeDistribution).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(distribution.data.gradeDistribution).map(([grade, count]) => (
            <Badge key={grade} variant="outline">
              {grade}: {count}
            </Badge>
          ))}
        </div>
      )}

      {/* Publications */}
      {results.isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : results.isError ? (
        <InlineError
          message={
            results.error instanceof ApiError ? results.error.message : "Failed to load results."
          }
        />
      ) : !results.data || results.data.snapshots.length === 0 ? (
        <EmptyState icon={FileText} label="No published results yet" />
      ) : (
        <>
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student ID</TableHead>
                  <TableHead>Subject ID</TableHead>
                  <TableHead>Percent</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead>Points</TableHead>
                  <TableHead>Passed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.data.snapshots.map((s) => (
                  <TableRow key={`${s.studentId}-${s.subjectId}`}>
                    <TableCell>{s.studentId}</TableCell>
                    <TableCell>{s.subjectId}</TableCell>
                    <TableCell>{formatPercent(s.percentBps)}%</TableCell>
                    <TableCell>{s.gradeLabel}</TableCell>
                    <TableCell>{s.gradePoints}</TableCell>
                    <TableCell>{s.passed ? "Yes" : "No"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {rollups.data && rollups.data.perSubject.length > 0 && (
            <div className="card p-0 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Subject ID</TableHead>
                    <TableHead>Count</TableHead>
                    <TableHead>Passed</TableHead>
                    <TableHead>Failed</TableHead>
                    <TableHead>Avg %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rollups.data.perSubject.map((r) => (
                    <TableRow key={r.subjectId}>
                      <TableCell>{r.subjectId}</TableCell>
                      <TableCell>{r.count}</TableCell>
                      <TableCell>{r.passed}</TableCell>
                      <TableCell>{r.failed}</TableCell>
                      <TableCell>{formatPercent(r.avgPercentBps)}%</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}

      {/* Publish dialog */}
      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish results</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            Publishing generates result snapshots for every candidate and needs a fresh
            authentication code.
          </p>
          {needsReason && (
            <div className="space-y-1">
              <Label htmlFor="publish-reason">Reason for re-publication</Label>
              <Input
                id="publish-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={publish.isPending || (needsReason && reason.trim() === "")}
              onClick={() => runPublish()}
            >
              {publish.isPending ? "Publishing…" : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <StepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onToken={(token) => runPublish(token)}
      />
    </div>
  );
}

function SummaryCard({
  title,
  value,
  icon,
}: {
  title: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="card p-4 flex items-center justify-between">
      <div>
        <p className="text-xs text-gray-500">{title}</p>
        <p className="text-xl font-semibold text-gray-900">{value}</p>
      </div>
      {icon}
    </div>
  );
}
