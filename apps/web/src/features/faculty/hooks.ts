// features/faculty/hooks.ts
// No "use client": hooks files are plain TS modules (mirrors features/library/hooks.ts).
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";
import { can } from "@/lib/authz";
import { useAuthStore } from "@/stores/auth";
import { facultyKeys } from "./keys";
import type {
  FacultyListResponse,
  FacultyLookups,
  FacultyProfile,
  Qualification,
  WorkloadPolicy,
  WorkloadResult,
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

function toastError(error: unknown): void {
  toast.error(describeApiError(error));
}

export interface FacultyFilters {
  q?: string;
  departmentId?: string;
  status?: string;
  page: number;
}

export function useFacultyList(filters: FacultyFilters) {
  const allowed = can("faculty.directory.view", usePerms());
  const q = useQuery<FacultyListResponse, ApiError>({
    queryKey: facultyKeys.list(filters),
    queryFn: () =>
      api.get(
        `/api/faculty${qs({
          q: filters.q,
          departmentId: filters.departmentId,
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

export function useFacultyLookups() {
  const allowed = can("faculty.directory.view", usePerms());
  const q = useQuery<FacultyLookups, ApiError>({
    queryKey: facultyKeys.lookups(),
    queryFn: () => api.get("/api/faculty/lookups"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useFacultyProfile(id: string | undefined) {
  const allowed = can("faculty.directory.view", usePerms());
  const q = useQuery<FacultyProfile, ApiError>({
    queryKey: facultyKeys.profile(id ?? ""),
    queryFn: () => api.get(`/api/faculty/${id}/profile`),
    enabled: allowed && Boolean(id),
  });
  return withAllowed(q, allowed);
}

export function useWorkloadPolicy() {
  const allowed = can("faculty.workload.manage", usePerms());
  const q = useQuery<{ policy: WorkloadPolicy | null }, ApiError>({
    queryKey: facultyKeys.policy(),
    queryFn: () => api.get("/api/faculty/workload-policy"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useMyFacultyProfile() {
  const allowed = can("faculty.view_own", usePerms());
  const q = useQuery<FacultyProfile, ApiError>({
    queryKey: facultyKeys.meProfile(),
    queryFn: () => api.get("/api/faculty/me/profile"),
    enabled: allowed,
    retry: false,
  });
  return withAllowed(q, allowed);
}

/** toast:false: the policy page renders the error inline. */
export function usePutWorkloadPolicy() {
  const qc = useQueryClient();
  return useMutation<{ policy: WorkloadPolicy }, ApiError, { maxWeeklyHours: number }>({
    mutationFn: (body) => api.put("/api/faculty/workload-policy", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: facultyKeys.policy() });
      void qc.invalidateQueries({ queryKey: ["faculty", "profile"] });
    },
  });
}

/** toast:false: the dialog renders the error inline. */
export function useCreateQualification(id: string) {
  const qc = useQueryClient();
  return useMutation<Qualification, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/faculty/${id}/qualifications`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: facultyKeys.profile(id) }),
  });
}

/** toast:false: the dialog renders the error inline. */
export function useUpdateQualification(id: string) {
  const qc = useQueryClient();
  return useMutation<Qualification, ApiError, { qid: string; body: Record<string, unknown> }>({
    mutationFn: ({ qid, body }) => api.patch(`/api/faculty/${id}/qualifications/${qid}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: facultyKeys.profile(id) }),
  });
}

export function useDeleteQualification(id: string) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, string>({
    mutationFn: (qid) => api.delete(`/api/faculty/${id}/qualifications/${qid}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: facultyKeys.profile(id) }),
    onError: (e) => {
      toastError(e);
      void qc.invalidateQueries({ queryKey: facultyKeys.profile(id) });
    },
  });
}

export function useRecomputeWorkload(id: string) {
  const qc = useQueryClient();
  return useMutation<WorkloadResult, ApiError, string>({
    // Bodyless POST: api.ts always sends a JSON content type, so pass {} (the handler parses nothing).
    mutationFn: (termId) => api.post(`/api/faculty/${id}/workload/${termId}/recompute`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: facultyKeys.profile(id) }),
    onError: (e) => {
      toastError(e);
      void qc.invalidateQueries({ queryKey: facultyKeys.profile(id) });
    },
  });
}

/** toast:false: the dialog renders the 422 inline and stays open. */
export function usePatchWorkload(id: string) {
  const qc = useQueryClient();
  return useMutation<WorkloadResult, ApiError, { termId: string; body: Record<string, unknown> }>({
    mutationFn: ({ termId, body }) => api.patch(`/api/faculty/${id}/workload/${termId}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: facultyKeys.profile(id) }),
  });
}

export function useReconcileHistory(id: string) {
  const qc = useQueryClient();
  return useMutation<{ appended: number }, ApiError, void>({
    // Bodyless POST: pass {} so the JSON content type has a body.
    mutationFn: () => api.post(`/api/faculty/${id}/teaching-history/reconcile`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: facultyKeys.profile(id) }),
    onError: (e) => {
      toastError(e);
      void qc.invalidateQueries({ queryKey: facultyKeys.profile(id) });
    },
  });
}
