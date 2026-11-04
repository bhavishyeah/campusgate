/** Splits a comma/whitespace separated ID list into unique, non-empty IDs. */
export function parseIdList(text: string): string[] {
  return Array.from(new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)));
}

/** Formats an ISO datetime for display. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Basis points -> "12.34". */
export function formatPercent(bps: number): string {
  return (bps / 100).toFixed(2);
}
