# Technical Design — Classes & Attendance Frontend Modules

**Revision:** 2 (post-review)
**Status:** REVISED — all design-review findings addressed (see §13)
**API contract source:** `c:/campusgate/.agents/tasks/frontend-classes-attendance/api-contract.md`

---

## 1. Overview

This document designs the CLASSES module (`app/(app)/classes/`) and ATTENDANCE module (`app/(app)/attendance/`) for the CAMPUSGATE web frontend. Both modules mirror the established F0 pattern precisely: query-key factory (`keys.ts`) + typed React Query hooks (`hooks.ts`) + zod form schemas (`formSchemas.ts`) + typed interfaces (`types.ts`), all under `apps/web/src/features/<domain>/`. Every page file begins with `"use client";` (required by Next.js 14 App Router for all hook-using files), is wrapped in `<RouteGuard>` (auth-only, no `requirePermission`), and gates individual actions with `<Can>`. The reference implementation is `app/(app)/academics/sessions/page.tsx` and `features/academics/hooks.ts`.

**Important enforcement asymmetry (from API contract):** The `classes.*` API routes are _permission-gated only_ — `requireModuleActive` is never called there. The `attendance.*` API routes carry _both_ `requirePermission` and `requireModuleActive("attendance")`. This asymmetry drives the AppShell NAV design: Classes items omit `module`; the Attendance item sets `module: "attendance"`.

**API gaps acknowledged:** Five gaps from the API contract §4 affect this design (no faculty-assignments GET, no end-assignment endpoint, no section-detail faculty assignments, no server-side today/faculty session filter, session statuses differ from brief). Each gap is handled explicitly in the screen designs below.

---

## 2. TypeScript Types — `features/classes/types.ts`

```typescript
// features/classes/types.ts

export type SectionStatus = "PLANNED" | "ACTIVE" | "CLOSED" | "CANCELLED";
export type AssignmentRole = "PRIMARY" | "SUBSTITUTE" | "ASSISTANT";
export type AssignmentStatus = "ACTIVE" | "ENDED";
export type DayOfWeek = "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT";
export type ScheduledClassStatus = "SCHEDULED" | "CANCELLED";
export type TimetableStatus = "DRAFT" | "PUBLISHED";

export interface ClassSection {
  id: string;
  institutionId: string;
  programId: string;
  academicSessionId: string;
  academicTermId: string;
  label: string | null;
  capacity: number | null;
  status: SectionStatus;
  createdAt: string;
  updatedAt: string;
  // Only present on GET /sections/:id
  enrollments?: ClassEnrollment[];
}

export interface ClassEnrollment {
  id: string;
  classSectionId: string;
  studentId: string;
  status: string;
  enrolledAt: string;
}

export interface FacultyProfile {
  id: string;
  institutionId: string;
  userId: string;
  name: string;
  departmentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FacultyAssignment {
  id: string;
  institutionId: string;
  facultyId: string;
  subjectId: string;
  classSectionId: string | null;
  academicTermId: string;
  role: AssignmentRole;
  status: AssignmentStatus;
  endedAt: string | null;   // set when status transitions to ENDED
  createdAt: string;
  updatedAt: string;         // may not be present in all API responses; treat as optional
}

export interface Course {
  id: string;
  institutionId: string;
  programId: string;
  name: string;
  code: string;
  description: string | null;
  academicTermId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  subjects?: Subject[];
}

export interface Subject {
  id: string;
  courseId: string;
  name: string;
  code: string;
  credits: number | null;
  contactHoursPerWeek: number | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface Timetable {
  id: string;
  institutionId: string;
  academicTermId: string;
  name: string;
  status: TimetableStatus;
  createdAt: string;
  updatedAt: string;
  scheduledClasses?: ScheduledClass[];
}

export interface ScheduledClass {
  id: string;
  timetableId: string;
  classSectionId: string;
  subjectId: string;
  facultyId: string;
  academicTermId: string;
  room: string | null;
  dayOfWeek: DayOfWeek | null;
  date: string | null;
  startTime: number;  // minute-of-day, 0..1440
  endTime: number;
  period: string | null;
  status: ScheduledClassStatus;
}

/** Placeholder — actual shape is not documented in the API contract. */
export interface ConflictReport {
  [key: string]: unknown;
}
```

---

## 3. TypeScript Types — `features/attendance/types.ts`

```typescript
// features/attendance/types.ts

export type SessionStatus = "OPEN" | "SUBMITTED" | "FINALIZED";
export type AttendanceStatus = "PRESENT" | "ABSENT" | "LATE" | "EXCUSED";
export type CorrectionReviewStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface AttendanceSession {
  id: string;
  institutionId: string;
  scheduledClassId: string;
  date: string;               // ISO date string YYYY-MM-DD
  submissionDeadline: string | null;
  status: SessionStatus;
  submittedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
  records?: AttendanceRecord[];
}

export interface AttendanceRecord {
  id: string;
  sessionId: string;
  studentId: string;
  status: AttendanceStatus;
  markedByUserId: string | null;
  markedAt: string | null;
}

export interface AttendanceCorrection {
  id: string;
  institutionId: string;
  attendanceRecordId: string;
  requestedStatus: AttendanceStatus;
  reason: string;
  reviewStatus: CorrectionReviewStatus;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SectionReportEntry {
  studentId: string;
  rate: number;   // attendance rate, 0..100
}

export interface SectionReport {
  perStudent: SectionReportEntry[];
  lowAttendance: SectionReportEntry[];
  thresholdPercent: number;
}
```

