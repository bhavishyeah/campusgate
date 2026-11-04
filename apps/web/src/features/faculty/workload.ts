import type { WorkloadRow } from "./types";

export function workloadForTerm(rows: WorkloadRow[], termId: string): WorkloadRow | undefined {
  return rows.find((r) => r.academicTermId === termId);
}

export function formatHours(n: number): string {
  return `${n} h`;
}

/** `over` is the server-computed flag (authoritative); `max` null means no cap. */
export function utilization(row: WorkloadRow): { total: number; max: number | null; over: boolean } {
  return { total: row.totalHours, max: row.policyMaxWeeklyHours, over: row.overAllocated };
}
