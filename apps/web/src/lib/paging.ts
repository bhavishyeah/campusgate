/** Number of pages for `total` rows; never less than 1. */
export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}

/** Client-side slice of an unpaginated list. `page` is clamped to 1..pageCount. */
export function slicePage<T>(rows: readonly T[], page: number, size: number): T[] {
  const p = Math.min(Math.max(1, page), pageCount(rows.length, size));
  return rows.slice((p - 1) * size, p * size);
}

const MAX_ID_PARAM = 64;

/** Validates an id taken from the URL. Empty or over-long values are dropped. */
export function readIdParam(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const v = value.trim();
  if (v === "" || v.length > MAX_ID_PARAM) return undefined;
  return v;
}

/**
 * Keeps `id` only when it is among the loaded options. While the options have not
 * loaded (undefined) the id is kept so the first request is not delayed.
 */
export function resolveKnownId(
  id: string | undefined,
  options: readonly { id: string }[] | undefined,
): string | undefined {
  if (id === undefined) return undefined;
  if (options === undefined) return id;
  return options.some((o) => o.id === id) ? id : undefined;
}
