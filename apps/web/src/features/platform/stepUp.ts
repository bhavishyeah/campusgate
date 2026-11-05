import { ApiError, API_BASE } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

/**
 * Thrown when a platform route replies 401 `{ error: "Step-up required" }`.
 * The caller opens the step-up dialog, mints a token, and retries — this is
 * NOT a session expiry, so it must never trigger a logout.
 */
export class PlatformStepUpError extends Error {
  constructor() {
    super("Step-up required");
    this.name = "PlatformStepUpError";
  }
}

/**
 * Raw-fetch POST that attaches the step-up token to `x-step-up` (the shared
 * api.* helper does not). Mirrors features/exams/hooks.ts `publishRequest`:
 * - sets Authorization from the auth store + Content-Type
 * - sets `x-step-up` ONLY when a token is passed
 * - on 401 `Step-up required` throws PlatformStepUpError (no logout)
 * - on any other 401 logs out then throws ApiError
 * The step-up token is never logged or stored.
 */
export async function postWithStepUp<T>(
  endpoint: string,
  body: unknown,
  stepUpToken?: string,
): Promise<T> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (stepUpToken) headers["x-step-up"] = stepUpToken;

  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) {
      // The step-up gate also answers 401; only a real session expiry logs out.
      if (data?.error === "Step-up required") throw new PlatformStepUpError();
      useAuthStore.getState().logout();
    }
    throw new ApiError(response.status, data);
  }
  return data as T;
}
