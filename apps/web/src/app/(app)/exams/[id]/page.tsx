"use client";

import { useParams } from "next/navigation";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ExamStatusBadge } from "@/components/exams/ExamStatusBadge";
import { SchedulesTab } from "@/components/exams/SchedulesTab";
import { CandidatesTab } from "@/components/exams/CandidatesTab";
import { AssessmentsTab } from "@/components/exams/AssessmentsTab";
import { MarksTab } from "@/components/exams/MarksTab";
import { ResultsTab } from "@/components/exams/ResultsTab";
import { ApiError } from "@/lib/api";
import { useExam, useUpdateExamStatus } from "@/features/exams/hooks";
import { EXAM_PERM } from "@/features/exams/permissions";
import type { ExamStatusTarget } from "@/features/exams/types";

const MANAGE_TARGETS: ExamStatusTarget[] = ["SCHEDULED", "MARKS_OPEN"];
const MODERATE_TARGETS: ExamStatusTarget[] = ["MARKS_LOCKED", "MODERATION", "APPROVED"];

export default function ExamDetailPage() {
  return (
    <RouteGuard requirePermission={EXAM_PERM.view}>
      <ExamDetailInner />
    </RouteGuard>
  );
}

function ExamDetailInner() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { data: exam, isLoading, isError, error } = useExam(id);
  const updateStatus = useUpdateExamStatus(id);

  function advance(to: ExamStatusTarget) {
    updateStatus.mutate(
      { to },
      {
        onSuccess: () => toast.success(`Status changed to ${to}.`),
        onError: (err) => {
          if (err.status === 409) {
            toast.error("That transition isn't allowed from the current status.");
          } else {
            toast.error(err.message);
          }
        },
      },
    );
  }

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (isError || !exam) {
    return (
      <InlineError
        message={error instanceof ApiError ? error.message : "Failed to load examination."}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-gray-900">{exam.name}</h1>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <ExamStatusBadge status={exam.status} />
            <span>{exam.type}</span>
          </div>
        </div>
        <Can anyOf={[EXAM_PERM.manage, EXAM_PERM.moderate]}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={updateStatus.isPending}>
                Change status
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <Can permission={EXAM_PERM.manage}>
                {MANAGE_TARGETS.map((t) => (
                  <DropdownMenuItem key={t} onSelect={() => advance(t)}>
                    {t.replace("_", " ")}
                  </DropdownMenuItem>
                ))}
              </Can>
              <Can permission={EXAM_PERM.moderate}>
                {MODERATE_TARGETS.map((t) => (
                  <DropdownMenuItem key={t} onSelect={() => advance(t)}>
                    {t.replace("_", " ")}
                  </DropdownMenuItem>
                ))}
              </Can>
            </DropdownMenuContent>
          </DropdownMenu>
        </Can>
      </div>

      <Tabs defaultValue="schedules">
        <TabsList>
          <TabsTrigger value="schedules">Schedules</TabsTrigger>
          <TabsTrigger value="candidates">Candidates</TabsTrigger>
          <TabsTrigger value="assessments">Assessments</TabsTrigger>
          <TabsTrigger value="marks">Marks</TabsTrigger>
          <TabsTrigger value="results">Results</TabsTrigger>
        </TabsList>
        <TabsContent value="schedules">
          <SchedulesTab examId={exam.id} />
        </TabsContent>
        <TabsContent value="candidates">
          <CandidatesTab exam={exam} />
        </TabsContent>
        <TabsContent value="assessments">
          <AssessmentsTab examId={exam.id} />
        </TabsContent>
        <TabsContent value="marks">
          <MarksTab exam={exam} />
        </TabsContent>
        <TabsContent value="results">
          <ResultsTab examId={exam.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
