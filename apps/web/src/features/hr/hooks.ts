// features/hr/hooks.ts
// No "use client": hooks files are plain TS modules (mirrors features/library/hooks.ts).
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
import { hrKeys } from "./keys";
import type {
  AttendanceRow,
  AttendanceSummaryRow,
  Contract,
  Employee,
  EmployeeBrief,
  EmployeeDetail,
  HrLookups,
  LeaveApplication,
  LeaveBalance,
  LeavePolicy,
  LeaveQueueRow,
  LeaveSummaryRow,
  Paged,
  RosterRow,
  Shift,
  UserLookupItem,
} from "./types";

export const PAGE_SIZE = 20;
export const ROSTER_PAGE_SIZE = 50;

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

function invalidate(qc: QueryClient, keys: readonly (readonly unknown[])[]): void {
  for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
}

const REPORTS_KEY = ["hr", "reports"] as const;

// ─── Employees ───────────────────────────────────────────────────────────────
export interface EmployeeFilters {
  q?: string;
  status?: string;
  departmentId?: string;
  employmentType?: string;
  page: number;
}

export function useEmployees(filters: EmployeeFilters) {
  const allowed = can("hr.directory.view", usePerms());
  const q = useQuery<Paged & { employees: EmployeeBrief[] }, ApiError>({
    queryKey: hrKeys.employees(filters),
    queryFn: () =>
      api.get(
        `/api/hr/employees${qs({
          q: filters.q,
          status: filters.status,
          departmentId: filters.departmentId,
          employmentType: filters.employmentType,
          page: filters.page,
          pageSize: PAGE_SIZE,
        })}`,
      ),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useEmployee(id: string | undefined) {
  const allowed = can("hr.directory.view", usePerms());
  const q = useQuery<EmployeeDetail, ApiError>({
    queryKey: hrKeys.employee(id ?? ""),
    queryFn: () => api.get(`/api/hr/employees/${id}`),
    enabled: allowed && Boolean(id),
  });
  return withAllowed(q, allowed);
}

export function useHrLookups() {
  const allowed = can("hr.employees.manage", usePerms());
  const q = useQuery<HrLookups, ApiError>({
    queryKey: hrKeys.lookups(),
    queryFn: () => api.get("/api/hr/lookups"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useUserLookup(search: string) {
  const allowed = can("hr.employees.manage", usePerms());
  const term = search.trim();
  const q = useQuery<{ users: UserLookupItem[] }, ApiError>({
    queryKey: hrKeys.userLookup(term),
    queryFn: () => api.get(`/api/hr/users/lookup${qs({ q: term, limit: 10 })}`),
    enabled: allowed && term.length >= 2,
  });
  return withAllowed(q, allowed);
}

/** toast:false: the dialog renders the error inline. */
export function useCreateEmployee() {
  const qc = useQueryClient();
  return useMutation<Employee, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/hr/employees", body),
    onSuccess: () => invalidate(qc, [hrKeys.employeesAll(), hrKeys.lookups()]),
  });
}

/** toast:false: the dialog renders the error inline. */
export function usePatchEmployee(id: string) {
  const qc = useQueryClient();
  return useMutation<Employee, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.patch(`/api/hr/employees/${id}`, body),
    onSuccess: () => invalidate(qc, [hrKeys.employeesAll()]),
  });
}

// ─── Contracts ───────────────────────────────────────────────────────────────
export function useContracts(id: string | undefined, enabled = true) {
  const allowed = can("hr.directory.view", usePerms());
  const q = useQuery<{ contracts: Contract[] }, ApiError>({
    queryKey: hrKeys.contracts(id ?? ""),
    queryFn: () => api.get(`/api/hr/employees/${id}/contracts`),
    enabled: allowed && Boolean(id) && enabled,
  });
  return withAllowed(q, allowed);
}

/** toast:false: the dialog renders the error inline. */
export function useCreateContract(id: string) {
  const qc = useQueryClient();
  return useMutation<Contract, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/hr/employees/${id}/contracts`, body),
    onSuccess: () => invalidate(qc, [hrKeys.contracts(id)]),
  });
}

/** toast:false: the dialog renders the error inline. */
export function useSupersedeContract(id: string) {
  const qc = useQueryClient();
  return useMutation<Contract, ApiError, { contractId: string; body: Record<string, unknown> }>({
    mutationFn: ({ contractId, body }) => api.post(`/api/hr/employees/${id}/contracts/${contractId}/supersede`, body),
    onSuccess: () => invalidate(qc, [hrKeys.contracts(id)]),
    onError: (err) => {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) invalidate(qc, [hrKeys.contracts(id)]);
    },
  });
}

export function useEndContract(id: string) {
  const qc = useQueryClient();
  return useMutation<Contract, ApiError, string>({
    // Bodyless POST: api.ts always sends a JSON content type, so pass {} (the handler parses nothing).
    mutationFn: (contractId) => api.post(`/api/hr/employees/${id}/contracts/${contractId}/end`, {}),
    onSuccess: () => invalidate(qc, [hrKeys.contracts(id)]),
    onError: (e) => {
      toastError(e);
      invalidate(qc, [hrKeys.contracts(id)]);
    },
  });
}

// ─── Leave ───────────────────────────────────────────────────────────────────
export function useLeavePolicies() {
  const allowed = can("hr.directory.view", usePerms());
  const q = useQuery<{ leavePolicies: LeavePolicy[] }, ApiError>({
    queryKey: hrKeys.policies(),
    queryFn: () => api.get("/api/hr/leave-policies"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

/** toast:false: the dialog renders the error inline. */
export function usePutLeavePolicy() {
  const qc = useQueryClient();
  return useMutation<LeavePolicy, ApiError, { leaveType: string; body: Record<string, unknown> }>({
    mutationFn: ({ leaveType, body }) => api.put(`/api/hr/leave-policies/${leaveType}`, body),
    onSuccess: () => invalidate(qc, [hrKeys.policies(), REPORTS_KEY, ["hr", "employees"], ["hr", "me", "balance"]]),
  });
}

export interface LeaveQueueFilters {
  status?: string;
  leaveType?: string;
  employeeId?: string;
  page: number;
}

export function useLeaveQueue(filters: LeaveQueueFilters) {
  const allowed = can("hr.leave.manage", usePerms());
  const q = useQuery<Paged & { leaveApplications: LeaveQueueRow[] }, ApiError>({
    queryKey: hrKeys.leaveQueue(filters),
    queryFn: () =>
      api.get(
        `/api/hr/leave${qs({
          status: filters.status,
          leaveType: filters.leaveType,
          employeeId: filters.employeeId,
          page: filters.page,
          pageSize: PAGE_SIZE,
        })}`,
      ),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useEmployeeLeave(id: string | undefined, enabled = true) {
  const allowed = can("hr.directory.view", usePerms());
  const q = useQuery<{ leaveApplications: LeaveApplication[] }, ApiError>({
    queryKey: hrKeys.empLeave(id ?? ""),
    queryFn: () => api.get(`/api/hr/employees/${id}/leave`),
    enabled: allowed && Boolean(id) && enabled,
  });
  return withAllowed(q, allowed);
}

export function useLeaveBalance(id: string | undefined, year: number, enabled = true) {
  const allowed = can("hr.directory.view", usePerms());
  const q = useQuery<{ balances: LeaveBalance[] }, ApiError>({
    queryKey: hrKeys.balance(id ?? "", year),
    queryFn: () => api.get(`/api/hr/employees/${id}/leave-balance${qs({ year })}`),
    enabled: allowed && Boolean(id) && enabled,
  });
  return withAllowed(q, allowed);
}

/** toast:false: the dialog renders the error inline. */
export function useApplyLeaveForEmployee(id: string) {
  const qc = useQueryClient();
  return useMutation<LeaveApplication, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/hr/employees/${id}/leave`, body),
    onSuccess: () => invalidate(qc, [hrKeys.leaveAll(), hrKeys.empLeave(id), ["hr", "employees", id, "balance"], REPORTS_KEY]),
  });
}

