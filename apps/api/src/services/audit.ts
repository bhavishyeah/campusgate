import { privilegedPrisma, type AuditResult, type Prisma } from "@campusgate/db";
import { AUDIT_ACTION_KEY_SET, type AuditActionKey } from "@campusgate/shared";

export interface AuditInput {
  action: AuditActionKey;
  result: AuditResult; // SUCCESS | DENIED | ERROR
  actorUserId: string;
  actorRoleKey: string; // request.auth.roles[0] snapshot, or "SUPER_ADMIN"
  institutionId?: string | null; // null => pure platform action
  actorMembershipId?: string | null;
  resourceType: string;
  resourceId?: string | null;
  supportGrantId?: string | null;
  requestRef?: string | null; // Fastify request.id
  metadata?: Record<string, unknown>;
}

// Max length a sanitized string value may carry into an audit row's metadata.
const MAX_METADATA_STRING = 500;
// Keys whose names look like secrets are dropped entirely (never persisted).
const SECRET_KEY_PATTERN = /password|token|secret|mfa|qr/i;

/**
 * Relay only an allow-list of scalar metadata (string | number | boolean |
 * null); truncate long strings; drop any key whose name matches a secret-like
 * pattern (password|token|secret|mfa*|qr*). Never copies nested objects/arrays
 * or whole records (design §4.3 / spec §6.3).
 */
export function sanitizeMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    if (value === null) {
      out[key] = null;
    } else if (typeof value === "string") {
      out[key] = value.length > MAX_METADATA_STRING ? value.slice(0, MAX_METADATA_STRING) : value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
    // objects, arrays, functions, symbols, undefined, bigint: dropped
  }
  return out;
}

/**
 * Record an audit event (design §4.3).
 *  - Pass `tx` (a withTenant transaction client) for a TENANT action: the row is
 *    written inside the business transaction as campass_app, atomic with the
 *    mutation. RLS policy `audit_events_tenant_insert` requires institutionId ===
 *    the active tenant GUC, which the caller sets from request.auth.institutionId.
 *  - Omit `tx` for PLATFORM / pre-tenant / cross-tenant actions: the row is
 *    written on privilegedPrisma (bypasses RLS), required for institutionId ===
 *    null rows.
 *
 * Throws if `input.action` is not a known catalogue key — an unknown key is a
 * programming error and must never persist silently.
 */
export async function recordAuditEvent(
  input: AuditInput,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  if (!AUDIT_ACTION_KEY_SET.has(input.action)) {
    throw new Error(`recordAuditEvent: unknown action key "${input.action}"`);
  }
  const client = tx ?? privilegedPrisma;
  await client.auditEvent.create({
    data: {
      action: input.action,
      result: input.result,
      actorUserId: input.actorUserId,
      actorRoleKey: input.actorRoleKey,
      institutionId: input.institutionId ?? null,
      actorMembershipId: input.actorMembershipId ?? null,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      supportGrantId: input.supportGrantId ?? null,
      requestRef: input.requestRef ?? null,
      metadata: sanitizeMetadata(input.metadata) as Prisma.InputJsonValue | undefined,
    },
  });
}
