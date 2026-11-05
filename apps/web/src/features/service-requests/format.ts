import { formatDateTime } from "@/features/hr/format";
import type { ActiveType, Activity, FieldDef, Priority, RequestRow, RequestType, VolumeRow } from "./types";

/** "category · name". */
export function typeLabel(t: Pick<RequestType, "category" | "name">): string {
  return `${t.category} · ${t.name}`;
}

/** "{n}h SLA". */
export function slaLabel(t: { slaTargetHours: number }): string {
  return `${t.slaTargetHours}h SLA`;
}

const PRIORITY_ORDER: Record<Priority, number> = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 };
export function priorityRank(p: Priority): number {
  return PRIORITY_ORDER[p] ?? 0;
}

/** Reads the server-derived isOverdue flag — never computes overdue locally. */
export function overdueBadge(row: Pick<RequestRow, "isOverdue">): string | null {
  return row.isOverdue ? "Overdue" : null;
}

export function dueLabel(row: Pick<RequestRow, "dueAt">): string {
  return formatDateTime(row.dueAt);
}

export function activityLabel(a: Pick<Activity, "kind">): string {
  const map: Record<string, string> = {
    STATUS_CHANGE: "Status change",
    ASSIGNMENT: "Assignment",
    COMMENT: "Comment",
  };
  return map[a.kind] ?? a.kind;
}

/** Joins a volume row's requestTypeId to its type name; orphan -> "Unknown type". */
export function volumeJoin(
  rows: readonly VolumeRow[],
  types: readonly { id: string; name: string }[],
): { requestTypeId: string; name: string; count: number }[] {
  const byId = new Map(types.map((t) => [t.id, t.name]));
  return rows.map((r) => ({ requestTypeId: r.requestTypeId, name: byId.get(r.requestTypeId) ?? "Unknown type", count: r.count }));
}

export function fieldDefSort(fields: readonly FieldDef[]): FieldDef[] {
  return [...fields].sort((a, b) => a.sortOrder - b.sortOrder);
}

export interface CatalogueGroup {
  category: string;
  types: ActiveType[];
}

/** Groups the active-type catalogue by category, preserving the server's order. */
export function groupActiveTypes(types: readonly ActiveType[]): CatalogueGroup[] {
  const groups: CatalogueGroup[] = [];
  const index = new Map<string, CatalogueGroup>();
  for (const t of types) {
    let g = index.get(t.category);
    if (!g) {
      g = { category: t.category, types: [] };
      index.set(t.category, g);
      groups.push(g);
    }
    g.types.push(t);
  }
  return groups;
}

/** Resolves an optional ?typeId against the catalogue. Found -> that id; unknown/absent -> "". */
export function resolvePreselectType(typeId: string | undefined, types: readonly ActiveType[]): string {
  if (!typeId) return "";
  return types.some((t) => t.id === typeId) ? typeId : "";
}
