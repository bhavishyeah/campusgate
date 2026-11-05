import { z } from "zod";
import { formatPaise, rupeesToPaiseString } from "@/lib/money";

/** Paise digit string or null -> display. "-" when null. */
export function formatMinor(paise: string | null | undefined): string {
  if (paise === null || paise === undefined) return "-";
  return formatPaise(paise);
}

/** Rupee input text -> integer minor-unit (paise) digit string. Throws on invalid/zero. */
export const rupeesToMinorString = rupeesToPaiseString;

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

/**
 * Client zod leaf for the three inventory money fields, applied AFTER the rupee
 * -> minor-unit conversion. The literal is copied verbatim from the server's
 * `inventoryMoneyString` and is DISTINCT from lib/formFields.ts `digitString()`
 * (`...paise`) — a parity/unit test pins that they must stay different.
 */
export const minorUnitString = () =>
  z.string().regex(/^\d+$/, "must be a non-negative integer number of minor units");

/** Optional currency: 3-letter uppercase ISO-4217-shaped code. */
export const currencyString = () =>
  z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter uppercase currency code");
