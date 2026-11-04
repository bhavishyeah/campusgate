import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { can } from "@/lib/authz";
import { examsKeys } from "./keys";
import { EXAM_PERM } from "./permissions";
import type {
  Assessment,
  Candidate,
  Exam,
  ExamDistribution,
  ExamRollups,
  ExamSchedule,
  ExamStatusTarget,
  ExaminationType,
  GradingBand,
  GradingScheme,
  MarksRecord,
  MarksSheet,
  MyMarkingExam,
  MyResultDetail,
  MyResultExam,
  MyResultHistoryEntry,
  PublishResult,
  Result,
  WrittenMarkRecord,
} from "./types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

/** PATCH helper: lib/api.ts has no patch; same Bearer/ApiError/401 semantics. */
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

/** Standard mutation-error surface: a non-blocking toast of the server message. */
export function toastError(error: unknown): void {
  const message =
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Something went wrong.";
  toast.error(message);
}

/** Authenticated blob download (XLSX endpoints). */
export async function downloadFile(endpoint: string, fallbackName: string): Promise<void> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(`${API_BASE}${endpoint}`, { headers });
  if (!response.ok) {
    if (response.status === 401) useAuthStore.getState().logout();
    const data = await response.json().catch(() => ({}));
    throw new ApiError(response.status, data);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = match ? match[1] : fallbackName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// ─── Query hooks ─────────────────────────────────────────────────────────────

export function useExams() {
  return useQuery<{ examinations: Exam[] }>({
    queryKey: examsKeys.exams(),
    queryFn: () => api.get("/api/exams"),
    enabled: can(EXAM_PERM.view, currentPermissions()),
  });
}

export function useExam(id: string) {
  return useQuery<Exam>({
    queryKey: examsKeys.exam(id),
    queryFn: () => api.get(`/api/exams/${id}`),
    enabled: Boolean(id) && can(EXAM_PERM.view, currentPermissions()),
  });
}

export function useExamSchedules(id: string) {
  return useQuery<{ schedules: ExamSchedule[] }>({
    queryKey: examsKeys.schedules(id),
    queryFn: () => api.get(`/api/exams/${id}/schedules`),
    enabled: Boolean(id) && can(EXAM_PERM.view, currentPermissions()),
  });
}

export function useExamCandidates(id: string) {
  return useQuery<{ candidates: Candidate[] }>({
    queryKey: examsKeys.candidates(id),
    queryFn: () => api.get(`/api/exams/${id}/candidates`),
    enabled: Boolean(id) && can(EXAM_PERM.view, currentPermissions()),
  });
}

export function useExamAssessments(id: string) {
  return useQuery<{ assessments: Assessment[] }>({
    queryKey: examsKeys.assessments(id),
    queryFn: () => api.get(`/api/exams/${id}/assessments`),
    enabled: Boolean(id) && can(EXAM_PERM.view, currentPermissions()),
  });
}

export function useExamMarks(id: string) {
  return useQuery<{ marks: MarksRecord[] }>({
    queryKey: examsKeys.marks(id),
    queryFn: () => api.get(`/api/exams/${id}/marks`),
    enabled: Boolean(id) && can(EXAM_PERM.view, currentPermissions()),
  });
}

export function useMyMarking() {
  return useQuery<{ exams: MyMarkingExam[] }>({
    queryKey: examsKeys.myMarking(),
    queryFn: () => api.get("/api/exams/my-marking"),
    enabled: can(EXAM_PERM.marksEnter, currentPermissions()),
    retry: false,
  });
}

export function useMarksSheet(examId: string) {
  return useQuery<MarksSheet>({
    queryKey: examsKeys.marksSheet(examId),
    queryFn: () => api.get(`/api/exams/${examId}/marks-sheet`),
    enabled: Boolean(examId) && can(EXAM_PERM.marksEnter, currentPermissions()),
    retry: false,
  });
}

export function useExamResults(id: string) {
  return useQuery<Result>({
    queryKey: examsKeys.results(id),
    queryFn: () => api.get(`/api/exams/${id}/results`),
    enabled: Boolean(id) && can(EXAM_PERM.view, currentPermissions()),
  });
}

export function useExamDistribution(id: string) {
  return useQuery<ExamDistribution>({
    queryKey: examsKeys.distribution(id),
    queryFn: () => api.get(`/api/exams/${id}/results/distribution`),
    enabled: Boolean(id) && can(EXAM_PERM.view, currentPermissions()),
  });
}

export function useExamRollups(id: string) {
  return useQuery<ExamRollups>({
    queryKey: examsKeys.rollups(id),
    queryFn: () => api.get(`/api/exams/${id}/results/rollups`),
    enabled: Boolean(id) && can(EXAM_PERM.view, currentPermissions()),
  });
}

export function useGradingSchemes() {
  return useQuery<{ gradingSchemes: GradingScheme[] }>({
    queryKey: examsKeys.gradingSchemes(),
    queryFn: () => api.get("/api/exams/grading-schemes"),
    enabled: can(EXAM_PERM.view, currentPermissions()),
  });
}

export function useMyResults() {
  return useQuery<{ results: MyResultExam[] }>({
    queryKey: examsKeys.myResults(),
    queryFn: () => api.get("/api/exams/me/results"),
    enabled: can(EXAM_PERM.viewOwn, currentPermissions()),
  });
}

export function useMyResult(examId: string) {
  return useQuery<MyResultDetail>({
    queryKey: examsKeys.myResult(examId),
    queryFn: () => api.get(`/api/exams/me/results/${examId}`),
    enabled: Boolean(examId) && can(EXAM_PERM.viewOwn, currentPermissions()),
    retry: false,
  });
}

export function useMyResultsHistory() {
  return useQuery<{ history: MyResultHistoryEntry[] }>({
    queryKey: examsKeys.myHistory(),
    queryFn: () => api.get("/api/exams/me/results/history"),
    enabled: can(EXAM_PERM.viewOwn, currentPermissions()),
  });
}

// ─── Mutation hooks ──────────────────────────────────────────────────────────

export interface CreateExamBody {
  academicSessionId: string;
  academicTermId: string;
  programId: string;
  name: string;
  type: ExaminationType;
  parentExaminationId?: string;
}

export function useCreateExam() {
  const qc = useQueryClient();
  return useMutation<Exam, ApiError, CreateExamBody>({
    mutationFn: (body) => api.post("/api/exams", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: examsKeys.exams() });
    },
    onError: toastError,
  });
}

