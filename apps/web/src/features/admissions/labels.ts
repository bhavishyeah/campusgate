import type { Application, ApplicationOffer, ApplicationStatus, Campaign, ProgramRef, ReviewDecision } from "./types";

export const applicationStatusLabel: Record<ApplicationStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  DOCUMENTS_REQUIRED: "Documents required",
  ELIGIBLE: "Eligible",
  SHORTLISTED: "Shortlisted",
  OFFERED: "Offer issued",
  ACCEPTED: "Offer accepted",
  ENROLLED: "Enrolled",
  REJECTED: "Rejected",
  WITHDRAWN: "Withdrawn",
};

export const statusActionLabel: Record<ApplicationStatus, string> = {
  DRAFT: "Reset to draft",
  SUBMITTED: "Mark submitted",
  UNDER_REVIEW: "Mark under review",
  DOCUMENTS_REQUIRED: "Request documents",
  ELIGIBLE: "Mark eligible",
  SHORTLISTED: "Shortlist",
  OFFERED: "Issue offer",
  ACCEPTED: "Accept offer",
  ENROLLED: "Enroll applicant",
  REJECTED: "Reject",
  WITHDRAWN: "Withdraw",
};

export const reviewDecisionLabel: Record<ReviewDecision, string> = {
  RECOMMEND_ELIGIBLE: "Recommend eligible",
  RECOMMEND_REJECT: "Recommend reject",
  REQUEST_DOCUMENTS: "Request documents",
  SHORTLIST: "Shortlist recommendation",
  NOTE: "Note",
};

function dedupeById(programs: (ProgramRef | null | undefined)[]): ProgramRef[] {
  const seen = new Map<string, ProgramRef>();
  for (const p of programs) {
    if (p && !seen.has(p.id)) seen.set(p.id, p);
  }
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Target program UNION join-row programs, deduped by id, sorted by name. */
export function offeredPrograms(campaign: Pick<Campaign, "targetProgram" | "programs">): ProgramRef[] {
  return dedupeById([campaign.targetProgram, ...campaign.programs.map((p) => p.program)]);
}

/** Offer actions (expire/accept/decline) require BOTH sides to still be live. */
export function canActOnOffer(application: Pick<Application, "status">, offer: Pick<ApplicationOffer, "status">): boolean {
  return application.status === "OFFERED" && offer.status === "ISSUED";
}
