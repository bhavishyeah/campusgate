import type { FastifyRequest, FastifyReply } from "fastify";
import { privilegedPrisma, type UserRole } from "@campusgate/db";
import { ROLE_PERMISSIONS } from "@campusgate/shared";
import { resolvePermissions } from "../services/authz-engine.js";

// Extend Fastify's JWT types. During the Phase-0 transition the token carries
// BOTH the legacy `role` claim and the new membership/roles/permissions shape
// (design §6.1); the legacy claim is kept so the un-flipped routes keep working.
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      userId: string;
      membershipId: string | null;
      institutionId: string;
      roles: string[];
      permissions: string[];
      permissionsVersion: number | null;
      // legacy claim (kept for the un-migrated route guards)
      role: UserRole;
      jti?: string;
    };
    user: {
      userId: string;
      membershipId: string | null;
      institutionId: string;
      roles: string[];
      permissions: string[];
      permissionsVersion: number | null;
      // legacy claim (kept for the un-migrated route guards)
      role: UserRole;
      jti?: string;
    };
  }
}

// The resolved authorization claims the engine (authz-engine.ts) reads from.
// Populated by `authenticate` once per request via the top-level hook.
export interface RequestAuth {
  userId: string;
  membershipId: string | null;
  institutionId: string;
  roles: string[];
  permissions: string[];
  permissionsVersion: number | null;
  // Phase 1 (additive, read-only): the caller's department scope, re-read from
  // the membership each request (never from the token, so it cannot go stale).
  // null for SUPER_ADMIN (no membership) and for members with no scope set.
  departmentScope: string | null;
}

// Augment FastifyRequest with the resolved auth + tenant context. `tenant` is
// the ONLY value fed to withTenant/app.current_institution_id and is left
// undefined for SUPER_ADMIN (the PLATFORM institutionId is never a tenant GUC).
declare module "fastify" {
  interface FastifyRequest {
    auth?: RequestAuth;
    tenant?: { institutionId: string };
  }
}

