import type { FastifyRequest, FastifyReply } from "fastify";
import type { PermissionKey } from "@campusgate/shared";
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
 * Module-active guard. Phase-0 permissive stub — it always allows. It assumes
 * `authenticate` ran via the top-level hook and makes no decision of its own.
 */
export function requireModuleActive(_moduleKey: string) {
  // PHASE-0 STUB: permits all; real module-activation enforcement lands in the module-entitlement phase
  return async (_request: FastifyRequest, _reply: FastifyReply) => {
    // intentionally no-op: always permits
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