const REVIEW_KEYS = [hrKeys.leaveAll(), hrKeys.employeesAll(), REPORTS_KEY] as const;

/** toast:false: the dialog renders 422/409/404 itself. */
export function useApproveLeave() {
  const qc = useQueryClient();
  return useMutation<LeaveApplication, ApiError, { id: string; body: { reviewNote?: string } }>({
    mutationFn: ({ id, body }) => api.post(`/api/hr/leave/${id}/approve`, body),
    onSuccess: () => invalidate(qc, REVIEW_KEYS),
    onError: (err) => {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) invalidate(qc, REVIEW_KEYS);
    },
  });
}

/** toast:false: the dialog renders 409/404 itself. */
export function useRejectLeave() {
  const qc = useQueryClient();
  return useMutation<LeaveApplication, ApiError, { id: string; body: { reviewNote?: string } }>({
    mutationFn: ({ id, body }) => api.post(`/api/hr/leave/${id}/reject`, body),
    onSuccess: () => invalidate(qc, REVIEW_KEYS),
    onError: (err) => {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) invalidate(qc, REVIEW_KEYS);
    },
  });
}

// ─── Shifts and attendance ───────────────────────────────────────────────────
export function useShifts() {
  const allowed = can("hr.directory.view", usePerms());
  const q = useQuery<{ shifts: Shift[] }, ApiError>({
    queryKey: hrKeys.shifts(),
    queryFn: () => api.get("/api/hr/shifts"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

/** toast:false: the dialog maps the name conflict to a field error. */
export function useCreateShift() {
  const qc = useQueryClient();
  return useMutation<Shift, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/hr/shifts", body),
    onSuccess: () => invalidate(qc, [hrKeys.shifts()]),
  });
}

/** toast:false: the dialog maps the name conflict to a field error. */
export function usePatchShift() {
  const qc = useQueryClient();
  return useMutation<Shift, ApiError, { id: string; body: Record<string, unknown> }>({
    mutationFn: ({ id, body }) => api.patch(`/api/hr/shifts/${id}`, body),
    onSuccess: () => invalidate(qc, [hrKeys.shifts()]),
  });
}

export function useRoster(date: string, page: number) {
  const allowed = can("hr.attendance.manage", usePerms());
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date));
  const q = useQuery<Paged & { date: string; roster: RosterRow[] }, ApiError>({
    queryKey: hrKeys.roster({ date, page }),
    queryFn: () => api.get(`/api/hr/attendance/roster${qs({ date, page, pageSize: ROSTER_PAGE_SIZE })}`),
    enabled: allowed && validDate,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useEmployeeAttendance(id: string | undefined, enabled = true) {
  const allowed = can("hr.directory.view", usePerms());
  const q = useQuery<{ attendance: AttendanceRow[] }, ApiError>({
    queryKey: hrKeys.empAttendance(id ?? ""),
    queryFn: () => api.get(`/api/hr/employees/${id}/attendance`),
    enabled: allowed && Boolean(id) && enabled,
  });
  return withAllowed(q, allowed);
}

function attendanceKeys(id: string) {
  return [hrKeys.rosterAll(), hrKeys.empAttendance(id), REPORTS_KEY] as const;
}

/** toast:false: the dialog renders the error inline. */
export function useRecordAttendance(id: string) {
  const qc = useQueryClient();
  return useMutation<AttendanceRow, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/hr/employees/${id}/attendance`, body),
    onSuccess: () => invalidate(qc, attendanceKeys(id)),
    onError: (err) => {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) invalidate(qc, attendanceKeys(id));
    },
  });
}

/** toast:false: the dialog renders the error inline. */
export function useCorrectAttendance(id: string) {
  const qc = useQueryClient();
  return useMutation<AttendanceRow, ApiError, { date: string; body: Record<string, unknown> }>({
    mutationFn: ({ date, body }) => api.patch(`/api/hr/employees/${id}/attendance/${date}`, body),
    onSuccess: () => invalidate(qc, attendanceKeys(id)),
    onError: (err) => {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) invalidate(qc, attendanceKeys(id));
    },
  });
}

// ─── Reports ─────────────────────────────────────────────────────────────────
export function useLeaveSummary() {
  const allowed = can("hr.reports.view", usePerms());
  const q = useQuery<{ year: number; rows: LeaveSummaryRow[] }, ApiError>({
    queryKey: hrKeys.leaveSummary(),
    queryFn: () => api.get("/api/hr/reports/leave-summary"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useAttendanceSummary(from: string, to: string) {
  const allowed = can("hr.reports.view", usePerms());
  const q = useQuery<{ from: string; to: string; rows: AttendanceSummaryRow[] }, ApiError>({
    queryKey: hrKeys.attendanceSummary(from, to),
    queryFn: () => api.get(`/api/hr/reports/attendance-summary${qs({ from, to })}`),
    enabled: allowed && from !== "" && to !== "",
  });
  return withAllowed(q, allowed);
}

// ─── Self service ────────────────────────────────────────────────────────────
export function useMyEmployee() {
  const allowed = can("hr.view_own", usePerms());
  const q = useQuery<EmployeeDetail, ApiError>({
    queryKey: hrKeys.meEmployee(),
    queryFn: () => api.get("/api/hr/me/employee"),
    enabled: allowed,
    retry: false,
  });
  return withAllowed(q, allowed);
}

export function useMyContracts(enabled = true) {
  const allowed = can("hr.view_own", usePerms());
  const q = useQuery<{ contracts: Contract[] }, ApiError>({
    queryKey: hrKeys.meContracts(),
    queryFn: () => api.get("/api/hr/me/contracts"),
    enabled: allowed && enabled,
  });
  return withAllowed(q, allowed);
}

export function useMyLeave(enabled = true) {
  const allowed = can("hr.view_own", usePerms());
  const q = useQuery<{ leaveApplications: LeaveApplication[] }, ApiError>({
    queryKey: hrKeys.meLeave(),
    queryFn: () => api.get("/api/hr/me/leave"),
    enabled: allowed && enabled,
  });
  return withAllowed(q, allowed);
}

export function useMyLeaveBalance(year: number, enabled = true) {
  const allowed = can("hr.view_own", usePerms());
  const q = useQuery<{ balances: LeaveBalance[] }, ApiError>({
    queryKey: hrKeys.meBalance(year),
    queryFn: () => api.get(`/api/hr/me/leave-balance${qs({ year })}`),
    enabled: allowed && enabled,
  });
  return withAllowed(q, allowed);
}

export function useMyAttendance(enabled = true) {
  const allowed = can("hr.view_own", usePerms());
  const q = useQuery<{ attendance: AttendanceRow[] }, ApiError>({
    queryKey: hrKeys.meAttendance(),
    queryFn: () => api.get("/api/hr/me/attendance"),
    enabled: allowed && enabled,
  });
  return withAllowed(q, allowed);
}

/** toast:false: the dialog renders the error inline. */
export function useApplyLeave() {
  const qc = useQueryClient();
  return useMutation<LeaveApplication, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/hr/me/leave", body),
    onSuccess: () => invalidate(qc, [["hr", "me"]]),
  });
}

export function useCancelMyLeave() {
  const qc = useQueryClient();
  return useMutation<LeaveApplication, ApiError, string>({
    // Bodyless POST: pass {} so the JSON content type has a body.
    mutationFn: (id) => api.post(`/api/hr/me/leave/${id}/cancel`, {}),
    onSuccess: () => invalidate(qc, [["hr", "me"]]),
    onError: (e) => {
      toastError(e);
      invalidate(qc, [["hr", "me"]]);
    },
  });
}
