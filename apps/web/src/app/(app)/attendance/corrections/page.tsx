"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Info, ClipboardList } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ApiError } from "@/lib/api";
import { useCan } from "@/lib/authz";
import {
  useCorrections,
  useApproveCorrection,
  useRejectCorrection,
} from "@/features/attendance/hooks";
import type { AttendanceCorrection, CorrectionReviewStatus } from "@/features/attendance/types";
import {
  reviewCorrectionSchema,
  type ReviewCorrectionInput,
} from "@/features/attendance/formSchemas";

const REVIEW_STATUS_VARIANT: Record<CorrectionReviewStatus, "outline" | "default" | "secondary" | "destructive"> = {
  PENDING: "outline",
  APPROVED: "default",
  REJECTED: "destructive",
};

const STATUS_TABS = ["ALL", "PENDING", "APPROVED", "REJECTED"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

export default function AttendanceCorrectionsPage() {
  return (
    <RouteGuard>
      <AttendanceCorrectionsInner />
    </RouteGuard>
  );
}

function AttendanceCorrectionsInner() {
  const canReview = useCan("attendance.correct");
  const canMark   = useCan("attendance.mark");

  // Faculty with only attendance.mark cannot call GET /api/attendance/corrections.
  if (!canReview && canMark) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-gray-900">Corrections</h1>
        <EmptyState
          icon={Info}
          label="View not available"
          description="Corrections are submitted from the Mark Attendance screen. Your submitted corrections are reviewed by your HOD or administrator."
        />
      </div>
    );
  }

  return <CorrectionsReviewView />;
}

function CorrectionsReviewView() {
  const [statusTab, setStatusTab] = useState<StatusTab>("ALL");
  const [reviewTarget, setReviewTarget] = useState<{ id: string; action: "approve" | "reject" } | null>(null);

  const statusFilter = statusTab === "ALL" ? undefined : statusTab;
  const { data, isLoading, isError, error } = useCorrections(statusFilter);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Attendance Corrections</h1>
        <p className="text-sm text-gray-500">Review and manage correction requests.</p>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setStatusTab(tab)}
            className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
              statusTab === tab
                ? "bg-primary-600 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {tab === "ALL" ? "All" : tab.charAt(0) + tab.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : isError ? (
        <InlineError
          message={error instanceof ApiError ? error.message : "Failed to load corrections."}
        />
      ) : !data?.corrections || data.corrections.length === 0 ? (
        <EmptyState icon={ClipboardList} label="No corrections" description="No correction requests found." />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Record ID</TableHead>
                <TableHead>Requested Status</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Review Status</TableHead>
                <TableHead>Submitted At</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.corrections.map((correction) => (
                <TableRow key={correction.id}>
                  <TableCell className="font-mono text-xs">{correction.attendanceRecordId}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{correction.requestedStatus}</Badge>
                  </TableCell>
                  <TableCell className="max-w-[200px] truncate">{correction.reason}</TableCell>
                  <TableCell>
                    <Badge variant={REVIEW_STATUS_VARIANT[correction.reviewStatus]}>
                      {correction.reviewStatus}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-gray-600">{correction.createdAt}</TableCell>
                  <TableCell className="text-right">
                    {correction.reviewStatus === "PENDING" && (
                      <Can permission="attendance.correct">
                        <div className="flex gap-2 justify-end">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setReviewTarget({ id: correction.id, action: "approve" })}
                          >
                            Approve
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setReviewTarget({ id: correction.id, action: "reject" })}
                          >
                            Reject
                          </Button>
                        </div>
                      </Can>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {reviewTarget && (
        <ReviewCorrectionDialog
          correctionId={reviewTarget.id}
          action={reviewTarget.action}
          open={reviewTarget !== null}
          onOpenChange={(v) => { if (!v) setReviewTarget(null); }}
        />
      )}
    </div>
  );
}

function ReviewCorrectionDialog({
  correctionId,
  action,
  open,
  onOpenChange,
}: {
  correctionId: string;
  action: "approve" | "reject";
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const approveMutation = useApproveCorrection(correctionId);
  const rejectMutation = useRejectCorrection(correctionId);
  const activeMutation = action === "approve" ? approveMutation : rejectMutation;

  const form = useForm<ReviewCorrectionInput>({
    resolver: zodResolver(reviewCorrectionSchema),
    defaultValues: { reviewNote: "" },
  });

  const onSubmit = form.handleSubmit((values) => {
    activeMutation.mutate(
      { reviewNote: values.reviewNote || undefined },
      {
        onSuccess: () => {
          toast.success(action === "approve" ? "Correction approved." : "Correction rejected.");
          form.reset();
          onOpenChange(false);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) {
            const msg: string = err.data?.error ?? "";
            if (msg.includes("not pending")) {
              toast.error("Correction has already been reviewed.");
            } else if (msg.includes("record changed")) {
              toast.error("The record was changed after this correction was submitted.");
            } else {
              toast.error(err.message);
            }
          }
        },
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action === "approve" ? "Approve" : "Reject"} correction</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="reviewNote"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Review Note (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Add a note for the faculty member..."
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={activeMutation.isPending}
                variant={action === "reject" ? "destructive" : "default"}
              >
                {activeMutation.isPending
                  ? (action === "approve" ? "Approving…" : "Rejecting…")
                  : (action === "approve" ? "Approve" : "Reject")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
