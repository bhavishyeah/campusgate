// features/classes/hooks.ts
// NIT-9: No "use client" directive — hooks files are plain TS modules, not page/component files.
// This matches features/academics/hooks.ts.

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { can } from "@/lib/authz";
import { classesKeys } from "./keys";
import type {
  ClassSection,
  FacultyAssignment,
  Timetable,
  ConflictReport,
} from "./types";

// ─── Helpers (mirror of academics/hooks.ts) ────────────────────────────────

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

// ─── Sections ────────────────────────────────────────────────────────────────

interface SectionsResponse { sections: ClassSection[]; }

export function useSections() {
  const perms = currentPermissions();
  return useQuery<SectionsResponse>({
    queryKey: classesKeys.sections(),
    queryFn: () => api.get("/api/classes/sections"),
    enabled: can("classes.view", perms) || can("classes.sections.manage", perms),
  });
}

export function useSection(id: string) {
  const perms = currentPermissions();
  return useQuery<ClassSection>({
    queryKey: classesKeys.section(id),
    queryFn: () => api.get(`/api/classes/sections/${id}`),
    enabled: Boolean(id) && (can("classes.view", perms) || can("classes.sections.manage", perms)),
  });
}

export interface CreateSectionBody {
  programId: string;
  academicSessionId: string;
  academicTermId: string;
  label?: string;
  capacity?: number;
  status?: string;
}

export function useCreateSection() {
  const qc = useQueryClient();
  return useMutation<ClassSection, ApiError, CreateSectionBody>({
    mutationFn: (body) => api.post("/api/classes/sections", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: classesKeys.sections() });
    },
    onError: toastError,
  });
}

export interface PatchSectionBody {
  label?: string;
  capacity?: number;
  status?: string;
}

export function useUpdateSection(id: string) {
  const qc = useQueryClient();
  return useMutation<ClassSection, ApiError, PatchSectionBody>({
    mutationFn: (body) => apiPatch(`/api/classes/sections/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: classesKeys.sections() });
      qc.invalidateQueries({ queryKey: classesKeys.section(id) });
    },
    onError: toastError,
  });
}

// ─── Faculty assignments ──────────────────────────────────────────────────────

export interface AssignFacultyBody {
  facultyId: string;
  subjectId: string;
  academicTermId: string;
  classSectionId?: string;
  role?: string;
  replacesAssignmentId?: string;
}

export function useAssignFaculty() {
  const qc = useQueryClient();
  return useMutation<FacultyAssignment, ApiError, AssignFacultyBody>({
    mutationFn: (body) => api.post("/api/classes/faculty/assign", body),
    onSuccess: (_data, vars) => {
      // Always invalidate timetables (assignment changes affect scheduling context)
      qc.invalidateQueries({ queryKey: classesKeys.timetables() });
      // Invalidate the specific section detail when a section-scoped assignment was made
      if (vars.classSectionId) {
        qc.invalidateQueries({ queryKey: classesKeys.section(vars.classSectionId) });
      }
      // Note: non-section (term-level) assignments have no dedicated cache key yet
      // because there is no GET /api/classes/faculty/assignments endpoint (API gap §4.1).
      // Adding the timetables invalidation above ensures the timetable grid refreshes.
    },
    onError: toastError,
  });
}

// ─── Timetables ───────────────────────────────────────────────────────────────

interface TimetablesResponse { timetables: Timetable[]; }

export function useTimetables() {
  const perms = currentPermissions();
  return useQuery<TimetablesResponse>({
    queryKey: classesKeys.timetables(),
    queryFn: () => api.get("/api/classes/timetables"),
    enabled: can("classes.view", perms) || can("classes.timetable.manage", perms),
  });
}

export function useTimetable(id: string) {
  const perms = currentPermissions();
  return useQuery<Timetable>({
    queryKey: classesKeys.timetable(id),
    queryFn: () => api.get(`/api/classes/timetables/${id}`),
    enabled: Boolean(id) && (can("classes.view", perms) || can("classes.timetable.manage", perms)),
  });
}

export interface CreateTimetableBody { academicTermId: string; name: string; }

/* forward-declared, used by future timetable-management page */
export function useCreateTimetable() {
  const qc = useQueryClient();
  return useMutation<Timetable, ApiError, CreateTimetableBody>({
    mutationFn: (body) => api.post("/api/classes/timetables", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: classesKeys.timetables() });
    },
    onError: toastError,
  });
}

export interface PublishTimetableBody { acceptWarnings?: boolean; }
export interface PublishResult { timetable: Timetable; warnings: unknown[] }

export function usePublishTimetable(id: string) {
  const qc = useQueryClient();
  return useMutation<PublishResult, ApiError, PublishTimetableBody>({
    mutationFn: (body) => api.post(`/api/classes/timetables/${id}/publish`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: classesKeys.timetable(id) });
      qc.invalidateQueries({ queryKey: classesKeys.timetables() });
    },
    // onError NOT called here — Screen 4 handles 409 discrimination inline.
  });
}

/**
 * Fetch ALL timetables with their scheduledClasses in one logical call.
 * Used by CreateSessionDialog so faculty can pick a ScheduledClass.
 * Pattern: fetch timetables list → useQueries for each detail row.
 * Each detail row is already cached by useTimetable(id) so re-use is free.
 */
export function useAllScheduledClasses() {
  const perms = currentPermissions();
  // NOTE: GET /api/classes/timetables requires classes.view.
  // Faculty (attendance.mark only, no classes.view) will receive an empty list
  // from this hook — the server will 403 on the timetables fetch.
  // That is an API gap (no faculty-scoped scheduled-class listing endpoint yet);
  // the dialog falls back to an empty dropdown gracefully.
  const canView = can("classes.view", perms) || can("classes.timetable.manage", perms);

  const timetablesQuery = useQuery<TimetablesResponse>({
    queryKey: classesKeys.timetables(),
    queryFn: () => api.get("/api/classes/timetables"),
    enabled: canView,
  });

  const timetableIds = timetablesQuery.data?.timetables.map((t) => t.id) ?? [];

  const detailQueries = useQueries({
    queries: timetableIds.map((id) => ({
      queryKey: classesKeys.timetable(id),
      queryFn: () => api.get<Timetable>(`/api/classes/timetables/${id}`),
      enabled: canView,
    })),
  });

  const scheduledClasses = detailQueries
    .flatMap((q) => (q.data as Timetable | undefined)?.scheduledClasses ?? [])
    .filter((sc) => sc.status === "SCHEDULED");

  const isLoading = timetablesQuery.isLoading || detailQueries.some((q) => q.isLoading);

  return { scheduledClasses, isLoading };
}
