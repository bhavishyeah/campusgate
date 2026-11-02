import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { can } from "@/lib/authz";
import { sisKeys } from "./keys";
import type {
  StudentProfile,
  StudentListParams,
  Pagination,
  DeactivationStatus,
} from "./types";

// ─── Helpers (mirror of fees/hooks.ts) ────────────────────────────────────────

function currentPermissions(): string[] {
  return useAuthStore.getState().permissions;
}

function toastError(error: unknown): void {
  const message =
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Something went wrong.";
  toast.error(message);
}

// ─── Response shapes ───────────────────────────────────────────────────────

interface StudentsListResponse {
  students: StudentProfile[];
  pagination: Pagination;
}

// ─── Students ──────────────────────────────────────────────────────────────

/**
 * useStudents — paginated, searchable, filterable list.
 * All params (including page/pageSize) are included in the cache key so that
 * page navigation and filter changes produce distinct cache entries.
 */
export function useStudents(params: StudentListParams) {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.status) qs.set("status", params.status);
  if (params.programId) qs.set("programId", params.programId);
  if (params.departmentId) qs.set("departmentId", params.departmentId);
  if (params.page) qs.set("page", String(params.page));
  if (params.pageSize) qs.set("pageSize", String(params.pageSize));
  const search = qs.toString() ? `?${qs}` : "";
  const perms = currentPermissions();

  return useQuery<StudentsListResponse>({
    queryKey: sisKeys.list(params),
    queryFn: () => api.get(`/api/students${search}`),
    enabled:
      can("students.view", perms) ||
      can("students.create", perms) ||
      can("students.update", perms) ||
      can("students.deactivate", perms),
  });
}

/**
 * useStudent — single student detail with relations.
 * GET /api/students/:id returns the StudentProfile object directly (no envelope).
 */
export function useStudent(id: string) {
  const perms = currentPermissions();
  return useQuery<StudentProfile>({
    queryKey: sisKeys.detail(id),
    queryFn: () => api.get(`/api/students/${id}`),
    enabled:
      Boolean(id) &&
      (can("students.view", perms) ||
        can("students.update", perms) ||
        can("students.deactivate", perms) ||
        can("students.enroll", perms) ||
        can("students.promote", perms)),
  });
}

export interface DeactivateStudentBody {
  status: DeactivationStatus;
  reason?: string;
}

/**
 * useDeactivateStudent — archives a student via a terminal status.
 * POST /api/students/:id/deactivate returns the updated StudentProfile directly (no envelope).
 */
export function useDeactivateStudent(id: string) {
  const qc = useQueryClient();
  return useMutation<StudentProfile, ApiError, DeactivateStudentBody>({
    mutationFn: (body) => api.post(`/api/students/${id}/deactivate`, body),
    onSuccess: (updated) => {
      qc.setQueryData(sisKeys.detail(id), updated);
      qc.invalidateQueries({ queryKey: ["students"] });
    },
    onError: toastError,
  });
}

export interface PromoteStudentBody {
  semester?: number; // explicit semester; defaults to current if omitted
  currentTermId?: string; // target term FK; keeps current term if omitted
}

/**
 * usePromoteStudent — advance a student's term/semester.
 * POST /api/students/:id/promote returns the updated StudentProfile directly (no envelope).
 * Not surfaced as a UI action in this slice but provided per the feature hook spec.
 */
export function usePromoteStudent(id: string) {
  const qc = useQueryClient();
  return useMutation<StudentProfile, ApiError, PromoteStudentBody>({
    mutationFn: (body) => api.post(`/api/students/${id}/promote`, body),
    onSuccess: (updated) => {
      qc.setQueryData(sisKeys.detail(id), updated);
      qc.invalidateQueries({ queryKey: ["students"] });
    },
    onError: toastError,
  });
}
