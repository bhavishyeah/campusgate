import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  can,
  requireModuleActive,
  requirePermission,
  resolvePermissions,
  type ResolvableMembershipRole,
} from "../authz-engine.js";
import { ROLE_PERMISSIONS } from "@campusgate/shared";
import type { RequestAuth } from "../../middleware/auth.js";

// Build the roles[].role.permissions[].permission.key shape resolvePermissions
// accepts, from the shared ROLE_PERMISSIONS map, so the test fixtures and the
// login/re-resolve paths share one source of truth.
function rolesFixture(...roleKeys: string[]): ResolvableMembershipRole[] {
  return roleKeys.map((key) => ({
    role: {
      permissions: (ROLE_PERMISSIONS[key] ?? []).map((k) => ({ permission: { key: k } })),
    },
  }));
}

function makeAuth(permissions: string[]): RequestAuth {
  return {
    userId: "u-1",
    membershipId: "mbr-1",
    institutionId: "inst-1",
    roles: ["HOD"],
    permissions,
    permissionsVersion: 0,
  };
}

// Minimal request/reply doubles for exercising the preHandler guards.
function makeReply() {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return reply;
}

function makeRequest(auth: RequestAuth | undefined) {
  return {
    auth,
    method: "POST",
    url: "/hod/approve",
    routeOptions: { url: "/hod/approve" },
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  };
}

describe("authz-engine resolvePermissions", () => {
  it("de-duplicates and sorts the flattened permission keys", () => {
    const roles: ResolvableMembershipRole[] = [
      { role: { permissions: [{ permission: { key: "b" } }, { permission: { key: "a" } }] } },
      { role: { permissions: [{ permission: { key: "a" } }, { permission: { key: "c" } }] } },
    ];
    expect(resolvePermissions(roles)).toEqual(["a", "b", "c"]);
  });

  it("returns [] for an empty role set (fail-closed)", () => {
    expect(resolvePermissions([])).toEqual([]);
  });

  it("login path and re-resolve path yield byte-identical arrays for a multi-role input", () => {
    // ADMIN + HOD share campus_movement.* keys (e.g. pass.revoke, emergency.view).
    const roles = rolesFixture("ADMIN", "HOD");

    // Login path and the authenticate re-resolve path are the SAME helper, so
    // calling it twice (as the two sites would) must produce identical arrays.
    const loginPath = resolvePermissions(roles);
    const reResolvePath = resolvePermissions(roles);

    expect(reResolvePath).toEqual(loginPath);
    // identity is byte-for-byte (same order, deduped)
    expect(JSON.stringify(reResolvePath)).toBe(JSON.stringify(loginPath));
    // the shared key appears exactly once despite two roles holding it
    expect(loginPath.filter((k) => k === "campus_movement.pass.revoke")).toHaveLength(1);
    // output is sorted
    expect([...loginPath].sort()).toEqual(loginPath);
  });

  it("resolves a single role to exactly its ROLE_PERMISSIONS set (sorted)", () => {
    const resolved = resolvePermissions(rolesFixture("GUARD"));
    expect(resolved).toEqual([...new Set(ROLE_PERMISSIONS.GUARD)].sort());
  });
});

describe("authz-engine can()", () => {
  it("returns true when the permission is present", () => {
    expect(can(makeAuth(["campus_movement.pass.approve"]), "campus_movement.pass.approve")).toBe(true);
  });

  it("returns false when the permission is absent", () => {
    expect(can(makeAuth(["campus_movement.pass.approve"]), "campus_movement.pass.reject")).toBe(false);
  });
});

describe("authz-engine requirePermission", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes (no reply) when the permission is present", async () => {
    const guard = requirePermission("campus_movement.pass.approve");
    const request = makeRequest(makeAuth(["campus_movement.pass.approve"]));
    const reply = makeReply();

    await guard(request as any, reply as any);

    expect(reply.statusCode).toBe(0); // never replied → passed through
  });

  it("returns 403 (not 401) on a missing permission", async () => {
    const guard = requirePermission("campus_movement.pass.reject");
    const request = makeRequest(makeAuth(["campus_movement.pass.approve"]));
    const reply = makeReply();

    await guard(request as any, reply as any);

    expect(reply.statusCode).toBe(403);
    expect(reply.body).toEqual({ error: "Forbidden: missing permission campus_movement.pass.reject" });
    expect(request.log.info).toHaveBeenCalledTimes(1);
  });

  it("returns 401 (does not throw) and logs at ERROR when request.auth is unset", async () => {
    const guard = requirePermission("campus_movement.pass.approve");
    const request = makeRequest(undefined);
    const reply = makeReply();

    await expect(guard(request as any, reply as any)).resolves.toBeDefined();

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: "Unauthorized" });
    expect(request.log.error).toHaveBeenCalledTimes(1);
  });

  it("never re-authenticates: it only reads request.auth", async () => {
    // A pure can-check must make no DB/jwt calls. We prove it by passing a
    // request with no jwtVerify/db handles at all and still getting a decision.
    const guard = requirePermission("campus_movement.pass.approve");
    const request = { auth: makeAuth(["campus_movement.pass.approve"]), log: { error: vi.fn(), info: vi.fn() } };
    const reply = makeReply();

    await guard(request as any, reply as any);
    expect(reply.statusCode).toBe(0);
  });
});

describe("authz-engine requireModuleActive (PHASE-0 STUB)", () => {
  it("permits every request regardless of module key or auth state", async () => {
    const guard = requireModuleActive("campus_movement");
    const reply = makeReply();

    // no auth at all, any module key — still permits
    await guard({ auth: undefined } as any, reply as any);
    await guard({ auth: makeAuth([]) } as any, reply as any);

    expect(reply.statusCode).toBe(0); // never denied
  });
});
