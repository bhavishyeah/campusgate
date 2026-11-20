import { useAuthStore } from "@/stores/auth";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

class ApiError extends Error {
  status: number;
  data: any;
  constructor(status: number, data: any) {
    super(data.error || `API Error: ${status}`);
    this.status = status;
    this.data = data;
  }
}

// ─── Session freshness ───────────────────────────────────────────────────────
// The API answers `x-session-stale: 1` when the caller's token is behind the
// membership (e.g. an applicant was just enrolled and gained the STUDENT role).
// The client then swaps the token for a re-signed one (same session, same
// expiry) so the sidebar, route guards and <Can> see the new permissions.
const REFRESH_MIN_INTERVAL_MS = 30_000;
let refreshInFlight: Promise<void> | null = null;
let lastRefreshAt = 0;
let onSessionRefreshed: (() => void) | null = null;

/** Called after a successful refresh (AppProviders invalidates the query cache). */
export function setSessionRefreshListener(fn: (() => void) | null): void {
  onSessionRefreshed = fn;
}

/** Test seam. */
export function resetSessionRefreshForTests(): void {
  refreshInFlight = null;
  lastRefreshAt = 0;
  onSessionRefreshed = null;
}

function refreshSession(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  if (Date.now() - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return Promise.resolve();
  const sentWith = useAuthStore.getState().token;
  if (!sentWith) return Promise.resolve();
  lastRefreshAt = Date.now();
  refreshInFlight = (async () => {
    try {
      // A body-less JSON POST is rejected by Fastify, so send {}.
      const response = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sentWith}` },
        body: "{}",
      });
      if (!response.ok) return; // never log out here; the next 401 does that
      const data = (await response.json().catch(() => null)) as { token?: string; user?: any } | null;
      // Ignore the result when the user logged out or signed in again meanwhile.
      if (!data?.token || useAuthStore.getState().token !== sentWith) return;
      const state = useAuthStore.getState();
      state.setAuth(data.token, data.user ?? state.user!);
      onSessionRefreshed?.();
    } catch {
      // swallowed on purpose
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = useAuthStore.getState().token;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (token && !endpoint.startsWith("/api/auth/") && response.headers?.get?.("x-session-stale") === "1") {
    void refreshSession();
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Auto-logout on 401
    if (response.status === 401) {
      useAuthStore.getState().logout();
    }
    throw new ApiError(response.status, data);
  }

  return data as T;
}

export const api = {
  get: <T>(endpoint: string) => request<T>(endpoint),
  post: <T>(endpoint: string, body?: any) =>
    request<T>(endpoint, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    }),
  put: <T>(endpoint: string, body?: any) =>
    request<T>(endpoint, {
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
    }),
  patch: <T>(endpoint: string, body?: any) =>
    request<T>(endpoint, {
      method: "PATCH",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  delete: <T>(endpoint: string, body?: any) =>
    request<T>(endpoint, {
      method: "DELETE",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
};

export { ApiError };
export { API_BASE };
