export { isModuleInactiveError } from "@/features/hr/errors";

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Extra context line for the 422 `workload exceeds policy max` response; null when extras are missing. */
export function describeWorkloadExceeded(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const { totalHours, maxWeeklyHours } = data as { totalHours?: unknown; maxWeeklyHours?: unknown };
  if (!isNum(totalHours) || !isNum(maxWeeklyHours)) return null;
  return `Total ${totalHours} h exceeds the policy maximum of ${maxWeeklyHours} h.`;
}
