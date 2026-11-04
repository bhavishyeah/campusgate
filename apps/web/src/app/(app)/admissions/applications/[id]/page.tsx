"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { ClipboardCheck } from "lucide-react";
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
import { SectionNav, ADMISSIONS_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { RecordReviewDialog } from "@/components/admissions/RecordReviewDialog";
import { StatusActionBar } from "@/components/admissions/StatusActionBar";
import { ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";
import { ApplicationStatusBadge } from "@/features/admissions/ApplicationStatusBadge";
import {
  useApplication,
  useCampaign,
  useExpireOffer,
  useVerifyDocument,
} from "@/features/admissions/hooks";
import { canActOnOffer, offeredPrograms, reviewDecisionLabel } from "@/features/admissions/labels";
import { isTerminal } from "@/features/admissions/transitions";
import type { Application, ApplicationOffer, Campaign } from "@/features/admissions/types";

export default function StaffApplicationPage() {
  return (
    <RouteGuard requirePermission="admissions.applications.view">
      <StaffApplicationInner />
    </RouteGuard>
  );
}

function humanize(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "—";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function StaffApplicationInner() {
  const params = useParams<{ id: string }>();
  const app = useApplication(params.id, { staff: true });
  const campaign = useCampaign(app.data?.campaignId);

  if (app.isLoading) {
    return (
      <div className="space-y-6">
        <SectionNav items={ADMISSIONS_STAFF_NAV} />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (app.isError) {
    return (
      <div className="space-y-6">
        <SectionNav items={ADMISSIONS_STAFF_NAV} />
        {app.error instanceof ApiError && app.error.status === 404 ? (
          <EmptyState icon={ClipboardCheck} label="Not found" description="This application does not exist." />
        ) : (
          <InlineError message={describeApiError(app.error)} />
        )}
      </div>
    );
  }
  if (!app.data) return null;
  return <StaffApplicationBody application={app.data} campaign={campaign.data} />;
}

function offerProgramName(application: Application, offer: ApplicationOffer, campaign: Campaign | undefined): string {
  const fromCampaign = campaign ? offeredPrograms(campaign).find((p) => p.id === offer.offeredProgramId) : undefined;
  if (fromCampaign) return fromCampaign.name;
  if (application.program && offer.offeredProgramId === application.programId) return application.program.name;
  return "Offered program";
}

function StaffApplicationBody({ application, campaign }: { application: Application; campaign: Campaign | undefined }) {
  const verify = useVerifyDocument(application.id);
  const expire = useExpireOffer(application.id);
  const [reviewOpen, setReviewOpen] = useState(false);
  const terminal = isTerminal(application.status);
  const formEntries = Object.entries(application.formData ?? {});
  const reviews = [...(application.reviews ?? [])].sort(
    (a, b) => new Date(b.reviewedAt).getTime() - new Date(a.reviewedAt).getTime(),
  );
  const enrolled = application.status === "ENROLLED";

  return (
    <div className="space-y-6">
      <SectionNav items={ADMISSIONS_STAFF_NAV} />

      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-gray-900">{application.applicationNumber}</h1>
          <ApplicationStatusBadge status={application.status} />
        </div>
        <p className="text-sm text-gray-500">
          {application.campaign?.name ?? "Campaign"} · {application.program?.name ?? "Program"}
        </p>
        <p className="text-sm text-gray-500">
          Created {new Date(application.createdAt).toLocaleDateString()}
          {application.submittedAt ? ` · Submitted ${new Date(application.submittedAt).toLocaleDateString()}` : ""}
          {application.interviewAt ? ` · Interview ${new Date(application.interviewAt).toLocaleString()}` : ""}
        </p>
      </div>

      <StatusActionBar application={application} campaign={campaign} />

      {enrolled ? (
        <div role="status" className="bg-success-50 border border-success-500 text-success-700 px-4 py-3 rounded-lg text-sm">
          This applicant is enrolled.
          <Can permission="students.view">
            {" "}
            <span className="text-xs">Open the student list to find the record.</span>{" "}
            <Link href="/sis/students" className="underline">
              Students
            </Link>
          </Can>
        </div>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-gray-900">Form data</h2>
        {formEntries.length === 0 ? (
          <p className="text-sm text-gray-500">No form data</p>
        ) : (
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            {formEntries.map(([k, v]) => (
              <div key={k}>
                <dt className="text-gray-500">{humanize(k)}</dt>
                <dd className="text-gray-900 break-words">{formatValue(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-gray-900">Documents</h2>
        {(application.documents ?? []).length === 0 ? (
          <p className="text-sm text-gray-500">No documents added.</p>
        ) : (
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>File name</TableHead>
                  <TableHead>Verified</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(application.documents ?? []).map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>{d.docType}</TableCell>
                    <TableCell className="max-w-xs break-all">
                      {/^https?:\/\//i.test(d.reference) ? (
                        <a href={d.reference} target="_blank" rel="noopener noreferrer" className="text-primary-700 underline">
                          {d.reference}
                        </a>
                      ) : (
                        d.reference
                      )}
                    </TableCell>
                    <TableCell>{d.fileName ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{d.verified ? "Verified" : "Not verified"}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {!d.verified ? (
                        <Can permission="admissions.applications.manage">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={verify.isPending}
                            onClick={() => verify.mutate(d.id, { onSuccess: () => toast.success("Document marked verified.") })}
                          >
                            Mark verified
                          </Button>
                        </Can>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-gray-900">Offers</h2>
        {(application.offers ?? []).length === 0 ? (
          <p className="text-sm text-gray-500">No offers issued.</p>
        ) : (
          <ul className="space-y-2">
            {(application.offers ?? []).map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-3 rounded-md border border-gray-200 px-3 py-2 text-sm">
                <div>
                  <div className="font-medium">{offerProgramName(application, o, campaign)}</div>
                  <div className="text-xs text-gray-500">
                    Offered {new Date(o.offeredAt).toLocaleDateString()}
                    {o.expiresAt ? ` · Expires ${new Date(o.expiresAt).toLocaleString()}` : ""}
                    {o.acceptedAt ? ` · Accepted ${new Date(o.acceptedAt).toLocaleDateString()}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{o.status.charAt(0) + o.status.slice(1).toLowerCase()}</Badge>
                  {canActOnOffer(application, o) ? (
                    <Can permission="admissions.offers.manage">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={expire.isPending}
                        onClick={() => expire.mutate(o.id, { onSuccess: () => toast.success("Offer expired.") })}
                      >
                        Expire offer
                      </Button>
                    </Can>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Review history</h2>
          {!terminal ? (
            <Can permission="admissions.applications.review">
              <Button variant="outline" size="sm" onClick={() => setReviewOpen(true)}>
                Record review
              </Button>
            </Can>
          ) : null}
        </div>
        <p className="text-xs text-gray-500">Reviews are notes. They do not change the application&apos;s status.</p>
        {reviews.length === 0 ? (
          <p className="text-sm text-gray-500">No reviews recorded.</p>
        ) : (
          <ul className="space-y-2">
            {reviews.map((r) => (
              <li key={r.id} className="rounded-md border border-gray-200 px-3 py-2 text-sm">
                <div className="font-medium">{reviewDecisionLabel[r.decision] ?? r.decision}</div>
                {r.notes ? <div className="text-gray-700 whitespace-pre-wrap">{r.notes}</div> : null}
                <div className="text-xs text-gray-500">
                  {new Date(r.reviewedAt).toLocaleString()} · reviewer {r.reviewerUserId.slice(0, 8)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Can permission="admissions.applications.review">
        {reviewOpen ? <RecordReviewDialog open onOpenChange={setReviewOpen} applicationId={application.id} /> : null}
      </Can>
    </div>
  );
}
