import { z } from "zod";
import {
  privilegedPrisma,
  withSupportGrant,
  type SupportGrantStatus,
  type Prisma,
} from "@campusgate/db";
import { recordAuditEvent } from "./audit.js";

// Hard upper bound on a grant's lifetime (design §7.1). A grant may live at most
// MAX_TTL from creation; zod rejects anything beyond it.
export const MAX_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/** zod schema for the create-grant body (design §8.1). IDs come from the body
 *  here (institutionId is the TARGET tenant, not the caller's), but the operator
 *  (grantedToUserId) always comes from request.auth, never the body. */
export const createSupportGrantSchema = z
  .object({
    institutionId: z.string().min(1),
    purpose: z.string().trim().min(1).max(500),
    expiresAt: z.coerce.date(),
    scope: z
      .object({
        modules: z.array(z.string()).max(50).optional(),
        resources: z.array(z.string()).max(50).optional(),
      })
      .optional(),
  })
  .superRefine((val, ctx) => {
    const now = Date.now();
    const exp = val.expiresAt.getTime();
    if (exp <= now) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be in the future",
      });
    } else if (exp > now + MAX_TTL_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt exceeds the maximum grant lifetime",
      });
    }
  });

export type CreateSupportGrantInput = z.infer<typeof createSupportGrantSchema>;

export interface ActorContext {
  userId: string;
  roleKey: string;
  requestRef?: string | null;
}

/**
 * Create an ACTIVE support grant (design §7.1). Phase 0 collapses
 * REQUESTED→ACTIVE for the Super-Admin-initiated flow. Writes the
 * `platform.support_grant.created` + `.activated` audit rows. The target
 * institution must exist (else a 404-signalling null is returned).
 */
export async function createSupportGrant(
  input: CreateSupportGrantInput,
  actor: ActorContext,
): Promise<
  | { ok: true; grant: Awaited<ReturnType<typeof privilegedPrisma.supportGrant.create>> }
  | { ok: false; reason: "institutionNotFound" }
> {
  const institution = await privilegedPrisma.institution.findUnique({
    where: { id: input.institutionId },
    select: { id: true },
  });
  if (!institution) {
    return { ok: false, reason: "institutionNotFound" };
  }

  const grant = await privilegedPrisma.supportGrant.create({
    data: {
      institutionId: input.institutionId,
      grantedToUserId: actor.userId,
      purpose: input.purpose,
      scope: (input.scope ?? undefined) as Prisma.InputJsonValue | undefined,
      status: "ACTIVE",
      activatedAt: new Date(),
      expiresAt: input.expiresAt,
    },
  });

  for (const action of ["platform.support_grant.created", "platform.support_grant.activated"] as const) {
    await recordAuditEvent({
      action,
      result: "SUCCESS",
      actorUserId: actor.userId,
      actorRoleKey: actor.roleKey,
      institutionId: input.institutionId,
      supportGrantId: grant.id,
      resourceType: "SupportGrant",
      resourceId: grant.id,
      requestRef: actor.requestRef ?? null,
    });
  }

  return { ok: true, grant };
}

/**
 * Lazy auto-expire a single grant (design §6.4). Conditional updateMany so
 * concurrent loaders are idempotent: only the request whose WHERE still matches
 * ACTIVE+expired flips the row (count === 1) and writes the ONE
 * `platform.support_grant.expired` audit; a loser writes nothing. Returns true
 * when THIS call performed the flip.
 */
export async function lazyExpireGrant(
  grant: { id: string; institutionId: string },
  actor: ActorContext,
): Promise<boolean> {
  const now = new Date();
  const { count } = await privilegedPrisma.supportGrant.updateMany({
    where: { id: grant.id, status: "ACTIVE", expiresAt: { lte: now } },
    data: { status: "EXPIRED" },
  });
  if (count === 1) {
    await recordAuditEvent({
      action: "platform.support_grant.expired",
      result: "SUCCESS",
      actorUserId: actor.userId,
      actorRoleKey: actor.roleKey,
      institutionId: grant.institutionId,
      supportGrantId: grant.id,
      resourceType: "SupportGrant",
      resourceId: grant.id,
      requestRef: actor.requestRef ?? null,
    });
    return true;
  }
  return false;
}

