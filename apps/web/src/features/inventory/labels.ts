export const assetStatusLabel: Record<string, string> = {
  IN_STORE: "In store",
  ASSIGNED: "Assigned",
  IN_MAINTENANCE: "In maintenance",
  RETIRED: "Retired",
  DISPOSED: "Disposed",
};
export const assetKindLabel: Record<string, string> = {
  FIXED_ASSET: "Fixed asset",
  CONSUMABLE: "Consumable",
};
export const maintenanceStatusLabel: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  RESOLVED: "Resolved",
  CANCELLED: "Cancelled",
};
export const stockKindLabel: Record<string, string> = {
  RECEIPT: "Receipt",
  ISSUE: "Issue",
  ADJUSTMENT: "Adjustment",
};
export const disposalMethodLabel: Record<string, string> = {
  SOLD: "Sold",
  SCRAPPED: "Scrapped",
  DONATED: "Donated",
  LOST: "Lost",
  WRITTEN_OFF: "Written off",
  OTHER: "Other",
};
export const terminalStatusLabel: Record<string, string> = {
  RETIRED: "Retired",
  DISPOSED: "Disposed",
};

export type StatusKind = "asset" | "maintenance" | "stock";

export const STATUS_LABELS: Record<StatusKind, Record<string, string>> = {
  asset: assetStatusLabel,
  maintenance: maintenanceStatusLabel,
  stock: stockKindLabel,
};

/** Badge tone per status: good, bad, muted, otherwise warning. */
export const GOOD_STATUSES = new Set(["IN_STORE", "RESOLVED", "RECEIPT"]);
export const BAD_STATUSES = new Set(["RETIRED", "DISPOSED", "CANCELLED", "ISSUE"]);
export const MUTED_STATUSES = new Set(["ADJUSTMENT"]);

export function toOptions(labels: Record<string, string>): { value: string; label: string }[] {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}
