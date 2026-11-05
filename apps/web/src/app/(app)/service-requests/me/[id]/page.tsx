"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { ListChecks } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { ConfirmDialog } from "@/components/ui-ext/ConfirmDialog";
import { InlineError } from "@/components/ui-ext/InlineError";
import { RequestStatusBadge, OverdueBadge } from "@/components/service-requests/StatusBadges";
import { PriorityBadge } from "@/components/service-requests/PriorityBadge";
import { ActivityList } from "@/components/service-requests/ActivityList";
import { CommentForm } from "@/components/service-requests/CommentForm";
import { FeedbackDialog } from "@/components/service-requests/FeedbackDialog";
import { ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";
import { readIdParam } from "@/lib/paging";
import { useMyCancel, useMyClose, useMyComment, useMyRequest } from "@/features/service-requests/hooks";
import { selfActions } from "@/features/service-requests/transitions";
import { requestStatusLabel } from "@/features/service-requests/labels";
import { formatDateTime } from "@/features/hr/format";

type Dialog = "cancel" | "close" | "feedback" | null;

export default function MyRequestDetailPage() {
  return (
    <RouteGuard requirePermission="service_requests.request_own">
      <MyRequestDetailInner />
    </RouteGuard>
  );
}

function MyRequestDetailInner() {
  const params = useParams<{ id: string }>();
  const id = readIdParam(params.id) ?? "";
  const request = useMyRequest(id);
  const comment = useMyComment(id, { toast: false });
  const [dialog, setDialog] = useState<Dialog>(null);

  const notFound = request.isError && request.error instanceof ApiError && request.error.status === 404;
  const actions = request.data ? selfActions(request.data.status) : [];

  return (
    <div className="space-y-6">
      {!request.allowed ? (
        <NoAccess what="this request" />
      ) : request.isLoading ? (
        <TableSkeleton />
      ) : notFound ? (
        <EmptyState icon={ListChecks} label="Request not found." />
      ) : request.isError || !request.data ? (
        <ErrorBlock error={request.error} onRetry={() => void request.refetch()} />
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">{request.data.title}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <RequestStatusBadge status={request.data.status} />
                <PriorityBadge priority={request.data.priority} />
                <OverdueBadge overdue={request.data.isOverdue} />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {actions.includes("CANCEL") ? (
                <Button size="sm" variant="destructive" onClick={() => setDialog("cancel")}>
                  Cancel
                </Button>
              ) : null}
              {actions.includes("CLOSE") ? (
                <Button size="sm" variant="outline" onClick={() => setDialog("close")}>
                  Close
                </Button>
              ) : null}
              {actions.includes("FEEDBACK") && !request.data.feedback ? (
                <Button size="sm" variant="outline" onClick={() => setDialog("feedback")}>
                  Leave feedback
                </Button>
              ) : null}
            </div>
          </div>

          <Card>
            <CardContent className="grid gap-3 p-4 sm:grid-cols-2">
              <Detail label="Status" value={requestStatusLabel[request.data.status] ?? request.data.status} />
              <Detail label="Raised" value={formatDateTime(request.data.raisedAt)} />
              <Detail label="Due" value={formatDateTime(request.data.dueAt)} />
            </CardContent>
          </Card>

          {request.data.description ? (
            <div>
              <h2 className="text-sm font-medium text-gray-500">Description</h2>
              <p className="text-sm text-gray-900">{request.data.description}</p>
            </div>
          ) : null}

          {Object.keys(request.data.fieldValues ?? {}).length > 0 ? (
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Details</h2>
              <dl className="grid gap-2 sm:grid-cols-2">
                {Object.entries(request.data.fieldValues).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-xs text-gray-500">{k}</dt>
                    <dd className="text-sm text-gray-900">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          <div>
            <h2 className="text-lg font-semibold text-gray-900">Activity</h2>
            <ActivityList activities={request.data.activities} />
          </div>

          {request.data.feedback ? (
            <Card>
              <CardContent className="p-4">
                <p className="text-sm font-medium text-gray-900">Your feedback: {request.data.feedback.rating}/5</p>
                {request.data.feedback.comment ? <p className="text-sm text-gray-700">{request.data.feedback.comment}</p> : null}
              </CardContent>
            </Card>
          ) : null}

          {actions.includes("COMMENT") ? <CommentForm mutation={comment} /> : null}

          {dialog === "cancel" ? <CancelConfirm requestId={id} onClose={() => setDialog(null)} /> : null}
          {dialog === "close" ? <CloseConfirm requestId={id} onClose={() => setDialog(null)} /> : null}
          {dialog === "feedback" ? <FeedbackDialog open onOpenChange={() => setDialog(null)} requestId={id} /> : null}
        </>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-sm text-gray-900">{value}</p>
    </div>
  );
}

function CancelConfirm({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const cancel = useMyCancel(requestId, { toast: false });
  async function onConfirm() {
    setError(null);
    try {
      await cancel.mutateAsync();
      toast.success("Request cancelled");
      onClose();
    } catch (err) {
      setError(describeApiError(err));
    }
  }
  return (
    <ConfirmDialog
      open
      title="Cancel request"
      description="Cancelling is final."
      confirmLabel="Cancel request"
      destructive
      pending={cancel.isPending}
      onConfirm={() => void onConfirm()}
      onOpenChange={(o) => !o && onClose()}
    >
      {error ? <InlineError message={error} /> : null}
    </ConfirmDialog>
  );
}

function CloseConfirm({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const close = useMyClose(requestId, { toast: false });
  async function onConfirm() {
    setError(null);
    try {
      await close.mutateAsync();
      toast.success("Request closed");
      onClose();
    } catch (err) {
      setError(describeApiError(err));
    }
  }
  return (
    <ConfirmDialog
      open
      title="Close request"
      description="Closing is final."
      confirmLabel="Close"
      pending={close.isPending}
      onConfirm={() => void onConfirm()}
      onOpenChange={(o) => !o && onClose()}
    >
      {error ? <InlineError message={error} /> : null}
    </ConfirmDialog>
  );
}