/**
 * List grants for the platform operator view (design §7.3), with opportunistic
 * lazy-expiry of any stale ACTIVE rows encountered.
 */
export async function listSupportGrants(
  filter: { institutionId?: string; status?: SupportGrantStatus },
  actor: ActorContext,
) {
  const where: Prisma.SupportGrantWhereInput = {};
  if (filter.institutionId) where.institutionId = filter.institutionId;
  if (filter.status) where.status = filter.status;

  const grants = await privilegedPrisma.supportGrant.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  // Opportunistic expiry of stale ACTIVE rows (idempotent per §6.4).
  const now = Date.now();
  for (const g of grants) {
    if (g.status === "ACTIVE" && g.expiresAt.getTime() <= now) {
      await lazyExpireGrant({ id: g.id, institutionId: g.institutionId }, actor);
      g.status = "EXPIRED";
    }
  }

  return grants;
}

/** Revoke a grant on the platform path (design §7.2). Returns null if not found. */
export async function revokeSupportGrantAsPlatform(
  id: string,
  reason: string | undefined,
  actor: ActorContext,
) {
  const grant = await privilegedPrisma.supportGrant.findUnique({ where: { id } });
  if (!grant) return null;

  const updated = await privilegedPrisma.supportGrant.update({
    where: { id },
    data: {
      status: "REVOKED",
      revokedAt: new Date(),
      revokedByUserId: actor.userId,
      revokedReason: reason ?? null,
    },
  });

  await recordAuditEvent({
    action: "platform.support_grant.revoked",
    result: "SUCCESS",
    actorUserId: actor.userId,
    actorRoleKey: actor.roleKey,
    institutionId: grant.institutionId,
    supportGrantId: grant.id,
    resourceType: "SupportGrant",
    resourceId: grant.id,
    requestRef: actor.requestRef ?? null,
  });

  return updated;
}

export type BreakGlassDenyReason =
  | "notFound"
  | "notActive"
  | "expired"
  | "notOperator"
  | "institutionSuspended";

/**
 * Validate an ACTIVE grant for break-glass access (design §6.3). Runs on
 * privilegedPrisma. Performs the lazy-expiry check (never trusts `status`
 * alone), the operator binding, and the institution-status re-check. On any
 * failure writes a DENIED `platform.support_grant.accessed` audit and returns
 * the reason; on success returns the grant.
 */
export async function validateGrantForAccess(
  id: string,
  actor: ActorContext,
): Promise<
  | { ok: true; grant: { id: string; institutionId: string } }
  | { ok: false; reason: BreakGlassDenyReason }
> {
  const grant = await privilegedPrisma.supportGrant.findUnique({
    where: { id },
    include: { institution: { select: { status: true } } },
  });

  const deny = async (reason: BreakGlassDenyReason, institutionId?: string) => {
    await recordAuditEvent({
      action: "platform.support_grant.accessed",
      result: "DENIED",
      actorUserId: actor.userId,
      actorRoleKey: actor.roleKey,
      institutionId: institutionId ?? null,
      supportGrantId: grant?.id ?? null,
      resourceType: "SupportGrant",
      resourceId: id,
      requestRef: actor.requestRef ?? null,
      metadata: { reason },
    }).catch(() => {});
    return { ok: false as const, reason };
  };

  if (!grant) return deny("notFound");

  // Never trust status alone: expire lazily when due.
  if (grant.status === "ACTIVE" && grant.expiresAt.getTime() <= Date.now()) {
    await lazyExpireGrant({ id: grant.id, institutionId: grant.institutionId }, actor);
    return deny("expired", grant.institutionId);
  }

  if (grant.status !== "ACTIVE") return deny("notActive", grant.institutionId);
  if (grant.grantedToUserId !== actor.userId) return deny("notOperator", grant.institutionId);
  if (grant.institution.status !== "ACTIVE") {
    return deny("institutionSuspended", grant.institutionId);
  }

  return { ok: true, grant: { id: grant.id, institutionId: grant.institutionId } };
}

