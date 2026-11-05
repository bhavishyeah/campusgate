import type { AuditLine, AuditSession } from "./types";

/**
 * There is no GET /audits endpoint (api-contract §audits note), so the create-and-work
 * surface holds the session + appended lines in client state (sessionStorage, so it
 * survives the navigate from the list page to the detail page). A hard refresh with no
 * stored state shows an EmptyState.
 */
interface StoredAudit {
  session: AuditSession;
  lines: AuditLine[];
}

const KEY = (id: string) => `inventory.audit.${id}`;

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

export function seedAuditSession(session: AuditSession): void {
  if (!isBrowser()) return;
  const stored: StoredAudit = { session, lines: [] };
  window.sessionStorage.setItem(KEY(session.id), JSON.stringify(stored));
}

export function readAuditSession(id: string): StoredAudit | null {
  if (!isBrowser()) return null;
  const raw = window.sessionStorage.getItem(KEY(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredAudit;
  } catch {
    return null;
  }
}

export function appendAuditLine(id: string, line: AuditLine): StoredAudit | null {
  const current = readAuditSession(id);
  if (!current) return null;
  const next: StoredAudit = { ...current, lines: [...current.lines, line] };
  window.sessionStorage.setItem(KEY(id), JSON.stringify(next));
  return next;
}

export function closeAuditSession(id: string): StoredAudit | null {
  const current = readAuditSession(id);
  if (!current) return null;
  const next: StoredAudit = { ...current, session: { ...current.session, status: "CLOSED" } };
  window.sessionStorage.setItem(KEY(id), JSON.stringify(next));
  return next;
}
