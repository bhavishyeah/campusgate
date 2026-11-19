import { describe, expect, it, vi } from "vitest";
import {
  ACTIVATION_TTL_MS,
  RESET_TTL_MS,
  consumeToken,
  ensureMembership,
  failIssuedToken,
  generateToken,
  hashToken,
  isPlatformAccount,
  issueToken,
} from "../account-tokens.js";
import { FakeOwnerDb, asDb } from "./helpers/fake-owner-db.js";

const NOW = new Date("2027-02-07T10:00:00.000Z");
const at = (ms: number) => () => new Date(NOW.getTime() + ms);

function setup() {
  const f = new FakeOwnerDb();
  const hashPassword = vi.fn(async (p: string) => `hash:${p}`);
  const deps = (offsetMs = 0) => ({ db: asDb(f), now: at(offsetMs), hashPassword });
  const student = f.addUser({ email: "s@x.edu", studentProfile: { enrollmentNo: "ENR1", status: "ACTIVE" } });
  const staff = f.addUser({ email: "t@x.edu", role: "HOD", passwordHash: "old" });
  return { f, deps, hashPassword, student, staff };
}

const BASE = { institutionId: "inst-1", budgetCeiling: 300 };

describe("token generation", () => {
  it("is 32 random bytes as 43-char base64url, hash is 64-hex and differs", () => {
    const { token, tokenHash } = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toBe(token);
    expect(hashToken(token)).toBe(tokenHash);
    expect(generateToken().token).not.toBe(token);
  });

  it("TTLs are 45 minutes and 72 hours", () => {
    expect(RESET_TTL_MS).toBe(45 * 60_000);
    expect(ACTIVATION_TTL_MS).toBe(72 * 3_600_000);
  });
});

