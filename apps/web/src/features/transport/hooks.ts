// features/transport/hooks.ts
// No "use client": hooks files are plain TS modules (mirrors features/hr/hooks.ts).
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
import { transportKeys } from "./keys";
import type {
  AssignmentRow,
  Driver,
  EnrollmentRow,
  MaintenanceRow,
  MyEnrollment,
  MyFee,
  Paged,
  Route,
  Schedule,
  Stop,
  StudentLookupItem,
  UtilizationRow,
  Vehicle,
} from "./types";

export const PAGE_SIZE = 20;
export const OPTION_PAGE_SIZE = 100;

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
  /** Default true. Pass false when the caller renders the error inline. */
  toast?: boolean;
}

function errorHandler(opts: MutationOpts): (error: unknown) => void {
  return (error) => {
    if (opts.toast !== false) toast.error(describeApiError(error));
  };
}

// ─── Vehicles ─────────────────────────────────────────────────────────────
export interface StatusFilters {
  status?: string;
  page: number;
}

export function useVehicles(f: StatusFilters) {
  const allowed = can("transport.view", usePerms());
  const q = useQuery<Paged & { vehicles: Vehicle[] }, ApiError>({
    queryKey: transportKeys.vehicles(f),
    queryFn: () => api.get(`/api/transport/vehicles${qs({ status: f.status, page: f.page, pageSize: PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

/** Assignment passes "ACTIVE"; maintenance passes nothing (every vehicle). */
export function useVehicleOptions(status?: string) {
  const allowed = can("transport.view", usePerms());
  const q = useQuery<Paged & { vehicles: Vehicle[] }, ApiError>({
    queryKey: transportKeys.vehicleOptions(status),
    queryFn: () => api.get(`/api/transport/vehicles${qs({ status, pageSize: OPTION_PAGE_SIZE })}`),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useCreateVehicle(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<Vehicle, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/transport/vehicles", body),
    onSuccess: () => invalidate(qc, [transportKeys.vehiclesAll(), transportKeys.reportsAll()]),
    onError: errorHandler(opts),
  });
}

export function usePatchVehicle(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<Vehicle, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.patch(`/api/transport/vehicles/${id}`, body),
    onSuccess: () =>
      invalidate(qc, [transportKeys.vehiclesAll(), ["transport", "assignments"], transportKeys.reportsAll()]),
    onError: errorHandler(opts),
  });
}

// ─── Drivers ──────────────────────────────────────────────────────────────
export function useDrivers(f: StatusFilters) {
  const allowed = can("transport.view", usePerms());
  const q = useQuery<Paged & { drivers: Driver[] }, ApiError>({
    queryKey: transportKeys.drivers(f),
    queryFn: () => api.get(`/api/transport/drivers${qs({ status: f.status, page: f.page, pageSize: PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

/** Active drivers only (the assignment dialog). */
export function useDriverOptions() {
  const allowed = can("transport.view", usePerms());
  const q = useQuery<Paged & { drivers: Driver[] }, ApiError>({
    queryKey: transportKeys.driverOptions(),
    queryFn: () => api.get(`/api/transport/drivers${qs({ status: "ACTIVE", pageSize: OPTION_PAGE_SIZE })}`),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useCreateDriver(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<Driver, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/transport/drivers", body),
    onSuccess: () => invalidate(qc, [transportKeys.driversAll(), ["transport", "assignments"]]),
    onError: errorHandler(opts),
  });
}

export function usePatchDriver(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<Driver, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.patch(`/api/transport/drivers/${id}`, body),
    onSuccess: () => invalidate(qc, [transportKeys.driversAll(), ["transport", "assignments"]]),
    onError: errorHandler(opts),
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────
export function useRoutes(f: StatusFilters) {
  const allowed = can("transport.view", usePerms());
  const q = useQuery<Paged & { routes: Route[] }, ApiError>({
    queryKey: transportKeys.routes(f),
    queryFn: () => api.get(`/api/transport/routes${qs({ status: f.status, page: f.page, pageSize: PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useRouteOptions() {
  const allowed = can("transport.view", usePerms());
  const q = useQuery<Paged & { routes: Route[] }, ApiError>({
    queryKey: transportKeys.routeOptions(),
    queryFn: () => api.get(`/api/transport/routes${qs({ pageSize: OPTION_PAGE_SIZE })}`),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useRoute(id: string | undefined) {
  const allowed = can("transport.view", usePerms());
  const q = useQuery<Route, ApiError>({
    queryKey: transportKeys.route(id ?? ""),
    queryFn: () => api.get(`/api/transport/routes/${id}`),
    enabled: allowed && Boolean(id),
  });
  return withAllowed(q, allowed);
}

export function useCreateRoute(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<Route, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/transport/routes", body),
    onSuccess: () => invalidate(qc, [transportKeys.routesAll(), transportKeys.reportsAll()]),
    onError: errorHandler(opts),
  });
}

export function usePatchRoute(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<Route, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.patch(`/api/transport/routes/${id}`, body),
    onSuccess: () => invalidate(qc, [transportKeys.routesAll(), transportKeys.reportsAll()]),
    onError: errorHandler(opts),
  });
}

// ─── Stops ────────────────────────────────────────────────────────────────
export function useStops(routeId: string | undefined) {
  const allowed = can("transport.view", usePerms());
  const q = useQuery<{ stops: Stop[] }, ApiError>({
    queryKey: transportKeys.stops(routeId ?? ""),
    queryFn: () => api.get(`/api/transport/routes/${routeId}/stops`),
    enabled: allowed && Boolean(routeId),
  });
  return withAllowed(q, allowed);
}

export function useCreateStop(routeId: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<Stop, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/transport/routes/${routeId}/stops`, body),
    onSuccess: () => invalidate(qc, [transportKeys.stops(routeId), transportKeys.schedules(routeId)]),
    onError: errorHandler(opts),
  });
}

/** A stop edit invalidates schedules too: the schedule table shows stop names. */
export function usePatchStop(routeId: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<Stop, ApiError, { stopId: string; body: Record<string, unknown> }>({
    mutationFn: ({ stopId, body }) => api.patch(`/api/transport/stops/${stopId}`, body),
    onSuccess: () => invalidate(qc, [transportKeys.stops(routeId), transportKeys.schedules(routeId)]),
    onError: errorHandler(opts),
  });
}

// ─── Schedules ────────────────────────────────────────────────────────────
export function useSchedules(routeId: string | undefined) {
  const allowed = can("transport.view", usePerms());
  const q = useQuery<{ schedules: Schedule[] }, ApiError>({
    queryKey: transportKeys.schedules(routeId ?? ""),
    queryFn: () => api.get(`/api/transport/routes/${routeId}/schedules`),
    enabled: allowed && Boolean(routeId),
  });
  return withAllowed(q, allowed);
}

export function useCreateSchedule(routeId: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<Schedule, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/transport/routes/${routeId}/schedules`, body),
    onSuccess: () => invalidate(qc, [transportKeys.schedules(routeId)]),
    onError: errorHandler(opts),
  });
}

export function usePatchSchedule(routeId: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<Schedule, ApiError, { scheduleId: string; body: Record<string, unknown> }>({
    mutationFn: ({ scheduleId, body }) => api.patch(`/api/transport/schedules/${scheduleId}`, body),
    onSuccess: () => invalidate(qc, [transportKeys.schedules(routeId)]),
    onError: errorHandler(opts),
  });
}

// ─── Assignments ──────────────────────────────────────────────────────────
/** Lazy: pass enabled=false until the Assignment tab is active. */
export function useAssignments(routeId: string | undefined, enabled = true) {
  const allowed = can("transport.view", usePerms());
  const q = useQuery<{ assignments: AssignmentRow[] }, ApiError>({
    queryKey: transportKeys.assignments(routeId ?? ""),
    queryFn: () => api.get(`/api/transport/routes/${routeId}/assignments`),
    enabled: allowed && Boolean(routeId) && enabled,
  });
  return withAllowed(q, allowed);
}

export function useCreateAssignment(routeId: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<AssignmentRow, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/transport/routes/${routeId}/assignments`, body),
    onSuccess: () =>
      invalidate(qc, [transportKeys.assignments(routeId), transportKeys.reportsAll(), transportKeys.enrollmentsAll()]),
    onError: errorHandler(opts),
  });
}

export function useEndAssignment(routeId: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<AssignmentRow, ApiError, string>({
    // Bodyless POST: api.ts always sends a JSON content type, so pass {}.
    mutationFn: (assignmentId) => api.post(`/api/transport/assignments/${assignmentId}/end`, {}),
    onSuccess: () =>
      invalidate(qc, [transportKeys.assignments(routeId), transportKeys.reportsAll(), transportKeys.enrollmentsAll()]),
    onError: errorHandler(opts),
  });
}

// ─── Enrollments ──────────────────────────────────────────────────────────
export interface EnrollmentFilters {
  routeId?: string;
  status?: string;
  page: number;
}

export function useEnrollments(f: EnrollmentFilters) {
  const allowed = can("transport.view", usePerms());
  const q = useQuery<Paged & { enrollments: EnrollmentRow[] }, ApiError>({
    queryKey: transportKeys.enrollments(f),
    queryFn: () =>
      api.get(
        `/api/transport/enrollments${qs({ routeId: f.routeId, status: f.status, page: f.page, pageSize: PAGE_SIZE })}`,
      ),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useEnroll(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<EnrollmentRow, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/transport/enrollments", body),
    onSuccess: () => invalidate(qc, [transportKeys.enrollmentsAll(), transportKeys.reportsAll(), ["transport", "student-lookup"]]),
    onError: errorHandler(opts),
  });
}

export function useSuspendEnrollment(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<EnrollmentRow, ApiError, string>({
    // Bodyless POST: api.ts always sends a JSON content type, so pass {}.
    mutationFn: (id) => api.post(`/api/transport/enrollments/${id}/suspend`, {}),
    onSuccess: () => invalidate(qc, [transportKeys.enrollmentsAll(), transportKeys.reportsAll()]),
    onError: errorHandler(opts),
  });
}

export function useEndEnrollment(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<EnrollmentRow, ApiError, string>({
    // Bodyless POST: api.ts always sends a JSON content type, so pass {}.
    mutationFn: (id) => api.post(`/api/transport/enrollments/${id}/end`, {}),
    onSuccess: () => invalidate(qc, [transportKeys.enrollmentsAll(), transportKeys.reportsAll()]),
    onError: errorHandler(opts),
  });
}

// ─── Maintenance ──────────────────────────────────────────────────────────
export interface MaintenanceFilters {
  vehicleId?: string;
  status?: string;
  page: number;
}

export function useTransportMaintenance(f: MaintenanceFilters) {
  const allowed = can("transport.view", usePerms());
  const q = useQuery<Paged & { requests: MaintenanceRow[] }, ApiError>({
    queryKey: transportKeys.maintenance(f),
    queryFn: () =>
      api.get(
        `/api/transport/maintenance${qs({ vehicleId: f.vehicleId, status: f.status, page: f.page, pageSize: PAGE_SIZE })}`,
      ),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useCreateTransportMaintenance(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<MaintenanceRow, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/transport/maintenance", body),
    onSuccess: () => invalidate(qc, [transportKeys.maintenanceAll()]),
    onError: errorHandler(opts),
  });
}

export function useTransitionTransportMaintenance(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<MaintenanceRow, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/transport/maintenance/${id}/transition`, body),
    onSuccess: () => invalidate(qc, [transportKeys.maintenanceAll()]),
    onError: errorHandler(opts),
  });
}

// ─── Reports ──────────────────────────────────────────────────────────────
export function useUtilization() {
  const allowed = can("transport.view", usePerms());
  const q = useQuery<{ utilization: UtilizationRow[] }, ApiError>({
    queryKey: transportKeys.utilization(),
    queryFn: () => api.get("/api/transport/reports/utilization"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

/** routeId "" means all routes. */
export function useRoster(routeId: string) {
  const allowed = can("transport.view", usePerms());
  const q = useQuery<{ roster: EnrollmentRow[] }, ApiError>({
    queryKey: transportKeys.roster(routeId),
    queryFn: () => api.get(`/api/transport/reports/roster${qs({ routeId })}`),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function downloadRoster(routeId?: string): Promise<void> {
  return downloadAuthed(`/api/transport/reports/roster/export${qs({ routeId })}`, "transport-roster.xlsx");
}

// ─── Lookup ───────────────────────────────────────────────────────────────
export function useStudentLookup(q: string) {
  const allowed = can("transport.enrollments.manage", usePerms());
  const term = q.trim();
  const query = useQuery<{ students: StudentLookupItem[] }, ApiError>({
    queryKey: transportKeys.studentLookup(term),
    queryFn: () => api.get(`/api/transport/students/lookup${qs({ q: term, limit: 10 })}`),
    enabled: allowed && term.length >= 2,
  });
  return withAllowed(query, allowed);
}

// ─── Self (STUDENT) ───────────────────────────────────────────────────────
export function useMyEnrollments() {
  const allowed = can("transport.view_own", usePerms());
  const q = useQuery<{ enrollments: MyEnrollment[] }, ApiError>({
    queryKey: transportKeys.meEnrollments(),
    queryFn: () => api.get("/api/transport/me/enrollments"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useMyRoutes() {
  const allowed = can("transport.view_own", usePerms());
  const q = useQuery<{ routes: Route[] }, ApiError>({
    queryKey: transportKeys.meRoutes(),
    queryFn: () => api.get("/api/transport/me/routes"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useMySchedules() {
  const allowed = can("transport.view_own", usePerms());
  const q = useQuery<{ schedules: Schedule[] }, ApiError>({
    queryKey: transportKeys.meSchedules(),
    queryFn: () => api.get("/api/transport/me/schedules"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useMyFees() {
  const allowed = can("transport.view_own", usePerms());
  const q = useQuery<{ fees: MyFee[] }, ApiError>({
    queryKey: transportKeys.meFees(),
    queryFn: () => api.get("/api/transport/me/fees"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}
