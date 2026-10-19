import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @campusgate/db so requireModuleActive's privilegedPrisma point read is a
// single controllable call (design §9.5 — the testability win of reading via
// privilegedPrisma rather than a second withTenant transaction).
const findUniqueMock = vi.fn();
vi.mock("@campusgate/db", () => ({
  privilegedPrisma: { institutionModule: { findUnique: (...args: unknown[]) => findUniqueMock(...args) } },
}));

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

describe("authz-engine requireModuleActive (REAL enforcement, design §7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueMock.mockReset();
  });

  it("passes (no reply) when the module row is ACTIVE", async () => {
    findUniqueMock.mockResolvedValue({ state: "ACTIVE" });
    const guard = requireModuleActive("campus_movement");
    const request = makeRequest(makeAuth([]));
    const reply = makeReply();

    await guard(request as any, reply as any);

    expect(reply.statusCode).toBe(0); // allowed through
    // read is hard-filtered by the token's institutionId + the module key
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { institutionId_moduleKey: { institutionId: "inst-1", moduleKey: "campus_movement" } },
      select: { state: true },
    });
  });

  it("returns 403 'Module not active' when the row is SUSPENDED", async () => {
    findUniqueMock.mockResolvedValue({ state: "SUSPENDED" });
    const guard = requireModuleActive("campus_movement");
    const request = makeRequest(makeAuth([]));
    const reply = makeReply();

    await guard(request as any, reply as any);

    expect(reply.statusCode).toBe(403);
    expect(reply.body).toEqual({ error: "Module not active: campus_movement" });
  });

  it("returns 403 when there is no row (NOT_ENTITLED)", async () => {
    findUniqueMock.mockResolvedValue(null);
    const guard = requireModuleActive("campus_movement");
    const request = makeRequest(makeAuth([]));
    const reply = makeReply();

    await guard(request as any, reply as any);

    expect(reply.statusCode).toBe(403);
    expect(reply.body).toEqual({ error: "Module not active: campus_movement" });
  });

  it("fails CLOSED to 500 when the state read throws (never a silent allow)", async () => {
    findUniqueMock.mockRejectedValue(new Error("P1001: unreachable"));
    const guard = requireModuleActive("campus_movement");
    const request = makeRequest(makeAuth([]));
    const reply = makeReply();

    await guard(request as any, reply as any);

    expect(reply.statusCode).toBe(500);
    expect(reply.body).toEqual({ error: "Module state unavailable" });
    expect(request.log.error).toHaveBeenCalledTimes(1);
  });

  it("returns 401 and never reads state when request.auth is unset", async () => {
    const guard = requireModuleActive("campus_movement");
    const request = makeRequest(undefined);
    const reply = makeReply();

    await guard(request as any, reply as any);

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: "Unauthorized" });
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(request.log.error).toHaveBeenCalledTimes(1);
  });
});
