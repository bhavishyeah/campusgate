import { formatPaise } from "@/lib/money";

/**
 * Rupee text -> integer paise as a JSON number (the HR API takes a number). Zero is allowed.
 * String operations only; null on invalid input or a value above Number.MAX_SAFE_INTEGER.
 */
export function parseSalaryRupees(input: string): number | null {
  const stripped = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(stripped)) return null;
  const [whole, fraction = ""] = stripped.split(".");
  const digits = (whole + (fraction + "00").slice(0, 2)).replace(/^0+/, "") || "0";
  if (BigInt(digits) > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(digits);
}

export function formatSalary(paise: string | null): string {
  return paise === null ? "-" : formatPaise(paise);
}

/** Paise string -> rupee text for edit prefill: "123450" -> "1234.50". */
export function paiseToRupeeInput(paise: string): string {
  const s = paise.trim().replace(/^0+/, "") || "0";
  const padded = s.padStart(3, "0");
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}
