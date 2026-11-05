import type { DocStatus } from "./types";

/**
 * Forward status machine, mirroring the server DOC_STATUS_TRANSITIONS:
 * ACTIVE ⇄ ARCHIVED, both → PURGE_PENDING → PURGED (terminal). A self-transition
 * is a legal no-op server-side but is NOT offered as a UI action.
 */
export const DOC_STATUS_TRANSITIONS: Record<DocStatus, DocStatus[]> = {
  ACTIVE: ["ARCHIVED", "PURGE_PENDING"],
  ARCHIVED: ["ACTIVE", "PURGE_PENDING"],
  PURGE_PENDING: ["PURGED"],
  PURGED: [],
};

export type LifecycleAction = "archive" | "unarchive" | "purge-request" | "purge";

/**
 * The lifecycle actions legal from a given status (drives which buttons render):
 *  - ACTIVE        → archive, purge-request
 *  - ARCHIVED      → unarchive, purge-request
 *  - PURGE_PENDING → purge
 *  - PURGED        → [] (terminal)
 */
export function lifecycleActions(status: DocStatus): LifecycleAction[] {
  switch (status) {
    case "ACTIVE":
      return ["archive", "purge-request"];
    case "ARCHIVED":
      return ["unarchive", "purge-request"];
    case "PURGE_PENDING":
      return ["purge"];
    case "PURGED":
      return [];
  }
}
