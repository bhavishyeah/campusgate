/**
 * Account lifecycle LIVE suite. TEST Supabase project only (live-test-env.ts
 * refuses the production ref). Self-contained under the ACCTLC_TEST_ prefix.
 * Run alone: npx vitest run --config vitest.integration.config.ts account-lifecycle
 */
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import bcrypt from "bcrypt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pinLiveTestEnv } from "./helpers/live-test-env.js";

pinLiveTestEnv("full");

const PFX = "ACCTLC_TEST_";
const inst = `${PFX}inst`;
const inst2 = `${PFX}inst2`;
const dept = `${PFX}dept`;

let db: typeof import("@campusgate/db");
let tokens: typeof import("../../services/account-tokens.js");
let lifecycle: typeof import("../account-lifecycle.js");
let authMod: typeof import("../auth.js");
let adminMod: typeof import("../admin.js");
let o: any; // owner client
let seq = 0;

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const transient = ["Can't reach database server", "P1001", "Timed out", "ECONNRESET", "max clients reached", "EMAXCONNSESSION", "Transaction API error", "connection pool"].some((s) => msg.includes(s));
      if (!transient || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
}

async function mkUser(over: Record<string, unknown> = {}, enrollmentNo?: string) {
  const n = ++seq;
  const user = await withRetry(() =>
    o.user.create({
      data: { email: `${PFX.toLowerCase()}u${n}@example.test`, role: "STUDENT", institutionId: inst, accountStatus: "ACTIVE", ...over },
    }),
  );
  if (enrollmentNo) {
    await withRetry(() =>
      o.studentProfile.create({
        data: { userId: user.id, institutionId: inst, name: `${PFX}S${n}`, enrollmentNo, departmentId: dept, program: "BTech", semester: 1 },
      }),
    );
  }
  return user;
}

async function teardown() {
  const where = { institutionId: { startsWith: PFX } };
  await withRetry(() => o.accountToken.deleteMany({ where }));
  await withRetry(() => o.securityEvent.deleteMany({ where }));
  await withRetry(() => o.notification?.deleteMany?.({ where }));
  // audit_events is append-only: delete our rows with the trigger disabled (scoped, re-enabled).
  await withRetry(async () => {
    await o.$executeRawUnsafe(`ALTER TABLE "audit_events" DISABLE TRIGGER "audit_events_no_update_delete"`);
    try {
      await o.$executeRawUnsafe(`DELETE FROM "audit_events" WHERE "institutionId" LIKE '${PFX}%'`);
    } finally {
      await o.$executeRawUnsafe(`ALTER TABLE "audit_events" ENABLE TRIGGER "audit_events_no_update_delete"`);
    }
  });
  await withRetry(() => o.membershipRole.deleteMany({ where }));
  await withRetry(() => o.institutionMembership.deleteMany({ where }));
  await withRetry(() => o.studentProfile.deleteMany({ where }));
  await withRetry(() => o.session.deleteMany({ where: { user: { institutionId: { startsWith: PFX } } } }));
  await withRetry(() => o.user.deleteMany({ where }));
  await withRetry(() => o.department.deleteMany({ where }));
  await withRetry(() => o.institution.deleteMany({ where: { id: { startsWith: PFX } } }));
}

beforeAll(async () => {
  db = await import("@campusgate/db");
  tokens = await import("../../services/account-tokens.js");
  lifecycle = await import("../account-lifecycle.js");
  authMod = await import("../auth.js");
  adminMod = await import("../admin.js");
  o = db.privilegedPrisma;
  await teardown();
  await withRetry(() => o.institution.create({ data: { id: inst, name: `${PFX}Inst`, code: `${PFX}C1`, status: "ACTIVE" } }));
  await withRetry(() => o.institution.create({ data: { id: inst2, name: `${PFX}Inst2`, code: `${PFX}C2`, status: "ACTIVE" } }));
  await withRetry(() => o.department.create({ data: { id: dept, name: `${PFX}Dept`, code: `${PFX}D`, institutionId: inst } }));
}, 120_000);