describe("issueToken", () => {
  it("stores only the hash and reserves budget with emailSentAt", async () => {
    const { f, deps, student } = setup();
    const r = await issueToken({ ...BASE, userId: student.id, purpose: "ACCOUNT_ACTIVATION", createdByUserId: "admin" }, deps());
    expect(r.status).toBe("OK");
    if (r.status !== "OK") return;
    expect(f.tokens).toHaveLength(1);
    expect(f.tokens[0].tokenHash).toBe(hashToken(r.token));
    expect(JSON.stringify(f.tokens[0])).not.toContain(r.token);
    expect(f.tokens[0].emailSentAt).toEqual(NOW);
    expect(f.tokens[0].createdByUserId).toBe("admin");
    expect(r.expiresAt.getTime()).toBe(NOW.getTime() + ACTIVATION_TTL_MS);
  });

  it("supersedes the previous live token of the same purpose (one live token)", async () => {
    const { f, deps, student } = setup();
    const a = await issueToken({ ...BASE, userId: student.id, purpose: "ACCOUNT_ACTIVATION" }, deps());
    const b = await issueToken({ ...BASE, userId: student.id, purpose: "ACCOUNT_ACTIVATION" }, deps(1000));
    expect(a.status).toBe("OK");
    expect(b.status).toBe("OK");
    expect(f.tokens.filter((t) => !t.usedAt && !t.supersededAt)).toHaveLength(1);
    expect(f.tokens[0].supersededAt).not.toBeNull();
  });

  it("throttles at 3 tokens per user and purpose per hour", async () => {
    const { deps, student } = setup();
    for (let i = 0; i < 3; i++) {
      expect((await issueToken({ ...BASE, userId: student.id, purpose: "ACCOUNT_ACTIVATION" }, deps(i * 1000))).status).toBe("OK");
    }
    expect((await issueToken({ ...BASE, userId: student.id, purpose: "ACCOUNT_ACTIVATION" }, deps(5000))).status).toBe("THROTTLED");
    // a different purpose has its own counter; after the hour the user may be invited again
    expect((await issueToken({ ...BASE, userId: student.id, purpose: "PASSWORD_RESET" }, deps(5000))).status).toBe("OK");
    expect((await issueToken({ ...BASE, userId: student.id, purpose: "ACCOUNT_ACTIVATION" }, deps(3_600_001))).status).toBe("OK");
  });

  it("refuses when the rolling 24h budget would pass the ceiling", async () => {
    const { deps, student, staff, f } = setup();
    const third = f.addUser({ email: "z@x.edu" });
    expect((await issueToken({ ...BASE, userId: student.id, purpose: "ACCOUNT_ACTIVATION", budgetCeiling: 2 }, deps())).status).toBe("OK");
    expect((await issueToken({ ...BASE, userId: staff.id, purpose: "PASSWORD_RESET", budgetCeiling: 2 }, deps())).status).toBe("OK");
    expect((await issueToken({ ...BASE, userId: third.id, purpose: "ACCOUNT_ACTIVATION", budgetCeiling: 2 }, deps())).status).toBe("BUDGET");
    // reservation ages out after 24h
    expect((await issueToken({ ...BASE, userId: third.id, purpose: "ACCOUNT_ACTIVATION", budgetCeiling: 2 }, deps(24 * 3_600_000 + 1))).status).toBe("OK");
  });

  it("anonymous sends obey the hourly and daily ceilings and leave createdByUserId null", async () => {
    const { f, deps } = setup();
    const users = Array.from({ length: 4 }, (_, i) => f.addUser({ email: `a${i}@x.edu`, passwordHash: "p" }));
    const opts = { ...BASE, purpose: "PASSWORD_RESET" as const, anonymous: true, hourlyAnonCeiling: 2, dailyAnonCeiling: 3, createdByUserId: "ignored" };
    expect((await issueToken({ ...opts, userId: users[0].id }, deps())).status).toBe("OK");
    expect((await issueToken({ ...opts, userId: users[1].id }, deps())).status).toBe("OK");
    expect((await issueToken({ ...opts, userId: users[2].id }, deps())).status).toBe("ANON_HOURLY");
    expect(f.tokens.every((t) => t.createdByUserId === null)).toBe(true);
    expect((await issueToken({ ...opts, userId: users[2].id }, deps(3_600_001))).status).toBe("OK");
    expect((await issueToken({ ...opts, userId: users[3].id }, deps(3_600_002))).status).toBe("ANON_DAILY");
  });

  it("never issues for platform accounts or an institution mismatch", async () => {
    const { f, deps } = setup();
    const sa = f.addUser({ email: "sa@x.edu", role: "SUPER_ADMIN", passwordHash: "p" });
    const px = f.addUser({ email: "px@x.edu", role: "ADMIN", passwordHash: "p" });
    f.membershipPerms.set(px.id, [{ role: { key: "PLATFORM_OPS", permissions: [{ permission: { key: "platform.analytics.view" } }] } }]);
    const plain = f.addUser({ email: "plain@x.edu", role: "ADMIN", passwordHash: "p" });
    expect((await issueToken({ ...BASE, userId: sa.id, purpose: "PASSWORD_RESET" }, deps())).status).toBe("INELIGIBLE");
    expect((await issueToken({ ...BASE, userId: px.id, purpose: "PASSWORD_RESET" }, deps())).status).toBe("INELIGIBLE");
    expect((await issueToken({ ...BASE, institutionId: "other", userId: plain.id, purpose: "PASSWORD_RESET" }, deps())).status).toBe("INELIGIBLE");
    expect(f.tokens).toHaveLength(0);
    expect(await isPlatformAccount(f as never, plain)).toBe(false);
  });

  it("failIssuedToken releases the reservation and invalidates the token", async () => {
    const { f, deps, student } = setup();
    const r = await issueToken({ ...BASE, userId: student.id, purpose: "ACCOUNT_ACTIVATION" }, deps());
    if (r.status !== "OK") throw new Error("setup");
    await failIssuedToken(r.id, "PROVIDER_UNAVAILABLE", deps(1000));
    const row = f.tokens[0];
    expect(row.emailSentAt).toBeNull();
    expect(row.failedAt).not.toBeNull();
    expect(row.supersededAt).not.toBeNull();
    expect(row.failureReason).toBe("PROVIDER_UNAVAILABLE");
    expect(await consumeToken({ token: r.token, purpose: "ACCOUNT_ACTIVATION", password: "newpass123" }, deps(2000))).toBe("INVALID");
  });
});

async function issued(ctx: ReturnType<typeof setup>, userId: string, purpose: "PASSWORD_RESET" | "ACCOUNT_ACTIVATION") {
  const r = await issueToken({ ...BASE, userId, purpose }, ctx.deps());
  if (r.status !== "OK") throw new Error("setup issue failed");
  return r;
}

