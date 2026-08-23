// Pass status transitions — defines which states can transition to which
export const VALID_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["ACTIVE", "CANCELLED", "REVOKED", "EXPIRED"],
  ACTIVE: ["OUTSIDE", "CANCELLED", "REVOKED", "EXPIRED"],
  OUTSIDE: ["COMPLETED"],
  // Terminal states — no transitions out
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
  EXPIRED: [],
  REVOKED: [],
};

// Pass number prefix
export const PASS_NUMBER_PREFIX = "CG";

// QR token validity in minutes
export const QR_TOKEN_VALIDITY_MINUTES = 480; // 8 hours

// Roles
export const ROLES = ["STUDENT", "HOD", "GUARD", "ADMIN"] as const;
export type RoleType = (typeof ROLES)[number];

// Account statuses
export const ACCOUNT_STATUSES = [
  "ACTIVE",
  "INACTIVE",
  "PENDING_APPROVAL",
] as const;