afterAll(async () => {
  await teardown().catch(() => {});
  await db.privilegedPrisma.$disconnect();
  await db.prisma.$disconnect();
}, 120_000);

describe("account_tokens table", () => {
  it("owner can read/write; composite FK rejects a mismatched institution; unique and partial-unique hold", async () => {
    const u = await mkUser();
    const mk = (extra: Record<string, unknown> = {}) =>
      o.accountToken.create({
        data: { userId: u.id, institutionId: inst, purpose: "PASSWORD_RESET", tokenHash: tokens.generateToken().tokenHash, expiresAt: new Date(Date.now() + 60_000), ...extra },
      });
    const first = await withRetry(() => mk());
    expect((await o.accountToken.findUnique({ where: { id: first.id } })).userId).toBe(u.id);

    await expect(o.accountToken.create({ data: { userId: u.id, institutionId: inst2, purpose: "PASSWORD_RESET", tokenHash: tokens.generateToken().tokenHash, expiresAt: new Date(Date.now() + 60_000) } })).rejects.toThrow();
    await expect(mk()).rejects.toMatchObject({ code: "P2002" }); // second live token, same purpose
    await o.accountToken.update({ where: { id: first.id }, data: { supersededAt: new Date() } });
    await expect(mk()).resolves.toBeTruthy(); // free again after supersede
    await expect(mk({ tokenHash: "not-hex" })).rejects.toThrow(); // CHECK
  }, 60_000);

  it("campass_app cannot read or insert", async () => {
    const u = await mkUser();
    await o.accountToken.create({ data: { userId: u.id, institutionId: inst, purpose: "ACCOUNT_ACTIVATION", tokenHash: tokens.generateToken().tokenHash, expiresAt: new Date(Date.now() + 60_000) } });
    const read = await db.withTenant(inst, (tx: any) => tx.accountToken.findMany({ where: { userId: u.id } })).then((r: any[]) => r, () => "denied");
    expect(read === "denied" || (Array.isArray(read) && read.length === 0)).toBe(true);
    await expect(
      db.withTenant(inst, (tx: any) => tx.accountToken.create({ data: { userId: u.id, institutionId: inst, purpose: "PASSWORD_RESET", tokenHash: tokens.generateToken().tokenHash, expiresAt: new Date(Date.now() + 60_000) } })),
    ).rejects.toThrow();
  }, 60_000);
});

