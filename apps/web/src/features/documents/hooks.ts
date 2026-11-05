// features/documents/hooks.ts — plain TS module (no "use client"), mirrors
// features/inventory/hooks.ts. Uploads go through the local raw-body helper in
// upload.ts; everything else uses the shared JSON client.
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
import { can, canAny } from "@/lib/authz";
import { downloadAuthed } from "@/lib/downloadFile";
import { readIdParam } from "@/lib/paging";
import { useAuthStore } from "@/stores/auth";
import { documentsKeys } from "./keys";
import { uploadDocument, uploadVersion, type UploadMeta, type VersionMeta } from "./upload";
import type {
  AccessLogRow,
  CreatedDocument,
  DocumentDetail,
  DocumentListEnvelope,
  DocumentReport,
  DocumentVersion,
  DocumentGrant,
  MintedDownloadUrl,
  RetentionPolicy,
  UserLookupItem,
} from "./types";

export const PAGE_SIZE = 20;

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

// ─── List ───────────────────────────────────────────────────────────────────
export interface DocumentListFilters {
  scope?: "mine" | "all";
  status?: string;
  category?: string;
  ownerUserId?: string;
  page: number;
}

export function useDocuments(f: DocumentListFilters) {
  const perms = usePerms();
  const allowed = canAny(["documents.view_own", "documents.admin.view_all"], perms);
  const isAdmin = can("documents.admin.view_all", perms);
  // Admin-only params are sent only for an admin (own-scoped callers never send
  // them — the server would ignore them, but gating keeps the key clean).
  const scope = isAdmin ? f.scope : undefined;
  const ownerUserId = isAdmin ? f.ownerUserId : undefined;
  const keyFilters = { scope, status: f.status, category: f.category, ownerUserId, page: f.page };
  const q = useQuery<DocumentListEnvelope, ApiError>({
    queryKey: documentsKeys.list(keyFilters),
    queryFn: () =>
      api.get(
        `/api/documents${qs({
          scope,
          status: f.status,
          category: f.category,
          ownerUserId,
          page: f.page,
          pageSize: PAGE_SIZE,
        })}`,
      ),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  return withAllowed(q, allowed);
}

// ─── Detail (+ versions + grants); 404 is the existence-hiding signal ─────────
type WithDetailFlags = WithAllowed<DocumentDetail> & { notFound: boolean };

export function useDocument(id: string | undefined) {
  const perms = usePerms();
  const allowed = canAny(["documents.view_own", "documents.download", "documents.admin.view_all"], perms);
  const validId = readIdParam(id);
  const q = useQuery<DocumentDetail, ApiError>({
    queryKey: documentsKeys.detail(validId ?? ""),
    queryFn: () => api.get(`/api/documents/${validId}`),
    enabled: allowed && validId !== undefined,
    retry: false,
  });
  const notFound = q.error instanceof ApiError && q.error.status === 404;
  return Object.assign(q, { allowed, notFound }) as WithDetailFlags;
}

// ─── Retention policies ───────────────────────────────────────────────────────
export function useRetentionPolicies() {
  const allowed = can("documents.retention.manage", usePerms());
  const q = useQuery<RetentionPolicy[], ApiError>({
    queryKey: documentsKeys.retentionPolicies(),
    queryFn: () => api.get("/api/documents/retention-policies"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

// ─── Report ───────────────────────────────────────────────────────────────────
export function useDocumentReport() {
  const allowed = can("documents.admin.view_all", usePerms());
  const q = useQuery<DocumentReport, ApiError>({
    queryKey: documentsKeys.report(),
    queryFn: () => api.get("/api/documents/report"),
    enabled: allowed,
  });
  return withAllowed(q, allowed);
}

// ─── Access log ────────────────────────────────────────────────────────────────
export function useAccessLog(id: string | undefined) {
  const allowed = can("documents.audit.view", usePerms());
  const validId = readIdParam(id);
  const q = useQuery<AccessLogRow[], ApiError>({
    queryKey: documentsKeys.accessLog(validId ?? ""),
    queryFn: () => api.get(`/api/documents/${validId}/access-log`),
    enabled: allowed && validId !== undefined,
  });
  return withAllowed(q, allowed);
}

// ─── Grantee user lookup (documents-gated) ────────────────────────────────────
export function useUserLookup(q: string) {
  const allowed = can("documents.grants.manage", usePerms());
  const term = q.trim();
  const query = useQuery<{ users: UserLookupItem[] }, ApiError>({
    queryKey: documentsKeys.userLookup(term),
    queryFn: () => api.get(`/api/documents/users/lookup${qs({ q: term, limit: 10 })}`),
    enabled: allowed && term.length >= 2,
  });
  return withAllowed(query, allowed);
}

// ─── Mutations ────────────────────────────────────────────────────────────────
export function useUploadDocument(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<CreatedDocument, ApiError, { file: File; meta: UploadMeta }>({
    mutationFn: ({ file, meta }) => uploadDocument(file, meta),
    onSuccess: () => invalidate(qc, [documentsKeys.all]),
    onError: errorHandler(opts),
  });
}

export function useUploadVersion(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<DocumentVersion, ApiError, { file: File; meta: VersionMeta }>({
    mutationFn: ({ file, meta }) => uploadVersion(id, file, meta),
    onSuccess: () => invalidate(qc, [documentsKeys.detail(id), documentsKeys.all]),
    onError: errorHandler(opts),
  });
}

export function useMintDownloadUrl(opts: MutationOpts = {}) {
  return useMutation<MintedDownloadUrl, ApiError, { id: string; vid: string }>({
    mutationFn: ({ id, vid }) => api.post(`/api/documents/${id}/versions/${vid}/download-url`, {}),
    onError: errorHandler(opts),
  });
}

export function useCreateGrant(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<DocumentGrant, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post(`/api/documents/${id}/grants`, body),
    onSuccess: () => invalidate(qc, [documentsKeys.detail(id)]),
    onError: errorHandler(opts),
  });
}

export function useRevokeGrant(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<{ status: string }, ApiError, string>({
    mutationFn: (grantId) => api.delete(`/api/documents/${id}/grants/${grantId}`),
    onSuccess: () => invalidate(qc, [documentsKeys.detail(id)]),
    onError: errorHandler(opts),
  });
}

function lifecycleMutation(id: string, action: string, opts: MutationOpts) {
  return {
    mutationFn: () => api.post<{ status: string }>(`/api/documents/${id}/${action}`, {}),
    onError: errorHandler(opts),
  };
}

export function useArchive(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<{ status: string }, ApiError, void>({
    ...lifecycleMutation(id, "archive", opts),
    onSuccess: () => invalidate(qc, [documentsKeys.detail(id), documentsKeys.all]),
  });
}
export function useUnarchive(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<{ status: string }, ApiError, void>({
    ...lifecycleMutation(id, "unarchive", opts),
    onSuccess: () => invalidate(qc, [documentsKeys.detail(id), documentsKeys.all]),
  });
}
export function usePurgeRequest(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<{ status: string }, ApiError, void>({
    ...lifecycleMutation(id, "purge-request", opts),
    onSuccess: () => invalidate(qc, [documentsKeys.detail(id), documentsKeys.all]),
  });
}
export function usePurge(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<{ status: string }, ApiError, void>({
    ...lifecycleMutation(id, "purge", opts),
    onSuccess: () => invalidate(qc, [documentsKeys.detail(id), documentsKeys.all]),
  });
}

export function useCreateRetentionPolicy(opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<RetentionPolicy, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.post("/api/documents/retention-policies", body),
    onSuccess: () => invalidate(qc, [documentsKeys.retentionPolicies()]),
    onError: errorHandler(opts),
  });
}

export function useUpdateRetentionPolicy(id: string, opts: MutationOpts = {}) {
  const qc = useQueryClient();
  return useMutation<RetentionPolicy, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.patch(`/api/documents/retention-policies/${id}`, body),
    onSuccess: () => invalidate(qc, [documentsKeys.retentionPolicies()]),
    onError: errorHandler(opts),
  });
}

export function downloadDocumentsReport(): Promise<void> {
  return downloadAuthed("/api/documents/report/export", "documents-report.xlsx");
}
