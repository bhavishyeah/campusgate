import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks for @campusgate/db + the audit writer so the service's lazy
// expiry / revoke / operator-binding logic is exercised without a DB.
const {
  supportGrantFindUnique,
  supportGrantUpdate,
  supportGrantUpdateMany,
  institutionFindUnique,
  recordAuditEvent,
} = vi.hoisted(() => ({
  supportGrantFindUnique: vi.fn(),
  supportGrantUpdate: vi.fn(),
  supportGrantUpdateMany: vi.fn(),
  institutionFindUnique: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

vi.mock("@campusgate/db", () => ({
  privilegedPrisma: {
    supportGrant: {
      findUnique: supportGrantFindUnique,
      update: supportGrantUpdate,
      updateMany: supportGrantUpdateMany,
    },
    institution: { findUnique: institutionFindUnique },
  },
  withSupportGrant: vi.fn(),
  Prisma: {},
}));

vi.mock("../audit.js", () => ({ recordAuditEvent }));

import {
  lazyExpireGrant,
  revokeSupportGrantAsPlatform,
  validateGrantForAccess,
  MAX_TTL_MS,
  createSupportGrantSchema,
} from "../support-grant.js";

const actor = { userId: "op-1", roleKey: "SUPER_ADMIN", requestRef: "req-1" };

beforeEach(() => {
  vi.clearAllMocks();
  // recordAuditEvent returns a Promise in production (the deny helper chains
  // .catch on it), so the mock must resolve rather than return undefined.
  recordAuditEvent.mockResolvedValue(undefined);
});

describe("createSupportGrantSchema", () => {
  it("rejects an expiresAt in the past", () => {
    const r = createSupportGrantSchema.safeParse({
      institutionId: "inst-1",
      purpose: "support",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(r.success).toBe(false);
  });

  it("rejects an expiresAt beyond MAX_TTL", () => {
    const r = createSupportGrantSchema.safeParse({
      institutionId: "inst-1",
      purpose: "support",
      expiresAt: new Date(Date.now() + MAX_TTL_MS + 60_000).toISOString(),
    });
    expect(r.success).toBe(false);
  });

  it("rejects an empty purpose", () => {
    const r = createSupportGrantSchema.safeParse({
      institutionId: "inst-1",
      purpose: "   ",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(r.success).toBe(false);
  });

  it("accepts a valid body", () => {
    const r = createSupportGrantSchema.safeParse({
      institutionId: "inst-1",
      purpose: "investigate a reported issue",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(r.success).toBe(true);
  });
});

describe("lazyExpireGrant", () => {
  it("flips ACTIVE→EXPIRED and writes ONE expired audit when the row still matched", async () => {
    supportGrantUpdateMany.mockResolvedValue({ count: 1 });
    const flipped = await lazyExpireGrant({ id: "g-1", institutionId: "inst-1" }, actor);
    expect(flipped).toBe(true);
    expect(supportGrantUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "g-1", status: "ACTIVE" }),
        data: { status: "EXPIRED" },
      }),
    );
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent.mock.calls[0][0].action).toBe("platform.support_grant.expired");
  });

  it("writes NO audit when a concurrent loser got count 0 (idempotent)", async () => {
    supportGrantUpdateMany.mockResolvedValue({ count: 0 });
    const flipped = await lazyExpireGrant({ id: "g-1", institutionId: "inst-1" }, actor);
    expect(flipped).toBe(false);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});

describe("revokeSupportGrantAsPlatform", () => {
  it("returns null when the grant is not found", async () => {
    supportGrantFindUnique.mockResolvedValue(null);
    const r = await revokeSupportGrantAsPlatform("g-x", "reason", actor);
    expect(r).toBeNull();
    expect(supportGrantUpdate).not.toHaveBeenCalled();
  });

  it("transitions to REVOKED and audits", async () => {
    supportGrantFindUnique.mockResolvedValue({ id: "g-1", institutionId: "inst-1" });
    supportGrantUpdate.mockResolvedValue({ id: "g-1", status: "REVOKED" });
    const r = await revokeSupportGrantAsPlatform("g-1", "done", actor);
    expect(r).toEqual({ id: "g-1", status: "REVOKED" });
    expect(supportGrantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "g-1" },
        data: expect.objectContaining({ status: "REVOKED", revokedByUserId: "op-1" }),
      }),
    );
    expect(recordAuditEvent.mock.calls[0][0].action).toBe("platform.support_grant.revoked");
  });
});

describe("validateGrantForAccess — operator binding + lifecycle", () => {
  const base = {
    id: "g-1",
    institutionId: "inst-1",
    grantedToUserId: "op-1",
    status: "ACTIVE" as const,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    institution: { status: "ACTIVE" as const },
  };

  it("accepts an ACTIVE, unexpired, operator-bound grant for an active institution", async () => {
    supportGrantFindUnique.mockResolvedValue({ ...base });
    const r = await validateGrantForAccess("g-1", actor);
    expect(r.ok).toBe(true);
  });

  it("denies a grant bound to another operator", async () => {
    supportGrantFindUnique.mockResolvedValue({ ...base, grantedToUserId: "someone-else" });
    const r = await validateGrantForAccess("g-1", actor);
    expect(r).toMatchObject({ ok: false, reason: "notOperator" });
    expect(recordAuditEvent.mock.calls[0][0].result).toBe("DENIED");
  });

  it("denies + lazy-expires an ACTIVE grant whose expiresAt has passed", async () => {
    supportGrantFindUnique.mockResolvedValue({
      ...base,
      expiresAt: new Date(Date.now() - 1000),
    });
    supportGrantUpdateMany.mockResolvedValue({ count: 1 });
    const r = await validateGrantForAccess("g-1", actor);
    expect(r).toMatchObject({ ok: false, reason: "expired" });
    expect(supportGrantUpdateMany).toHaveBeenCalled();
  });

  it("denies when the target institution is suspended", async () => {
    supportGrantFindUnique.mockResolvedValue({
      ...base,
      institution: { status: "SUSPENDED" },
    });
    const r = await validateGrantForAccess("g-1", actor);
    expect(r).toMatchObject({ ok: false, reason: "institutionSuspended" });
  });

  it("denies a not-found grant", async () => {
    supportGrantFindUnique.mockResolvedValue(null);
    const r = await validateGrantForAccess("g-x", actor);
    expect(r).toMatchObject({ ok: false, reason: "notFound" });
  });
});
