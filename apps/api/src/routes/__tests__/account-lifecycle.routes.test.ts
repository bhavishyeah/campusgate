import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", async () => {
  const { FakeOwnerDb } = await import("../../services/__tests__/helpers/fake-owner-db.js");
  const fake = new FakeOwnerDb();
  return { privilegedPrisma: fake, prisma: fake, __fake: fake, withTenant: (_i: string, fn: any) => fn(fake), Prisma: {} };
});

import * as dbModule from "@campusgate/db";
import { accountLifecycleRoutes, drainBackground } from "../account-lifecycle.js";
import { InMemoryEmailSender, setEmailSender, UnconfiguredEmailSender } from "../../services/email/index.js";
import { resetAllLimiters } from "../../services/rate-limit.js";
import { generateToken } from "../../services/account-tokens.js";
import type { FakeOwnerDb } from "../../services/__tests__/helpers/fake-owner-db.js";

const f = (dbModule as unknown as { __fake: FakeOwnerDb }).__fake;
let mail: InMemoryEmailSender;
const GENERIC = { message: "If an account exists for that email, we have sent a link. Check your inbox." };

async function makeApp() {
  const app = Fastify();
  await app.register(accountLifecycleRoutes, { prefix: "/api/auth" });
  return app;
}
type App = Awaited<ReturnType<typeof makeApp>>;
const forgot = (app: App, email: string, ip = "49.1.1.1") =>
  app.inject({ method: "POST", url: "/api/auth/forgot-password", payload: { email }, remoteAddress: ip });

function reset() {
  f.tokens = []; f.users = []; f.sessions = []; f.events = []; f.memberships = []; f.membershipRoles = [];
  f.membershipPerms.clear();
  f.institutions = [{ id: "inst-1", name: "Demo College", status: "ACTIVE" }];
  resetAllLimiters();
  mail = new InMemoryEmailSender();
  setEmailSender(mail);
}

