import { beforeEach, describe, expect, it, vi } from "vitest";

// A privilegedPrisma stub whose auditEvent.create we can assert against.
// Declared via vi.hoisted so it exists before the hoisted vi.mock factory runs.
const { privilegedCreate } = vi.hoisted(() => ({ privilegedCreate: vi.fn() }));

vi.mock("@campusgate/db", () => {
  return {
    privilegedPrisma: { auditEvent: { create: privilegedCreate } },
    // recordAuditEvent only reads AuditResult as a type, so no runtime value needed.
    Prisma: {},
  };
});

import { recordAuditEvent, sanitizeMetadata } from "../audit.js";

function baseInput() {
  return {
    action: "admin.user.created" as const,
    result: "SUCCESS" as const,
    actorUserId: "u-1",
    actorRoleKey: "ADMIN",
    institutionId: "inst-1",
    resourceType: "User",
    resourceId: "u-2",
    requestRef: "req-1",
  };
}

describe("recordAuditEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws on an unknown action key", async () => {
    await expect(
      recordAuditEvent({ ...baseInput(), action: "not.a.real.key" as any }),
    ).rejects.toThrow(/unknown action key/);
    expect(privilegedCreate).not.toHaveBeenCalled();
  });

  it("writes on privilegedPrisma when no tx is passed", async () => {
    privilegedCreate.mockResolvedValue({});
    await recordAuditEvent(baseInput());
    expect(privilegedCreate).toHaveBeenCalledTimes(1);
    const arg = privilegedCreate.mock.calls[0][0];
    expect(arg.data.action).toBe("admin.user.created");
    expect(arg.data.result).toBe("SUCCESS");
    expect(arg.data.actorUserId).toBe("u-1");
    expect(arg.data.institutionId).toBe("inst-1");
  });

  it("uses the passed tx client when present (not privilegedPrisma)", async () => {
    const txCreate = vi.fn().mockResolvedValue({});
    const tx = { auditEvent: { create: txCreate } } as any;
    await recordAuditEvent(baseInput(), tx);
    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(privilegedCreate).not.toHaveBeenCalled();
  });

  it("defaults optional fields to null", async () => {
    privilegedCreate.mockResolvedValue({});
    await recordAuditEvent({
      action: "platform.institution.created",
      result: "SUCCESS",
      actorUserId: "u-1",
      actorRoleKey: "SUPER_ADMIN",
      resourceType: "Institution",
    });
    const arg = privilegedCreate.mock.calls[0][0];
    expect(arg.data.institutionId).toBeNull();
    expect(arg.data.actorMembershipId).toBeNull();
    expect(arg.data.resourceId).toBeNull();
    expect(arg.data.supportGrantId).toBeNull();
    expect(arg.data.requestRef).toBeNull();
  });

  it("runs metadata through sanitizeMetadata (secret keys dropped)", async () => {
    privilegedCreate.mockResolvedValue({});
    await recordAuditEvent({
      ...baseInput(),
      metadata: { reason: "cleanup", password: "hunter2", mfaSecret: "ABC", qrCode: "x" },
    });
    const arg = privilegedCreate.mock.calls[0][0];
    expect(arg.data.metadata).toEqual({ reason: "cleanup" });
  });
});

describe("sanitizeMetadata", () => {
  it("returns undefined for undefined input", () => {
    expect(sanitizeMetadata(undefined)).toBeUndefined();
  });

  it("drops secret-like keys (password, token, secret, mfa*, qr*)", () => {
    const out = sanitizeMetadata({
      keep: "yes",
      password: "p",
      authToken: "t",
      clientSecret: "s",
      mfaSecret: "m",
      qrCode: "q",
    });
    expect(out).toEqual({ keep: "yes" });
  });

  it("truncates long strings to 500 chars", () => {
    const long = "a".repeat(1000);
    const out = sanitizeMetadata({ note: long })!;
    expect((out.note as string).length).toBe(500);
  });

  it("keeps scalar numbers/booleans/null and drops nested objects/arrays", () => {
    const out = sanitizeMetadata({
      count: 3,
      ok: true,
      cleared: null,
      nested: { a: 1 },
      list: [1, 2, 3],
    })!;
    expect(out).toEqual({ count: 3, ok: true, cleared: null });
  });
});