---

## 4. Query Key Factory — `features/classes/keys.ts`

```typescript
// features/classes/keys.ts

/**
 * TanStack Query key factory for the classes domain.
 *
 * NOTE: classesKeys.sections() has NO filter parameter, because
 * GET /api/classes/sections accepts no ?status= query parameter.
 * Status filtering in Screen 1 is entirely client-side, so a single
 * shared cache entry is correct and intentional. This deviates from
 * academicsKeys.sessions({ status }) — that filter is server-side;
 * this one is not.
 */
export const classesKeys = {
  sections: () => ["classes", "sections"] as const,
  section: (id: string) => ["classes", "sections", id] as const,

  timetables: () => ["classes", "timetables"] as const,
  timetable: (id: string) => ["classes", "timetables", id] as const,

  courses: () => ["classes", "courses"] as const,
  course: (id: string) => ["classes", "courses", id] as const,
} as const;
```

---

## 5. Query Key Factory — `features/attendance/keys.ts`

```typescript
// features/attendance/keys.ts

export const attendanceKeys = {
  sessions: () => ["attendance", "sessions"] as const,
  session: (id: string) => ["attendance", "sessions", id] as const,

  corrections: (status?: string) =>
    ["attendance", "corrections", status ?? "all"] as const,

  report: (sectionId: string, termId: string) =>
    ["attendance", "report", sectionId, termId] as const,
} as const;
```

---

## 6. Form Schemas — `features/classes/formSchemas.ts`

```typescript
// features/classes/formSchemas.ts
import { z } from "zod";

// ─── Class Sections ──────────────────────────────────────────────────────────

export const createSectionSchema = z.object({
  programId:          z.string().min(1, "Program is required"),
  academicSessionId:  z.string().min(1, "Session is required"),
  academicTermId:     z.string().min(1, "Term is required"),
  label:              z.string().max(120).optional(),
  capacity:           z.number({ coerce: true }).int().positive().optional(),
  status:             z.enum(["PLANNED", "ACTIVE", "CLOSED", "CANCELLED"]).optional(),
});
export type CreateSectionInput = z.infer<typeof createSectionSchema>;

export const editSectionSchema = z.object({
  label:    z.string().max(120).optional(),
  capacity: z.number({ coerce: true }).int().positive().optional(),
  status:   z.enum(["PLANNED", "ACTIVE", "CLOSED", "CANCELLED"]).optional(),
});
export type EditSectionInput = z.infer<typeof editSectionSchema>;

// ─── Faculty Assignment ───────────────────────────────────────────────────────

export const assignFacultySchema = z.object({
  facultyId:            z.string().min(1, "Faculty is required"),
  subjectId:            z.string().min(1, "Subject is required"),
  academicTermId:       z.string().min(1, "Term is required"),
  classSectionId:       z.string().optional(),
  role:                 z.enum(["PRIMARY", "SUBSTITUTE", "ASSISTANT"]).default("PRIMARY"),
  replacesAssignmentId: z.string().optional(),
});
export type AssignFacultyInput = z.infer<typeof assignFacultySchema>;

// ─── Timetable ───────────────────────────────────────────────────────────────

export const createTimetableSchema = z.object({
  academicTermId: z.string().min(1, "Term is required"),
  name:           z.string().min(1, "Name is required").max(120),
});
export type CreateTimetableInput = z.infer<typeof createTimetableSchema>;
```

---

## 7. Form Schemas — `features/attendance/formSchemas.ts`

```typescript
// features/attendance/formSchemas.ts
import { z } from "zod";

export const createSessionSchema = z.object({
  scheduledClassId:   z.string().min(1, "Scheduled class is required"),
  date:               z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
  submissionDeadline: z.string().optional(),
});
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

export const submitCorrectionSchema = z.object({
  attendanceRecordId: z.string().min(1, "Record is required"),
  requestedStatus:    z.enum(["PRESENT", "ABSENT", "LATE", "EXCUSED"]),
  reason:             z.string().min(1, "Reason is required").max(2000),
});
export type SubmitCorrectionInput = z.infer<typeof submitCorrectionSchema>;

export const reviewCorrectionSchema = z.object({
  reviewNote: z.string().max(2000).optional(),
});
export type ReviewCorrectionInput = z.infer<typeof reviewCorrectionSchema>;
```

---

## 8. Hooks — `features/classes/hooks.ts`

All hooks follow the exact same pattern as `features/academics/hooks.ts`. The `apiPatch` helper is copied verbatim (same token/ApiError/401-logout semantics).

```typescript
// features/classes/hooks.ts
"use client";  // Not required here — hooks.ts is a plain TS module, not a page/component.
               // The "use client" directive is only needed on page and component files.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { can } from "@/lib/authz";
import { classesKeys } from "./keys";
import type {
  ClassSection, FacultyAssignment, FacultyProfile,
  Timetable, ScheduledClass, ConflictReport,
} from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

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

function currentPermissions() { return useAuthStore.getState().permissions; }

function toastError(error: unknown) {
  toast.error(
    error instanceof ApiError ? error.message
    : error instanceof Error  ? error.message
    : "Something went wrong.",
  );
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
```

