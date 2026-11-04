export type CampaignStatus = "DRAFT" | "OPEN" | "CLOSED";
export type ApplicationStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "UNDER_REVIEW"
  | "DOCUMENTS_REQUIRED"
  | "ELIGIBLE"
  | "SHORTLISTED"
  | "OFFERED"
  | "ACCEPTED"
  | "ENROLLED"
  | "REJECTED"
  | "WITHDRAWN";
export type ReviewDecision =
  | "RECOMMEND_ELIGIBLE"
  | "RECOMMEND_REJECT"
  | "REQUEST_DOCUMENTS"
  | "SHORTLIST"
  | "NOTE";
export type OfferStatus = "ISSUED" | "ACCEPTED" | "DECLINED" | "EXPIRED";

export interface ProgramRef { id: string; name: string; code: string }
export interface SessionRef { id: string; name: string; status?: string }

export interface CampaignConfig {
  requiredFields: string[];
  requiredDocTypes: string[];
}

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  intakeSessionId: string | null;
  targetProgramId: string | null;
  openAt: string | null;
  closeAt: string | null;
  config: CampaignConfig | null;
  createdAt: string;
  programs: { programId: string; program?: ProgramRef }[];
  intakeSession?: SessionRef | null;
  targetProgram?: ProgramRef | null;
}

export interface OpenCampaign {
  id: string;
  name: string;
  openAt: string | null;
  closeAt: string | null;
  programs: ProgramRef[];
  config: CampaignConfig;
}

export interface ApplicationDocument {
  id: string;
  docType: string;
  reference: string;
  fileName: string | null;
  contentType: string | null;
  verified: boolean;
  verifiedAt: string | null;
}

export interface ApplicationOffer {
  id: string;
  offeredProgramId: string;
  status: OfferStatus;
  offeredAt: string;
  expiresAt: string | null;
  acceptedAt: string | null;
}

export interface ApplicationReview {
  id: string;
  reviewerUserId: string;
  decision: ReviewDecision;
  notes: string | null;
  reviewedAt: string;
}

export interface Application {
  id: string;
  applicationNumber: string;
  campaignId: string;
  applicantUserId: string;
  programId: string;
  status: ApplicationStatus;
  formData: Record<string, unknown>;
  submittedAt: string | null;
  interviewAt: string | null;
  rejectedAt: string | null;
  withdrawnAt: string | null;
  createdAt: string;
  campaign?: { id: string; name: string };
  program?: ProgramRef;
  documents?: ApplicationDocument[];
  offers?: ApplicationOffer[];
  reviews?: ApplicationReview[];
}

export interface Paged {
  total: number;
  page: number;
  pageSize: number;
}

export interface AdmissionLookups {
  programs: ProgramRef[];
  sessions: SessionRef[];
}
