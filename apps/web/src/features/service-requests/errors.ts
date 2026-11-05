import { ApiError } from "@/lib/api";

/** 409 `field definitions are frozen once the type has requests`. */
export function isFrozenFields(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 409 &&
    err.data?.error === "field definitions are frozen once the type has requests"
  );
}

/**
 * Extracts the raise 422 field-value map `{ errors: { <fieldKey>: token } }`.
 * Returns null for any non-422 or a body without the `errors` object.
 */
export function fieldValueErrors(err: unknown): Record<string, string> | null {
  if (!(err instanceof ApiError) || err.status !== 422) return null;
  const raw: unknown = err.data?.errors;
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}
