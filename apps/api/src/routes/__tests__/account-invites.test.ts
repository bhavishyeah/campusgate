import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", async () => {
  const { FakeOwnerDb } = await import("../../services/__tests__/helpers/fake-owner-db.js");
  const fake = new FakeOwnerDb();
  return { privilegedPrisma: fake, prisma: fake, __fake: fake, withTenant: (_i: string, fn: any) => fn(fake), Prisma: {} };
});
// Auth is exercised elsewhere; here the actor comes from headers and permissions
// come from the real ROLE_PERMISSIONS templates.
vi.mock("../../middleware/auth.js", () => ({
  authenticate: async (request: any) => {
    const role = String(request.headers["x-role"] ?? "ADMIN");
    request.user = { userId: String(request.headers["x-user"] ?? "admin-1"), institutionId: "inst-1", role };
    request.auth = { roles: [role], membershipId: "mb" };
  },
}));
vi.mock("../../services/authz-engine.js", async () => {
  const { ROLE_PERMISSIONS } = await import("@campusgate/shared");
  return {
    requirePermission: (key: string) => async (request: any, reply: any) => {
      if (!(ROLE_PERMISSIONS[request.auth.roles[0]] ?? []).includes(key)) {
        return reply.status(403).send({ error: "Forbidden" });
      }
    },
  };
});
vi.mock("../../services/audit.js", () => ({ recordAuditEvent: vi.fn(async () => {}) }));

import * as dbModule from "@campusgate/db";
import { accountInviteRoutes } from "../account-invites.js";
import { EmailSendError, InMemoryEmailSender, setEmailSender, UnconfiguredEmailSender } from "../../services/email/index.js";
import { resetAllLimiters } from "../../services/rate-limit.js";
import { recordAuditEvent } from "../../services/audit.js";
import type { FakeOwnerDb } from "../../services/__tests__/helpers/fake-owner-db.js";

const f = (dbModule as unknown as { __fake: FakeOwnerDb }).__fake;
let mail: InMemoryEmailSender;

async function makeApp() {
  const app = Fastify();
  await app.register(accountInviteRoutes, { prefix: "/api/account-invites" });
  return app;
}
type App = Awaited<ReturnType<typeof makeApp>>;
const call = (app: App, method: "POST" | "GET", url: string, role = "ADMIN", payload?: unknown, user = "admin-1") =>
  app.inject({ method, url: `/api/account-invites${url}`, headers: { "x-role": role, "x-user": user }, payload: payload as never });

function student(i: number, over: Record<string, unknown> = {}) {
  return f.addUser({ email: `s${i}@x.edu`, studentProfile: { enrollmentNo: `E${i}`, status: "ACTIVE" }, createdAt: new Date(2027, 0, 1, 0, 0, i), ...over });
}

beforeEach(() => {
  f.tokens = []; f.users = []; f.events = []; f.memberships = []; f.membershipPerms.clear();
  f.institutions = [{ id: "inst-1", name: "Demo College", status: "ACTIVE" }];
  resetAllLimiters();
  vi.unstubAllEnvs();
  vi.stubEnv("FRONTEND_URL", "https://app.x.edu");
  vi.mocked(recordAuditEvent).mockClear();
  mail = new InMemoryEmailSender();
  setEmailSender(mail);
});

describe("permissions", () => {
  it("student route needs students.create, staff route needs admin.users.create; others are 403", async () => {
    const s = student(1);
    const t = f.addUser({ email: "t@x.edu", role: "HOD" });
    const app = await makeApp();
    expect((await call(app, "POST", `/students/${s.id}`, "ADMIN")).statusCode).toBe(200);
    expect((await call(app, "POST", `/users/${t.id}`, "ADMIN")).statusCode).toBe(200);
    expect((await call(app, "POST", `/students/${s.id}`, "STUDENT")).statusCode).toBe(403);
    expect((await call(app, "POST", `/users/${t.id}`, "STUDENT")).statusCode).toBe(403);
    expect((await call(app, "POST", "/bulk-students", "STUDENT", { mode: "ALL_PENDING" })).statusCode).toBe(403);
    expect((await call(app, "GET", "/summary", "STUDENT")).statusCode).toBe(403);
  });

  it("cross-route roles are 404 (student via staff route and reverse); SUPER_ADMIN and platform accounts are 404", async () => {
    const s = student(1);
    const t = f.addUser({ email: "t@x.edu", role: "HOD" });
    const sa = f.addUser({ email: "sa@x.edu", role: "SUPER_ADMIN" });
    const px = f.addUser({ email: "px@x.edu", role: "ADMIN" });
    f.membershipPerms.set(px.id, [{ role: { key: "OPS", permissions: [{ permission: { key: "platform.onboarding" } }] } }]);
    const app = await makeApp();
    expect((await call(app, "POST", `/users/${s.id}`)).statusCode).toBe(404);
    expect((await call(app, "POST", `/students/${t.id}`)).statusCode).toBe(404);
    expect((await call(app, "POST", `/users/${sa.id}`)).statusCode).toBe(404);
    expect((await call(app, "POST", `/users/${px.id}`)).statusCode).toBe(404);
    expect(mail.sent).toHaveLength(0);
  });
});

