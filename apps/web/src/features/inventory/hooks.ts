// features/inventory/hooks.ts — plain TS module (no "use client"), mirrors features/hostel/hooks.ts.
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
import { inventoryKeys } from "./keys";
import type {
  Asset,
  AuditSession,
  AuditLine,
  Category,
  Disposal,
  MaintenanceRow,
  Paged,
  StockItem,
  StockMovement,
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

// ─── Categories ───────────────────────────────────────────────────────────
export function useCategories(f: { kind?: string; page: number }) {
  const allowed = can("inventory.view", usePerms());
  const q = useQuery<{ categories: Category[] } & Paged, ApiError>({
    queryKey: inventoryKeys.categories({ kind: f.kind, page: f.page }),
    queryFn: () => api.get(`/api/inventory/categories${qs({ kind: f.kind, page: f.page, pageSize: PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useCategoryOptions() {
  const allowed = can("inventory.view", usePerms());
  const q = useQuery<{ categories: Category[] } & Paged, ApiError>({
    queryKey: inventoryKeys.categoryOptions(),
    queryFn: () => api.get(`/api/inventory/categories${qs({ pageSize: OPTION_PAGE_SIZE })}`),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useCreateCategory(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<Category, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/inventory/categories", body),
    onSuccess: () => invalidate(qc, [inventoryKeys.categoriesAll()]),
    onError: errorHandler(opts),
  });
}

export function usePatchCategory(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<Category, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.patch(`/api/inventory/categories/${id}`, body),
    onSuccess: () => invalidate(qc, [inventoryKeys.categoriesAll()]),
    onError: errorHandler(opts),
  });
}

// ─── Assets ───────────────────────────────────────────────────────────────
export function useAssets(f: { status?: string; categoryId?: string; page: number }) {
  const allowed = can("inventory.view", usePerms());
  const q = useQuery<{ assets: Asset[] } & Paged, ApiError>({
    queryKey: inventoryKeys.assets(f),
    queryFn: () =>
      api.get(`/api/inventory/assets${qs({ status: f.status, categoryId: f.categoryId, page: f.page, pageSize: PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useAssetOptions(page: number) {
  const allowed = can("inventory.view", usePerms());
  const q = useQuery<{ assets: Asset[] } & Paged, ApiError>({
    queryKey: inventoryKeys.assetOptions({ page }),
    queryFn: () => api.get(`/api/inventory/assets${qs({ page, pageSize: OPTION_PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useAsset(id: string) {
  const allowed = can("inventory.view", usePerms());
  const q = useQuery<Asset, ApiError>({
    queryKey: inventoryKeys.asset(id),
    queryFn: () => api.get(`/api/inventory/assets/${id}`),
    enabled: allowed && id !== "",
  });
  return withAllowed(q, allowed);
}

export function useCreateAsset(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<Asset, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/inventory/assets", body),
    onSuccess: () => invalidate(qc, [inventoryKeys.assetsAll(), inventoryKeys.stockAll(), inventoryKeys.reportsAll()]),
    onError: errorHandler(opts),
  });
}

export function usePatchAsset(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<Asset, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.patch(`/api/inventory/assets/${id}`, body),
    onSuccess: () => invalidate(qc, [inventoryKeys.assetsAll(), inventoryKeys.reportsAll()]),
    onError: errorHandler(opts),
  });
}

export function useTransferAsset(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<Asset, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/inventory/assets/${id}/transfer`, body),
    onSuccess: () => invalidate(qc, [inventoryKeys.assetsAll(), inventoryKeys.reportsAll()]),
    onError: errorHandler(opts),
  });
}

export function useOpenMaintenance(assetId: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<MaintenanceRow, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/inventory/assets/${assetId}/maintenance`, body),
    onSuccess: () => invalidate(qc, [inventoryKeys.assetsAll(), inventoryKeys.maintenanceAll(), inventoryKeys.reportsAll()]),
    onError: errorHandler(opts),
  });
}

export function useDisposeAsset(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<Disposal, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/inventory/assets/${id}/dispose`, body),
    onSuccess: () => invalidate(qc, [inventoryKeys.assetsAll(), inventoryKeys.reportsAll()]),
    onError: errorHandler(opts),
  });
}

// ─── Maintenance ──────────────────────────────────────────────────────────
export function useMaintenance(f: { status?: string; assetId?: string; page: number }) {
  const allowed = can("inventory.view", usePerms());
  const q = useQuery<{ requests: MaintenanceRow[] } & Paged, ApiError>({
    queryKey: inventoryKeys.maintenance(f),
    queryFn: () =>
      api.get(`/api/inventory/maintenance${qs({ status: f.status, assetId: f.assetId, page: f.page, pageSize: PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useTransitionMaintenance(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<MaintenanceRow, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.patch(`/api/inventory/maintenance/${id}`, body),
    onSuccess: () => invalidate(qc, [inventoryKeys.maintenanceAll(), inventoryKeys.assetsAll()]),
    onError: errorHandler(opts),
  });
}

// ─── Consumable stock ─────────────────────────────────────────────────────
export function useStockItems(page: number) {
  const allowed = can("inventory.view", usePerms());
  const q = useQuery<{ stockItems: StockItem[] } & Paged, ApiError>({
    queryKey: inventoryKeys.stockItems({ page }),
    queryFn: () => api.get(`/api/inventory/stock${qs({ page, pageSize: PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

// Picker-oriented stock list: OPTION_PAGE_SIZE per page with "Load more" so every
// stock item is reachable (mirrors useAssetOptions — the AssetPicker precedent).
export function useStockItemOptions(page: number) {
  const allowed = can("inventory.view", usePerms());
  const q = useQuery<{ stockItems: StockItem[] } & Paged, ApiError>({
    queryKey: inventoryKeys.stockOptions({ page }),
    queryFn: () => api.get(`/api/inventory/stock${qs({ page, pageSize: OPTION_PAGE_SIZE })}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

export function useStockItem(assetId: string) {
  const allowed = can("inventory.view", usePerms());
  const q = useQuery<{ stockItem: StockItem; movements: StockMovement[] }, ApiError>({
    queryKey: inventoryKeys.stockItem(assetId),
    queryFn: () => api.get(`/api/inventory/stock/${assetId}`),
    enabled: allowed && assetId !== "",
  });
  return withAllowed(q, allowed);
}

export function useRecordMovement(assetId: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<{ movement: StockMovement; onHandQuantity: number }, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/inventory/stock/${assetId}/movements`, body),
    onSuccess: () => invalidate(qc, [inventoryKeys.stockAll(), inventoryKeys.reportLowStock()]),
    onError: errorHandler(opts),
  });
}

// ─── Stock-take audits (no GET list/detail endpoint — client-state surface) ──
export function useCreateAudit(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<AuditSession, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/inventory/audits", body),
    onSuccess: () => invalidate(qc, [inventoryKeys.auditsAll()]),
    onError: errorHandler(opts),
  });
}

export function useAddAuditLine(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<AuditLine, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/inventory/audits/${id}/lines`, body),
    onSuccess: () => invalidate(qc, [inventoryKeys.audit(id)]),
    onError: errorHandler(opts),
  });
}

export function useCloseAudit(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<AuditSession, ApiError, void>({
    // Bodyless PATCH: api.ts always sends a JSON content type, so pass {}.
    mutationFn: () => api.patch(`/api/inventory/audits/${id}`, {}),
    onSuccess: () => invalidate(qc, [inventoryKeys.auditsAll()]),
    onError: errorHandler(opts),
  });
}

// ─── Reports ───────────────────────────────────────────────────────────────
export function useRegister() {
  const allowed = can("inventory.view", usePerms());
  const q = useQuery<{ register: Asset[] }, ApiError>({
    queryKey: inventoryKeys.reportRegister(),
    queryFn: () => api.get("/api/inventory/reports/register"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useCustody() {
  const allowed = can("inventory.view", usePerms());
  const q = useQuery<{ custody: Asset[] }, ApiError>({
    queryKey: inventoryKeys.reportCustody(),
    queryFn: () => api.get("/api/inventory/reports/custody"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useLowStock() {
  const allowed = can("inventory.view", usePerms());
  const q = useQuery<{ lowStock: StockItem[] }, ApiError>({
    queryKey: inventoryKeys.reportLowStock(),
    queryFn: () => api.get("/api/inventory/reports/low-stock"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function useDisposals() {
  const allowed = can("inventory.view", usePerms());
  const q = useQuery<{ disposals: Disposal[] }, ApiError>({
    queryKey: inventoryKeys.reportDisposals(),
    queryFn: () => api.get("/api/inventory/reports/disposals"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

export function downloadRegister(): Promise<void> {
  return downloadAuthed("/api/inventory/reports/register.xlsx", "inventory-register.xlsx");
}

// ─── Lookup ────────────────────────────────────────────────────────────────
export function useUserLookup(q: string) {
  const allowed = can("inventory.assets.manage", usePerms());
  const term = q.trim();
  const query = useQuery<{ users: UserLookupItem[] }, ApiError>({
    queryKey: inventoryKeys.userLookup(term),
    queryFn: () => api.get(`/api/inventory/users/lookup${qs({ q: term, limit: 10 })}`),
    enabled: allowed && term.length >= 2,
  });
  return withAllowed(query, allowed);
}

// ─── Self (INVENTORY_MANAGER) ──────────────────────────────────────────────
export function useMyAssets() {
  const allowed = can("inventory.view_own", usePerms());
  const q = useQuery<{ assets: Asset[] }, ApiError>({
    queryKey: inventoryKeys.meAssets(),
    queryFn: () => api.get("/api/inventory/me/assets"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}
