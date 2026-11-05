import type { Asset, AuditLine, Category, StockItem, Asset as AssetT } from "./types";

/** "CODE - Name". */
export function categoryLabel(c: Pick<Category, "code" | "name">): string {
  return `${c.code} - ${c.name}`;
}

/** "TAG - Name". */
export function assetLabel(a: Pick<Asset, "assetTag" | "name">): string {
  return `${a.assetTag} - ${a.name}`;
}

/** Custodian summary with no id: "Assigned (user)" / "Assigned (dept)" / "In store". */
export function custodianLabel(a: Pick<Asset, "custodyUserId" | "custodyDepartmentId">): string {
  if (a.custodyUserId) return "Assigned (user)";
  if (a.custodyDepartmentId) return "Assigned (dept)";
  return "In store";
}

/** On-hand with reorder level, e.g. "12 (reorder at 5)" or "12". */
export function onHandLabel(item: Pick<StockItem, "onHandQuantity" | "reorderLevel">): string {
  if (item.reorderLevel !== null && item.reorderLevel !== undefined) {
    return `${item.onHandQuantity} (reorder at ${item.reorderLevel})`;
  }
  return String(item.onHandQuantity);
}

/** found - expected, or null when either is missing. */
export function discrepancy(line: Pick<AuditLine, "expectedQuantity" | "foundQuantity">): number | null {
  if (line.expectedQuantity === null || line.expectedQuantity === undefined) return null;
  if (line.foundQuantity === null || line.foundQuantity === undefined) return null;
  return line.foundQuantity - line.expectedQuantity;
}

export function isTerminalAsset(status: AssetT["status"]): boolean {
  return status === "RETIRED" || status === "DISPOSED";
}

/** Concatenate asset option pages, de-duplicating by id (a refetch may overlap). */
export function mergeOptionPages(existing: readonly Asset[], next: readonly Asset[]): Asset[] {
  const seen = new Set(existing.map((a) => a.id));
  const out = [...existing];
  for (const a of next) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

/** Case-insensitive substring filter on the asset tag. */
export function filterByText(assets: readonly Asset[], text: string): Asset[] {
  const t = text.trim().toLowerCase();
  if (t === "") return [...assets];
  return assets.filter((a) => a.assetTag.toLowerCase().includes(t));
}

/**
 * Concatenate stock-item option pages, de-duplicating by id (a refetch may
 * overlap). The AuditLine stock picker accumulates pages so every stock item is
 * reachable, not just the first page (the AssetPicker precedent).
 */
export function mergeStockPages(existing: readonly StockItem[], next: readonly StockItem[]): StockItem[] {
  const seen = new Set(existing.map((s) => s.id));
  const out = [...existing];
  for (const s of next) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

/** "TAG (on-hand N)" / "ID (on-hand N)" option label for the stock picker. */
export function stockOptionLabel(s: Pick<StockItem, "id" | "assetTag" | "onHandQuantity">): string {
  return s.assetTag ? `${s.assetTag} (on-hand ${s.onHandQuantity})` : `${s.id} (on-hand ${s.onHandQuantity})`;
}