describe("consumeToken: activation", () => {
  it("sets the password once, revokes sessions, supersedes others, ensures membership, logs the event", async () => {
    const ctx = setup();
    const { f, deps, student } = ctx;
    f.sessions.push({ userId: student.id, revoked: false }, { userId: student.id, revoked: false });
    const a = await issued(ctx, student.id, "ACCOUNT_ACTIVATION");
    // a live reset token of the same user must be superseded by the success
    const reset = await issueToken({ ...BASE, userId: student.id, purpose: "PASSWORD_RESET" }, deps(10));

    expect(await consumeToken({ token: a.token, purpose: "ACCOUNT_ACTIVATION", password: "newpass123", ip: "1.2.3.4" }, deps(1000))).toBe("OK");

    expect(f.users.find((u) => u.id === student.id)!.passwordHash).toBe("hash:newpass123");
    expect(f.sessions.every((s) => s.revoked && s.revokedReason === "account_activation")).toBe(true);
    expect(f.tokens.filter((t) => !t.usedAt && !t.supersededAt)).toHaveLength(0);
    expect(reset.status).toBe("OK");
    expect(f.memberships).toHaveLength(1);
    expect(f.membershipRoles).toHaveLength(1);
    expect(f.events).toEqual([
      expect.objectContaining({ eventType: "PASSWORD_CHANGED", userId: student.id, deviceInfo: "activation", ipAddress: "1.2.3.4", institutionId: "inst-1" }),
    ]);

    // single use
    expect(await consumeToken({ token: a.token, purpose: "ACCOUNT_ACTIVATION", password: "other-pass1" }, deps(2000))).toBe("INVALID");
  });

  it("does not duplicate an existing membership", async () => {
    const ctx = setup();
    ctx.f.memberships.push({ id: "m-existing", userId: ctx.student.id, institutionId: "inst-1", membershipStatus: "SUSPENDED" });
    const a = await issued(ctx, ctx.student.id, "ACCOUNT_ACTIVATION");
    expect(await consumeToken({ token: a.token, purpose: "ACCOUNT_ACTIVATION", password: "newpass123" }, ctx.deps(1))).toBe("OK");
    expect(ctx.f.memberships).toHaveLength(1);
    expect(ctx.f.memberships[0].membershipStatus).toBe("SUSPENDED");
  });

  it("is refused when the user already has a password", async () => {
    const ctx = setup();
    const a = await issued(ctx, ctx.student.id, "ACCOUNT_ACTIVATION");
    ctx.student.passwordHash = "already";
    expect(await consumeToken({ token: a.token, purpose: "ACCOUNT_ACTIVATION", password: "newpass123" }, ctx.deps(1))).toBe("INVALID");
    expect(ctx.f.tokens[0].usedAt).toBeNull();
  });
});

