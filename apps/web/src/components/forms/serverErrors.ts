import { ApiError } from "@/lib/api";
import { describeApiError } from "@/lib/apiErrors";

/** Server 4xx text -> the form field it belongs to (exact strings only). */
export type FieldConflictMap = Record<string, string>;

/**
 * Returns the message to show inline (server text verbatim for 4xx). When the message is a known
 * field conflict, the same text is also attached to that field with setError.
 */
export function handleServerError(
  err: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  form: any,
  conflicts: FieldConflictMap = {},
): string {
  const message = describeApiError(err);
  if (err instanceof ApiError) {
    const raw: unknown = err.data?.error;
    if (typeof raw === "string" && conflicts[raw]) {
      form.setError(conflicts[raw], { type: "server", message: raw });
    }
  }
  return message;
}

/** True for a 5xx ApiError (used for the duplicate-name hint). */
export function isServerFault(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 500;
}
