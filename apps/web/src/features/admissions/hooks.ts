// features/admissions/hooks.ts
// No "use client": hooks files are plain TS modules (mirrors features/classes/hooks.ts).

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";
import { can } from "@/lib/authz";
import { useAuthStore } from "@/stores/auth";
import { admissionsKeys } from "./keys";
import type {
  AdmissionLookups,
  Application,
  ApplicationStatus,
  Campaign,
  OpenCampaign,
  Paged,
  ReviewDecision,
} from "./types";

export const PAGE_SIZE = 20;

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

function usePerms(): string[] {
  return useAuthStore((s) => s.permissions);
}

type WithAllowed<T> = UseQueryResult<T, ApiError> & { allowed: boolean };
function withAllowed<T>(query: UseQueryResult<T, ApiError>, allowed: boolean): WithAllowed<T> {
  return Object.assign(query, { allowed });
}

function toastError(error: unknown): void {
  toast.error(describeApiError(error));
}

function invalidate(qc: QueryClient, keys: readonly (readonly unknown[])[]) {
  for (const queryKey of keys) qc.invalidateQueries({ queryKey });
}

// ─── Staff queries ──────────────────────────────────────────────────────────

export function useCampaigns(page: number) {
  const allowed = can("admissions.applications.view", usePerms());
  const q = useQuery<Paged & { campaigns: Campaign[] }, ApiError>({
    queryKey: admissionsKeys.campaigns(page),
    queryFn: () => api.get(`/api/admissions/campaigns${qs({ page, pageSize: PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

/** Filter options. Loads the first 100 campaigns only (the API maximum). */
export function useCampaignOptions() {
  const allowed = can("admissions.applications.view", usePerms());
  const q = useQuery<Paged & { campaigns: Campaign[] }, ApiError>({
    queryKey: ["admissions", "campaigns", "options"],
    queryFn: () => api.get(`/api/admissions/campaigns${qs({ page: 1, pageSize: 100 })}`),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useCampaign(id: string | undefined) {
  const allowed = can("admissions.applications.view", usePerms());
  const q = useQuery<Campaign, ApiError>({
    queryKey: admissionsKeys.campaign(id ?? ""),
    queryFn: () => api.get(`/api/admissions/campaigns/${id}`),
    enabled: allowed && Boolean(id),
  });
  return withAllowed(q, allowed);
}

export function useAdmissionLookups(enabledExtra = true) {
  const allowed = can("admissions.campaigns.manage", usePerms());
  const q = useQuery<AdmissionLookups, ApiError>({
    queryKey: admissionsKeys.lookups(),
    queryFn: () => api.get("/api/admissions/lookups"),
    enabled: allowed && enabledExtra,
  });
  return withAllowed(q, allowed);
}

export interface ApplicationFilters { campaignId?: string; status?: string; page: number }

export function useApplications(filters: ApplicationFilters) {
  const allowed = can("admissions.applications.view", usePerms());
  const q = useQuery<Paged & { applications: Application[] }, ApiError>({
    queryKey: admissionsKeys.applications(filters),
    queryFn: () =>
      api.get(
        `/api/admissions/applications${qs({
          campaignId: filters.campaignId,
          status: filters.status,
          page: filters.page,
          pageSize: PAGE_SIZE,
        })}`,
      ),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

/** Staff screens gate on applications.view; the applicant screen on view_own. */
export function useApplication(id: string | undefined, opts: { staff: boolean }) {
  const perms = usePerms();
  const allowed = opts.staff ? can("admissions.applications.view", perms) : can("admissions.view_own", perms);
  const q = useQuery<Application, ApiError>({
    queryKey: admissionsKeys.application(id ?? ""),
    queryFn: () => api.get(`/api/admissions/applications/${id}`),
    enabled: allowed && Boolean(id),
  });
  return withAllowed(q, allowed);
}

// ─── Applicant queries ──────────────────────────────────────────────────────

export function useOpenCampaigns(page: number) {
  const allowed = can("admissions.view_own", usePerms());
  const q = useQuery<Paged & { campaigns: OpenCampaign[] }, ApiError>({
    queryKey: admissionsKeys.openCampaigns(page),
    queryFn: () => api.get(`/api/admissions/campaigns/open${qs({ page, pageSize: PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useOpenCampaign(id: string | undefined) {
  const allowed = can("admissions.view_own", usePerms());
  const q = useQuery<OpenCampaign, ApiError>({
    queryKey: admissionsKeys.openCampaign(id ?? ""),
    queryFn: () => api.get(`/api/admissions/campaigns/open/${id}`),
    enabled: allowed && Boolean(id),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
  return withAllowed(q, allowed);
}

export function useMyApplications() {
  const allowed = can("admissions.view_own", usePerms());
  const q = useQuery<{ applications: Application[] }, ApiError>({
    queryKey: admissionsKeys.mine(),
    queryFn: () => api.get("/api/admissions/applications/mine"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

// ─── Campaign mutations ─────────────────────────────────────────────────────

// Campaign dialogs map 404/409/422 to inline/field errors, so no toast here.
export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation<Campaign, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/admissions/campaigns", body),
    onSuccess: () => invalidate(qc, [admissionsKeys.campaignsAll()]),
  });
}

export function useUpdateCampaign(id: string) {
  const qc = useQueryClient();
  return useMutation<Campaign, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.patch(`/api/admissions/campaigns/${id}`, body),
    onSuccess: () => invalidate(qc, [admissionsKeys.campaignsAll()]),
  });
}

/** Open / close is a plain status flip on the campaign. */
export function useSetCampaignStatus() {
  const qc = useQueryClient();
  return useMutation<Campaign, ApiError, { id: string; status: "OPEN" | "CLOSED" }>({
    mutationFn: ({ id, status }) => api.patch(`/api/admissions/campaigns/${id}`, { status }),
    onSuccess: () => invalidate(qc, [admissionsKeys.campaignsAll()]),
    onError: toastError,
  });
}

// ─── Staff application mutations ────────────────────────────────────────────

const APP_KEYS = (id: string) => [admissionsKeys.application(id), admissionsKeys.applicationsAll()] as const;

export function useChangeApplicationStatus(id: string) {
  const qc = useQueryClient();
  return useMutation<Application, ApiError, { status: ApplicationStatus; reason?: string }>({
    mutationFn: (body) => api.patch(`/api/admissions/applications/${id}/status`, body),
    onSuccess: () => invalidate(qc, APP_KEYS(id)),
    onError: (e) => {
      toastError(e);
      invalidate(qc, APP_KEYS(id));
    },
  });
}

export function useSetInterview(id: string) {
  const qc = useQueryClient();
  return useMutation<Application, ApiError, { interviewAt: string }>({
    mutationFn: (body) => api.post(`/api/admissions/applications/${id}/interview`, body),
    onSuccess: () => invalidate(qc, APP_KEYS(id)),
    onError: toastError,
  });
}

export function useVerifyDocument(id: string) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, string>({
    mutationFn: (docId) => api.post(`/api/admissions/applications/${id}/documents/${docId}/verify`),
    onSuccess: () => invalidate(qc, [admissionsKeys.application(id)]),
    onError: toastError,
  });
}

export function useRecordReview(id: string) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { decision: ReviewDecision; notes?: string }>({
    mutationFn: (body) => api.post(`/api/admissions/applications/${id}/reviews`, body),
    onSuccess: () => invalidate(qc, [admissionsKeys.application(id)]),
    onError: toastError,
  });
}

/** toast:false — IssueOfferDialog renders 409/422 inline. */
export function useIssueOffer(id: string) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { offeredProgramId: string; expiresAt?: string }>({
    mutationFn: (body) => api.post(`/api/admissions/applications/${id}/offers`, body),
    onSuccess: () => invalidate(qc, APP_KEYS(id)),
  });
}

export function useExpireOffer(applicationId: string) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, string>({
    mutationFn: (offerId) => api.post(`/api/admissions/offers/${offerId}/expire`, {}),
    onSuccess: () => invalidate(qc, APP_KEYS(applicationId)),
    onError: (e) => {
      toastError(e);
      invalidate(qc, APP_KEYS(applicationId));
    },
  });
}

export interface EnrollResult {
  enrollment: unknown;
  studentProfileId: string;
  created: boolean;
}

/** toast:false — EnrollDialog renders identity/conflict errors inline. */
export function useEnroll(id: string) {
  const qc = useQueryClient();
  return useMutation<EnrollResult, ApiError, { enrollmentNo: string; academicSessionId?: string }>({
    mutationFn: (body) => api.post(`/api/admissions/applications/${id}/enroll`, body),
    onSuccess: () => invalidate(qc, APP_KEYS(id)),
  });
}

// ─── Applicant mutations ────────────────────────────────────────────────────

/** Inline errors on the apply page (409/422 with links), so no toast. */
export function useCreateApplication() {
  const qc = useQueryClient();
  return useMutation<Application, ApiError, { campaignId: string; programId: string; formData: Record<string, unknown> }>({
    mutationFn: (body) => api.post("/api/admissions/applications", body),
    onSuccess: () => invalidate(qc, [admissionsKeys.mine()]),
  });
}

/** Sends the FULL formData object: the server REPLACES it. */
export function useSaveDraft(id: string) {
  const qc = useQueryClient();
  return useMutation<Application, ApiError, Record<string, unknown>>({
    mutationFn: (formData) => api.patch(`/api/admissions/applications/${id}`, { formData }),
    onSuccess: () => invalidate(qc, [admissionsKeys.application(id), admissionsKeys.mine()]),
    onError: (e) => {
      toastError(e);
      invalidate(qc, [admissionsKeys.application(id)]);
    },
  });
}

export function useAddDocument(id: string) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { docType: string; reference: string; fileName?: string }>({
    mutationFn: (body) => api.post(`/api/admissions/applications/${id}/documents`, body),
    onSuccess: () => invalidate(qc, [admissionsKeys.application(id)]),
  });
}

/** Errors (422 missing field/doc) render inline above the button. */
export function useSubmitApplication(id: string) {
  const qc = useQueryClient();
  return useMutation<Application, ApiError, void>({
    mutationFn: () => api.post(`/api/admissions/applications/${id}/submit`, {}),
    onSuccess: () => invalidate(qc, [admissionsKeys.application(id), admissionsKeys.mine()]),
  });
}

export function useWithdrawApplication(id: string) {
  const qc = useQueryClient();
  return useMutation<Application, ApiError, { reason?: string }>({
    mutationFn: (body) => api.post(`/api/admissions/applications/${id}/withdraw`, body),
    onSuccess: () => invalidate(qc, [admissionsKeys.application(id), admissionsKeys.mine()]),
    onError: (e) => {
      toastError(e);
      invalidate(qc, [admissionsKeys.application(id)]);
    },
  });
}

export function useAcceptOffer(applicationId: string) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, string>({
    mutationFn: (offerId) => api.post(`/api/admissions/offers/${offerId}/accept`, {}),
    onSuccess: () => invalidate(qc, [admissionsKeys.application(applicationId), admissionsKeys.mine()]),
    onError: (e) => {
      toastError(e);
      invalidate(qc, [admissionsKeys.application(applicationId)]);
    },
  });
}

export function useDeclineOffer(applicationId: string) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { offerId: string; reason?: string }>({
    mutationFn: ({ offerId, reason }) => api.post(`/api/admissions/offers/${offerId}/decline`, reason ? { reason } : {}),
    onSuccess: () => invalidate(qc, [admissionsKeys.application(applicationId), admissionsKeys.mine()]),
    onError: (e) => {
      toastError(e);
      invalidate(qc, [admissionsKeys.application(applicationId)]);
    },
  });
}
