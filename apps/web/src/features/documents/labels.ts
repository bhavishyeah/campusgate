import type { AccessLevel, DocStatus } from "./types";

/** Labels reflect real backend semantics only. */
export const DOC_STATUS_LABEL: Record<DocStatus, string> = {
  ACTIVE: "Active",
  ARCHIVED: "Archived",
  PURGE_PENDING: "Purge pending",
  PURGED: "Purged",
};

export const ACCESS_LEVEL_LABEL: Record<AccessLevel, string> = {
  READ: "Read",
  MANAGE: "Manage",
};

/**
 * Formats the API's BigInt-string `sizeBytes` as a human-readable size.
 * Parses the string (never treats it as a number elsewhere). Binary units.
 */
export function formatBytes(sizeBytes: string): string {
  const n = Number(sizeBytes);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * Whether a document of this status can still have a signed download minted.
 * True for ACTIVE/ARCHIVED; false for PURGE_PENDING/PURGED (bytes gone/going →
 * the server returns 403 "document is not downloadable"). Drives Download-button
 * visibility.
 */
export function canDownloadStatus(status: DocStatus): boolean {
  return status === "ACTIVE" || status === "ARCHIVED";
}
