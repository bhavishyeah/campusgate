import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { can } from "@/lib/authz";
import { academicsKeys } from "./keys";
import type {
  AcademicSession,
  AcademicTerm,
  AcademicCalendarDay,
  Program,
  SessionStructureType,
  DurationUnit,
  ProgramStatus,
  Warning,
} from "./types";

// ─── Helpers (mirror of fees/hooks.ts) ────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

/**
 * PATCH helper. lib/api.ts exposes only get/post/put/delete; PATCH is issued
 * here using the same token/ApiError/auto-logout semantics.
 */
async function apiPatch<T>(endpoint: string, body?: unknown): Promise<T> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: "PATCH",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) useAuthStore.getState().logout();
    throw new ApiError(response.status, data);
  }
  return data as T;
}

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

// ─── Response envelope shapes ──────────────────────────────────────────────

interface SessionsResponse {
  sessions: AcademicSession[];
  warnings: Warning[];
}
interface SessionResponse {
  session: AcademicSession;
  warnings: Warning[];
}
interface TermResponse {
  term: AcademicTerm;
  warnings: Warning[];
}
interface ProgramsResponse {
  programs: Program[];
  warnings: Warning[];
}
interface ProgramResponse {
  program: Program;
  warnings: Warning[];
}

// ─── Sessions ──────────────────────────────────────────────────────────────

/**
 * useSessions — includes status filter in the query KEY so filter-tab
 * switches produce distinct cache entries (each fetches its own filtered list).
 */
export function useSessions(status?: string) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const perms = currentPermissions();
  return useQuery<SessionsResponse>({
    queryKey: academicsKeys.sessions({ status }),
    queryFn: () => api.get(`/api/admin/academic/sessions${qs}`),
    enabled:
      can("academics.sessions.manage", perms) ||
      can("academics.view", perms),
  });
}

export function useSession(id: string) {
  const perms = currentPermissions();
  return useQuery<SessionResponse>({
    queryKey: academicsKeys.session(id),
    queryFn: () => api.get(`/api/admin/academic/sessions/${id}`),
    enabled:
      Boolean(id) &&
      (can("academics.sessions.manage", perms) || can("academics.view", perms)),
  });
}

export interface CreateSessionBody {
  name: string;
  structureType: SessionStructureType;
  startDate: string;
  endDate: string;
}

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation<SessionResponse, ApiError, CreateSessionBody>({
    mutationFn: (body) => api.post("/api/admin/academic/sessions", body),
    onSuccess: () => {
      // Invalidate all sessions cache entries (prefix match covers all filter variants)
      qc.invalidateQueries({ queryKey: ["academics", "sessions"] });
    },
    onError: toastError,
  });
}

export function useUpdateSession(id: string) {
  const qc = useQueryClient();
  return useMutation<SessionResponse, ApiError, Partial<CreateSessionBody>>({
    mutationFn: (body) => apiPatch(`/api/admin/academic/sessions/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["academics", "sessions"] });
      qc.invalidateQueries({ queryKey: academicsKeys.session(id) });
    },
    onError: toastError,
  });
}

/**
 * useActivateSession — MUST-FIX 5: handover is sent as a query parameter,
 * NOT a body field, to avoid a silent 409 if the backend handler reads
 * req.query only.
 */
export function useActivateSession(id: string) {
  const qc = useQueryClient();
  return useMutation<SessionResponse, ApiError, { handover?: boolean }>({
    mutationFn: (body) =>
      api.post(
        `/api/admin/academic/sessions/${id}/activate${body.handover ? "?handover=true" : ""}`,
        {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["academics", "sessions"] });
      qc.invalidateQueries({ queryKey: academicsKeys.session(id) });
    },
    onError: toastError,
  });
}

export function useCloseSession(id: string) {
  const qc = useQueryClient();
  return useMutation<SessionResponse, ApiError, void>({
    mutationFn: () => api.post(`/api/admin/academic/sessions/${id}/close`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["academics", "sessions"] });
      qc.invalidateQueries({ queryKey: academicsKeys.session(id) });
    },
    onError: toastError,
  });
}

// ─── Terms ─────────────────────────────────────────────────────────────────

export interface AddTermBody {
  name: string;
  ordinal: number;
  startDate: string;
  endDate: string;
}

export function useCreateTerm(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<TermResponse, ApiError, AddTermBody>({
    mutationFn: (body) =>
      api.post(`/api/admin/academic/sessions/${sessionId}/terms`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: academicsKeys.session(sessionId) });
    },
    onError: toastError,
  });
}

/**
 * useUpdateTerm — edit a term's name, ordinal, or dates.
 * Not allowed when term status is CLOSED (API returns 409).
 * sessionId is needed for cache invalidation only.
 */
export function useUpdateTerm(termId: string, sessionId: string) {
  const qc = useQueryClient();
  return useMutation<TermResponse, ApiError, Partial<AddTermBody>>({
    mutationFn: (body) => apiPatch(`/api/admin/academic/terms/${termId}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: academicsKeys.session(sessionId) });
    },
    onError: toastError,
  });
}

