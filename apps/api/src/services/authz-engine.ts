import type { FastifyRequest, FastifyReply } from "fastify";
import { privilegedPrisma } from "@campusgate/db";
import type { PermissionKey, ModuleKey } from "@campusgate/shared";
import type { RequestAuth } from "../middleware/auth.js";

/**
 * Central authz engine (design §6.4). The existing tenant-lookup helpers in
 * `authz.ts` stay as they are — this file owns the coarse action-level
 * authorization decision only.
 *
 * Authentication ownership (finding #2): a single top-level `authenticate`
 * preHandler hook populates `request.auth` exactly once per request. The guards
 * here do NOT authenticate; `requirePermission` is a pure `can(request.auth, key)`
 * check that assumes `authenticate` already ran.
 */

/**
 * The membership-role shape resolvePermissions normalizes — exactly the shape
 * selected by both the login resolver and the authenticate re-resolve path:
 * `roles[].role.permissions[].permission.key`.
 */
export interface ResolvableMembershipRole {
  role: {
    permissions: { permission: { key: string } }[];
  };
}

/**
 * Flatten a membership's roles into a de-duplicated, sorted permission-key
 * array. This single helper is imported by BOTH the login resolver (auth.ts)
 * and the authenticate re-resolve path (middleware/auth.ts) so the token set
 * and any re-resolved set are byte-identical (design §6.2 finding #4).
 */
export function resolvePermissions(roles: ResolvableMembershipRole[]): string[] {
  const keys = roles.flatMap((mr) => mr.role.permissions.map((rp) => rp.permission.key));
  return [...new Set(keys)].sort();
}

/**
 * Pure predicate over the resolved claims on the request. No I/O, no request
 * access — just a set-membership test against the already-resolved permissions.
 */
export function can(auth: RequestAuth, permission: PermissionKey): boolean {
  return auth.permissions.includes(permission);
}

/**
 * Fastify preHandler guard; 403 if the permission is missing.
 *
 * It is a PURE can-check: it does NOT call `authenticate`. It assumes the
 * top-level `authenticate` hook has already populated `request.auth`.
 * Defensive wiring-bug path: if `request.auth` is unset it logs at ERROR (the
 * route + permission key) then replies 401 — this can only happen when the
 * top-level `authenticate` hook is missing or misordered on the file.
 */
export function requirePermission(permission: PermissionKey) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth) {
      request.log.error(
        {
          method: request.method,
          url: request.routeOptions?.url ?? request.url,
          permission,
        },
        "requirePermission: request.auth unset — top-level authenticate hook missing or misordered",
      );
      return reply.status(401).send({ error: "Unauthorized" });
    }

    if (!can(request.auth, permission)) {
      request.log.info(
        { userId: request.auth.userId, permission },
        "requirePermission: forbidden — missing permission",
      );
      return reply.status(403).send({ error: `Forbidden: missing permission ${permission}` });
    }
  };
}

/**
 * Module-active guard (design §7). Real server-side enforcement backed by the
 * tenant-owned `institution_modules` table: the route proceeds only when the
 * caller's institution has `moduleKey` in state ACTIVE. Wired onto the
 * `campus_movement.*` GatePass routes IN ADDITION to `requirePermission`; it
 * assumes the top-level `authenticate` hook already populated `request.auth`.
 *
 * Reads via `privilegedPrisma` with a hard token-derived `institutionId` filter
 * (NEVER request input), not a second `withTenant` transaction — the guard runs
 * once per request on the latency-sensitive hot path and is a cheap single
 * indexed point lookup (§7.1). Cross-tenant safety rests on `institutionId`
 * coming only from the verified token.
 *
 * Status contract (§7.2):
 *  - request.auth unset   -> 401 (wiring bug; same defensive branch as requirePermission)
 *  - state read throws     -> 500, fail CLOSED (never a silent allow)
 *  - no row / not ACTIVE   -> 403 { error: "Module not active: <key>" }
 */
export function requireModuleActive(moduleKey: ModuleKey) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth) {
      request.log.error(
        { moduleKey, method: request.method, url: request.routeOptions?.url ?? request.url },
        "requireModuleActive: request.auth unset — top-level authenticate hook missing or misordered",
      );
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const { institutionId } = request.auth; // from the verified token ONLY
    let row: { state: string } | null;
    try {
      row = await privilegedPrisma.institutionModule.findUnique({
        where: { institutionId_moduleKey: { institutionId, moduleKey } },
        select: { state: true },
      });
    } catch (err) {
      request.log.error({ err, moduleKey, institutionId }, "requireModuleActive: state read failed");
      return reply.status(500).send({ error: "Module state unavailable" }); // fail CLOSED
    }

    if (!row || row.state !== "ACTIVE") {
      request.log.info(
        { moduleKey, institutionId, state: row?.state ?? "NOT_ENTITLED" },
        "requireModuleActive: denied — module not active",
      );
      return reply.status(403).send({ error: `Module not active: ${moduleKey}` });
    }
  };
}

// Record-level scope — DOCUMENTED FUTURE STUB, not implemented or exported now.
// GatePass's existing department/ownership checks (getHodInTenant + departmentId
// filter, getStudentInTenant ownership) remain the record-level enforcement for
// Phase 0; canOnResource formalises them in a later phase.
//
// export function canOnResource(
//   auth: RequestAuth,
//   permission: PermissionKey,
//   resource: unknown,
// ): Promise<boolean>
