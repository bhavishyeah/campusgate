// features/hostel/hooks.ts
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
import { hostelKeys } from "./keys";
import type {
  AllocationRow,
  BuildingRow,
  CheckEventRow,
  LeaveRow,
  MaintenanceRow,
  MyAllocation,
  MyLeave,
  MyOccupancy,
  OccupancyResponse,
  Paged,
  RoomRow,
  StudentLookupItem,
  UserLookupItem,
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

// ─── Buildings ────────────────────────────────────────────────────────────
export function useBuildings(page: number) {
  const allowed = can("hostel.view", usePerms());
  const q = useQuery<Paged & { buildings: BuildingRow[] }, ApiError>({
    queryKey: hostelKeys.buildings(page),
    queryFn: () => api.get(`/api/hostel/buildings${qs({ page, pageSize: PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useBuildingOptions() {
  const allowed = can("hostel.view", usePerms());
  const q = useQuery<Paged & { buildings: BuildingRow[] }, ApiError>({
    queryKey: hostelKeys.buildingOptions(),
    queryFn: () => api.get(`/api/hostel/buildings${qs({ pageSize: OPTION_PAGE_SIZE })}`),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useCreateBuilding(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<BuildingRow, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/hostel/buildings", body),
    onSuccess: () => invalidate(qc, [hostelKeys.buildingsAll(), hostelKeys.buildingOptions(), hostelKeys.occupancy()]),
    onError: errorHandler(opts),
  });
}

export function usePatchBuilding(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<BuildingRow, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.patch(`/api/hostel/buildings/${id}`, body),
    onSuccess: () => invalidate(qc, [hostelKeys.buildingsAll(), hostelKeys.buildingOptions(), hostelKeys.occupancy()]),
    onError: errorHandler(opts),
  });
}

// ─── Rooms ────────────────────────────────────────────────────────────────
export interface RoomFilters {
  buildingId?: string;
  status?: string;
  page: number;
}

export function useRooms(f: RoomFilters) {
  const allowed = can("hostel.view", usePerms());
  const q = useQuery<Paged & { rooms: RoomRow[] }, ApiError>({
    queryKey: hostelKeys.rooms(f),
    queryFn: () =>
      api.get(`/api/hostel/rooms${qs({ buildingId: f.buildingId, status: f.status, page: f.page, pageSize: PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

/** The picker concatenates pages client-side (RoomPicker owns the accumulation). */
export function useRoomOptions(f: { buildingId: string; status?: string; page: number }) {
  const allowed = can("hostel.view", usePerms()) && Boolean(f.buildingId);
  const q = useQuery<Paged & { rooms: RoomRow[] }, ApiError>({
    queryKey: hostelKeys.roomOptions(f),
    queryFn: () =>
      api.get(
        `/api/hostel/rooms${qs({ buildingId: f.buildingId, status: f.status, page: f.page, pageSize: OPTION_PAGE_SIZE })}`,
      ),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useCreateRoom(buildingId: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<RoomRow, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/hostel/buildings/${buildingId}/rooms`, body),
    onSuccess: () => invalidate(qc, [hostelKeys.roomsAll(), hostelKeys.buildingsAll(), hostelKeys.occupancy()]),
    onError: errorHandler(opts),
  });
}

export function usePatchRoom(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<RoomRow, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.patch(`/api/hostel/rooms/${id}`, body),
    onSuccess: () => invalidate(qc, [hostelKeys.roomsAll(), hostelKeys.occupancy()]),
    onError: errorHandler(opts),
  });
}

// ─── Allocations ──────────────────────────────────────────────────────────
export interface AllocationFilters {
  status?: string;
  buildingId?: string;
  page: number;
}

export function useAllocations(f: AllocationFilters) {
  const allowed = can("hostel.view", usePerms());
  const q = useQuery<Paged & { allocations: AllocationRow[] }, ApiError>({
    queryKey: hostelKeys.allocations(f),
    queryFn: () =>
      api.get(`/api/hostel/allocations${qs({ status: f.status, buildingId: f.buildingId, page: f.page, pageSize: PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

function invalidateAfterAllocationChange(qc: QueryClient): void {
  invalidate(qc, [hostelKeys.allocationsAll(), hostelKeys.roomsAll(), hostelKeys.occupancy(), hostelKeys.checkEventsAll(), ["hostel", "student-lookup"]]);
}

export function useAllocate(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<AllocationRow, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/hostel/allocations", body),
    onSuccess: () => invalidateAfterAllocationChange(qc),
    onError: errorHandler(opts),
  });
}

export function useTransfer(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<AllocationRow, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/hostel/allocations/${id}/transfer`, body),
    onSuccess: () => invalidateAfterAllocationChange(qc),
    onError: errorHandler(opts),
  });
}

export function useVacate(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<AllocationRow, ApiError, void>({
    // Bodyless POST: api.ts always sends a JSON content type, so pass {}.
    mutationFn: () => api.post(`/api/hostel/allocations/${id}/vacate`, {}),
    onSuccess: () => invalidateAfterAllocationChange(qc),
    onError: errorHandler(opts),
  });
}

export function useRecordCheck(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<CheckEventRow, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/hostel/allocations/${id}/check`, body),
    onSuccess: () => invalidate(qc, [hostelKeys.checkEventsAll()]),
    onError: errorHandler(opts),
  });
}

// ─── Occupancy / check events ─────────────────────────────────────────────
export function useOccupancy() {
  const allowed = can("hostel.view", usePerms());
  const q = useQuery<OccupancyResponse, ApiError>({
    queryKey: hostelKeys.occupancy(),
    queryFn: () => api.get("/api/hostel/occupancy"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export interface CheckEventFilters {
  allocationId?: string;
  studentId?: string;
  page: number;
}

export function useCheckEvents(f: CheckEventFilters) {
  const allowed = can("hostel.view", usePerms());
  const q = useQuery<Paged & { events: CheckEventRow[] }, ApiError>({
    queryKey: hostelKeys.checkEvents(f),
    queryFn: () =>
      api.get(
        `/api/hostel/check-events${qs({ allocationId: f.allocationId, studentId: f.studentId, page: f.page, pageSize: PAGE_SIZE })}`,
      ),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

// ─── Leave queue (staff) ──────────────────────────────────────────────────
export interface LeaveFilters {
  status?: string;
  page: number;
}

export function useHostelLeaveQueue(f: LeaveFilters) {
  const allowed = can("hostel.view", usePerms());
  const q = useQuery<Paged & { applications: LeaveRow[] }, ApiError>({
    queryKey: hostelKeys.leave(f),
    queryFn: () => api.get(`/api/hostel/leave${qs({ status: f.status, page: f.page, pageSize: PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useApproveLeave(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<LeaveRow, ApiError, { id: string; body: Record<string, unknown> }>({
    mutationFn: ({ id, body }) => api.post(`/api/hostel/leave/${id}/approve`, body),
    onSuccess: () => invalidate(qc, [hostelKeys.leaveAll()]),
    onError: errorHandler(opts),
  });
}

export function useRejectLeave(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<LeaveRow, ApiError, { id: string; body: Record<string, unknown> }>({
    mutationFn: ({ id, body }) => api.post(`/api/hostel/leave/${id}/reject`, body),
    onSuccess: () => invalidate(qc, [hostelKeys.leaveAll()]),
    onError: errorHandler(opts),
  });
}

// ─── Maintenance ──────────────────────────────────────────────────────────
export interface MaintenanceFilters {
  status?: string;
  page: number;
}

export function useHostelMaintenance(f: MaintenanceFilters) {
  const allowed = can("hostel.view", usePerms());
  const q = useQuery<Paged & { requests: MaintenanceRow[] }, ApiError>({
    queryKey: hostelKeys.maintenance(f),
    queryFn: () => api.get(`/api/hostel/maintenance${qs({ status: f.status, page: f.page, pageSize: PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useCreateMaintenance(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<MaintenanceRow, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/hostel/maintenance", body),
    onSuccess: () => invalidate(qc, [hostelKeys.maintenanceAll()]),
    onError: errorHandler(opts),
  });
}

export function useTransitionMaintenance(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<MaintenanceRow, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/hostel/maintenance/${id}/transition`, body),
    onSuccess: () => invalidate(qc, [hostelKeys.maintenanceAll()]),
    onError: errorHandler(opts),
  });
}

// ─── Lookups ──────────────────────────────────────────────────────────────
export function useStudentLookup(q: string) {
  const allowed = can("hostel.allocations.manage", usePerms());
  const term = q.trim();
  const query = useQuery<{ students: StudentLookupItem[] }, ApiError>({
    queryKey: hostelKeys.studentLookup(term),
    queryFn: () => api.get(`/api/hostel/students/lookup${qs({ q: term, limit: 10 })}`),
    enabled: allowed && term.length >= 2,
  });
  return withAllowed(query, allowed);
}

export function useUserLookup(q: string) {
  const allowed = can("hostel.buildings.manage", usePerms());
  const term = q.trim();
  const query = useQuery<{ users: UserLookupItem[] }, ApiError>({
    queryKey: hostelKeys.userLookup(term),
    queryFn: () => api.get(`/api/hostel/users/lookup${qs({ q: term, limit: 10 })}`),
    enabled: allowed && term.length >= 2,
  });
  return withAllowed(query, allowed);
}

export function downloadAllocations(): Promise<void> {
  return downloadAuthed("/api/hostel/allocations/export", "hostel-allocations.xlsx");
}

// ─── Self (STUDENT) ───────────────────────────────────────────────────────
export function useMyAllocation() {
  const allowed = can("hostel.view_own", usePerms());
  const q = useQuery<{ allocation: MyAllocation | null }, ApiError>({
    queryKey: hostelKeys.meAllocation(),
    queryFn: () => api.get("/api/hostel/me/allocation"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useMyOccupancy() {
  const allowed = can("hostel.view_own", usePerms());
  const q = useQuery<{ occupancy: MyOccupancy | null }, ApiError>({
    queryKey: hostelKeys.meOccupancy(),
    queryFn: () => api.get("/api/hostel/me/occupancy"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useMyHostelLeave(f: LeaveFilters) {
  const allowed = can("hostel.view_own", usePerms());
  const q = useQuery<Paged & { applications: MyLeave[] }, ApiError>({
    queryKey: hostelKeys.meLeave(f),
    queryFn: () => api.get(`/api/hostel/me/leave${qs({ status: f.status, page: f.page, pageSize: PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useApplyMyLeave(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<MyLeave, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/hostel/me/leave", body),
    onSuccess: () => invalidate(qc, [hostelKeys.meAll()]),
    onError: errorHandler(opts),
  });
}

export function useCancelMyLeave(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<MyLeave, ApiError, string>({
    // Bodyless POST: api.ts always sends a JSON content type, so pass {}.
    mutationFn: (id) => api.post(`/api/hostel/me/leave/${id}/cancel`, {}),
    onSuccess: () => invalidate(qc, [hostelKeys.meAll()]),
    onError: errorHandler(opts),
  });
}
