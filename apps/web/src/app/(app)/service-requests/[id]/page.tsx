"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { ClipboardList } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { ConfirmDialog } from "@/components/ui-ext/ConfirmDialog";
import { InlineError } from "@/components/ui-ext/InlineError";
import { SERVICE_REQUESTS_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { RequestStatusBadge, OverdueBadge } from "@/components/service-requests/StatusBadges";
import { PriorityBadge } from "@/components/service-requests/PriorityBadge";
import { ActivityList } from "@/components/service-requests/ActivityList";
import { CommentForm } from "@/components/service-requests/CommentForm";
import { AssignDialog } from "@/components/service-requests/AssignDialog";
import { StatusDialog } from "@/components/service-requests/StatusDialog";
import { ResolveDialog } from "@/components/service-requests/ResolveDialog";
import { RejectDialog } from "@/components/service-requests/RejectDialog";
import { ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";
import { readIdParam } from "@/lib/paging";
import {
  useApprove,
  useCancelStaff,
  useCloseStaff,
  useCommentStaff,
  useRequest,
  useTypes,
} from "@/features/service-requests/hooks";
import { staffActions } from "@/features/service-requests/transitions";
import { slaLabel } from "@/features/service-requests/format";
import { requestStatusLabel } from "@/features/service-requests/labels";
import { formatDateTime } from "@/features/hr/format";
import type { RequestType } from "@/features/service-requests/types";

type Dialog = "assign" | "reassign" | "inprogress" | "approval" | "resolve" | "reject" | "approve" | "close" | "cancel" | null;

export default function RequestDetailPage() {
  return (
    <RouteGuard requirePermission="service_requests.view">
      <RequestDetailInner />
    </RouteGuard>
  );
}

function RequestDetailInner() {
  const params = useParams<{ id: string }>();
  const id = readIdParam(params.id) ?? "";
  const request = useRequest(id);
  const types = useTypes();
  const [dialog, setDialog] = useState<Dialog>(null);
  const comment = useCommentStaff(id, { toast: false });

  const notFound = request.isError && request.error instanceof ApiError && request.error.status === 404;
  const type: RequestType | undefined = (types.data ?? []).find((t) => t.id === request.data?.requestTypeId);
  const requiresApproval = type?.requiresApproval ?? false;
  const actions = request.data ? staffActions(request.data.status, requiresApproval) : [];

  return (
    <div className="space-y-6">
      <SectionNav items={SERVICE_REQUESTS_STAFF_NAV} />
      {!request.allowed ? (
        <NoAccess what="this request" />
      ) : request.isLoading ? (
        <TableSkeleton />
      ) : notFound ? (
        <EmptyState icon={ClipboardList} label="Request not found." />
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
                {type ? <span className="text-sm text-gray-500">{type.name}</span> : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {actions.includes("ASSIGN") ? (
                <Can permission="service_requests.assign.manage">
                  <Button size="sm" variant="outline" onClick={() => setDialog("assign")}>
                    Assign
                  </Button>
                </Can>
              ) : null}
              {actions.includes("REASSIGN") ? (
                <Can permission="service_requests.assign.manage">
                  <Button size="sm" variant="outline" onClick={() => setDialog("reassign")}>
                    Reassign
                  </Button>
                </Can>
              ) : null}
              {actions.includes("IN_PROGRESS") ? (
                <Can permission="service_requests.requests.handle">
                  <Button size="sm" variant="outline" onClick={() => setDialog("inprogress")}>
                    Mark in progress
                  </Button>
                </Can>
              ) : null}
              {actions.includes("SEND_FOR_APPROVAL") ? (
                <Can permission="service_requests.requests.handle">
                  <Button size="sm" variant="outline" onClick={() => setDialog("approval")}>
                    Send for approval
                  </Button>
                </Can>
              ) : null}
              {actions.includes("RESOLVE") ? (
                <Can permission="service_requests.requests.handle">
                  <Button size="sm" variant="outline" onClick={() => setDialog("resolve")}>
                    Resolve
                  </Button>
                </Can>
              ) : null}
              {actions.includes("APPROVE") ? (
                <Can permission="service_requests.requests.approve">
                  <Button size="sm" variant="outline" onClick={() => setDialog("approve")}>
                    Approve
                  </Button>
                </Can>
              ) : null}
              {actions.includes("REJECT") ? (
                <Can permission="service_requests.requests.approve">
                  <Button size="sm" variant="destructive" onClick={() => setDialog("reject")}>
                    Reject
                  </Button>
                </Can>
              ) : null}
              {actions.includes("CLOSE") ? (
                <Can permission="service_requests.requests.handle">
                  <Button size="sm" variant="outline" onClick={() => setDialog("close")}>
                    Close
                  </Button>
                </Can>
              ) : null}
              {actions.includes("CANCEL") ? (
                <Can permission="service_requests.requests.handle">
                  <Button size="sm" variant="destructive" onClick={() => setDialog("cancel")}>
                    Cancel request
                  </Button>
                </Can>
              ) : null}
            </div>
          </div>

          <Card>
            <CardContent className="grid gap-3 p-4 sm:grid-cols-2">
              <Detail label="Status" value={requestStatusLabel[request.data.status] ?? request.data.status} />
              <Detail label="SLA" value={type ? slaLabel(type) : "-"} />
              <Detail label="Requester" value="-" />
              <Detail label="Assignee" value={request.data.assigneeUserId ? "Assigned" : "-"} />
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
              <h2 className="text-lg font-semibold text-gray-900">Field values</h2>
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
                <p className="text-sm font-medium text-gray-900">Feedback: {request.data.feedback.rating}/5</p>
                {request.data.feedback.comment ? (
                  <p className="text-sm text-gray-700">{request.data.feedback.comment}</p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {request.data.status !== "CLOSED" ? (
            <Can permission="service_requests.requests.handle">
              <CommentForm mutation={comment} />
            </Can>
          ) : null}

          {/* Dialogs */}
          {dialog === "assign" || dialog === "reassign" ? (
            <Can permission="service_requests.assign.manage">
              <AssignDialog open onOpenChange={() => setDialog(null)} requestId={id} reassign={dialog === "reassign"} />
            </Can>
          ) : null}
          {dialog === "inprogress" ? (
            <Can permission="service_requests.requests.handle">
              <StatusDialog open onOpenChange={() => setDialog(null)} requestId={id} target="IN_PROGRESS" />
            </Can>
          ) : null}
          {dialog === "approval" ? (
            <Can permission="service_requests.requests.handle">
              <StatusDialog open onOpenChange={() => setDialog(null)} requestId={id} target="PENDING_APPROVAL" />
            </Can>
          ) : null}
          {dialog === "resolve" ? (
            <Can permission="service_requests.requests.handle">
              <ResolveDialog open onOpenChange={() => setDialog(null)} requestId={id} />
            </Can>
          ) : null}
          {dialog === "reject" ? (
            <Can permission="service_requests.requests.approve">
              <RejectDialog open onOpenChange={() => setDialog(null)} requestId={id} />
            </Can>
          ) : null}
          {dialog === "approve" ? (
            <Can permission="service_requests.requests.approve">
              <ApproveConfirm requestId={id} onClose={() => setDialog(null)} />
            </Can>
          ) : null}
          {dialog === "close" ? (
            <Can permission="service_requests.requests.handle">
              <CloseConfirm requestId={id} onClose={() => setDialog(null)} />
            </Can>
          ) : null}
          {dialog === "cancel" ? (
            <Can permission="service_requests.requests.handle">
              <CancelConfirm requestId={id} onClose={() => setDialog(null)} />
            </Can>
          ) : null}
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

function ApproveConfirm({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const approve = useApprove(requestId, { toast: false });
  async function onConfirm() {
    setError(null);
    try {
      await approve.mutateAsync();
      toast.success("Request approved");
      onClose();
    } catch (err) {
      setError(describeApiError(err));
    }
  }
  return (
    <ConfirmDialog
      open
      title="Approve request"
      description="Approving resolves the request. This cannot be undone."
      confirmLabel="Approve"
      pending={approve.isPending}
      onConfirm={() => void onConfirm()}
      onOpenChange={(o) => !o && onClose()}
    >
      {error ? <InlineError message={error} /> : null}
    </ConfirmDialog>
  );
}

function CloseConfirm({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const close = useCloseStaff(requestId, { toast: false });
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

function CancelConfirm({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const cancel = useCancelStaff(requestId, { toast: false });
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
