/** Format an ISO date/datetime using UTC components so a UTC-midnight value never shifts a day. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }) + " UTC";
}

/** 540 -> "09:00". */
export function formatMinute(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** "HH:MM" -> minutes since midnight, or null when invalid. */
export function minuteFromTime(t: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

/** Local calendar date as YYYY-MM-DD (the server uses UTC "today"; the difference is accepted). */
export function todayIsoDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** First day of the current local month as YYYY-MM-DD. */
export function monthStartIsoDate(): string {
  return `${todayIsoDate().slice(0, 7)}-01`;
}

export function isoYear(s: string): string {
  return s.slice(0, 4);
}

/** ISO datetime -> value for <input type="date"> (UTC date). */
export function toDateInput(iso: string): string {
  return iso.slice(0, 10);
}

/** Display-only inclusive day count between two YYYY-MM-DD dates, or null when invalid/reversed. */
export function inclusiveDays(start: string, end: string): number | null {
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return null;
  return Math.round((e - s) / 86_400_000) + 1;
}
