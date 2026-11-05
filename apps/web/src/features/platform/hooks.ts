import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { platformKeys, type AuditScope } from "./keys";
import { PlatformStepUpError, postWithStepUp } from "./stepUp";
import type {
  AuditEventsResponse,
  BreakGlassOverview,
  CreateInstitutionResult,
  InstitutionRow,
  InstitutionStatus,
  ModuleMatrixResponse,
  ModuleState,
  PlatformStats,
  SupportGrant,
  SupportGrantStatus,
} from "./types";

// ─── Query hooks ─────────────────────────────────────────────────────────────

export function useStats() {
  return useQuery<PlatformStats>({
    queryKey: platformKeys.stats(),
    queryFn: () => api.get("/api/platform/stats"),
  });
}

export function useInstitutions() {
  return useQuery<InstitutionRow[]>({
    queryKey: platformKeys.institutions(),
    queryFn: () => api.get("/api/platform/institutions"),
  });
}

export function useModuleMatrix(id: string) {
  return useQuery<ModuleMatrixResponse>({
    queryKey: platformKeys.modules(id),
    queryFn: () => api.get(`/api/platform/institutions/${id}/modules`),
    enabled: Boolean(id),
  });
}

export function useSupportGrants(
  institutionId?: string,
  status?: SupportGrantStatus,
) {
  return useQuery<SupportGrant[]>({
    queryKey: platformKeys.grants(institutionId, status),
    queryFn: () => {
      const params = new URLSearchParams();
      if (institutionId) params.set("institutionId", institutionId);
      if (status) params.set("status", status);
      const qs = params.toString();
      return api.get(`/api/platform/support-grants${qs ? `?${qs}` : ""}`);
    },
  });
}

export function useBreakGlassOverview(grantId: string, enabled: boolean) {
  return useQuery<BreakGlassOverview>({
    queryKey: platformKeys.grantOverview(grantId),
    queryFn: () =>
      api.get(`/api/platform/support-grants/${grantId}/tenant/overview`),
    enabled: Boolean(grantId) && enabled,
  });
}

export function useAuditEvents(
  scope: AuditScope,
  grantId: string | null,
  limit: number,
  enabled: boolean,
) {
  return useQuery<AuditEventsResponse>({
    queryKey: platformKeys.audit(scope, grantId, limit),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("scope", scope);
      if (grantId) params.set("grantId", grantId);
      params.set("limit", String(limit));
      return api.get(`/api/platform/audit-events?${params.toString()}`);
    },
    enabled,
  });
}

// ─── Mutation hooks ──────────────────────────────────────────────────────────

export interface CreateInstitutionBody {
  name: string;
  code: string;
  adminEmail: string;
  domain?: string;
}

/**
 * Creates an institution + bootstrap admin. The 201 result carries a show-once
 * tempPassword — it is returned to the caller for transient display ONLY and is
 * deliberately NOT written into any query cache.
 */
export function useCreateInstitution() {
  const qc = useQueryClient();
  return useMutation<CreateInstitutionResult, ApiError, CreateInstitutionBody>({
    mutationFn: (body) => api.post("/api/platform/institutions", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: platformKeys.institutions() });
    },
  });
}

export function useSetInstitutionStatus(id: string) {
  const qc = useQueryClient();
  return useMutation<InstitutionRow, ApiError, { status: InstitutionStatus }>({
    mutationFn: (body) => api.put(`/api/platform/institutions/${id}/status`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: platformKeys.institutions() });
    },
  });
}

export function useGrantModule(id: string) {
  const qc = useQueryClient();
  return useMutation<
    { institutionId: string; moduleKey: string; state: ModuleState },
    ApiError,
    { moduleKey: string }
  >({
    mutationFn: (body) =>
      api.post(`/api/platform/institutions/${id}/modules`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: platformKeys.modules(id) });
    },
  });
}

export function useRevokeModule(id: string) {
  const qc = useQueryClient();
  return useMutation<
    { institutionId: string; moduleKey: string; state: ModuleState },
    ApiError,
    { moduleKey: string }
  >({
    mutationFn: ({ moduleKey }) =>
      api.delete(`/api/platform/institutions/${id}/modules/${moduleKey}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: platformKeys.modules(id) });
    },
  });
}

export interface CreateSupportGrantBody {
  institutionId: string;
  purpose: string;
  expiresAt: string;
  scope?: { modules?: string[]; resources?: string[] };
}

/**
 * Create a support grant. This is the ONLY step-up-gated platform route
 * (action class `support_grant.create`): it posts via `postWithStepUp` so the
 * `x-step-up` header is attached and a 401 "Step-up required" surfaces as
 * PlatformStepUpError (never a logout). The step-up token is never stored.
 */
export function useCreateSupportGrant() {
  const qc = useQueryClient();
  return useMutation<
    SupportGrant,
    ApiError | PlatformStepUpError,
    { body: CreateSupportGrantBody; stepUpToken?: string }
  >({
    mutationFn: ({ body, stepUpToken }) =>
      postWithStepUp("/api/platform/support-grants", body, stepUpToken),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: platformKeys.grants() });
    },
  });
}

export function useRevokeSupportGrant(id: string) {
  const qc = useQueryClient();
  return useMutation<SupportGrant, ApiError, void>({
    mutationFn: () => api.delete(`/api/platform/support-grants/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: platformKeys.grants() });
    },
  });
}