// Platform permission keys for a SUPER_ADMIN (no membership). Resolved from the
// shared ROLE_PERMISSIONS map and normalized the same way as everything else.
const SUPER_ADMIN_PERMISSIONS: string[] = [
  ...new Set(ROLE_PERMISSIONS.SUPER_ADMIN ?? []),
].sort();

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  const tokenUser = request.user;

  // Check session revocation before anything else.
  // If the token carries a jti, that session must exist and not be revoked.
  if (tokenUser.jti) {
    const session = await privilegedPrisma.session.findFirst({
      where: { jti: tokenUser.jti, revoked: false },
      select: { id: true, expiresAt: true },
    });

    if (!session) {
      return reply.status(401).send({ error: "Session revoked or expired" });
    }

    // Update lastActiveAt in background so it doesn't slow down requests
    privilegedPrisma.session
      .update({ where: { jti: tokenUser.jti }, data: { lastActiveAt: new Date() } })
      .catch(() => {});
  }

  const dbUser = await privilegedPrisma.user.findUnique({
    where: { id: tokenUser.userId },
    select: {
      id: true,
      role: true,
      institutionId: true,
      accountStatus: true,
      institution: { select: { status: true } },
    },
  });

  if (!dbUser || dbUser.accountStatus !== "ACTIVE") {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  if (dbUser.institution.status !== "ACTIVE") {
    return reply.status(403).send({ error: "Institution is suspended" });
  }

  // ─── SUPER_ADMIN branch (no membership, no tenant context) ─────────────────
  // The PLATFORM institutionId is carried on request.auth for logging/audit
  // only and is NEVER fed to app.current_institution_id; request.tenant stays
  // undefined so a super admin can never open a tenant transaction (§6.3).
  if (dbUser.role === "SUPER_ADMIN") {
    request.auth = {
      userId: dbUser.id,
      membershipId: null,
      institutionId: dbUser.institutionId,
      roles: ["SUPER_ADMIN"],
      permissions: SUPER_ADMIN_PERMISSIONS,
      permissionsVersion: null,
      departmentScope: null,
    };
    // request.tenant deliberately left unset for SUPER_ADMIN.

    request.user = {
      userId: dbUser.id,
      membershipId: null,
      institutionId: dbUser.institutionId,
      roles: ["SUPER_ADMIN"],
      permissions: SUPER_ADMIN_PERMISSIONS,
      permissionsVersion: null,
      role: dbUser.role,
      jti: tokenUser.jti,
    };
    return;
  }

  // ─── Tenant actor branch: load the membership (pre-tenant-context) ─────────
  // These reads MUST run on privilegedPrisma: there is no tenant GUC yet and the
  // membership/role tables are RLS tables that would fail-closed otherwise (§6.3).
  let membership;
  try {
    membership = await privilegedPrisma.institutionMembership.findUnique({
      where: { userId_institutionId: { userId: dbUser.id, institutionId: dbUser.institutionId } },
      select: {
        id: true,
        membershipStatus: true,
        permissionsVersion: true,
        departmentScope: true,
        roles: {
          select: {
            role: {
              select: {
                key: true,
                permissions: { select: { permission: { select: { key: true } } } },
              },
            },
          },
        },
      },
    });
  } catch (err) {
    // Fail-closed: never attach request.auth on a DB error (§6.3).
    request.log.error({ err, userId: dbUser.id }, "authenticate: membership load failed");
    return reply.status(500).send({ error: "Internal Server Error" });
  }

  if (!membership) {
    request.log.warn({ userId: dbUser.id }, "authenticate: no active membership for user");
    return reply.status(401).send({ error: "Unauthorized" });
  }

  if (membership.membershipStatus === "SUSPENDED") {
    request.log.info({ userId: dbUser.id, membershipId: membership.id }, "authenticate: membership suspended");
    return reply.status(403).send({ error: "Membership suspended" });
  }

  const roleKeys = [...new Set(membership.roles.map((mr) => mr.role.key))].sort();

  // Permission freshness (§6.2): the token carries a resolved permissions set
  // plus the permissionsVersion it was signed with. If the membership's current
  // version differs, the token set is stale — re-resolve from the loaded rows
  // via the SAME helper login uses so the sets are byte-identical.
  let permissions: string[];
  if (tokenUser.permissionsVersion === membership.permissionsVersion) {
    permissions = tokenUser.permissions;
  } else {
    try {
      permissions = resolvePermissions(membership.roles);
    } catch (err) {
      // Fail-closed: never fall back to the stale token for a privilege decision.
      request.log.error({ err, userId: dbUser.id }, "authenticate: permission re-resolve failed");
      return reply.status(500).send({ error: "Internal Server Error" });
    }
  }

  request.auth = {
    userId: dbUser.id,
    membershipId: membership.id,
    institutionId: dbUser.institutionId,
    roles: roleKeys,
    permissions,
    permissionsVersion: membership.permissionsVersion,
    departmentScope: membership.departmentScope,
  };
  request.tenant = { institutionId: dbUser.institutionId };

  // Preserve jti + legacy claims so logout/session endpoints and the un-flipped
  // role guards keep reading request.user as before.
  request.user = {
    userId: dbUser.id,
    membershipId: membership.id,
    institutionId: dbUser.institutionId,
    roles: roleKeys,
    permissions,
    permissionsVersion: membership.permissionsVersion,
    role: dbUser.role,
    jti: tokenUser.jti,
  };
}

export function requireRole(...roles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await authenticate(request, reply);
    if (reply.sent) return;

    const user = request.user;
    if (!roles.includes(user.role)) {
      return reply.status(403).send({ error: "Forbidden: insufficient role" });
    }
  };
}

export function requireSuperAdmin() {
  return requireRole("SUPER_ADMIN");
}

export function requireTenantRole(...roles: Exclude<UserRole, "SUPER_ADMIN">[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await authenticate(request, reply);
    if (reply.sent) return;

    const user = request.user;
    if (user.role === "SUPER_ADMIN") {
      return reply.status(403).send({ error: "Forbidden: platform role cannot access tenant endpoint" });
    }

    if (!roles.includes(user.role as Exclude<UserRole, "SUPER_ADMIN">)) {
      return reply.status(403).send({ error: "Forbidden: insufficient role" });
    }
  };
}
