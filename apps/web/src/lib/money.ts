/**
 * Money helpers — INTEGER PAISE, STRING-ONLY. Money NEVER passes through a JS
 * float: there is NO Number(paise), NO parseFloat, NO `* 100` anywhere in this
 * file. Display and summation use BigInt + string operations exclusively, so a
 * paise value larger than Number.MAX_SAFE_INTEGER can never lose precision.
 */

/** Group an unsigned rupee integer STRING with Indian digit grouping (last 3
 * digits, then pairs). Pure string ops. e.g. "1234567" -> "12,34,567". */
function groupIndian(rupees: string): string {
  if (rupees.length <= 3) return rupees;
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  // Split the remaining head into pairs from the right.
  const parts: string[] = [];
  let i = rest.length;
  while (i > 0) {
    const start = Math.max(0, i - 2);
    parts.unshift(rest.slice(start, i));
    i = start;
  }
  return parts.join(",") + "," + last3;
}

/**
 * Format a decimal paise STRING (e.g. "123456") as a grouped rupee string with
 * the ₹ sign (e.g. "₹1,234.56"). Handles a leading '-'. String ops only.
 */
export function formatPaise(paise: string): string {
  let s = paise.trim();
  let neg = false;
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  }
  // Strip leading zeros (keep at least one digit), then pad to >= 3 so the
  // slice into rupees + paise is always well-defined.
  s = s.replace(/^0+/, "");
  if (s === "") s = "0";
  const padded = s.padStart(3, "0");
  const rupees = padded.slice(0, -2);
  const paisePart = padded.slice(-2);
  const grouped = groupIndian(rupees);
  return `${neg ? "-" : ""}₹${grouped}.${paisePart}`;
}

/**
 * Convert a rupee input STRING (optionally with Indian grouping commas and up
 * to two decimals) to an integer paise STRING satisfying PaiseAmount's
 * /^[1-9]\d*$/. Throws a clear Error on invalid or zero input. String ops only.
 */
export function rupeesToPaiseString(input: string): string {
  const stripped = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(stripped)) {
    throw new Error("Enter a valid amount (digits with up to two decimals).");
  }
  const [whole, fraction = ""] = stripped.split(".");
  const paddedFraction = (fraction + "00").slice(0, 2);
  let paise = (whole + paddedFraction).replace(/^0+/, "");
  if (paise === "") {
    throw new Error("Amount must be greater than zero.");
  }
  // At this point `paise` has no leading zeros and is non-empty, so it matches
  // /^[1-9]\d*$/ by construction.
  return paise;
}

/** Sum a list of decimal paise STRINGs via BigInt accumulation. */
export function sumPaise(values: string[]): string {
  let total = 0n;
  for (const v of values) {
    total += BigInt(v);
  }
  return total.toString();
}
