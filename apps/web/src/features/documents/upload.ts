// features/documents/upload.ts
//
// The documents upload contract is NOT multipart: the raw file bytes are the
// HTTP request body (Content-Type: application/octet-stream) and all metadata
// rides on lowercased `x-<field>` request headers. The shared `lib/api.ts`
// client is JSON-only (it forces Content-Type: application/json and
// JSON.stringifies the body), so it cannot carry a raw Blob body with custom
// headers. Rather than bend the shared client, this module ships a minimal
// local fetch helper mirroring the `fees` apiPatch precedent: it uses the auth
// token, throws ApiError, and logs out on 401.
import { API_BASE, ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import type { CreatedDocument, DocumentVersion } from "./types";

/** 25 MiB — mirrors the server MAX_UPLOAD_BYTES constant (25 * 1024 * 1024). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface UploadMeta {
  title: string;
  filename: string;
  contentType: string;
  description?: string;
  category?: string;
  retentionPolicyId?: string;
}

export interface VersionMeta {
  filename: string;
  contentType: string;
}

/** Appends `x-<name>` only when the value is a non-empty string. */
function putOptional(headers: Record<string, string>, name: string, value: string | undefined): void {
  if (value !== undefined && value !== "") headers[name] = value;
}

/**
 * PURE header builder for the create-document upload. Lowercased header names;
 * octet-stream body content type; optional metadata headers omitted when their
 * field is empty/undefined; `authorization` present only when a token exists.
 */
export function buildCreateHeaders(m: UploadMeta, token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "x-title": m.title,
    "x-filename": m.filename,
    "x-contenttype": m.contentType,
  };
  if (token) headers["authorization"] = `Bearer ${token}`;
  putOptional(headers, "x-description", m.description);
  putOptional(headers, "x-category", m.category);
  putOptional(headers, "x-retentionpolicyid", m.retentionPolicyId);
  return headers;
}

/** PURE header builder for the new-version upload (filename + contentType only). */
export function buildVersionHeaders(m: VersionMeta, token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "x-filename": m.filename,
    "x-contenttype": m.contentType,
  };
  if (token) headers["authorization"] = `Bearer ${token}`;
  return headers;
}

/**
 * PURE client-side size guard, run BEFORE the network call so an oversize file
 * never wastes a 413 round-trip. The server still enforces the limit.
 */
export function validateUploadSize(bytes: number): { ok: true } | { ok: false; message: string } {
  if (bytes === 0) return { ok: false, message: "Select a file to upload." };
  if (bytes > MAX_UPLOAD_BYTES) return { ok: false, message: "File is larger than the 25 MiB limit." };
  return { ok: true };
}

async function postRawBody<T>(path: string, headers: Record<string, string>, file: File): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    // A File is a Blob → its raw bytes become the request body. The browser does
    // NOT override our explicit octet-stream content type when it is set.
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) useAuthStore.getState().logout();
    throw new ApiError(res.status, data);
  }
  return data as T;
}

/** POST /api/documents — raw bytes + x-* metadata headers. */
export function uploadDocument(file: File, m: UploadMeta): Promise<CreatedDocument> {
  const token = useAuthStore.getState().token;
  return postRawBody<CreatedDocument>("/api/documents", buildCreateHeaders(m, token), file);
}

/** POST /api/documents/:id/versions — raw bytes + x-filename/x-contenttype. */
export function uploadVersion(id: string, file: File, m: VersionMeta): Promise<DocumentVersion> {
  const token = useAuthStore.getState().token;
  return postRawBody<DocumentVersion>(`/api/documents/${id}/versions`, buildVersionHeaders(m, token), file);
}