describe("issue and consume against the real database", () => {
  it("10 parallel issues against a ceiling of 5 reserve exactly 5", async () => {
    const used = await o.accountToken.count({ where: { emailSentAt: { gte: new Date(Date.now() - 24 * 3_600_000) } } });
    const users = await Promise.all(Array.from({ length: 10 }, () => mkUser()));
    const results = await Promise.all(
      users.map((u) => tokens.issueToken({ userId: u.id, institutionId: inst, purpose: "ACCOUNT_ACTIVATION", budgetCeiling: used + 5 })),
    );
    expect(results.filter((r) => r.status === "OK")).toHaveLength(5);
    expect(results.filter((r) => r.status === "BUDGET")).toHaveLength(5);
  }, 120_000);

  it("parallel double consume has one winner; sessions revoked; membership ensured; login then works", async () => {
    const u = await mkUser({}, `${PFX}ENR-A`);
    await o.session.create({ data: { userId: u.id, jti: `${PFX}jti-${u.id}`, expiresAt: new Date(Date.now() + 3_600_000) } });
    const issued = await tokens.issueToken({ userId: u.id, institutionId: inst, purpose: "ACCOUNT_ACTIVATION", budgetCeiling: 100000 });
    if (issued.status !== "OK") throw new Error(`issue failed: ${issued.status}`);

    // before activation: no membership (F3 probe) and no password
    const before = await o.institutionMembership.findUnique({ where: { userId_institutionId: { userId: u.id, institutionId: inst } } });
    console.log(`F3 probe: freshly created passwordless student has membership = ${!!before}`);

    const [a, b] = await Promise.all([
      tokens.consumeToken({ token: issued.token, purpose: "ACCOUNT_ACTIVATION", password: "correct-horse-1" }),
      tokens.consumeToken({ token: issued.token, purpose: "ACCOUNT_ACTIVATION", password: "correct-horse-2" }),
    ]);
    expect([a, b].sort()).toEqual(["INVALID", "OK"]);

    expect((await o.session.findMany({ where: { userId: u.id } })).every((s: any) => s.revoked)).toBe(true);
    const m = await o.institutionMembership.findUnique({ where: { userId_institutionId: { userId: u.id, institutionId: inst } }, include: { roles: true } });
    expect(m.roles).toHaveLength(1);
    expect(await o.securityEvent.count({ where: { userId: u.id, eventType: "PASSWORD_CHANGED" } })).toBe(1);

    const app = Fastify();
    await app.register(jwt, { secret: "live-secret" });
    await app.register(authMod.authRoutes, { prefix: "/api/auth" });
    const email = (await o.user.findUnique({ where: { id: u.id } })).email;
    const pw = (await o.user.findUnique({ where: { id: u.id } })).passwordHash;
    const pwd = (await bcrypt.compare("correct-horse-1", pw)) ? "correct-horse-1" : "correct-horse-2";
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: pwd } });
    expect(login.statusCode).toBe(200);
    expect(login.json().token).toBeTruthy();
  }, 120_000);

  it("ensureMembership works from the tenant (campass_app) client and does not duplicate", async () => {
    const u = await mkUser({ accountStatus: "PENDING_APPROVAL" }, `${PFX}ENR-B`);
    for (let i = 0; i < 2; i++) {
      await db.withTenant(inst, (tx: any) => tokens.ensureMembership(tx, { userId: u.id, institutionId: inst, legacyRole: "STUDENT" }));
    }
    const m = await o.institutionMembership.findMany({ where: { userId: u.id }, include: { roles: true } });
    expect(m).toHaveLength(1);
    expect(m[0].roles).toHaveLength(1);
  }, 60_000);

  it("a rejected password leaves the token unburned and a SUPER_ADMIN gets no token from forgot", async () => {
    const u = await mkUser({}, `${PFX}ENR-C`);
    const issued = await tokens.issueToken({ userId: u.id, institutionId: inst, purpose: "ACCOUNT_ACTIVATION", budgetCeiling: 100000 });
    if (issued.status !== "OK") throw new Error("issue");
    expect(await tokens.consumeToken({ token: issued.token, purpose: "ACCOUNT_ACTIVATION", password: `${PFX}ENR-C` })).toBe("PASSWORD_REJECTED");
    expect((await o.accountToken.findUnique({ where: { id: issued.id } })).usedAt).toBeNull();

    const sa = await mkUser({ role: "SUPER_ADMIN", passwordHash: "x" });
    expect((await tokens.issueToken({ userId: sa.id, institutionId: inst, purpose: "PASSWORD_RESET", budgetCeiling: 100000 })).status).toBe("INELIGIBLE");
    expect(await o.accountToken.count({ where: { userId: sa.id } })).toBe(0);
  }, 60_000);

  it("throttles at 3 tokens per hour", async () => {
    const u = await mkUser({ passwordHash: "x", role: "HOD" });
    const statuses: string[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await tokens.issueToken({ userId: u.id, institutionId: inst, purpose: "PASSWORD_RESET", budgetCeiling: 100000 })).status);
    expect(statuses).toEqual(["OK", "OK", "OK", "THROTTLED"]);
  }, 60_000);
});

