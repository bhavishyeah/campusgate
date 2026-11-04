import { API_BASE, ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

/** Parse the filename from a Content-Disposition header, falling back when absent. */
export function filenameFromDisposition(header: string | null | undefined, fallback: string): string {
  if (!header) return fallback;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  if (!m || !m[1].trim()) return fallback;
  try {
    return decodeURIComponent(m[1].trim());
  } catch {
    return m[1].trim();
  }
}

export type ReportKind = "leave-summary" | "attendance-summary";

/** Fetches the xlsx with the bearer token and saves it via a temporary link. */
export async function downloadReport(
  kind: ReportKind,
  params?: { from: string; to: string },
): Promise<void> {
  const token = useAuthStore.getState().token;
  const query = kind === "attendance-summary" && params
    ? `?from=${encodeURIComponent(params.from)}&to=${encodeURIComponent(params.to)}`
    : "";
  const response = await fetch(`${API_BASE}/api/hr/reports/${kind}.xlsx${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(response.status, data);
  }
  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get("Content-Disposition"), `${kind}.xlsx`);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
