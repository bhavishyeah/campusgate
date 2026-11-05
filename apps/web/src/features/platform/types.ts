/**
 * Response/row types for the platform (super-admin) surface, mirroring the
 * api-contract §3 handler shapes. These are UI-facing read models; the backend
 * is the authoritative source of truth.
 */

export type InstitutionStatus = "ACTIVE" | "SUSPENDED";

export interface PlatformStats {
  institutions: { total: number; active: number; suspended: number };
  users: { total: number; students: number };
  movement: { totalPasses: number; currentlyOutside: number };
}

export interface InstitutionRow {
  id: string;
  name: string;
  code: string;
  domain: string | null;
  status: InstitutionStatus;
  _count: {
    users: number;
    departments: number;
    gates: number;
    exitReasons: number;
  };
}

export interface CreateInstitutionResult {
  institution: InstitutionRow;
  admin: { id: string; email: string; role: string };
  /**
   * Show-once bootstrap secret. NEVER persist this to any store, localStorage,
   * React Query cache, analytics, console.*, or toast — transient state only.
   */
  tempPassword: string;
}

export type ModuleState =
  | "NOT_ENTITLED"
  | "ENTITLED"
  | "ACTIVE"
  | "SUSPENDED";

export interface ModuleMatrixRow {
  moduleKey: string;
  name: string;
  state: ModuleState;
  entitledAt: string | null;
  activatedAt: string | null;
  suspendedAt: string | null;
}

export interface ModuleMatrixResponse {
  institutionId: string;
  modules: ModuleMatrixRow[];
}

export type SupportGrantStatus =
  | "REQUESTED"
  | "ACTIVE"
  | "EXPIRED"
  | "REVOKED";

export interface SupportGrant {
  id: string;
  institutionId: string;
  grantedToUserId: string;
  purpose: string;
  status: SupportGrantStatus;
  expiresAt: string;
  activatedAt: string | null;
  revokedAt?: string | null;
  revokedReason?: string | null;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  institutionId: string | null;
  action: string;
  outcome: string;
  actorUserId: string | null;
  actorRoleKey: string | null;
  metadata: unknown;
  timestamp: string;
}

export interface AuditEventsResponse {
  events: AuditEvent[];
}

export interface BreakGlassOverview {
  institutionId: string;
  auditEvents: AuditEvent[];
  passes: unknown[];
}