/** No default toast: the detail screen maps 400/403/409 itself. */
export function useUpdateExamStatus(id: string) {
  const qc = useQueryClient();
  return useMutation<{ id: string; status: string }, ApiError, { to: ExamStatusTarget }>({
    mutationFn: (body) => api.post(`/api/exams/${id}/status`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: examsKeys.exam(id) });
    },
  });
}

export interface AddScheduleBody {
  subjectId: string;
  room: string;
  roomCapacity: number;
  startsAt: string;
  endsAt: string;
}

export function useAddSchedule(id: string) {
  const qc = useQueryClient();
  return useMutation<ExamSchedule, ApiError, AddScheduleBody>({
    mutationFn: (body) => api.post(`/api/exams/${id}/schedules`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: examsKeys.schedules(id) });
    },
  });
}

export function useRegisterCandidate(id: string) {
  const qc = useQueryClient();
  return useMutation<
    { registered: number; candidateIds: string[] },
    ApiError,
    { studentIds: string[] }
  >({
    mutationFn: (body) => api.post(`/api/exams/${id}/candidates`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: examsKeys.candidates(id) });
    },
    onError: toastError,
  });
}

export function useAllocateCandidates(id: string, scheduleId: string) {
  const qc = useQueryClient();
  return useMutation<
    { allocated: number; occupied: number },
    ApiError,
    { candidateIds: string[] }
  >({
    mutationFn: (body) =>
      api.post(`/api/exams/${id}/schedules/${scheduleId}/allocate`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: examsKeys.schedules(id) });
      qc.invalidateQueries({ queryKey: examsKeys.candidates(id) });
    },
    onError: toastError,
  });
}

export function useRegisterSupplementary(id: string) {
  const qc = useQueryClient();
  return useMutation<
    { eligibleCount: number; registered: number; candidateIds: string[] },
    ApiError,
    { subjectIds: string[]; studentIds?: string[] }
  >({
    mutationFn: (body) => api.post(`/api/exams/${id}/candidates/supplementary`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: examsKeys.candidates(id) });
    },
    onError: toastError,
  });
}

