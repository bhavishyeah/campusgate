"use client";

import { useState } from "react";
import { Megaphone, Plus } from "lucide-react";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Pagination } from "@/components/ui-ext/Pagination";
import { SectionNav, ADMISSIONS_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { CampaignFormDialog } from "@/components/admissions/CampaignFormDialog";
import { ReasonDialog } from "@/components/library/ReasonDialog";
import { describeApiError } from "@/lib/apiErrors";
import { useCampaigns, useSetCampaignStatus } from "@/features/admissions/hooks";
import { offeredPrograms } from "@/features/admissions/labels";
import type { Campaign } from "@/features/admissions/types";

const STATUS_LABEL = { DRAFT: "Draft", OPEN: "Open", CLOSED: "Closed" } as const;

export default function CampaignsPage() {
  return (
    <RouteGuard requirePermission="admissions.applications.view">
      <CampaignsInner />
    </RouteGuard>
  );
}

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "-";
}

function CampaignsInner() {
  const [page, setPage] = useState(1);
  const campaigns = useCampaigns(page);
  const setStatus = useSetCampaignStatus();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [closing, setClosing] = useState<Campaign | null>(null);

  return (
    <div className="space-y-6">
      <SectionNav items={ADMISSIONS_STAFF_NAV} />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Campaigns</h1>
          <p className="text-sm text-gray-500">Admission campaigns and their application windows.</p>
        </div>
        <Can permission="admissions.campaigns.manage">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> New campaign
          </Button>
        </Can>
      </div>

      {campaigns.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : campaigns.isError ? (
        <InlineError message={describeApiError(campaigns.error)} />
      ) : !campaigns.data || campaigns.data.campaigns.length === 0 ? (
        <EmptyState icon={Megaphone} label="No campaigns yet" description="Create a campaign to start taking applications." />
      ) : (
        <>
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Intake session</TableHead>
                  <TableHead>Programs</TableHead>
                  <TableHead>Window</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.data.campaigns.map((c) => {
                  const names = offeredPrograms({ targetProgram: c.targetProgram, programs: c.programs }).map((p) => p.name);
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{STATUS_LABEL[c.status]}</Badge>
                      </TableCell>
                      <TableCell>{c.intakeSession?.name ?? "-"}</TableCell>
                      <TableCell>{names.length > 0 ? names.join(", ") : "-"}</TableCell>
                      <TableCell className="text-xs">
                        {fmt(c.openAt)} to {fmt(c.closeAt)}
                      </TableCell>
                      <TableCell>{new Date(c.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell className="text-right">
                        <Can permission="admissions.campaigns.manage">
                          <div className="flex gap-2 justify-end">
                            <Button variant="ghost" size="sm" onClick={() => setEditing(c)}>
                              Edit
                            </Button>
                            {c.status === "DRAFT" ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={setStatus.isPending}
                                onClick={() =>
                                  setStatus.mutate(
                                    { id: c.id, status: "OPEN" },
                                    { onSuccess: () => toast.success("Applications are now open.") },
                                  )
                                }
                              >
                                Open applications
                              </Button>
                            ) : null}
                            {c.status === "OPEN" ? (
                              <Button variant="ghost" size="sm" onClick={() => setClosing(c)}>
                                Close applications
                              </Button>
                            ) : null}
                          </div>
                        </Can>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <Pagination
            page={campaigns.data.page}
            pageSize={campaigns.data.pageSize}
            total={campaigns.data.total}
            onPage={setPage}
          />
        </>
      )}

      <Can permission="admissions.campaigns.manage">
        {createOpen ? <CampaignFormDialog open onOpenChange={setCreateOpen} /> : null}
        {editing ? (
          <CampaignFormDialog
            open
            campaign={editing}
            onOpenChange={(v) => {
              if (!v) setEditing(null);
            }}
          />
        ) : null}
        {closing ? (
          <ReasonDialog
            open
            onOpenChange={(v) => {
              if (!v) setClosing(null);
            }}
            title="Close applications"
            description="Applicants will no longer be able to apply."
            confirmLabel="Close applications"
            destructive
            hideField
            pending={setStatus.isPending}
            onConfirm={async () => {
              await setStatus.mutateAsync({ id: closing.id, status: "CLOSED" });
              toast.success("Applications are now closed.");
            }}
          />
        ) : null}
      </Can>
    </div>
  );
}
