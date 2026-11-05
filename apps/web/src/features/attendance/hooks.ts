// features/attendance/hooks.ts
// No "use client" directive — hooks files are plain TS modules, not page/component files.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { can } from "@/lib/authz";
import { attendanceKeys } from "./keys";
import { attendanceSessionsAccess } from "./gating";
import type {
  AttendanceSession,
  AttendanceCorrection,
  SectionReport,
} from "./types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

/**
 * PATCH helper. lib/api.ts exposes only get/post/put/delete; PATCH is issued
 * here using the same token/ApiError/auto-logout semantics.
 */
async function apiPatch<T>(endpoint: string, body?: unknown): Promise<T> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: "PATCH",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) useAuthStore.getState().logout();
    throw new ApiError(res.status, data);
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

// ─── todayISO helper ─────────────────────────────────────────────────────────

/** Returns today's date as a YYYY-MM-DD string.
 *  UTC date (matches server storage) */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Keep todayISO in scope (used implicitly via import in formSchemas; exported from utils.ts).
// Suppress unused warning by referencing it:
void todayISO;

// ─── Sessions ────────────────────────────────────────────────────────────────

interface SessionsResponse { sessions: AttendanceSession[]; }

/**
 * MF6: GET /api/attendance/sessions requires `attendance.view` permission.
 * Per ROLE_PERMISSIONS catalogue:
 *   - FACULTY holds `attendance.mark` but NOT `attendance.view`
 *   - HOD holds both `attendance.view` and `attendance.correct`
 *   - ADMIN holds `attendance.view` but NOT `attendance.mark`
 * Therefore roles holding `attendance.mark` do NOT necessarily hold `attendance.view`.
 * However, FACULTY must be able to reach their own sessions — the server enforces
 * record-level scope via resolveMarkingFaculty + assertFacultyAssigned, so a faculty
 * caller with `attendance.mark` only gets back their own assigned sessions.
 * Gate: `attendance.view` (staff read) || `attendance.mark` (faculty self-scoped).
 */
export function useAttendanceSessions() {
  const perms = currentPermissions();
  // The server gates GET /sessions on `attendance.view` ONLY — there is no
  // mark-scoped fallback (see attendance.ts). Firing this query for a mark-only
  // FACULTY produced a 403 that rendered as an error banner. Gate `enabled` on
  // `attendance.view` so mark-only users never hit that 403; the page shows a
  // clean guidance state instead (they mark attendance from their class roster).
  return useQuery<SessionsResponse>({
    queryKey: attendanceKeys.sessions(),
    queryFn: () => api.get("/api/attendance/sessions"),
    enabled: attendanceSessionsAccess(perms).canList,
  });
}

export function useAttendanceSession(id: string) {
  const perms = currentPermissions();
  return useQuery<AttendanceSession>({
    queryKey: attendanceKeys.session(id),
    queryFn: () => api.get(`/api/attendance/sessions/${id}`),
    enabled: Boolean(id) && (can("attendance.view", perms) || can("attendance.mark", perms)),
  });
}

export interface CreateAttendanceSessionBody {
  scheduledClassId: string;
  date: string;
  submissionDeadline?: string;
}

export function useCreateAttendanceSession() {
  const qc = useQueryClient();
  return useMutation<{ session: AttendanceSession; recordCount: number }, ApiError, CreateAttendanceSessionBody>({
    mutationFn: (body) => api.post("/api/attendance/sessions", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: attendanceKeys.sessions() });
    },
    onError: toastError,
  });
}

export interface MarkRecordsBody {
  records: { studentId: string; status: string }[];
}

// MF1: exactly one mutationFn — uses apiPatch (the API uses PATCH for this endpoint)
export function useMarkAttendance(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<{ changed: number }, ApiError, MarkRecordsBody>({
    mutationFn: (body) => apiPatch(`/api/attendance/sessions/${sessionId}/records`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: attendanceKeys.session(sessionId) });
    },
    onError: toastError,
  });
}

export function useSubmitSession(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<AttendanceSession, ApiError, void>({
    mutationFn: () => api.post(`/api/attendance/sessions/${sessionId}/submit`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: attendanceKeys.session(sessionId) });
      qc.invalidateQueries({ queryKey: attendanceKeys.sessions() });
    },
    onError: toastError,
  });
}

export function useFinalizeSession(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<AttendanceSession, ApiError, void>({
    mutationFn: () => api.post(`/api/attendance/sessions/${sessionId}/finalize`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: attendanceKeys.session(sessionId) });
      qc.invalidateQueries({ queryKey: attendanceKeys.sessions() });
    },
    onError: toastError,
  });
}

// ─── Corrections ─────────────────────────────────────────────────────────────

interface CorrectionsResponse { corrections: AttendanceCorrection[]; }

/**
 * useCorrections is gated on attendance.correct (the review permission).
 * Faculty with only attendance.mark cannot call GET /api/attendance/corrections
 * (the API returns 403). The Screen 7 design handles this with an explicit
 * empty-state message for attendance.mark-only users.
 */
export function useCorrections(status?: string) {
  const perms = currentPermissions();
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return useQuery<CorrectionsResponse>({
    queryKey: attendanceKeys.corrections(status),
    queryFn: () => api.get(`/api/attendance/corrections${qs}`),
    enabled: can("attendance.correct", perms),
  });
}

export interface SubmitCorrectionBody {
  attendanceRecordId: string;
  requestedStatus: string;
  reason: string;
}

export function useSubmitCorrection() {
  const qc = useQueryClient();
  return useMutation<AttendanceCorrection, ApiError, SubmitCorrectionBody>({
    mutationFn: (body) => api.post("/api/attendance/corrections", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: attendanceKeys.corrections() });
    },
    onError: toastError,
  });
}

export interface ReviewCorrectionBody { reviewNote?: string; }

export function useApproveCorrection(correctionId: string) {
  const qc = useQueryClient();
  return useMutation<AttendanceCorrection, ApiError, ReviewCorrectionBody>({
    mutationFn: (body) => api.post(`/api/attendance/corrections/${correctionId}/approve`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: attendanceKeys.corrections() });
    },
    onError: toastError,
  });
}

export function useRejectCorrection(correctionId: string) {
  const qc = useQueryClient();
  return useMutation<AttendanceCorrection, ApiError, ReviewCorrectionBody>({
    mutationFn: (body) => api.post(`/api/attendance/corrections/${correctionId}/reject`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: attendanceKeys.corrections() });
    },
    onError: toastError,
  });
}

// ─── Reports ─────────────────────────────────────────────────────────────────

export function useSectionReport(sectionId: string, academicTermId: string) {
  const perms = currentPermissions();
  return useQuery<SectionReport>({
    queryKey: attendanceKeys.report(sectionId, academicTermId),
    queryFn: () =>
      api.get(`/api/attendance/reports/section/${sectionId}?academicTermId=${encodeURIComponent(academicTermId)}`),
    enabled: Boolean(sectionId) && Boolean(academicTermId) && can("attendance.view", perms),
  });
}
