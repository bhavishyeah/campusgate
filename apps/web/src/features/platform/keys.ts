import type { SupportGrantStatus } from "./types";

/**
 * TanStack Query key factory for the platform (super-admin) domain. Every
 * parameterized key embeds ALL of its params (object segments for the
 * filterable grants/audit lists) so caches never collide across inputs.
 */
export const platformKeys = {
  stats: () => ["platform", "stats"] as const,
  institutions: () => ["platform", "institutions"] as const,
  modules: (id: string) => ["platform", "institutions", id, "modules"] as const,
  grants: (institutionId?: string, status?: SupportGrantStatus) =>
    [
      "platform",
      "support-grants",
      { institutionId: institutionId ?? null, status: status ?? null },
    ] as const,
  grantOverview: (grantId: string) =>
    ["platform", "support-grants", grantId, "overview"] as const,
  audit: (scope: AuditScope, grantId: string | null, limit: number) =>
    ["platform", "audit-events", { scope, grantId, limit }] as const,
} as const;

export type AuditScope = "platform" | "grant";