describe("consumeToken: reset, expiry and binding", () => {
  it("a reset token resets a password and records deviceInfo reset", async () => {
    const ctx = setup();
    const r = await issued(ctx, ctx.staff.id, "PASSWORD_RESET");
    expect(await consumeToken({ token: r.token, purpose: "PASSWORD_RESET", password: "brand-new-1" }, ctx.deps(1000))).toBe("OK");
    expect(ctx.f.users.find((u) => u.id === ctx.staff.id)!.passwordHash).toBe("hash:brand-new-1");
    expect(ctx.f.events[0].deviceInfo).toBe("reset");
  });

  it("expiry boundary: expiresAt equal to now is invalid, one ms earlier is valid", async () => {
    const ctx = setup();
    const r = await issued(ctx, ctx.staff.id, "PASSWORD_RESET");
    expect(await consumeToken({ token: r.token, purpose: "PASSWORD_RESET", password: "brand-new-1" }, ctx.deps(RESET_TTL_MS))).toBe("INVALID");
    expect(ctx.hashPassword).not.toHaveBeenCalled();
    expect(await consumeToken({ token: r.token, purpose: "PASSWORD_RESET", password: "brand-new-1" }, ctx.deps(RESET_TTL_MS - 1))).toBe("OK");
  });

  it("purpose binding works both ways", async () => {
    const ctx = setup();
    const reset = await issued(ctx, ctx.staff.id, "PASSWORD_RESET");
    expect(await consumeToken({ token: reset.token, purpose: "ACCOUNT_ACTIVATION", password: "brand-new-1" }, ctx.deps(1))).toBe("INVALID");
    const act = await issued(ctx, ctx.student.id, "ACCOUNT_ACTIVATION");
    expect(await consumeToken({ token: act.token, purpose: "PASSWORD_RESET", password: "brand-new-1" }, ctx.deps(1))).toBe("INVALID");
    expect(ctx.f.tokens.every((t) => t.usedAt === null)).toBe(true);
  });

  it("a superseded token is invalid", async () => {
    const ctx = setup();
    const first = await issued(ctx, ctx.staff.id, "PASSWORD_RESET");
    await issueToken({ ...BASE, userId: ctx.staff.id, purpose: "PASSWORD_RESET" }, ctx.deps(1000));
    expect(await consumeToken({ token: first.token, purpose: "PASSWORD_RESET", password: "brand-new-1" }, ctx.deps(2000))).toBe("INVALID");
  });

  it("a junk token never reaches the password hash", async () => {
    const ctx = setup();
    expect(await consumeToken({ token: generateToken().token, purpose: "PASSWORD_RESET", password: "brand-new-1" }, ctx.deps())).toBe("INVALID");
    expect(ctx.hashPassword).not.toHaveBeenCalled();
  });

  it("a password equal to the enrollment number is rejected and the token is not burned", async () => {
    const ctx = setup();
    const a = await issued(ctx, ctx.student.id, "ACCOUNT_ACTIVATION");
    expect(await consumeToken({ token: a.token, purpose: "ACCOUNT_ACTIVATION", password: "ENR1" }, ctx.deps(1))).toBe("PASSWORD_REJECTED");
    expect(ctx.f.tokens[0].usedAt).toBeNull();
    expect(ctx.hashPassword).not.toHaveBeenCalled();
    expect(await consumeToken({ token: a.token, purpose: "ACCOUNT_ACTIVATION", password: "another-pass1" }, ctx.deps(2))).toBe("OK");
  });

  it("an ineligible user (suspended institution, inactive) gets INVALID and the token stays unburned", async () => {
    const ctx = setup();
    const a = await issued(ctx, ctx.student.id, "ACCOUNT_ACTIVATION");
    ctx.f.institutions[0].status = "SUSPENDED";
    expect(await consumeToken({ token: a.token, purpose: "ACCOUNT_ACTIVATION", password: "newpass123" }, ctx.deps(1))).toBe("INVALID");
    ctx.f.institutions[0].status = "ACTIVE";
    ctx.student.accountStatus = "INACTIVE";
    expect(await consumeToken({ token: a.token, purpose: "ACCOUNT_ACTIVATION", password: "newpass123" }, ctx.deps(1))).toBe("INVALID");
    expect(ctx.f.tokens[0].usedAt).toBeNull();
  });

  it("a token that somehow exists for a platform account is refused and left unburned", async () => {
    const ctx = setup();
    const sa = ctx.f.addUser({ email: "sa@x.edu", role: "SUPER_ADMIN", passwordHash: "p" });
    const { token, tokenHash } = generateToken();
    ctx.f.tokens.push({ id: "tx", userId: sa.id, institutionId: "inst-1", purpose: "PASSWORD_RESET", tokenHash, expiresAt: new Date(NOW.getTime() + 60_000), usedAt: null, supersededAt: null, createdAt: NOW });
    expect(await consumeToken({ token, purpose: "PASSWORD_RESET", password: "brand-new-1" }, ctx.deps())).toBe("INVALID");
    expect(ctx.f.tokens[0].usedAt).toBeNull();
    expect(ctx.hashPassword).not.toHaveBeenCalled();
  });

  it("a parallel double consume has exactly one winner", async () => {
    const ctx = setup();
    const r = await issued(ctx, ctx.staff.id, "PASSWORD_RESET");
    const results = await Promise.all([
      consumeToken({ token: r.token, purpose: "PASSWORD_RESET", password: "brand-new-1" }, ctx.deps(1)),
      consumeToken({ token: r.token, purpose: "PASSWORD_RESET", password: "brand-new-2" }, ctx.deps(1)),
    ]);
    expect(results.sort()).toEqual(["INVALID", "OK"]);
  });
});

describe("ensureMembership", () => {
  it("leaves a membership that already has roles untouched", async () => {
    const f = new FakeOwnerDb();
    f.memberships.push({ id: "m1", userId: "u", institutionId: "inst-1", membershipStatus: "SUSPENDED" });
    f.membershipRoles.push({ id: "mr1", membershipId: "m1", roleId: "role-other", institutionId: "inst-1" });
    await ensureMembership(f as never, { userId: "u", institutionId: "inst-1", legacyRole: "STUDENT" });
    expect(f.membershipRoles).toHaveLength(1);
    expect(f.membershipRoles[0].roleId).toBe("role-other");
    expect(f.memberships[0].membershipStatus).toBe("SUSPENDED");
  });
  it("skips SUPER_ADMIN and warns when the template role is missing", async () => {
    const f = new FakeOwnerDb();
    await ensureMembership(f as never, { userId: "u", institutionId: "inst-1", legacyRole: "SUPER_ADMIN" });
    expect(f.memberships).toHaveLength(0);
    const warn = vi.fn();
    await ensureMembership(f as never, { userId: "u", institutionId: "inst-1", legacyRole: "NOPE" }, { warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(f.memberships).toHaveLength(1); // membership exists, role link skipped
    expect(f.membershipRoles).toHaveLength(0);
  });
});