export function useActivateTerm(termId: string, sessionId: string) {
  const qc = useQueryClient();
  return useMutation<TermResponse, ApiError, void>({
    mutationFn: () =>
      api.post(`/api/admin/academic/terms/${termId}/activate`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: academicsKeys.session(sessionId) });
    },
    onError: toastError,
  });
}

export function useCloseTerm(termId: string, sessionId: string) {
  const qc = useQueryClient();
  return useMutation<TermResponse, ApiError, void>({
    mutationFn: () =>
      api.post(`/api/admin/academic/terms/${termId}/close`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: academicsKeys.session(sessionId) });
    },
    onError: toastError,
  });
}

// ─── Programs ──────────────────────────────────────────────────────────────

interface ProgramFilter {
  departmentId?: string;
  status?: string;
}

/**
 * usePrograms — filter params are included in the query KEY so that
 * departmentId/status filter changes produce distinct cache entries.
 *
 * Permission gate: academics.programs.manage (NOT academics.view per MUST-FIX 1).
 */
export function usePrograms(filter?: ProgramFilter) {
  const qs = new URLSearchParams();
  // departmentId is optional — filters programs by department when provided
  if (filter?.departmentId) qs.set("departmentId", filter.departmentId);
  if (filter?.status) qs.set("status", filter.status);
  const search = qs.toString() ? `?${qs}` : "";
  const perms = currentPermissions();

  return useQuery<ProgramsResponse>({
    queryKey: academicsKeys.programs(filter),
    queryFn: () => api.get(`/api/admin/academic/programs${search}`),
    // Per MUST-FIX 1: programs are gated by academics.programs.manage only
    enabled: can("academics.programs.manage", perms),
  });
}

export function useProgram(id: string) {
  const perms = currentPermissions();
  return useQuery<ProgramResponse>({
    queryKey: academicsKeys.program(id),
    queryFn: () => api.get(`/api/admin/academic/programs/${id}`),
    // Per MUST-FIX 1: programs are gated by academics.programs.manage only
    enabled: Boolean(id) && can("academics.programs.manage", perms),
  });
}

export interface CreateProgramBody {
  departmentId: string;
  name: string;
  code: string;
  duration: number;
  durationUnit: DurationUnit;
}

export function useCreateProgram() {
  const qc = useQueryClient();
  return useMutation<ProgramResponse, ApiError, CreateProgramBody>({
    mutationFn: (body) => api.post("/api/admin/academic/programs", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["academics", "programs"] });
    },
    onError: toastError,
  });
}

export interface PatchProgramBody {
  name?: string;
  code?: string;
  duration?: number;
  durationUnit?: DurationUnit;
  departmentId?: string;
  status?: ProgramStatus;
}

export function useUpdateProgram(id: string) {
  const qc = useQueryClient();
  return useMutation<ProgramResponse, ApiError, PatchProgramBody>({
    mutationFn: (body) => apiPatch(`/api/admin/academic/programs/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["academics", "programs"] });
      qc.invalidateQueries({ queryKey: academicsKeys.program(id) });
    },
    onError: toastError,
  });
}

// ─── Academic Calendar ──────────────────────────────────────────────────────

/**
 * useSessionCalendar — fetches calendar days for a session's date range.
 *
 * sessionId is accepted as a parameter for the caller's convenience (to
 * pre-compute the range from session dates); it is NOT sent to the API and is
 * NOT part of the cache key. Only startDate/endDate are sent.
 *
 * Per MUST-FIX 1: calendar is gated by academics.calendar.manage only.
 */
export function useSessionCalendar(
  sessionId: string,
  startDate?: string,
  endDate?: string,
) {
  // sessionId included in cache key so different sessions get distinct entries
  const qs = new URLSearchParams();
  if (startDate) qs.set("startDate", startDate);
  if (endDate) qs.set("endDate", endDate);
  const search = qs.toString() ? `?${qs}` : "";
  const perms = currentPermissions();

  return useQuery<AcademicCalendarDay[]>({
    queryKey: ["academics", "calendar", sessionId, { startDate, endDate }],
    queryFn: () => api.get(`/api/admin/academic-calendar${search}`),
    // Per MUST-FIX 1: calendar is gated by academics.calendar.manage only
    enabled:
      Boolean(sessionId) &&
      can("academics.calendar.manage", perms),
  });
}
