// features/service-requests/hooks.ts — plain TS module (no "use client").
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
import { downloadAuthed } from "@/lib/downloadFile";
import { serviceRequestKeys } from "./keys";
import type {
  ActiveType,
  FeedbackReport,
  FieldDef,
  ListResponse,
  OverdueReport,
  RequestDetail,
  RequestRow,
  RequestType,
  SlaReport,
  UserLookupItem,
  VolumeRow,
} from "./types";

export const PAGE_SIZE = 20;

function qs(params: Record<string, string | number | boolean | undefined>): string {
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

function invalidate(qc: QueryClient, keys: readonly (readonly unknown[])[]): void {
  for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
}

interface MutationOpts {
  toast?: boolean;
}

function errorHandler(opts: MutationOpts): (error: unknown) => void {
  return (error) => {
    if (opts.toast !== false) toast.error(describeApiError(error));
  };
}

// ─── Types + fields ─────────────────────────────────────────────────────────
export function useTypes() {
  const allowed = can("service_requests.view", usePerms());
  const q = useQuery<RequestType[], ApiError>({
    queryKey: serviceRequestKeys.types(),
    queryFn: () => api.get("/api/service-requests/types"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useActiveTypes() {
  const perms = usePerms();
  const allowed = can("service_requests.view", perms) || can("service_requests.request_own", perms);
  const q = useQuery<{ types: ActiveType[] }, ApiError>({
    queryKey: serviceRequestKeys.activeTypes(),
    queryFn: () => api.get("/api/service-requests/types/active"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useCreateType(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<RequestType, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/service-requests/types", body),
    onSuccess: () => invalidate(qc, [serviceRequestKeys.types(), serviceRequestKeys.activeTypes()]),
    onError: errorHandler(opts),
  });
}

export function usePatchType(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<RequestType, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.patch(`/api/service-requests/types/${id}`, body),
    onSuccess: () => invalidate(qc, [serviceRequestKeys.types(), serviceRequestKeys.activeTypes()]),
    onError: errorHandler(opts),
  });
}

export function useTypeFields(typeId: string) {
  const perms = usePerms();
  const allowed = can("service_requests.view", perms) || can("service_requests.request_own", perms);
  const q = useQuery<FieldDef[], ApiError>({
    queryKey: serviceRequestKeys.typeFields(typeId),
    queryFn: () => api.get(`/api/service-requests/types/${typeId}/fields`),
    enabled: allowed && typeId !== "",
  });
  return withAllowed(q, allowed);
}

export function useCreateField(typeId: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<FieldDef, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/service-requests/types/${typeId}/fields`, body),
    onSuccess: () => invalidate(qc, [serviceRequestKeys.typeFields(typeId), serviceRequestKeys.types()]),
    onError: errorHandler(opts),
  });
}

export function usePatchField(typeId: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<FieldDef, ApiError, { fid: string; body: Record<string, unknown> }>({
    mutationFn: ({ fid, body }) => api.patch(`/api/service-requests/types/${typeId}/fields/${fid}`, body),
    onSuccess: () => invalidate(qc, [serviceRequestKeys.typeFields(typeId), serviceRequestKeys.types()]),
    onError: errorHandler(opts),
  });
}

// ─── Triage queue ─────────────────────────────────────────────────────────
export function useQueue(f: { status?: string; requestTypeId?: string; assigneeUserId?: string; overdue?: boolean; page: number }) {
  const allowed = can("service_requests.view", usePerms());
  const q = useQuery<ListResponse<RequestRow>, ApiError>({
    queryKey: serviceRequestKeys.queue(f),
    queryFn: () =>
      api.get(
        `/api/service-requests${qs({
          status: f.status,
          requestTypeId: f.requestTypeId,
          assigneeUserId: f.assigneeUserId,
          overdue: f.overdue ? true : undefined,
          page: f.page,
          pageSize: PAGE_SIZE,
        })}`,
      ),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useRequest(id: string) {
  const allowed = can("service_requests.view", usePerms());
  const q = useQuery<RequestDetail, ApiError>({
    queryKey: serviceRequestKeys.request(id),
    queryFn: () => api.get(`/api/service-requests/${id}`),
    enabled: allowed && id !== "",
  });
  return withAllowed(q, allowed);
}

function invalidateRequest(qc: QueryClient, id: string): void {
  invalidate(qc, [serviceRequestKeys.queueAll(), serviceRequestKeys.request(id)]);
}

export function useAssign(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<{ status: string }, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/service-requests/${id}/assign`, body),
    onSuccess: () => invalidateRequest(qc, id),
    onError: errorHandler(opts),
  });
}

export function useStatus(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<{ status: string }, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.patch(`/api/service-requests/${id}/status`, body),
    onSuccess: () => invalidateRequest(qc, id),
    onError: errorHandler(opts),
  });
}

export function useResolve(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<{ status: string }, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/service-requests/${id}/resolve`, body),
    onSuccess: () => invalidateRequest(qc, id),
    onError: errorHandler(opts),
  });
}

export function useApprove(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<{ status: string }, ApiError, void>({
    // Bodyless POST: api.ts always sends a JSON content type, so pass {}.
    mutationFn: () => api.post(`/api/service-requests/${id}/approve`, {}),
    onSuccess: () => invalidateRequest(qc, id),
    onError: errorHandler(opts),
  });
}

export function useReject(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<{ status: string }, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/service-requests/${id}/reject`, body),
    onSuccess: () => invalidateRequest(qc, id),
    onError: errorHandler(opts),
  });
}

