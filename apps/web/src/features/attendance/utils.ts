// features/attendance/utils.ts

/** Returns today's date as a YYYY-MM-DD ISO string.
 * UTC date (matches server storage) */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
