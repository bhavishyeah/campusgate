// features/classes/utils.ts

/** Converts a minute-of-day integer (0..1440) to HH:MM display label. */
export function minuteToLabel(m: number): string {
  const h = Math.floor(m / 60).toString().padStart(2, "0");
  const min = (m % 60).toString().padStart(2, "0");
  return `${h}:${min}`;
}
