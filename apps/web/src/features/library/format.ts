/**
 * Library fines are RUPEE decimal strings (e.g. "12.5"), not paise. This is a
 * display-only formatter; lib/money.ts (paise) must not be used for them.
 */
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

export function formatRupeeDecimal(value: string): string {
  const m = DECIMAL.exec(value.trim());
  if (!m) return value;
  const [, sign, whole, frac = ""] = m;
  // Round half up to 2 dp using BigInt scaling (no float arithmetic).
  const padded = (frac + "000").slice(0, 3);
  let cents = BigInt(whole) * 100n + BigInt(padded.slice(0, 2));
  if (padded[2] >= "5") cents += 1n;
  const w = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const f = (cents % 100n).toString().padStart(2, "0");
  return `${sign}₹${w}.${f}`;
}

const RUPEE_INPUT = /^\d+(\.\d{1,2})?$/;

/** Parse a rupee amount typed by the user into a JSON number; null if invalid. */
export function parseRupeeInput(value: string): number | null {
  const v = value.trim();
  if (!RUPEE_INPUT.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
