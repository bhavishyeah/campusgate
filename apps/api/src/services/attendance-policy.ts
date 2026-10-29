import type { AttendanceStatus } from "@campusgate/db";

/**
 * Pure attendance-policy helpers (design §3.5 / §8.6). No I/O — the ONE shared
 * definition of the attendance rate + threshold used by `GET /me`, the section
 * report, and the low-attendance alert, so they can never disagree.
 */

export interface AttendancePolicy {
  /** Which statuses count toward the attendance-rate numerator. */
  presentStatuses: AttendanceStatus[];
  /** Alert / flag when a student's rate drops below this percent. */
  lowAttendanceThresholdPercent: number;
  /** The marker may edit SUBMITTED records in place before finalize. */
  allowSelfCorrectionBeforeFinalize: boolean;
}

const VALID_STATUSES: readonly AttendanceStatus[] = ["PRESENT", "ABSENT", "LATE", "EXCUSED"];

const DEFAULT_PRESENT_STATUSES: AttendanceStatus[] = ["PRESENT", "LATE"];
const DEFAULT_THRESHOLD = 75;
const DEFAULT_ALLOW_SELF_CORRECTION = true;

/**
 * Resolve an institution's attendance policy from `InstitutionModule.settings`
 * JSON (unknown shape). Any absent/invalid key falls back to the documented
 * Phase 4 default (design §3.5). Always returns a complete, safe policy.
 */
export function attendancePolicy(settings: unknown): AttendancePolicy {
  const obj: Record<string, unknown> =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};

  // presentStatuses: must be a non-empty array of valid status strings.
  let presentStatuses = DEFAULT_PRESENT_STATUSES;
  const rawPresent = obj.presentStatuses;
  if (Array.isArray(rawPresent)) {
    const filtered = rawPresent.filter(
      (s): s is AttendanceStatus =>
        typeof s === "string" && (VALID_STATUSES as readonly string[]).includes(s),
    );
    if (filtered.length > 0) {
      presentStatuses = [...new Set(filtered)];
    }
  }

  // lowAttendanceThresholdPercent: a finite number in [0, 100].
  let lowAttendanceThresholdPercent = DEFAULT_THRESHOLD;
  const rawThreshold = obj.lowAttendanceThresholdPercent;
  if (typeof rawThreshold === "number" && Number.isFinite(rawThreshold) && rawThreshold >= 0 && rawThreshold <= 100) {
    lowAttendanceThresholdPercent = rawThreshold;
  }

  // allowSelfCorrectionBeforeFinalize: a boolean.
  let allowSelfCorrectionBeforeFinalize = DEFAULT_ALLOW_SELF_CORRECTION;
  const rawAllow = obj.allowSelfCorrectionBeforeFinalize;
  if (typeof rawAllow === "boolean") {
    allowSelfCorrectionBeforeFinalize = rawAllow;
  }

  return { presentStatuses, lowAttendanceThresholdPercent, allowSelfCorrectionBeforeFinalize };
}

/**
 * The ONE attendance-rate definition (design §8.6):
 *  - numerator   = count(status ∈ policy.presentStatuses)
 *  - denominator = count(status != EXCUSED)   (EXCUSED excluded from BOTH)
 *  - rate        = denominator === 0 ? null : (numerator / denominator) * 100
 *
 * Returns null when there is nothing to count (no non-EXCUSED records).
 */
export function attendanceRate(
  records: { status: AttendanceStatus }[],
  policy: AttendancePolicy,
): number | null {
  const present = new Set(policy.presentStatuses);
  let numerator = 0;
  let denominator = 0;
  for (const r of records) {
    if (r.status === "EXCUSED") continue; // excluded from both
    denominator += 1;
    if (present.has(r.status)) numerator += 1;
  }
  if (denominator === 0) return null;
  return (numerator / denominator) * 100;
}

/**
 * The downward-crossing predicate for the low-attendance alert (design §8.6).
 * Fire iff the student is below threshold now AND was at/above threshold (or had
 * no prior history) before this finalize.
 */
export function crossedBelowThreshold(
  priorRate: number | null,
  postRate: number | null,
  thresholdPercent: number,
): boolean {
  return (
    postRate !== null &&
    postRate < thresholdPercent &&
    (priorRate === null || priorRate >= thresholdPercent)
  );
}
