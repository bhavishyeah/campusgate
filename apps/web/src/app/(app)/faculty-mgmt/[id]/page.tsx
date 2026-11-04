"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Scale, UserX } from "lucide-react";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/ui-ext/ConfirmDialog";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { SectionNav, FACULTY_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { FacultyOverview } from "@/components/faculty/FacultyOverview";
import { QualificationFormDialog } from "@/components/faculty/QualificationFormDialog";
import { QualificationsTable } from "@/components/faculty/QualificationsTable";
import { TeachingHistoryTable } from "@/components/faculty/TeachingHistoryTable";
import { WorkloadEditDialog } from "@/components/faculty/WorkloadEditDialog";
import { WorkloadPanel } from "@/components/faculty/WorkloadPanel";
import { ApiError } from "@/lib/api";
import {
  useDeleteQualification,
  useFacultyLookups,
  useFacultyProfile,
  useReconcileHistory,
  useRecomputeWorkload,
} from "@/features/faculty/hooks";
import { workloadForTerm } from "@/features/faculty/workload";
import type { Qualification, WorkloadResult } from "@/features/faculty/types";

export default function FacultyProfilePage() {
  return (
    <RouteGuard requirePermission="faculty.directory.view">
      <FacultyProfileInner />
    </RouteGuard>
  );
}

function FacultyProfileInner() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const profile = useFacultyProfile(id);
  const lookups = useFacultyLookups();

  const [qualDialog, setQualDialog] = useState<{ open: boolean; editing?: Qualification }>({ open: false });
  const [deleting, setDeleting] = useState<Qualification | null>(null);
  const [termId, setTermId] = useState("");
  const [editWorkload, setEditWorkload] = useState(false);
  const [confirmRecompute, setConfirmRecompute] = useState(false);
  const [confirmReconcile, setConfirmReconcile] = useState(false);
  const [lastResult, setLastResult] = useState<WorkloadResult | null>(null);

  const del = useDeleteQualification(id);
  const recompute = useRecomputeWorkload(id);
  const reconcile = useReconcileHistory(id);

  const terms = lookups.data?.terms ?? [];
  const workloads = profile.data?.workloads ?? [];
  // Default: newest term that has a workload row, else the newest term.
  const defaultTerm = terms.find((t) => workloads.some((w) => w.academicTermId === t.id)) ?? terms[0];
  const selectedTermId = termId || defaultTerm?.id || "";
  const selectedTerm = terms.find((t) => t.id === selectedTermId);
  const row = selectedTermId ? workloadForTerm(workloads, selectedTermId) : undefined;
  const resultForRow = lastResult && lastResult.academicTermId === selectedTermId ? lastResult : null;

  const notFound =
    profile.error instanceof ApiError && profile.error.status === 404 && profile.error.message === "faculty not found";

  let body: React.ReactNode;
  if (!profile.allowed) {
    body = <NoAccess what="faculty profiles" />;
  } else if (profile.isLoading) {
    body = <TableSkeleton />;
  } else if (notFound) {
    body = <EmptyState icon={UserX} label="Faculty member not found." />;
  } else if (profile.isError) {
    body = <ErrorBlock error={profile.error} onRetry={() => void profile.refetch()} />;
  } else if (profile.data) {
    const p = profile.data;
    body = (
      <>
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{p.identity.name}</h1>
          <p className="text-sm text-gray-500">{p.identity.department?.name ?? "No department"}</p>
        </div>
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="qualifications">Qualifications</TabsTrigger>
            <TabsTrigger value="workload">Workload</TabsTrigger>
            <TabsTrigger value="history">Teaching history</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <FacultyOverview profile={p} />
          </TabsContent>

          <TabsContent value="qualifications" className="space-y-3">
            <Can permission="faculty.qualifications.manage">
              <div className="flex justify-end">
                <Button onClick={() => setQualDialog({ open: true })}>Add qualification</Button>
              </div>
            </Can>
            <QualificationsTable
              rows={p.qualifications}
              onEdit={(q) => setQualDialog({ open: true, editing: q })}
              onDelete={(q) => setDeleting(q)}
            />
          </TabsContent>

          <TabsContent value="workload" className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-72">
                <SimpleSelect
                  ariaLabel="Term"
                  value={selectedTermId}
                  onChange={setTermId}
                  placeholder="Select term"
                  options={terms.map((t) => ({
                    value: t.id,
                    label: t.session ? `${t.name} (${t.session.name})` : t.name,
                  }))}
                />
              </div>
              <Can permission="faculty.workload.manage">
                <Button variant="outline" disabled={!selectedTermId} onClick={() => setConfirmRecompute(true)}>
                  Recompute teaching hours
                </Button>
                <Button disabled={!selectedTermId} onClick={() => setEditWorkload(true)}>
                  Edit workload
                </Button>
              </Can>
            </div>
            {!lookups.allowed ? (
              <NoAccess what="academic terms" />
            ) : lookups.isLoading ? (
              <TableSkeleton />
            ) : lookups.isError ? (
              <ErrorBlock error={lookups.error} onRetry={() => void lookups.refetch()} />
            ) : terms.length === 0 ? (
              <EmptyState icon={Scale} label="No academic terms exist yet." />
            ) : row ? (
              <WorkloadPanel row={row} lastResult={resultForRow} />
            ) : (
              <EmptyState icon={Scale} label="No workload recorded for this term." />
            )}
          </TabsContent>

          <TabsContent value="history" className="space-y-3">
            <Can permission="faculty.teaching_history.manage">
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => setConfirmReconcile(true)}>
                  Reconcile from assignments
                </Button>
              </div>
            </Can>
            <TeachingHistoryTable rows={p.teachingHistory} />
          </TabsContent>
        </Tabs>

        <Can permission="faculty.qualifications.manage">
          {qualDialog.open ? (
            <QualificationFormDialog
              key={qualDialog.editing?.id ?? "new"}
              open
              onOpenChange={(o) => setQualDialog({ open: o })}
              facultyId={id}
              qualification={qualDialog.editing}
            />
          ) : null}
          <ConfirmDialog
            open={deleting !== null}
            onOpenChange={(o) => {
              if (!o) setDeleting(null);
            }}
            title="Delete qualification"
            description="Delete this qualification? This cannot be undone."
            confirmLabel="Delete"
            destructive
            pending={del.isPending}
            onConfirm={() => {
              if (!deleting) return;
              del.mutate(deleting.id, {
                onSuccess: () => {
                  toast.success("Qualification deleted.");
                  setDeleting(null);
                },
                onSettled: () => setDeleting(null),
              });
            }}
          />
        </Can>

        <Can permission="faculty.workload.manage">
          {editWorkload && selectedTermId ? (
            <WorkloadEditDialog
              key={`${selectedTermId}-${row?.updatedAt ?? "none"}`}
              open
              onOpenChange={setEditWorkload}
              facultyId={id}
              termId={selectedTermId}
              termName={selectedTerm?.name ?? "Selected term"}
              row={row}
            />
          ) : null}
          <ConfirmDialog
            open={confirmRecompute}
            onOpenChange={setConfirmRecompute}
            title="Recompute teaching hours"
            description="Recomputes teaching hours from active primary assignments and each subject's contact hours per week. Non-teaching hours are kept."
            confirmLabel="Recompute"
            pending={recompute.isPending}
            onConfirm={() =>
              recompute.mutate(selectedTermId, {
                onSuccess: (res) => {
                  setLastResult(res);
                  toast.success("Teaching hours recomputed.");
                },
                onSettled: () => setConfirmRecompute(false),
              })
            }
          />
        </Can>

        <Can permission="faculty.teaching_history.manage">
          <ConfirmDialog
            open={confirmReconcile}
            onOpenChange={setConfirmReconcile}
            title="Reconcile teaching history"
            description="Appends missing history entries from current assignments. Existing entries are never changed or removed."
            confirmLabel="Reconcile"
            pending={reconcile.isPending}
            onConfirm={() =>
              reconcile.mutate(undefined, {
                onSuccess: (res) =>
                  toast.success(res.appended > 0 ? `${res.appended} entry(ies) added` : "Already up to date"),
                onSettled: () => setConfirmReconcile(false),
              })
            }
          />
        </Can>
      </>
    );
  } else {
    body = null;
  }

  return (
    <div className="space-y-6">
      <SectionNav items={FACULTY_STAFF_NAV} />
      <Link href="/faculty-mgmt" className="text-sm text-primary-600 underline">
        Back to directory
      </Link>
      {body}
    </div>
  );
}