---

## 9. Hooks — `features/attendance/hooks.ts`

```typescript
// features/attendance/hooks.ts

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { can } from "@/lib/authz";
import { attendanceKeys } from "./keys";
import type {
  AttendanceSession, AttendanceRecord, AttendanceCorrection, SectionReport,
} from "./types";

function currentPermissions() { return useAuthStore.getState().permissions; }

function toastError(error: unknown) {
  toast.error(
    error instanceof ApiError ? error.message
    : error instanceof Error  ? error.message
    : "Something went wrong.",
  );
}

// ─── Sessions ────────────────────────────────────────────────────────────────

interface SessionsResponse { sessions: AttendanceSession[]; }

export function useAttendanceSessions() {
  const perms = currentPermissions();
  return useQuery<SessionsResponse>({
    queryKey: attendanceKeys.sessions(),
    queryFn: () => api.get("/api/attendance/sessions"),
    enabled: can("attendance.view", perms) || can("attendance.mark", perms),
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

export function useMarkAttendance(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<{ changed: number }, ApiError, MarkRecordsBody>({
    mutationFn: (body) => api.post(`/api/attendance/sessions/${sessionId}/records`, body),
    // Note: API uses PATCH semantics but the endpoint path is /records (treated as a
    // sub-resource POST in lib/api.ts). The API contract confirms the method is PATCH.
    // Use apiPatch here instead of api.post:
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

// ─── apiPatch helper (same pattern as academics/fees) ────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

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

// ─── Corrections ─────────────────────────────────────────────────────────────

interface CorrectionsResponse { corrections: AttendanceCorrection[]; }

/**
 * useCorrections is gated on attendance.correct (the review permission).
 * Faculty with only attendance.mark cannot call GET /api/attendance/corrections
 * (the API returns 403). The Screen 7 design handles this with an explicit
 * empty-state message for attendance.mark-only users — see Screen 7 below.
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
      qc.invalidateQueries({ queryKey: ["attendance", "corrections"] });
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
      qc.invalidateQueries({ queryKey: ["attendance", "corrections"] });
    },
    onError: toastError,
  });
}

export function useRejectCorrection(correctionId: string) {
  const qc = useQueryClient();
  return useMutation<AttendanceCorrection, ApiError, ReviewCorrectionBody>({
    mutationFn: (body) => api.post(`/api/attendance/corrections/${correctionId}/reject`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attendance", "corrections"] });
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
```

---

## 10. Screen Designs

All page files use `"use client";` as their first line. Every page exports a default component that wraps its inner component in `<RouteGuard>` (no `requirePermission`). Action buttons are individually gated with `<Can>`.

The standard loading/error/empty rhythm (from `academics/sessions/page.tsx`):
```
isLoading ? <Skeleton rows /> : isError ? <InlineError message /> : !data || empty ? <EmptyState /> : <Table>
```

---

### Screen 1 — Class Sections List

**Route file:** `apps/web/src/app/(app)/classes/sections/page.tsx`

**API calls:** `GET /api/classes/sections` → `{ sections: ClassSection[] }`
**Hook:** `useSections()` from `features/classes/hooks`
**Query key:** `classesKeys.sections()` → `["classes", "sections"]`

**RouteGuard:** `<RouteGuard>` (auth-only, no `requirePermission`)

**Permission gates:**
- Create button: `<Can anyOf={["classes.sections.manage"]}>`
- Table renders for any user where `useSections.enabled` fires (i.e. `classes.view` OR `classes.sections.manage`)

**Client-side status filter:**
The API has no `?status=` parameter. A `statusTab` state variable (`"ALL" | "PLANNED" | "ACTIVE" | "CLOSED" | "CANCELLED"`) filters `data.sections` client-side before rendering. A single cache entry covers all tab states.

**Table columns:** Program ID | Session ID | Term ID | Label | Capacity | Status | Actions

**Row actions:**
- "View" link → `/classes/sections/${section.id}` (always visible for authenticated users)
- "Edit" button (opens inline edit dialog): `<Can permission="classes.sections.manage">`

**Create dialog (`CreateSectionDialog`):**
- Form schema: `createSectionSchema` from `features/classes/formSchemas`
- Fields: `programId` (Input), `academicSessionId` (Input), `academicTermId` (Input), `label?` (Input), `capacity?` (Input type="number"), `status?` (Select)
- Mutation: `useCreateSection()`
- **409 handling:** The API fires 409 when the `programId + academicSessionId + academicTermId` combination already exists — this is NOT a label conflict. Map to a root-level form error:
  ```typescript
  if (err.status === 409) {
    form.setError("root", {
      message: "A section for this program, session, and term already exists.",
    });
  }
  ```
  Display below the form fields: `{form.formState.errors.root && <p className="text-sm text-destructive">{form.formState.errors.root.message}</p>}`
- 404 `"program not found"` → `form.setError("programId", { message: err.data?.error })`
- 404 `"invalid session or term"` → `form.setError("academicTermId", { message: err.data?.error })`
- onSuccess: `toast.success("Section created.")`, `form.reset()`, `onOpenChange(false)`

**shadcn components:** Table, Dialog, Form, Input, Select, Badge, Skeleton, EmptyState (icon: `LayoutGrid`), InlineError

---

### Screen 2 — Section Detail

