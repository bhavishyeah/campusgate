import { ApiError } from "@/lib/api";

/**
 * Pure classifiers for the two special platform error responses. Both check the
 * EXACT server error string so a nearby-but-different message never trips them.
 */

/** 403 `{ error: "MFA enrollment required" }` — show the MFA gate, do NOT logout. */
export function isMfaEnrollmentRequired(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 403 &&
    err.data?.error === "MFA enrollment required"
  );
}

/** 401 `{ error: "Step-up required" }` — open the step-up dialog, do NOT logout. */
export function isStepUpRequired(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 401 &&
    err.data?.error === "Step-up required"
  );
}
