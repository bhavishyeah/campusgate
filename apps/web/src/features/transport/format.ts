import { formatDate, formatMinute } from "@/features/hr/format";
import { dayOfWeekLabel } from "./labels";
import type { Schedule, UtilizationRow } from "./types";

export function dayLabel(d: string): string {
  return dayOfWeekLabel[d] ?? d;
}

/** "Every Mon" for a weekly schedule, else the one-off date. */
export function scheduleWhen(s: Pick<Schedule, "dayOfWeek" | "date">): string {
  if (s.dayOfWeek) return `Every ${dayLabel(s.dayOfWeek)}`;
  return formatDate(s.date);
}

/** "08:00 - 09:15", or "08:00" without an arrival time. */
export function scheduleTimes(s: Pick<Schedule, "departureTime" | "arrivalTime">): string {
  const dep = formatMinute(s.departureTime);
  return s.arrivalTime === null || s.arrivalTime === undefined ? dep : `${dep} - ${formatMinute(s.arrivalTime)}`;
}

export function pickupOffsetLabel(n: number | null | undefined): string {
  return n === null || n === undefined ? "-" : `+${n} min`;
}

export function utilizationLabel(row: Pick<UtilizationRow, "capacity" | "enrolled" | "utilization">): string {
  if (row.capacity === null) return "No active vehicle";
  const pct = row.utilization === null ? 0 : Math.round(row.utilization * 100);
  return `${row.enrolled} of ${row.capacity} (${pct}%)`;
}

export function stopLabel(stop: { sequence: number; name: string }): string {
  return `${stop.sequence}. ${stop.name}`;
}
