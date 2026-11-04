import { API_BASE, ApiError } from "@/lib/api";
import { filenameFromDisposition } from "@/features/hr/download";
import { useAuthStore } from "@/stores/auth";

/**
 * Authenticated file download: fetches with the bearer token, then saves the blob via a
 * temporary link. A non-OK response throws ApiError with the parsed body.
 */
export async function downloadAuthed(path: string, fallbackName: string): Promise<void> {
  const token = useAuthStore.getState().token;
  const response = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(response.status, data);
  }
  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get("Content-Disposition"), fallbackName);
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