export function useCloseStaff(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<{ status: string }, ApiError, void>({
    // Bodyless POST.
    mutationFn: () => api.post(`/api/service-requests/${id}/close`, {}),
    onSuccess: () => invalidateRequest(qc, id),
    onError: errorHandler(opts),
  });
}

export function useCancelStaff(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<{ status: string }, ApiError, void>({
    // Bodyless POST.
    mutationFn: () => api.post(`/api/service-requests/${id}/cancel`, {}),
    onSuccess: () => invalidateRequest(qc, id),
    onError: errorHandler(opts),
  });
}

export function useCommentStaff(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/service-requests/${id}/comments`, body),
    onSuccess: () => invalidate(qc, [serviceRequestKeys.request(id)]),
    onError: errorHandler(opts),
  });
}

// ─── Reports ───────────────────────────────────────────────────────────────
export function useOverdueReport(atRiskHours: number) {
  const allowed = can("service_requests.view", usePerms());
  const q = useQuery<OverdueReport, ApiError>({
    queryKey: serviceRequestKeys.reportOverdue(atRiskHours),
    queryFn: () => api.get(`/api/service-requests/reports/overdue${qs({ atRiskHours })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useVolumeReport() {
  const allowed = can("service_requests.view", usePerms());
  const q = useQuery<{ data: VolumeRow[] }, ApiError>({
    queryKey: serviceRequestKeys.reportVolume(),
    queryFn: () => api.get("/api/service-requests/reports/volume"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useSlaReport() {
  const allowed = can("service_requests.view", usePerms());
  const q = useQuery<SlaReport, ApiError>({
    queryKey: serviceRequestKeys.reportSla(),
    queryFn: () => api.get("/api/service-requests/reports/sla"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useFeedbackReport() {
  const allowed = can("service_requests.view", usePerms());
  const q = useQuery<FeedbackReport, ApiError>({
    queryKey: serviceRequestKeys.reportFeedback(),
    queryFn: () => api.get("/api/service-requests/reports/feedback"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function downloadExport(): Promise<void> {
  return downloadAuthed("/api/service-requests/reports/export", "service-requests.xlsx");
}

// ─── Lookup ──────────────────────────────────────────────────────────────
export function useUserLookup(q: string) {
  const allowed = can("service_requests.assign.manage", usePerms());
  const term = q.trim();
  const query = useQuery<{ users: UserLookupItem[] }, ApiError>({
    queryKey: serviceRequestKeys.userLookup(term),
    queryFn: () => api.get(`/api/service-requests/users/lookup${qs({ q: term, limit: 10 })}`),
    enabled: allowed && term.length >= 2,
  });
  return withAllowed(query, allowed);
}

// ─── Self (requester) ──────────────────────────────────────────────────────
export function useRaise(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<RequestRow, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/service-requests", body),
    onSuccess: () => invalidate(qc, [serviceRequestKeys.myAll()]),
    onError: errorHandler(opts),
  });
}

export function useMyRequests(f: { status?: string; requestTypeId?: string; page: number }) {
  const allowed = can("service_requests.request_own", usePerms());
  const q = useQuery<ListResponse<RequestRow>, ApiError>({
    queryKey: serviceRequestKeys.myRequests(f),
    queryFn: () =>
      api.get(
        `/api/service-requests/me/requests${qs({ status: f.status, requestTypeId: f.requestTypeId, page: f.page, pageSize: PAGE_SIZE })}`,
      ),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useMyRequest(id: string) {
  const allowed = can("service_requests.request_own", usePerms());
  const q = useQuery<RequestDetail, ApiError>({
    queryKey: serviceRequestKeys.myRequest(id),
    queryFn: () => api.get(`/api/service-requests/me/requests/${id}`),
    enabled: allowed && id !== "",
  });
  return withAllowed(q, allowed);
}

export function useMyComment(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/service-requests/me/requests/${id}/comments`, body),
    onSuccess: () => invalidate(qc, [serviceRequestKeys.myRequest(id)]),
    onError: errorHandler(opts),
  });
}

export function useMyCancel(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, void>({
    // Bodyless POST.
    mutationFn: () => api.post(`/api/service-requests/me/requests/${id}/cancel`, {}),
    onSuccess: () => invalidate(qc, [serviceRequestKeys.myAll()]),
    onError: errorHandler(opts),
  });
}

export function useMyClose(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, void>({
    // Bodyless POST.
    mutationFn: () => api.post(`/api/service-requests/me/requests/${id}/close`, {}),
    onSuccess: () => invalidate(qc, [serviceRequestKeys.myAll()]),
    onError: errorHandler(opts),
  });
}

export function useMyFeedback(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/service-requests/me/requests/${id}/feedback`, body),
    onSuccess: () => invalidate(qc, [serviceRequestKeys.myRequest(id)]),
    onError: errorHandler(opts),
  });
}
