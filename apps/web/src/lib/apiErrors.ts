import { ApiError } from "@/lib/api";

/**
 * Turn any thrown value into a user-facing message. Server 4xx text is returned
 * verbatim unless an exact-string override is supplied. The ONLY logging in the
 * Library/Admissions UI happens here, for status >= 500 (status + message only).
 */
export function describeApiError(
  err: unknown,
  overrides?: Record<string, string>,
): string {
  if (!(err instanceof ApiError)) {
    if (err instanceof TypeError) return "Network error, check your connection.";
    if (err instanceof Error && err.message) return err.message;
    return "Something went wrong.";
  }

  if (err.status >= 500) {
    console.error(`API error ${err.status}: ${err.message}`);
    return "Server error, please try again.";
  }

  const raw: unknown = err.data?.error;

  if (err.status === 403) {
    if (typeof raw === "string" && raw.startsWith("Module not active")) {
      return "This module isn't enabled for your institution.";
    }
    return "You don't have permission to do that.";
  }

  if (typeof raw === "string") {
    return overrides?.[raw] ?? raw;
  }

  if (raw && typeof raw === "object") {
    const flat = raw as {
      fieldErrors?: Record<string, string[] | undefined>;
      formErrors?: string[];
    };
    for (const msgs of Object.values(flat.fieldErrors ?? {})) {
      if (msgs && msgs.length > 0) return msgs[0];
    }
    if (flat.formErrors && flat.formErrors.length > 0) return flat.formErrors[0];
  }

  return "Invalid request.";
}