describe("login and register hardening", () => {
  it("login rejects the legacy bcrypt(enrollmentNo) default; register never changes an existing account", async () => {
    const enr = `${PFX}ENR-D`;
    const legacyHash = await bcrypt.hash(enr, 4);
    const u = await mkUser({ passwordHash: legacyHash }, enr);
    await db.withTenant(inst, (tx: any) => tokens.ensureMembership(tx, { userId: u.id, institutionId: inst, legacyRole: "STUDENT" }));
    const app = Fastify();
    await app.register(jwt, { secret: "live-secret" });
    await app.register(authMod.authRoutes, { prefix: "/api/auth" });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: u.email, password: enr } });
    expect(login.statusCode).toBe(403);
    expect(login.json().token).toBeUndefined();

    const reg = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { email: u.email, password: "attacker-pass-1", name: "Attacker", role: "STUDENT", enrollmentNo: enr, departmentId: dept, program: "BTech", semester: 1 },
      remoteAddress: "49.7.7.7",
    });
    expect(reg.statusCode).toBe(409);
    expect((await o.user.findUnique({ where: { id: u.id } })).passwordHash).toBe(legacyHash);
  }, 60_000);
});

describe("admin users list and reject", () => {
  it("list omits secrets and adds hasPassword; reject deletes a pending user and frees the email", async () => {
    const admin = await mkUser({ role: "ADMIN", passwordHash: "x" });
    await db.withTenant(inst, (tx: any) => tokens.ensureMembership(tx, { userId: admin.id, institutionId: inst, legacyRole: "ADMIN" }));
    const pending = await mkUser({ accountStatus: "PENDING_APPROVAL", passwordHash: "x" }, `${PFX}ENR-E`);
    const app = Fastify();
    await app.register(jwt, { secret: "live-secret" });
    await app.register(adminMod.adminRoutes, { prefix: "/api/admin" });
    const token = app.jwt.sign({ userId: admin.id, role: "ADMIN", institutionId: inst });
    const headers = { authorization: `Bearer ${token}` };

    const list = await app.inject({ method: "GET", url: "/api/admin/users?limit=100", headers });
    expect(list.statusCode).toBe(200);
    const row = list.json().users.find((x: any) => x.id === pending.id);
    expect(row).toBeTruthy();
    expect(row).not.toHaveProperty("passwordHash");
    expect(row).not.toHaveProperty("mfaSecret");
    expect(row.hasPassword).toBe(true);
    expect(row.studentProfile).toBeTruthy();

    const rej = await app.inject({ method: "POST", url: `/api/admin/users/${pending.id}/reject`, headers });
    expect(rej.statusCode).toBe(200);
    expect(await o.user.findUnique({ where: { id: pending.id } })).toBeNull();
    expect(await o.studentProfile.findUnique({ where: { enrollmentNo: `${PFX}ENR-E` } })).toBeNull();
    expect((await app.inject({ method: "POST", url: `/api/admin/users/${pending.id}/reject`, headers })).statusCode).toBe(404);
  }, 120_000);
});

describe("forgot-password route end to end", () => {
  it("sends one reset mail for a real account and the token it carries resets the password", async () => {
    const { InMemoryEmailSender, setEmailSender } = await import("../../services/email/index.js");
    const mail = new InMemoryEmailSender();
    setEmailSender(mail);
    process.env.FRONTEND_URL = "https://app.example.test";
    const u = await mkUser({ role: "HOD", passwordHash: await bcrypt.hash("old-password-1", 4) });
    const app = Fastify();
    await app.register(lifecycle.accountLifecycleRoutes, { prefix: "/api/auth" });
    const r = await app.inject({ method: "POST", url: "/api/auth/forgot-password", payload: { email: u.email }, remoteAddress: "49.8.8.8" });
    expect(r.statusCode).toBe(200);
    await lifecycle.drainBackground();
    expect(mail.sent).toHaveLength(1);
    const tok = /#token=([A-Za-z0-9_-]+)/.exec(mail.sent[0].text)![1];
    const ok = await app.inject({ method: "POST", url: "/api/auth/reset-password", payload: { token: tok, password: "brand-new-pass-1" }, remoteAddress: "49.8.8.8" });
    expect(ok.statusCode).toBe(200);
    expect(await bcrypt.compare("brand-new-pass-1", (await o.user.findUnique({ where: { id: u.id } })).passwordHash)).toBe(true);
    setEmailSender(null);
  }, 120_000);
});