describe("single invite", () => {
  it("200 sends one activation mail and audits it", async () => {
    const s = student(1);
    const r = await call(await makeApp(), "POST", `/students/${s.id}`);
    expect(r.statusCode).toBe(200);
    expect(r.json().sent).toBe(true);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to.email).toBe("s1@x.edu");
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.user.invite_sent" }), expect.anything());
  });

  it("404 for another institution or unknown id", async () => {
    f.institutions.push({ id: "inst-2", name: "Other", status: "ACTIVE" });
    const o = student(1, { institutionId: "inst-2" });
    const app = await makeApp();
    expect((await call(app, "POST", `/students/${o.id}`)).statusCode).toBe(404);
    expect((await call(app, "POST", "/students/nope")).statusCode).toBe(404);
  });

  it("409 ALREADY_ACTIVATED and ACCOUNT_NOT_ACTIVE", async () => {
    const a = student(1, { passwordHash: "x" });
    const b = student(2, { accountStatus: "INACTIVE" });
    const app = await makeApp();
    const ra = await call(app, "POST", `/students/${a.id}`);
    expect(ra.statusCode).toBe(409);
    expect(ra.json().code).toBe("ALREADY_ACTIVATED");
    const rb = await call(app, "POST", `/students/${b.id}`);
    expect(rb.json().code).toBe("ACCOUNT_NOT_ACTIVE");
  });

  it("429 INVITE_THROTTLED on the 4th token in an hour; a resend supersedes the earlier link", async () => {
    const s = student(1);
    const app = await makeApp();
    for (let i = 0; i < 3; i++) expect((await call(app, "POST", `/students/${s.id}`)).statusCode).toBe(200);
    expect(f.tokens.filter((t) => !t.supersededAt && !t.usedAt)).toHaveLength(1);
    const r = await call(app, "POST", `/students/${s.id}`);
    expect(r.statusCode).toBe(429);
    expect(r.json().code).toBe("INVITE_THROTTLED");
  });

  it("502 on provider failure with the token invalidated; 429 on provider limit; 503 when unconfigured", async () => {
    const s = student(1);
    const app = await makeApp();
    mail.failWith = new EmailSendError("PROVIDER_UNAVAILABLE", "x");
    const r = await call(app, "POST", `/students/${s.id}`);
    expect(r.statusCode).toBe(502);
    expect(r.json().code).toBe("EMAIL_SEND_FAILED");
    expect(f.tokens.filter((t) => !t.supersededAt && !t.usedAt)).toHaveLength(0);
    expect(f.tokens[0].emailSentAt).toBeNull();

    mail.failWith = new EmailSendError("PROVIDER_LIMIT", "x", 402);
    const r2 = await call(app, "POST", `/students/${s.id}`);
    expect(r2.statusCode).toBe(429);
    expect(r2.json().code).toBe("EMAIL_PROVIDER_LIMIT");

    setEmailSender(new UnconfiguredEmailSender());
    const r3 = await call(app, "POST", `/students/${s.id}`);
    expect(r3.statusCode).toBe(503);
    expect(r3.json().code).toBe("EMAIL_NOT_CONFIGURED");
  });

  it("per-admin limit is 30 per minute", async () => {
    const app = await makeApp();
    let last;
    for (let i = 0; i < 31; i++) last = await call(app, "POST", "/students/nope");
    expect(last!.statusCode).toBe(429);
  });
});