/**
 * The ONE break-glass read proxy (design §7.4). Validates the grant, reads the
 * granted tenant's recent audit_events + passes inside the READ-ONLY
 * `withSupportGrant` (campass_app + GUC — RLS enforces the scope), then writes
 * ONE `platform.support_grant.accessed` SUCCESS audit on a SEPARATE
 * privilegedPrisma call AFTER the read returns. A failed audit write aborts the
 * access (the caller discards the result and returns 500).
 *
 * This is the sole caller of `withSupportGrant`; it always injects an explicit
 * `where: { institutionId }` filter (defense-in-depth over the RLS layer).
 */
export async function breakGlassReadTenant(
  id: string,
  actor: ActorContext,
): Promise<
  | { ok: true; data: { institutionId: string; auditEvents: unknown[]; passes: unknown[] } }
  | { ok: false; reason: BreakGlassDenyReason }
  | { ok: false; reason: "auditWriteFailed" }
> {
  const validation = await validateGrantForAccess(id, actor);
  if (!validation.ok) return validation;
  const { grant } = validation;

  const data = await withSupportGrant(grant.institutionId, async (tx) => {
    const [auditEvents, passes] = await Promise.all([
      tx.auditEvent.findMany({
        where: { institutionId: grant.institutionId },
        orderBy: { timestamp: "desc" },
        take: 50,
      }),
      tx.gatePass.findMany({
        where: { institutionId: grant.institutionId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);
    return { auditEvents, passes };
  });

  // Separate, awaited privileged audit write AFTER the read-only tx returns.
  try {
    await recordAuditEvent({
      action: "platform.support_grant.accessed",
      result: "SUCCESS",
      actorUserId: actor.userId,
      actorRoleKey: actor.roleKey,
      institutionId: grant.institutionId,
      supportGrantId: grant.id,
      resourceType: "TenantData",
      resourceId: grant.institutionId,
      requestRef: actor.requestRef ?? null,
      metadata: {
        auditEventCount: data.auditEvents.length,
        passCount: data.passes.length,
      },
    });
  } catch {
    return { ok: false, reason: "auditWriteFailed" };
  }

  return {
    ok: true,
    data: { institutionId: grant.institutionId, auditEvents: data.auditEvents, passes: data.passes },
  };
}

/**
 * Super-Admin audit explorer (design §7.5). scope=platform ⇒ institutionId null
 * rows; scope=grant ⇒ validate an ACTIVE grant and filter to its tenant. All on
 * privilegedPrisma (bypasses RLS; the platform operator never sees all tenants
 * at once — the filter is explicit).
 */
export async function readPlatformAuditEvents(
  params: { scope: "platform" | "grant"; grantId?: string; limit?: number },
  actor: ActorContext,
): Promise<
  | { ok: true; events: unknown[] }
  | { ok: false; reason: "missingGrantId" | BreakGlassDenyReason }
> {
  const take = Math.min(100, Math.max(1, params.limit ?? 50));

  if (params.scope === "platform") {
    const events = await privilegedPrisma.auditEvent.findMany({
      where: { institutionId: null },
      orderBy: { timestamp: "desc" },
      take,
    });
    return { ok: true, events };
  }

  // scope === "grant"
  if (!params.grantId) return { ok: false, reason: "missingGrantId" };
  const validation = await validateGrantForAccess(params.grantId, actor);
  if (!validation.ok) return validation;

  const events = await privilegedPrisma.auditEvent.findMany({
    where: { institutionId: validation.grant.institutionId },
    orderBy: { timestamp: "desc" },
    take,
  });
  return { ok: true, events };
}