describe("POST /forgot-password", () => {
  beforeEach(() => { reset(); vi.unstubAllEnvs(); vi.stubEnv("FRONTEND_URL", "https://app.x.edu"); });

  it("returns the identical 200 body for existing, unknown, suspended, pending and platform accounts", async () => {
    f.addUser({ email: "ok@x.edu", role: "HOD", passwordHash: "p" });
    f.addUser({ email: "pend@x.edu", role: "HOD", passwordHash: "p", accountStatus: "PENDING_APPROVAL" });
    f.addUser({ email: "sa@x.edu", role: "SUPER_ADMIN", passwordHash: "p" });
    f.institutions.push({ id: "inst-2", name: "Susp", status: "SUSPENDED" });
    f.addUser({ email: "susp@x.edu", role: "HOD", passwordHash: "p", institutionId: "inst-2" });
    const app = await makeApp();
    const bodies: string[] = [];
    for (const e of ["ok@x.edu", "nobody@x.edu", "pend@x.edu", "sa@x.edu", "susp@x.edu"]) {
      const r = await forgot(app, e);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual(GENERIC);
      bodies.push(r.body);
    }
    expect(new Set(bodies).size).toBe(1);
    await drainBackground();
    expect(mail.sent.map((m) => m.to.email)).toEqual(["ok@x.edu"]);
    expect(f.tokens).toHaveLength(1);
  });

  it("does not await the sender (response returns before a slow send finishes)", async () => {
    f.addUser({ email: "ok@x.edu", role: "HOD", passwordHash: "p" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setEmailSender({ kind: "memory", isConfigured: () => true, send: async () => { await gate; return {}; } });
    const r = await forgot(await makeApp(), "ok@x.edu");
    expect(r.statusCode).toBe(200);
    release();
    await drainBackground();
  });

  it("passwordless active student gets an activation email; a non-ACTIVE profile gets nothing", async () => {
    f.addUser({ email: "new@x.edu", studentProfile: { enrollmentNo: "E1", status: "ACTIVE" } });
    f.addUser({ email: "grad@x.edu", studentProfile: { enrollmentNo: "E2", status: "GRADUATED" } });
    const app = await makeApp();
    await forgot(app, "new@x.edu");
    await forgot(app, "grad@x.edu");
    await drainBackground();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).toMatch(/^Activate your CampusGate account/);
    expect(f.tokens[0].purpose).toBe("ACCOUNT_ACTIVATION");
  });

  it("sends reset mail with a fragment link and stores only the hash", async () => {
    f.addUser({ email: "ok@x.edu", role: "HOD", passwordHash: "p" });
    await forgot(await makeApp(), "ok@x.edu");
    await drainBackground();
    const m = mail.sent[0].text;
    const tok = /reset-password#token=([A-Za-z0-9_-]+)/.exec(m)![1];
    expect(m).toContain("https://app.x.edu/reset-password#token=");
    expect(JSON.stringify(f.tokens)).not.toContain(tok);
  });

  it("case tie-break: picks the real ACTIVE row over a PENDING squatter; ambiguous ACTIVE variants send nothing", async () => {
    f.addUser({ email: "Victim@x.edu", role: "HOD", passwordHash: "p", accountStatus: "PENDING_APPROVAL" });
    f.addUser({ email: "victim@x.edu", role: "HOD", passwordHash: "p" });
    const app = await makeApp();
    await forgot(app, "VICTIM@x.edu");
    await drainBackground();
    expect(mail.sent.map((m) => m.to.email)).toEqual(["victim@x.edu"]);

    reset();
    f.addUser({ email: "Dup@x.edu", role: "HOD", passwordHash: "p" });
    f.addUser({ email: "dup@x.edu", role: "HOD", passwordHash: "p" });
    await forgot(await makeApp(), "DUP@x.edu");
    await drainBackground();
    expect(mail.sent).toHaveLength(0);
  });

  it("6 PENDING case variants cannot crowd out the real ACTIVE account", async () => {
    for (let i = 0; i < 6; i++) {
      f.addUser({ email: `VICTIM${i}`.slice(0, 6) + "@x.edu", accountStatus: "PENDING_APPROVAL", passwordHash: "p" });
    }
    f.addUser({ email: "victim@x.edu", role: "HOD", passwordHash: "p" });
    await forgot(await makeApp(), "victim@x.edu");
    await drainBackground();
    expect(mail.sent.map((m) => m.to.email)).toEqual(["victim@x.edu"]);
  });
  it("per-email limit (3/hour) silently suppresses the 4th send, still generic 200", async () => {
    f.addUser({ email: "ok@x.edu", role: "HOD", passwordHash: "p" });
    const app = await makeApp();
    for (let i = 0; i < 4; i++) {
      const r = await forgot(app, "ok@x.edu");
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual(GENERIC);
      await drainBackground();
    }
    expect(mail.sent).toHaveLength(3);
  });

  it("41 distinct eligible users send exactly 40 within an hour, all responses identical", async () => {
    for (let i = 0; i < 41; i++) f.addUser({ email: `u${i}@x.edu`, role: "HOD", passwordHash: "p" });
    const app = await makeApp();
    const bodies = new Set<string>();
    for (let i = 0; i < 41; i++) {
      const r = await forgot(app, `u${i}@x.edu`, `49.2.${Math.floor(i / 200)}.${i % 200 + 1}`);
      expect(r.statusCode).toBe(200);
      bodies.add(r.body);
      await drainBackground();
    }
    expect(bodies.size).toBe(1);
    expect(mail.sent).toHaveLength(40);
  });

  it("per-IP flood limit returns 429 with Retry-After", async () => {
    const app = await makeApp();
    let last;
    for (let i = 0; i < 61; i++) last = await forgot(app, `x${i}@x.edu`);
    expect(last!.statusCode).toBe(429);
    expect(last!.headers["retry-after"]).toBeDefined();
  });

  it("unconfigured production sender: generic 200, nothing sent, no token created", async () => {
    setEmailSender(new UnconfiguredEmailSender());
    f.addUser({ email: "ok@x.edu", role: "HOD", passwordHash: "p" });
    const r = await forgot(await makeApp(), "ok@x.edu");
    await drainBackground();
    expect(r.json()).toEqual(GENERIC);
    expect(f.tokens).toHaveLength(0);
  });

  it("a provider failure invalidates the token and releases the reservation", async () => {
    const { EmailSendError } = await import("../../services/email/index.js");
    mail.failWith = new EmailSendError("PROVIDER_UNAVAILABLE", "x");
    f.addUser({ email: "ok@x.edu", role: "HOD", passwordHash: "p" });
    await forgot(await makeApp(), "ok@x.edu");
    await drainBackground();
    expect(f.tokens[0].emailSentAt).toBeNull();
    expect(f.tokens[0].failedAt).not.toBeNull();
    expect(f.tokens[0].supersededAt).not.toBeNull();
  });

  it("validates the body with 400", async () => {
    const r = await (await makeApp()).inject({ method: "POST", url: "/api/auth/forgot-password", payload: { email: "nope" } });
    expect(r.statusCode).toBe(400);
  });
});

describe("POST /reset-password and /activate", () => {
  beforeEach(() => { reset(); vi.unstubAllEnvs(); vi.stubEnv("FRONTEND_URL", "https://app.x.edu"); });
  const INVALID = "This link is invalid or has expired. Request a new one.";

  async function issueVia(app: App, email: string) {
    await forgot(app, email);
    await drainBackground();
    const text = mail.sent.at(-1)!.text;
    return /#token=([A-Za-z0-9_-]+)/.exec(text)![1];
  }

  it("activates a passwordless student once; second use and wrong-purpose use give the generic 400", async () => {
    const s = f.addUser({ email: "new@x.edu", studentProfile: { enrollmentNo: "E1", status: "ACTIVE" } });
    const app = await makeApp();
    const token = await issueVia(app, "new@x.edu");

    const wrong = await app.inject({ method: "POST", url: "/api/auth/reset-password", payload: { token, password: "goodpassword1" } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe(INVALID);

    const ok = await app.inject({ method: "POST", url: "/api/auth/activate", payload: { token, password: "goodpassword1" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().message).toBe("Account activated. You can now sign in.");
    expect(ok.json().token).toBeUndefined();
    expect(f.users.find((u) => u.id === s.id)!.passwordHash).toBeTruthy();

    const again = await app.inject({ method: "POST", url: "/api/auth/activate", payload: { token, password: "goodpassword1" } });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe(INVALID);
  });

  it("unknown token, malformed token and weak password", async () => {
    const app = await makeApp();
    const u = generateToken().token;
    const unknown = await app.inject({ method: "POST", url: "/api/auth/reset-password", payload: { token: u, password: "goodpassword1" } });
    expect(unknown.json().error).toBe(INVALID);
    expect((await app.inject({ method: "POST", url: "/api/auth/reset-password", payload: { token: "short", password: "goodpassword1" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/auth/reset-password", payload: { token: u, password: "short" } })).statusCode).toBe(400);
  });

  it("the enrollment number is refused as a password with 400 and the token survives", async () => {
    f.addUser({ email: "new@x.edu", studentProfile: { enrollmentNo: "ENROLL-9", status: "ACTIVE" } });
    const app = await makeApp();
    const token = await issueVia(app, "new@x.edu");
    const r = await app.inject({ method: "POST", url: "/api/auth/activate", payload: { token, password: "ENROLL-9" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("Choose a different password.");
    expect(f.tokens[0].usedAt).toBeNull();
  });

  it("tokenIp allows heavy campus traffic (600) and 429s the 601st", async () => {
    const app = await makeApp();
    const t = generateToken().token;
    let last;
    for (let i = 0; i < 601; i++) {
      last = await app.inject({ method: "POST", url: "/api/auth/reset-password", payload: { token: t, password: "goodpassword1" }, remoteAddress: "49.9.9.9" });
    }
    expect(last!.statusCode).toBe(429);
  }, 60000);
});

describe("GET /public-config", () => {
  it("reflects ALLOW_SELF_REGISTRATION", async () => {
    vi.unstubAllEnvs();
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/api/auth/public-config" })).json()).toEqual({ selfRegistrationEnabled: true });
    vi.stubEnv("ALLOW_SELF_REGISTRATION", "false");
    expect((await app.inject({ method: "GET", url: "/api/auth/public-config" })).json()).toEqual({ selfRegistrationEnabled: false });
    vi.unstubAllEnvs();
  });
});