describe("bulk invite", () => {
  it("sends at most 100 per call, oldest first, and reports the rest as remaining", async () => {
    for (let i = 0; i < 130; i++) student(i);
    const r = await call(await makeApp(), "POST", "/bulk-students", "ADMIN", { mode: "ALL_PENDING" });
    const b = r.json();
    expect(r.statusCode).toBe(200);
    expect(b.eligibleTotal).toBe(130);
    expect(b.attempted).toBe(100);
    expect(b.sent).toBe(100);
    expect(b.remainingNotInvited).toBe(30);
    expect(mail.sent).toHaveLength(100);
    expect(b.results).toHaveLength(100);
    expect(b.budget.inviteCeiling).toBe(250);
    expect(JSON.stringify(b)).not.toMatch(/token=/);
  });

  it("dryRun sends nothing, works unconfigured, and reports emailConfigured", async () => {
    for (let i = 0; i < 3; i++) student(i);
    setEmailSender(new UnconfiguredEmailSender());
    const r = await call(await makeApp(), "POST", "/bulk-students", "ADMIN", { mode: "ALL_PENDING", dryRun: true });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ dryRun: true, emailConfigured: false, eligibleTotal: 3, attempted: 3, sent: 0 });
    expect(f.tokens).toHaveLength(0);
    const real = await call(await makeApp(), "POST", "/bulk-students", "ADMIN", { mode: "ALL_PENDING" });
    expect(real.statusCode).toBe(503);
  });

  it("skips recently invited and recently failed users, and resendRecent lifts only the first", async () => {
    const a = student(1), b = student(2), c = student(3);
    const now = new Date();
    f.tokens.push(
      { id: "t1", userId: a.id, institutionId: "inst-1", purpose: "ACCOUNT_ACTIVATION", tokenHash: "h1", expiresAt: now, emailSentAt: now, failedAt: null, usedAt: null, supersededAt: now, createdAt: now },
      { id: "t2", userId: b.id, institutionId: "inst-1", purpose: "ACCOUNT_ACTIVATION", tokenHash: "h2", expiresAt: now, emailSentAt: null, failedAt: now, usedAt: null, supersededAt: now, createdAt: now },
    );
    const app = await makeApp();
    const dry = (await call(app, "POST", "/bulk-students", "ADMIN", { mode: "ALL_PENDING", dryRun: true })).json();
    expect(dry.skipped).toMatchObject({ recentlyInvited: 1, recentFailure: 1 });
    expect(dry.eligibleTotal).toBe(1);
    expect(dry.failedRecently).toBe(1);
    const sel = (await call(app, "POST", "/bulk-students", "ADMIN", { mode: "SELECTED", userIds: [a.id, b.id, c.id], resendRecent: true, dryRun: true })).json();
    expect(sel.skipped.recentFailure).toBe(1);
    expect(sel.eligibleTotal).toBe(2);
  });

  it("SELECTED reports not found, already activated and not eligible", async () => {
    const act = student(1, { passwordHash: "x" });
    const ok = student(2);
    const staff = f.addUser({ email: "t@x.edu", role: "HOD" });
    const r = (await call(await makeApp(), "POST", "/bulk-students", "ADMIN", { mode: "SELECTED", userIds: [act.id, ok.id, staff.id, "ghost"], dryRun: true })).json();
    expect(r.skipped).toMatchObject({ alreadyActivated: 1, notEligible: 1, notFound: 1 });
    expect(r.eligibleTotal).toBe(1);
  });

  it("stops at the 250 invite ceiling and returns 429 EMAIL_DAILY_LIMIT when none is left", async () => {
    vi.stubEnv("EMAIL_DAILY_LIMIT", "300");
    const filler = f.addUser({ email: "filler@x.edu", role: "HOD" });
    const now = new Date();
    for (let i = 0; i < 245; i++) f.tokens.push({ id: `f${i}`, userId: filler.id, institutionId: "inst-1", purpose: "PASSWORD_RESET", tokenHash: `h${i}`, expiresAt: now, emailSentAt: now, supersededAt: now, usedAt: null, createdAt: now });
    for (let i = 0; i < 10; i++) student(i);
    const app = await makeApp();
    const r = (await call(app, "POST", "/bulk-students", "ADMIN", { mode: "ALL_PENDING" })).json();
    expect(r.sent).toBe(5);
    expect(r.attempted).toBe(5);
    expect(r.budget.inviteRemaining).toBe(0);
    const again = await call(app, "POST", "/bulk-students", "ADMIN", { mode: "ALL_PENDING" });
    expect(again.statusCode).toBe(429);
    expect(again.json().code).toBe("EMAIL_DAILY_LIMIT");
    expect(mail.sent).toHaveLength(5);
  });

  it("a provider limit stops the batch and reports the rest as skipped", async () => {
    for (let i = 0; i < 20; i++) student(i);
    mail.failWith = new EmailSendError("PROVIDER_LIMIT", "x", 429);
    const r = (await call(await makeApp(), "POST", "/bulk-students", "ADMIN", { mode: "ALL_PENDING" })).json();
    expect(r.sent).toBe(0);
    expect(r.skipped.providerLimit).toBeGreaterThan(0);
    expect(r.failed + r.skipped.providerLimit).toBe(20);
  });

  it("rejects an invalid body and limits real sends to 6 per hour per admin", async () => {
    const app = await makeApp();
    expect((await call(app, "POST", "/bulk-students", "ADMIN", { mode: "SELECTED" })).statusCode).toBe(400);
    for (let i = 0; i < 6; i++) expect((await call(app, "POST", "/bulk-students", "ADMIN", { mode: "ALL_PENDING" })).statusCode).toBe(200);
    expect((await call(app, "POST", "/bulk-students", "ADMIN", { mode: "ALL_PENDING" })).statusCode).toBe(429);
  });
});

describe("summary", () => {
  it("returns counts only", async () => {
    student(1); student(2); student(3, { passwordHash: "x" });
    const r = await call(await makeApp(), "GET", "/summary");
    expect(r.json()).toEqual({ notActivatedStudents: 2, emailConfigured: true, budget: { inviteCeiling: 250, inviteRemaining: 250 } });
  });
});
