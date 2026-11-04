"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ClipboardCheck } from "lucide-react";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
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
import { AddDocumentDialog } from "@/components/admissions/AddDocumentDialog";
import { DynamicFormFields, ReadOnlyValue } from "@/components/admissions/DynamicFormFields";
import { ProgressTimeline } from "@/components/admissions/ProgressTimeline";
import { ReasonDialog } from "@/components/library/ReasonDialog";
import { ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";
import { ApplicationStatusBadge } from "@/features/admissions/ApplicationStatusBadge";
import {
  useAcceptOffer,
  useApplication,
  useDeclineOffer,
  useOpenCampaign,
  useSaveDraft,
  useSubmitApplication,
  useWithdrawApplication,
} from "@/features/admissions/hooks";
import {
  buildApplyFormSchema,
  buildApplyValues,
  toFormData,
} from "@/features/admissions/formSchemas";
import { canActOnOffer } from "@/features/admissions/labels";
import { isTerminal } from "@/features/admissions/transitions";
import type { Application, ApplicationOffer, OpenCampaign } from "@/features/admissions/types";

export default function MyApplicationPage() {
  return (
    <RouteGuard requirePermission="admissions.view_own">
      <MyApplicationInner />
    </RouteGuard>
  );
}

function humanize(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function MyApplicationInner() {
  const params = useParams<{ id: string }>();
  const app = useApplication(params.id, { staff: false });
  const campaign = useOpenCampaign(app.data?.campaignId);

  if (app.isLoading) return <Skeleton className="h-64 w-full" />;
  if (app.isError || !app.data) {
    return app.error instanceof ApiError && app.error.status === 404 ? (
      <EmptyState icon={ClipboardCheck} label="Not found" description="This application does not exist." />
    ) : (
      <InlineError message={describeApiError(app.error)} />
    );
  }
  return <MyApplicationBody application={app.data} campaign={campaign.data} />;
}

function MyApplicationBody({ application, campaign }: { application: Application; campaign: OpenCampaign | undefined }) {
  const submit = useSubmitApplication(application.id);
  const withdraw = useWithdrawApplication(application.id);
  const [docOpen, setDocOpen] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const terminal = isTerminal(application.status);
  const draft = application.status === "DRAFT";
  const requiredDocTypes = campaign?.config.requiredDocTypes ?? [];
  const haveTypes = new Set((application.documents ?? []).map((d) => d.docType));
  const missingDocs = requiredDocTypes.filter((t) => !haveTypes.has(t));

  function offerProgramName(offer: ApplicationOffer): string {
    const fromCampaign = campaign?.programs.find((p) => p.id === offer.offeredProgramId);
    if (fromCampaign) return fromCampaign.name;
    if (application.program && offer.offeredProgramId === application.programId) return application.program.name;
    return "Offered program";
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-gray-900">{application.campaign?.name ?? "Application"}</h1>
          <ApplicationStatusBadge status={application.status} />
        </div>
        <p className="text-sm text-gray-500">
          {application.program?.name ?? "Program"} · {application.applicationNumber}
        </p>
        <Link href="/admissions/my" className="text-sm text-primary-700 underline">
          Back to my application
        </Link>
      </div>

      {application.status === "ENROLLED" ? (
        <div role="status" className="bg-success-50 border border-success-500 text-success-700 px-4 py-3 rounded-lg text-sm">
          You have been enrolled. Your admission is complete.
        </div>
      ) : null}

      <ProgressTimeline application={application} />

      {(application.offers ?? []).map((o) =>
        canActOnOffer(application, o) ? (
          <OfferCard key={o.id} applicationId={application.id} offer={o} programName={offerProgramName(o)} />
        ) : null,
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-gray-900">Details</h2>
        {draft ? (
          <DraftEditor
            key={JSON.stringify(application.formData)}
            application={application}
            requiredFields={campaign?.config.requiredFields}
            campaignKnown={Boolean(campaign)}
          />
        ) : (
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            {Object.entries(application.formData ?? {}).map(([k, v]) => (
              <div key={k}>
                <dt className="text-gray-500">{humanize(k)}</dt>
                <dd className="text-gray-900 break-words">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Documents</h2>
          {!terminal ? (
            <Can permission="admissions.view_own">
              <Button variant="outline" size="sm" onClick={() => setDocOpen(true)}>
                Add document link / reference
              </Button>
            </Can>
          ) : null}
        </div>
        {requiredDocTypes.length > 0 ? (
          <ul className="text-sm space-y-1">
            {requiredDocTypes.map((t) => (
              <li key={t} className="text-gray-700">
                {haveTypes.has(t) ? "Added" : "Missing"}: {t}
              </li>
            ))}
          </ul>
        ) : null}
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {(application.documents ?? []).map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>{d.docType}</TableCell>
                    <TableCell className="max-w-xs break-all">{d.reference}</TableCell>
                    <TableCell>{d.fileName ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{d.verified ? "Verified" : "Not verified"}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {!terminal ? (
        <section className="flex flex-wrap gap-2 items-start">
          {draft ? (
            <Can permission="admissions.view_own">
              <div className="space-y-2">
                {missingDocs.length > 0 ? (
                  <p className="text-xs text-gray-500">Missing documents: {missingDocs.join(", ")}</p>
                ) : null}
                <Button onClick={() => setConfirmSubmit(true)} disabled={submit.isPending}>
                  Submit application
                </Button>
                {submitError ? <InlineError message={submitError} /> : null}
              </div>
            </Can>
          ) : null}
          <Can permission="admissions.view_own">
            <Button variant="outline" onClick={() => setWithdrawOpen(true)}>
              Withdraw application
            </Button>
          </Can>
        </section>
      ) : null}

      <Can permission="admissions.view_own">
        {docOpen ? (
          <AddDocumentDialog
            open
            onOpenChange={setDocOpen}
            applicationId={application.id}
            requiredDocTypes={requiredDocTypes}
          />
        ) : null}
        <ReasonDialog
          open={confirmSubmit}
          onOpenChange={setConfirmSubmit}
          title="Submit application"
          description="After submitting you can no longer edit your details."
          confirmLabel="Submit application"
          hideField
          pending={submit.isPending}
          onConfirm={async () => {
            setSubmitError(null);
            try {
              await submit.mutateAsync();
              toast.success("Application submitted.");
            } catch (err) {
              // Shown inline above the button (422 missing field/document, 409, ...).
              setSubmitError(describeApiError(err));
              setConfirmSubmit(false);
            }
          }}
        />
        <ReasonDialog
          open={withdrawOpen}
          onOpenChange={setWithdrawOpen}
          title="Withdraw application"
          description="Withdrawing is final."
          confirmLabel="Withdraw application"
          fieldLabel="Reason (optional)"
          destructive
          pending={withdraw.isPending}
          onConfirm={async (reason) => {
            await withdraw.mutateAsync({ reason: reason || undefined });
            toast.success("Application withdrawn.");
          }}
        />
      </Can>
    </div>
  );
}

function OfferCard({ applicationId, offer, programName }: { applicationId: string; offer: ApplicationOffer; programName: string }) {
  const accept = useAcceptOffer(applicationId);
  const decline = useDeclineOffer(applicationId);
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  return (
    <section className="rounded-lg border border-primary-500 bg-primary-50 px-4 py-3 space-y-2">
      <h2 className="font-semibold text-primary-800">You have an offer: {programName}</h2>
      {offer.expiresAt ? <p className="text-sm text-gray-700">Expires {new Date(offer.expiresAt).toLocaleString()}</p> : null}
      <Can permission="admissions.view_own">
        <div className="flex gap-2">
          <Button onClick={() => setAcceptOpen(true)}>Accept offer</Button>
          <Button variant="outline" onClick={() => setDeclineOpen(true)}>
            Decline offer
          </Button>
        </div>
        <ReasonDialog
          open={acceptOpen}
          onOpenChange={setAcceptOpen}
          title="Accept offer"
          description="Accepting does not enroll you yet; the admissions office completes enrollment."
          confirmLabel="Accept offer"
          hideField
          pending={accept.isPending}
          onConfirm={async () => {
            await accept.mutateAsync(offer.id);
            toast.success("Offer accepted.");
          }}
        />
        <ReasonDialog
          open={declineOpen}
          onOpenChange={setDeclineOpen}
          title="Decline offer"
          description="Your application returns to eligible."
          confirmLabel="Decline offer"
          fieldLabel="Reason (optional)"
          destructive
          pending={decline.isPending}
          onConfirm={async (reason) => {
            await decline.mutateAsync({ offerId: offer.id, reason: reason || undefined });
            toast.success("Offer declined.");
          }}
        />
      </Can>
    </section>
  );
}

/**
 * Edits a DRAFT. Editable keys = campaign requiredFields UNION existing
 * string-valued formData keys, bound by index (R1). Non-string existing values
 * are shown read-only and preserved on save because the PATCH replaces formData.
 */
function DraftEditor({
  application,
  requiredFields,
  campaignKnown,
}: {
  application: Application;
  requiredFields: string[] | undefined;
  campaignKnown: boolean;
}) {
  const save = useSaveDraft(application.id);
  const original = application.formData ?? {};
  const existingKeys = Object.keys(original);
  const union = Array.from(new Set([...(requiredFields ?? []), ...existingKeys]));
  const editableKeys = union.filter((k) => !(k in original) || typeof original[k] === "string");
  const readOnlyKeys = union.filter((k) => k in original && typeof original[k] !== "string");
  const schema = buildApplyFormSchema(editableKeys);
  const form = useForm<{ values: string[] }>({
    resolver: zodResolver(schema),
    defaultValues: { values: buildApplyValues(editableKeys, original) },
  });
  const [error, setError] = useState<string | null>(null);

  const onSubmit = form.handleSubmit((data) => {
    setError(null);
    let body: Record<string, unknown>;
    try {
      body = toFormData(editableKeys, data.values, original);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid form.");
      return;
    }
    save.mutate(body, { onSuccess: () => toast.success("Draft saved.") });
  });

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="space-y-3">
        {!campaignKnown ? (
          <p className="text-xs text-gray-500">
            This campaign is no longer open, so only the details you already entered can be edited.
          </p>
        ) : null}
        <DynamicFormFields keys={editableKeys} control={form.control} />
        {readOnlyKeys.map((k) => (
          <div key={k}>
            <p className="text-sm font-medium">{humanize(k)}</p>
            <ReadOnlyValue value={original[k]} />
          </div>
        ))}
        {error ? <InlineError message={error} /> : null}
        <Can permission="admissions.view_own">
          <Button type="submit" variant="outline" disabled={save.isPending || editableKeys.length === 0}>
            {save.isPending ? "Saving…" : "Save draft"}
          </Button>
        </Can>
      </form>
    </Form>
  );
}