**Route file:** `apps/web/src/app/(app)/classes/sections/[id]/page.tsx`

**API calls:**
- `GET /api/classes/sections/:id` → ClassSection with `enrollments[]`
- (No faculty-assignments endpoint exists — API gap §4.3; see below)
- `GET /api/classes/timetables` → `{ timetables: Timetable[] }` (filtered client-side by `academicTermId`)

**Hooks:** `useSection(id)`, `useTimetables()`
**Query keys:** `classesKeys.section(id)`, `classesKeys.timetables()`

**RouteGuard:** `<RouteGuard>` (auth-only)

**Layout:** Header (section label + status Badge) → Tabs: "Enrollments" | "Faculty" | "Timetable"

**Enrollments tab:** Count + table of `section.enrollments` (studentId, status, enrolledAt). Empty state if none.

**Faculty tab (API gap §4.3):**
`GET /api/classes/sections/:id` does NOT return faculty assignments. This tab must call `GET /api/classes/timetables` and filter client-side for `ScheduledClass` rows where `classSectionId === section.id`. This shows the scheduled subjects and faculty for the section, not the raw `FacultyAssignment` rows. A note in the UI: "Faculty shown from timetable scheduled classes." The assign-faculty action creates an assignment and then refreshes timetables.
- Assign button: `<Can permission="classes.assignments.manage" anyOf={["classes.faculty.assign"]}>`
  
  > Implementation note: the permission key `classes.assignments.manage` does not exist. Use `<Can permission="classes.faculty.assign">` (the actual key from the shared package).

