"use client";

import { useState } from "react";
import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
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
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { SectionNav, ADMISSIONS_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { describeApiError } from "@/lib/apiErrors";
import { ApplicationStatusBadge } from "@/features/admissions/ApplicationStatusBadge";
import { useApplications, useCampaignOptions } from "@/features/admissions/hooks";
import type { ApplicationStatus } from "@/features/admissions/types";

const STATUSES: ApplicationStatus[] = [
  "DRAFT", "SUBMITTED", "UNDER_REVIEW", "DOCUMENTS_REQUIRED", "ELIGIBLE",
  "SHORTLISTED", "OFFERED", "ACCEPTED", "ENROLLED", "REJECTED", "WITHDRAWN",
];

export default function AdmissionsQueuePage() {
  return (
    <RouteGuard requirePermission="admissions.applications.view">
      <AdmissionsQueueInner />
    </RouteGuard>
  );
}

function AdmissionsQueueInner() {
  const [campaignId, setCampaignId] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const campaigns = useCampaignOptions();
  const applications = useApplications({ campaignId: campaignId || undefined, status: status || undefined, page });

  return (
    <div className="space-y-6">
      <SectionNav items={ADMISSIONS_STAFF_NAV} />
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Applications</h1>
        <p className="text-sm text-gray-500">Filter by campaign and status.</p>
      </div>

      <div className="flex gap-3 flex-wrap">
        <div className="max-w-xs">
          <SimpleSelect
            ariaLabel="Campaign"
            value={campaignId}
            onChange={(v) => {
              setCampaignId(v);
              setPage(1);
            }}
            noneLabel="All campaigns"
            options={(campaigns.data?.campaigns ?? []).map((c) => ({ value: c.id, label: c.name }))}
          />
        </div>
        <div className="max-w-xs">
          <SimpleSelect
            ariaLabel="Status"
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            noneLabel="All statuses"
            options={STATUSES.map((s) => ({ value: s, label: s }))}
          />
        </div>
      </div>

      {applications.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : applications.isError ? (
        <InlineError message={describeApiError(applications.error)} />
      ) : !applications.data || applications.data.applications.length === 0 ? (
        <EmptyState icon={ClipboardCheck} label="No applications match these filters." />
      ) : (
        <>
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Application no</TableHead>
                  <TableHead>Applicant</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Program</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {applications.data.applications.map((a) => {
                  const n = a.formData?.name;
                  const fn = a.formData?.fullName;
                  const name = typeof n === "string" && n ? n : typeof fn === "string" && fn ? fn : "Not provided";
                  return (
                    <TableRow key={a.id}>
                      <TableCell className="font-medium">
                        <Link href={`/admissions/applications/${a.id}`}>{a.applicationNumber}</Link>
                      </TableCell>
                      <TableCell>{name}</TableCell>
                      <TableCell>{a.campaign?.name ?? "—"}</TableCell>
                      <TableCell>{a.program?.name ?? "—"}</TableCell>
                      <TableCell>
                        <ApplicationStatusBadge status={a.status} />
                      </TableCell>
                      <TableCell>{a.submittedAt ? new Date(a.submittedAt).toLocaleDateString() : "—"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <Pagination
            page={applications.data.page}
            pageSize={applications.data.pageSize}
            total={applications.data.total}
            onPage={setPage}
          />
        </>
      )}
    </div>
  );
}
