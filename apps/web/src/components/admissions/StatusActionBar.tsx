"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { EnrollDialog } from "@/components/admissions/EnrollDialog";
import { InterviewDialog } from "@/components/admissions/InterviewDialog";
import { IssueOfferDialog } from "@/components/admissions/IssueOfferDialog";
import { ReasonStatusDialog } from "@/components/admissions/ReasonStatusDialog";
import { useChangeApplicationStatus } from "@/features/admissions/hooks";
import { offeredPrograms, statusActionLabel } from "@/features/admissions/labels";
import { isTerminal, staffActionsFor } from "@/features/admissions/transitions";
import type { Application, ApplicationStatus, Campaign } from "@/features/admissions/types";

/**
 * Staff actions for one application. Each status button is named for the
 * status it sets; nothing here "approves" or "finalizes" anything.
 */
export function StatusActionBar({ application, campaign }: { application: Application; campaign: Campaign | undefined }) {
  const change = useChangeApplicationStatus(application.id);
  const [pendingStatus, setPendingStatus] = useState<ApplicationStatus | null>(null);
  const [interviewOpen, setInterviewOpen] = useState(false);
  const [offerOpen, setOfferOpen] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);

  const actions = staffActionsFor(application.status);
  const terminal = isTerminal(application.status);
  const canOffer = application.status === "ELIGIBLE" || application.status === "SHORTLISTED";

  return (
    <div className="flex flex-wrap gap-2">
      <Can permission="admissions.applications.manage">
        {actions.map((s) => (
          <Button
            key={s}
            variant={s === "REJECTED" ? "destructive" : "outline"}
            size="sm"
            onClick={() => setPendingStatus(s)}
          >
            {statusActionLabel[s]}
          </Button>
        ))}
        {!terminal ? (
          <Button variant="outline" size="sm" onClick={() => setInterviewOpen(true)}>
            Set interview
          </Button>
        ) : null}
      </Can>

      {canOffer ? (
        <Can permission="admissions.offers.manage">
          <Button size="sm" onClick={() => setOfferOpen(true)}>
            Issue offer
          </Button>
        </Can>
      ) : null}

      {application.status === "ACCEPTED" ? (
        <Can permission="admissions.enroll">
          <Button size="sm" onClick={() => setEnrollOpen(true)}>
            Enroll applicant
          </Button>
        </Can>
      ) : null}

      <Can permission="admissions.applications.manage">
        {pendingStatus ? (
          <ReasonStatusDialog
            open
            onOpenChange={(v) => {
              if (!v) setPendingStatus(null);
            }}
            title={statusActionLabel[pendingStatus]}
            target={pendingStatus}
            currentStatus={application.status}
            destructive={pendingStatus === "REJECTED"}
            pending={change.isPending}
            onConfirm={async (reason) => {
              await change.mutateAsync({ status: pendingStatus, reason: reason || undefined });
              toast.success(`Application set to ${statusActionLabel[pendingStatus].toLowerCase()}.`);
            }}
          />
        ) : null}
        {interviewOpen ? (
          <InterviewDialog
            open
            onOpenChange={setInterviewOpen}
            applicationId={application.id}
            currentInterviewAt={application.interviewAt}
          />
        ) : null}
      </Can>

      <Can permission="admissions.offers.manage">
        {offerOpen ? (
          <IssueOfferDialog
            open
            onOpenChange={setOfferOpen}
            applicationId={application.id}
            programs={campaign ? offeredPrograms(campaign) : []}
          />
        ) : null}
      </Can>

      <Can permission="admissions.enroll">
        {enrollOpen ? (
          <EnrollDialog
            open
            onOpenChange={setEnrollOpen}
            applicationId={application.id}
            needsSession={!campaign?.intakeSession && !campaign?.intakeSessionId}
          />
        ) : null}
      </Can>
    </div>
  );
}
