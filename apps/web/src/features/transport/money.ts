import { formatPaise, rupeesToPaiseString } from "@/lib/money";

/** Fee is a paise digit string or null. Zero set via the API displays as the zero amount. */
export function formatFee(paise: string | null | undefined): string {
  if (paise === null || paise === undefined) return "No fee";
  return formatPaise(paise);
}

/**
 * Maintenance cost arrives as a JSON integer (or a digit string). Anything else is rejected
 * (null) rather than guessed at.
 */
export function costToPaiseString(v: number | string | null | undefined): string | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? String(v) : null;
  if (typeof v === "string") return /^\d+$/.test(v) ? v : null;
  return null;
}

export function formatCost(v: number | string | null | undefined): string {
  const paise = costToPaiseString(v);
  return paise === null ? "-" : formatPaise(paise);
}

/**
 * Paise digit string -> rupee input text by string splitting (no floats).
 * "0" gives "" so an untouched stored zero is neither dirty nor sent.
 */
export function paiseToRupeeInput(paise: string): string {
  const s = paise.replace(/^0+/, "");
  if (s === "") return "";
  const padded = s.padStart(3, "0");
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

export const rupeesToPaise = rupeesToPaiseString;
