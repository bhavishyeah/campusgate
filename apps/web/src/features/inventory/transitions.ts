import type { AssetStatus, MaintenanceStatus } from "./types";

// Maintenance request lifecycle (DB-guard enforced). Mirror of the server.
export const MAINTENANCE_TRANSITIONS = {
  OPEN: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["RESOLVED", "CANCELLED"],
  RESOLVED: [],
  CANCELLED: [],
} as const;

// Asset status is NOT a UI-chosen transition table: the UI never sets status
// directly. The UI only gates which ACTION is offered by the current status.
export const ASSET_ACTIONS = {
  IN_STORE: ["TRANSFER", "MAINTENANCE", "DISPOSE"],
  ASSIGNED: ["TRANSFER", "MAINTENANCE", "DISPOSE"],
  IN_MAINTENANCE: ["DISPOSE"],
  RETIRED: [],
  DISPOSED: [],
} as const;

export type AssetAction = "TRANSFER" | "MAINTENANCE" | "DISPOSE";

/** Legal maintenance targets from a status (never OPEN; [] for terminal). */
export function maintenanceActions(status: MaintenanceStatus): ("IN_PROGRESS" | "RESOLVED" | "CANCELLED")[] {
  return [...MAINTENANCE_TRANSITIONS[status]];
}

/** Actions offered for an asset status (terminal -> []). */
export function assetActions(status: AssetStatus): AssetAction[] {
  return [...ASSET_ACTIONS[status]];
}