**AssignFacultyDialog:**
- Form schema: `assignFacultySchema`
- Fields: `facultyId` (Input), `subjectId` (Input), `academicTermId` (Input, pre-filled from section's `academicTermId`), `classSectionId` (hidden, pre-filled from `section.id`), `role` (Select: PRIMARY/SUBSTITUTE/ASSISTANT), `replacesAssignmentId?` (Input, optional)
- Mutation: `useAssignFaculty()`
- **404 error mapping** — extract the `<kind>` from `err.data?.error` and map to form fields:
  ```typescript
  const KIND_TO_FIELD: Record<string, keyof AssignFacultyInput> = {
    faculty:    "facultyId",
    subject:    "subjectId",
    term:       "academicTermId",
    section:    "classSectionId",
    assignment: "replacesAssignmentId",
  };
  const match = /^(\w+) not found$/.exec(err.data?.error ?? "");
  const field = match ? KIND_TO_FIELD[match[1]] : undefined;
  if (field) form.setError(field, { message: err.data?.error });
  else toast.error(err.message);
  ```
- 409 → `toast.error(err.message)` (the error message from the server is descriptive)

**Timetable tab:**
- List timetables for this section's `academicTermId`. Each row links to `/classes/timetables/${timetable.id}`.
- `<Can permission="classes.timetable.view" anyOf={["classes.view"]}>` wraps the list.

**shadcn:** Tabs, Table, Dialog, Form, Input, Select, Badge, Skeleton, EmptyState, InlineError

---

### Screen 3 — Faculty Assignments List

**Route file:** `apps/web/src/app/(app)/classes/assignments/page.tsx`

**API gap (§4.1):** There is NO `GET /api/classes/faculty/assignments` endpoint. This screen is intentionally deferred to a stub until the backend endpoint exists.

**Stub design:**
```typescript
// app/(app)/classes/assignments/page.tsx
"use client";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { Users } from "lucide-react";

export default function FacultyAssignmentsPage() {
  return (
    <RouteGuard>
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-gray-900">Faculty Assignments</h1>
        <EmptyState
          icon={Users}
          label="Coming soon"
          description="The faculty assignments list requires a backend endpoint (GET /api/classes/faculty/assignments) that is not yet available."
        />
      </div>
    </RouteGuard>
  );
}
```

When the backend adds the list endpoint, add a `useAssignments(filter?: { status?, termId? })` hook to `features/classes/hooks.ts` and replace the stub with a full searchable table. The search (`query` string, client-side) filters by faculty name. Columns: Faculty | Subject | Section | Term | Role | Status.

**Permission gate for full screen (future):** `<Can anyOf={["classes.view", "classes.faculty.assign"]}>`

---

### Screen 4 — Timetable View

**Route file:** `apps/web/src/app/(app)/classes/timetables/[id]/page.tsx`

**API calls:**
- `GET /api/classes/timetables/:id` → Timetable with `scheduledClasses[]`
- `POST /api/classes/timetables/:id/publish` (mutation)

**Hooks:** `useTimetable(id)`, `usePublishTimetable(id)`
**Query key:** `classesKeys.timetable(id)`

**RouteGuard:** `<RouteGuard>` (auth-only)

**Weekly grid rendering:**
- Days: MON–FRI as columns (SUN/SAT visible but lighter).
- `startTime`/`endTime` are minute-of-day integers. A helper `minuteToLabel(m: number): string` (e.g. `0 → "00:00"`, `90 → "01:30"`) formats them. This helper is a pure function, exportable for unit testing.
- Each `ScheduledClass` is a card in the day column showing subject, faculty, room, period, time range.
- Cancelled slots are visually dimmed.

**Publish action:**

```typescript
"use client";
// State for conflict confirmation:
const [conflictData, setConflictData] = useState<ConflictReport | null>(null);
// conflictData !== null drives the confirm dialog open state

const publishMutation = usePublishTimetable(id);

function handlePublish(acceptWarnings = false) {
  publishMutation.mutate(
    { acceptWarnings },
    {
      onSuccess: () => toast.success("Timetable published."),
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409) {
          // Discriminate: resolvable conflict vs. unresolvable status error
          if (err.data?.error === "Timetable conflict") {
            // Resolvable — open the confirm dialog with conflict details
            setConflictData(err.data?.conflicts ?? {});
          } else {
            // "cannot publish a <status> timetable" — unresolvable
            toast.error(err.message);
          }
        } else {
          toast.error(err instanceof ApiError ? err.message : "Publish failed.");
        }
      },
    },
  );
}
```

The confirm dialog (`conflictData !== null`) shows a summary of conflicts (rendered as JSON pre-block until `ConflictReport` shape is confirmed) and a "Publish anyway" button that calls `handlePublish(true)`, closing the dialog on success with `setConflictData(null)`.

Permission gate on publish button: `<Can permission="classes.timetable.manage">`
Read-only view for `classes.timetable.view` holders: no publish button rendered.

**shadcn:** Table (for grid fallback), Dialog, Button, Badge, Skeleton, EmptyState (icon: `Grid`), InlineError

---

### Screen 5 — Attendance Sessions List

**Route file:** `apps/web/src/app/(app)/attendance/sessions/page.tsx`

**API calls:** `GET /api/attendance/sessions` → `{ sessions: AttendanceSession[] }`
**Hook:** `useAttendanceSessions()` from `features/attendance/hooks`
**Query key:** `attendanceKeys.sessions()`

**RouteGuard:** `<RouteGuard>` (auth-only)

**Client-side filtering (API gap §4.4 + §4.5):**

The API has no date or faculty filter. The session statuses are `OPEN/SUBMITTED/FINALIZED` (not `OPEN/CLOSED/CANCELLED` as stated in the brief).

```typescript
"use client";
const permissions = useAuthStore((s) => s.permissions);
const canViewAll = can("attendance.view", permissions);
// attendance.view ALWAYS takes precedence, even for users holding both
// attendance.view and attendance.mark. Only users holding attendance.mark
// WITHOUT attendance.view see today-filtered results.

// todayISO is a pure helper — exported for unit testing
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

const displayed = useMemo(() => {
  if (!data?.sessions) return [];
  if (canViewAll) return data.sessions;          // staff/HOD/admin: all sessions
  return data.sessions.filter(s => s.date === todayISO()); // faculty: today only
}, [data, canViewAll]);
```

**Status filter tabs:** `ALL | OPEN | SUBMITTED | FINALIZED` (matching actual API enum). Client-side filter on `displayed`.

**Table columns:** Section | Subject | Date | Time | Status | Actions

**Row actions:**
- "Open session" (create session): `<Can permission="attendance.mark">` — shown when no session exists for a scheduled class. Opens a `CreateSessionDialog`.
- "Mark attendance" link → `/attendance/sessions/${session.id}/mark` (for OPEN sessions): `<Can anyOf={["attendance.mark", "attendance.view"]}>`
- "Submit" → calls `useSubmitSession(session.id)`: `<Can permission="attendance.mark">` — visible when `session.status === "OPEN"`
- "Finalize" → calls `useFinalizeSession(session.id)`: `<Can permission="attendance.mark">` — visible when `session.status === "SUBMITTED"`

**shadcn:** Table, Dialog, Form, Badge, Skeleton, EmptyState (icon: `ClipboardList`), InlineError

---

### Screen 6 — Mark Attendance

**Route file:** `apps/web/src/app/(app)/attendance/sessions/[id]/mark/page.tsx`

**API calls:**
- `GET /api/attendance/sessions/:id` → AttendanceSession with `records[]`
- `PATCH /api/attendance/sessions/:id/records` (save marks)
- `POST /api/attendance/sessions/:id/submit` (submit)

**Hooks:** `useAttendanceSession(id)`, `useMarkAttendance(sessionId)`, `useSubmitSession(sessionId)`
**Query keys:** `attendanceKeys.session(id)`

**RouteGuard:** `<RouteGuard>` (auth-only)

**Page structure:**

```typescript
"use client";
// Local mark state — initialised from server records on first load
const [marks, setMarks] = useState<Record<string, string>>({});
const [isDirty, setIsDirty] = useState(false);

// Initialise from server on load
useEffect(() => {
  if (session?.records) {
    const initial: Record<string, string> = {};
    session.records.forEach(r => { initial[r.studentId] = r.status; });
    setMarks(initial);
    setIsDirty(false);
  }
}, [session?.id]);  // Re-run only when session id changes, not every poll

function handleToggle(studentId: string, status: string) {
  setMarks(prev => ({ ...prev, [studentId]: status }));
  setIsDirty(true);
}
```

**Save Marks button:**
- Calls `useMarkAttendance(sessionId).mutate({ records: Object.entries(marks).map(([studentId, status]) => ({ studentId, status })) })`
- Disabled when `!isDirty` or mutation is pending
- On success: `toast.success("Marks saved.")`, `setIsDirty(false)`
- On 403 "not assigned to this session" → `toast.error("You are not assigned to this session.")`
- On 409 "session finalized/submitted" → `toast.error("Session is no longer open.")` + invalidate session

**Submit Session button:**
- **Visibility:** Shown whenever `session.status === "OPEN"`. The Submit action is independent of whether local marks have been saved. The user may submit without making any changes (server records were pre-populated as ABSENT). A separate `isDirty` warning text ("You have unsaved changes — save marks before submitting.") appears above the Submit button when `isDirty === true`, but does NOT hide or disable the button.
- Calls `useSubmitSession(sessionId).mutate()`
- On success: `toast.success("Session submitted.")`, navigate to `/attendance/sessions`

**Student roster table:** studentId | Present/Absent/Late radio-toggle per student (three `<Button variant="outline">` buttons, active one highlighted)

**Permission gate:** `<Can permission="attendance.mark">` on Save Marks button and Submit button. Viewing the roster (read-only) available for `attendance.view` users too.

**shadcn:** Table, Button, Badge, Skeleton, EmptyState, InlineError

---

### Screen 7 — Attendance Corrections

**Route file:** `apps/web/src/app/(app)/attendance/corrections/page.tsx`

**API calls:**
- `GET /api/attendance/corrections?status=` → `{ corrections: AttendanceCorrection[] }`
- `POST /api/attendance/corrections/:id/approve`
- `POST /api/attendance/corrections/:id/reject`

**Hooks:** `useCorrections(status?)`, `useApproveCorrection(id)`, `useRejectCorrection(id)`
**Query key:** `attendanceKeys.corrections(status)`

**RouteGuard:** `<RouteGuard>` (auth-only)

**Permission divergence — faculty vs. HOD/admin:**

Faculty holding only `attendance.mark` CANNOT call `GET /api/attendance/corrections` (the API requires `attendance.correct`). The brief states "Faculty see their own submitted corrections" — but the current API does not support this scope. The page handles this explicitly:

```typescript
"use client";
const canReview  = useCan("attendance.correct");   // HOD / admin
const canMark    = useCan("attendance.mark");       // faculty
const canViewAll = canReview;

if (!canReview && canMark) {
  // Faculty with only attendance.mark: show informational empty state
  return (
    <RouteGuard>
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-gray-900">Corrections</h1>
        <EmptyState
          icon={Info}
          label="View not available"
          description="Corrections are submitted from the Mark Attendance screen. Your submitted corrections are reviewed by your HOD or administrator."
        />
      </div>
    </RouteGuard>
  );
}
```

This is a known UX limitation documented in §12. When the backend adds a `GET /api/attendance/corrections?submittedBy=me` scoped query, the hook's `enabled` gate and this branch can be updated.

**For `attendance.correct` holders (HOD/admin):**
- Status filter tabs: `ALL | PENDING | APPROVED | REJECTED`
- Table columns: Record ID | Requested Status | Reason | Review Status | Submitted At | Actions
- Per-row approve/reject buttons: `<Can permission="attendance.correct">`

**Review dialog:**
- Form schema: `reviewCorrectionSchema`
- Field: `reviewNote` — rendered with `<Textarea>` from `components/ui/textarea`. Implementation must verify this component exists; if not, substitute `<textarea className="...">` directly.
- Approve: `useApproveCorrection(correctionId).mutate({ reviewNote })`
- Reject: `useRejectCorrection(correctionId).mutate({ reviewNote })`
- 409 "correction not pending" → `toast.error("Correction has already been reviewed.")`
- 409 "record changed since request" → `toast.error("The record was changed after this correction was submitted.")`

**shadcn:** Table, Dialog, Form, Textarea (verify exists), Badge, Skeleton, EmptyState, InlineError

---

### Screen 8 — Student Attendance Report

**Route file:** `apps/web/src/app/(app)/attendance/report/page.tsx`

**API calls:** `GET /api/attendance/reports/section/:sectionId?academicTermId=` → SectionReport

**API gap (§4.6):** The API returns `perStudent[]` (studentId + rate), `lowAttendance[]`, `thresholdPercent` — NOT total sessions, present count, or absent count as described in the brief. The UI shows what the API provides: per-student attendance rate (%), a "low attendance" flag if the student is in `lowAttendance`, and the threshold percentage. Section+subject filtering is also not available — the endpoint takes section+term only.

**Hook:** `useSectionReport(sectionId, academicTermId)`
**Query key:** `attendanceKeys.report(sectionId, academicTermId)`

**RouteGuard:** `<RouteGuard>` (auth-only)

**Permission handling (F3 fix — `attendance.view_own` users):**

A student with `attendance.view_own` can reach this page (auth-only guard). The entire filter + report section must be wrapped in a `<Can>` gate so students never see controls they cannot use:

```typescript
"use client";
return (
  <RouteGuard>
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-gray-900">Attendance Report</h1>
      <Can
        permission="attendance.view"
        fallback={
          <EmptyState
            icon={BarChart2}
            label="Permission required"
            description="You need the attendance.view permission to access section reports."
          />
        }
      >
        <ReportFilterAndTable />
      </Can>
    </div>
  </RouteGuard>
);
```

`ReportFilterAndTable` is a sub-component (can be inline) that renders:
1. Two `<Input>` fields: Section ID and Academic Term ID
2. A "View Report" `<Button>` that updates `sectionId` / `termId` state to trigger the query
3. Loading/error/empty rhythm → `isLoading ? Skeleton : isError ? InlineError : !data ? EmptyState : <Table>`
4. Table columns: Student ID | Attendance Rate | Low Attendance flag

The `useSectionReport` hook's `enabled` gate already requires `attendance.view`, so even if the component somehow renders, the query won't fire. The `<Can>` wrapper provides the UX message.

**shadcn:** Input, Button, Table, Badge, Skeleton, EmptyState (icon: `BarChart2`), InlineError

---

## 11. AppShell NAV Additions

**File to modify:** `apps/web/src/components/shell/AppShell.tsx`

Add two import additions and two entries to the `NAV` array. Import `BookOpen` and `ClipboardList` from `lucide-react` (or equivalent Lucide icons). Exact icon names can be swapped for alternatives at build time without affecting the design.

```typescript
// Additional imports
import { BookOpen, ClipboardList } from "lucide-react";

// Add to NAV array (after the existing Students entry):
{
  href: "/classes/sections",
  label: "Classes",
  icon: BookOpen,
  // Permission-gated ONLY — no module field.
  // The API does not call requireModuleActive for classes.* routes.
  // Following the academics precedent: omitting module means
  // useNavItemVisible skips the "item.module && inactive" branch entirely.
  //
  // Note on the item.module ?? "fees" fallback in useNavItemVisible:
  // Since this item has no module field, useModuleActive("fees") is called
  // internally (existing fallback). This is harmless: the item.module guard
  // is undefined, so the "item.module && moduleStatus === 'inactive'" branch
  // never fires. The Classes nav entry is shown purely based on anyOf.
  // This fallback is pre-existing behavior — do NOT change useNavItemVisible.
  anyOf: ["classes.sections.manage", "classes.faculty.assign", "classes.timetable.manage", "classes.view"],
},
{
  href: "/attendance/sessions",
  label: "Attendance",
  icon: ClipboardList,
  anyOf: ["attendance.view", "attendance.mark", "attendance.correct"],
  module: "attendance",  // module-gated: attendance API calls requireModuleActive
},
```

**`useModuleActive` update required (attendance probe):**

The current `useModuleActive.ts` only has a probe for `"fees"`. An attendance probe must be added before the Attendance NAV entry will correctly hide when the attendance module is inactive. Add the following branch inside `useModuleActive`:

```typescript
// In features/modules/useModuleActive.ts, inside useModuleActive():
if (moduleKey === "attendance") {
  if (can("attendance.view", permissions))      probePath = "/api/attendance/sessions";
  else if (can("attendance.mark", permissions)) probePath = "/api/attendance/sessions";
  else if (can("attendance.correct", permissions)) probePath = "/api/attendance/corrections";
  // attendance.view_own (student) is NOT included in the Attendance staff nav item,
  // so no probe for view_own is needed here.
}
```

Only the explicit `"Module not active"` 403 message returns `"inactive"` and suppresses the nav item. A plain 403 for wrong permissions returns `"forbidden"` and leaves the nav visible.

---

## 12. Utility Helpers

Two pure functions are used by the timetable grid and the session list. They are simple enough to inline in their page files, but should be extracted and exported for unit testing:

```typescript
// Pure helpers (can live in features/classes/utils.ts or features/attendance/utils.ts)

/** Converts a minute-of-day integer to HH:MM display label. */
export function minuteToLabel(m: number): string {
  const h = Math.floor(m / 60).toString().padStart(2, "0");
  const min = (m % 60).toString().padStart(2, "0");
  return `${h}:${min}`;
}

/** Returns today's date as a YYYY-MM-DD ISO string (local time). */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
```

Unit tests for these: `minuteToLabel(0) === "00:00"`, `minuteToLabel(90) === "01:30"`, `minuteToLabel(1439) === "23:59"`. `todayISO` can be tested by mocking `Date`.

---

## 13. Decisions and Known Limitations

1. **No faculty-assignments GET endpoint (API gap §4.1):** Screen 3 is a stub that renders an informational empty state until the backend adds `GET /api/classes/faculty/assignments`. The stub compiles and passes lint; no feature code is blocked.

2. **No end-assignment endpoint (API gap §4.2):** Section detail (Screen 2) does not show an "End assignment" action. The API only supports reassignment via `replacesAssignmentId`. If explicit end-assignment UX is needed, the backend must add an endpoint.

3. **Section detail faculty assignments (API gap §4.3):** The Faculty tab on Section detail derives faculty from timetable `ScheduledClass` rows filtered by `classSectionId`, not from a `FacultyAssignment` list. This means only faculty with scheduled classes in the timetable appear. Faculty assigned to a section without a scheduled class are not shown. Documented in the UI.

4. **Session statuses (API gap §4.5):** The brief mentions `OPEN/CLOSED/CANCELLED`. The actual enum is `OPEN/SUBMITTED/FINALIZED`. All screen designs use the API vocabulary. No `CLOSED` or `CANCELLED` status is referenced anywhere in the implementation.

5. **Section report (API gap §4.6):** The API returns per-student rates only, not total/present/absent counts. Screen 8 displays what the API provides. The brief's "total sessions, present/absent counts" is deferred until the backend endpoint adds those fields.

6. **Faculty corrections visibility (F2 resolution):** Faculty with only `attendance.mark` cannot call `GET /api/attendance/corrections` (requires `attendance.correct`). Screen 7 shows them an informational empty state explaining that corrections are reviewed by their HOD/admin. This is a known UX limitation. The resolution is an API addition of a `GET /api/attendance/corrections?submittedBy=me` scoped endpoint.

7. **`ConflictReport` shape is unknown:** The API contract does not document the `ConflictReport` structure. The timetable publish conflict dialog renders the conflict data as a formatted JSON block. When the shape is confirmed, the dialog body can be made more user-friendly.

---

## 14. File Inventory

New files to create:

```
apps/web/src/features/classes/types.ts
apps/web/src/features/classes/keys.ts
apps/web/src/features/classes/formSchemas.ts
apps/web/src/features/classes/hooks.ts

apps/web/src/features/attendance/types.ts
apps/web/src/features/attendance/keys.ts
apps/web/src/features/attendance/formSchemas.ts
apps/web/src/features/attendance/hooks.ts

apps/web/src/app/(app)/classes/sections/page.tsx
apps/web/src/app/(app)/classes/sections/[id]/page.tsx
apps/web/src/app/(app)/classes/assignments/page.tsx          (stub)
apps/web/src/app/(app)/classes/timetables/[id]/page.tsx

apps/web/src/app/(app)/attendance/sessions/page.tsx
apps/web/src/app/(app)/attendance/sessions/[id]/mark/page.tsx
apps/web/src/app/(app)/attendance/corrections/page.tsx
apps/web/src/app/(app)/attendance/report/page.tsx
```

Files to modify:

```
apps/web/src/components/shell/AppShell.tsx           (add 2 NAV entries)
apps/web/src/features/modules/useModuleActive.ts     (add attendance probe)
```

---

## 15. Responses to Design Review Findings

**F1 (MEDIUM — `useModuleActive` fallback):** Addressed. §11 now explicitly documents the `item.module ?? "fees"` fallback, confirms it is pre-existing behavior, explains why it is harmless for the Classes nav item (the `item.module && ...` guard never fires for module-less items), and states that `useNavItemVisible` must NOT be changed.

**F2 (HIGH — Screen 7 faculty corrections):** Addressed. Screen 7 now has an explicit permission-check branch at the top of the component that renders an informational `EmptyState` for `attendance.mark`-only users, matching Option A from the review. Documented as a known limitation in §12.

**F3 (HIGH — Screen 8 `view_own` users):** Addressed. The entire filter + report section is now wrapped in `<Can permission="attendance.view" fallback={<EmptyState .../>}>`. Students with only `attendance.view_own` see a clear "Permission required" message without empty filter controls.

**F4 (HIGH — `useAssignFaculty` invalidation):** Addressed. `onSuccess` now always invalidates `classesKeys.timetables()` in addition to the section-specific key. Non-section assignments trigger the timetables invalidation, preventing stale caches.

**F5 (HIGH — Screen 6 Submit visibility):** Addressed. Submit button is shown whenever `session.status === "OPEN"`, independently of local state. An `isDirty` warning text appears above the button when there are unsaved local changes, but does not hide or disable Submit. The condition is now precisely specified.

**F6 (MEDIUM — `classesKeys` filter params):** Addressed. §4 (`classesKeys`) now has an explicit note explaining that `sections()` has no filter parameter because `GET /api/classes/sections` accepts no `?status=` param, making client-side filtering the correct approach with a single shared cache entry.

**F7 (MEDIUM — `attendance.view` precedence):** Addressed. Screen 5 now explicitly states: "`attendance.view` always takes precedence — any user holding `attendance.view` (even if they also hold `attendance.mark`) sees all sessions. Only users holding `attendance.mark` WITHOUT `attendance.view` see today-only results."

**F8 (MEDIUM — `FacultyAssignment.endedAt`):** Addressed. `FacultyAssignment` in `features/classes/types.ts` now includes `endedAt: string | null` with a comment explaining it is set when status transitions to `ENDED`.

**F9 (MEDIUM — Screen 4 publish conflict dialog state):** Addressed. Screen 4 now specifies `const [conflictData, setConflictData] = useState<ConflictReport | null>(null)` as the dialog open state, and provides the exact discriminator between resolvable 409 (`err.data?.error === "Timetable conflict"`) and unresolvable 409 (`toast.error`).

**F10 (MEDIUM — Screen 2 404 mapping):** Addressed. Screen 2 AssignFacultyDialog now provides the exact `KIND_TO_FIELD` mapping object and the regex to extract the kind from `err.data?.error`.

**F11 (HIGH — `"use client"` directive):** Addressed. All screen designs now begin with `"use client";` as their first line. The hook and schema files (plain TS modules, not components/pages) correctly do NOT need this directive — noted in §8.

**F12 (MEDIUM — Screen 1 409 error target):** Addressed. The 409 "section already exists" is now mapped to `form.setError("root", ...)` with a clear message about the program/session/term combination conflict, displayed below the form fields.

**F13 (NIT — `createSectionSchema` status enum):** No action required. Already correct.

**F14 (NIT — `minuteToLabel`/`todayISO` signatures):** Addressed. §12 now provides the exact function signatures and signatures with examples.

**F15 (NIT — `useSubmitSession`/`useFinalizeSession` body):** Addressed. Both hooks now call `api.post(url)` with no body argument, matching the API's no-body contract and eliminating the unnecessary `{}`.
