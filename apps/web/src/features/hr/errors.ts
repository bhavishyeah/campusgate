import { ApiError } from "@/lib/api";

/** True for the 403 the API returns when the institution has not activated the module. */
export function isModuleInactiveError(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 403) return false;
  const raw: unknown = err.data?.error;
  return typeof raw === "string" && raw.startsWith("Module not active");
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Extra context line for the 422 `insufficient leave balance` response; null when extras are missing. */
export function describeInsufficientBalance(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const { remaining, requested } = data as { remaining?: unknown; requested?: unknown };
  if (!isNum(remaining) || !isNum(requested)) return null;
  return `Remaining ${remaining} days, requested ${requested} days.`;
}