export type UpsertAssessmentBody =
  | { assessmentId?: undefined; subjectId: string; name: string; maxMarks: number; weight: number }
  | {
      assessmentId: string;
      patch: { name?: string; maxMarks?: number; weight?: number };
    };

/** Create (POST) when assessmentId is absent, update (PATCH) when present. */
export function useUpsertAssessment(id: string) {
  const qc = useQueryClient();
  return useMutation<Assessment, ApiError, UpsertAssessmentBody>({
    mutationFn: (body) => {
      if (body.assessmentId !== undefined) {
        return apiPatch<Assessment>(
          `/api/exams/${id}/assessments/${body.assessmentId}`,
          body.patch,
        );
      }
      const { subjectId, name, maxMarks, weight } = body;
      return api.post<Assessment>(`/api/exams/${id}/assessments`, {
        subjectId,
        name,
        maxMarks,
        weight,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: examsKeys.assessments(id) });
    },
  });
}

export interface MarkEntry {
  assessmentId: string;
  candidateId: string;
  marks: number;
}

/** No default toast: the marks screens map 400/403/409 themselves. */
export function useEnterMarks(id: string) {
  const qc = useQueryClient();
  return useMutation<
    { written: number; records: WrittenMarkRecord[] },
    ApiError,
    { marks: MarkEntry[] }
  >({
    mutationFn: (body) => api.put(`/api/exams/${id}/marks`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: examsKeys.marks(id) });
      qc.invalidateQueries({ queryKey: examsKeys.marksSheet(id) });
    },
  });
}

export function useCorrectMarks(id: string) {
  const qc = useQueryClient();
  return useMutation<
    { marksRecordId: string },
    ApiError,
    { recordId: string; marks: number; reason: string }
  >({
    mutationFn: ({ recordId, marks, reason }) =>
      api.post(`/api/exams/${id}/marks/${recordId}/correct`, { marks, reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: examsKeys.marks(id) });
    },
  });
}

export interface GradingSchemeBody {
  name: string;
  isActive?: boolean;
  bands: Omit<GradingBand, "ordinal">[];
}

export function useCreateGradingScheme() {
  const qc = useQueryClient();
  return useMutation<Omit<GradingScheme, "bands">, ApiError, GradingSchemeBody>({
    mutationFn: (body) => api.post("/api/exams/grading-schemes", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: examsKeys.gradingSchemes() });
    },
  });
}

export function useUpdateGradingScheme(id: string) {
  const qc = useQueryClient();
  return useMutation<{ id: string }, ApiError, Partial<GradingSchemeBody>>({
    mutationFn: (body) => apiPatch(`/api/exams/grading-schemes/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: examsKeys.gradingSchemes() });
    },
  });
}

// ─── Publish (step-up gated) ─────────────────────────────────────────────────

/** Thrown when the publish route replies 401 { error: "Step-up required" }. */
export class StepUpRequiredError extends Error {
  constructor() {
    super("Step-up required");
    this.name = "StepUpRequiredError";
  }
}

async function publishRequest(
  examId: string,
  body: { reason?: string },
  stepUpToken?: string,
): Promise<PublishResult> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (stepUpToken) headers["x-step-up"] = stepUpToken;
  const response = await fetch(`${API_BASE}/api/exams/${examId}/publish`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      // The step-up gate also answers 401; only a real session expiry logs out.
      if (data?.error === "Step-up required") throw new StepUpRequiredError();
      useAuthStore.getState().logout();
    }
    throw new ApiError(response.status, data);
  }
  return data as PublishResult;
}

export function usePublishExam(id: string) {
  const qc = useQueryClient();
  return useMutation<PublishResult, ApiError | StepUpRequiredError, { reason?: string; stepUpToken?: string }>({
    mutationFn: ({ reason, stepUpToken }) =>
      publishRequest(id, reason ? { reason } : {}, stepUpToken),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: examsKeys.results(id) });
      qc.invalidateQueries({ queryKey: examsKeys.exam(id) });
    },
  });
}
