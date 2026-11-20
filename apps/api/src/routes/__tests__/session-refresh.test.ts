/**
 * Session freshness after a role change: `authenticate` flags a token that is
 * behind the membership (x-session-stale) and POST /api/auth/refresh re-signs the
 * current claims WITHOUT extending the session. The real authenticate runs here.
 */
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import cors from "@fastify/cors";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  institutionMembership: { findUnique: vi.fn() },
  session: { findFirst: vi.fn(), update: vi.fn() },
}));
vi.mock("@campusgate/db", () => ({ privilegedPrisma: db, prisma: db, withTenant: vi.fn(), Prisma: {} }));

import { ROLE_PERMISSIONS } from "@campusgate/shared";
import { authRoutes } from "../auth.js";
import { authenticate } from "../../middleware/auth.js";
import { resetAllLimiters } from "../../services/rate-limit.js";

const role = (key: string) => ({
  role: { key, permissions: (ROLE_PERMISSIONS[key] ?? []).map((k) => ({ permission: { key: k } })) },
});

let membership: any;
async function makeApp() {
  const app = Fastify();
  await app.register(cors, { origin: "https://app.x.edu", exposedHeaders: ["x-session-stale"] });
  await app.register(jwt, { secret: "refresh-test-secret", sign: { expiresIn: "24h" } });
  await app.register(authRoutes, { prefix: "/api/auth" });
  app.get("/api/ping", { preHandler: [authenticate] }, async (request) => ({ roles: request.auth!.roles, permissions: request.auth!.permissions }));
  return app;
}
type App = Awaited<ReturnType<typeof makeApp>>;

function applicantToken(app: App, over: Record<string, unknown> = {}, signOpts: Record<string, unknown> = { expiresIn: "1h" }) {
  return app.jwt.sign(
    {
      userId: "u1", membershipId: "m1", institutionId: "inst-A", roles: ["APPLICANT"],
      permissions: ["admissions.view_own"], permissionsVersion: 0, role: "STUDENT", jti: "jti-1", ...over,
    } as never,
    signOpts as never,
  );
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const expOf = (app: App, t: string) => (app.jwt.decode(t) as { exp: number }).exp;

beforeEach(() => {
  vi.clearAllMocks();
  resetAllLimiters();
  membership = { id: "m1", membershipStatus: "ACTIVE", permissionsVersion: 0, departmentScope: null, roles: [role("APPLICANT")] };
  db.user.findUnique.mockImplementation(async () => ({
    id: "u1", email: "a@x.edu", role: "STUDENT", institutionId: "inst-A", accountStatus: "ACTIVE",
    institution: { status: "ACTIVE" }, studentProfile: null, hodProfile: null, guardProfile: null,
  }));
  db.institutionMembership.findUnique.mockImplementation(async () => membership);
  db.session.findFirst.mockResolvedValue({ id: "s1", expiresAt: new Date(Date.now() + 3_600_000) });
  db.session.update.mockResolvedValue({});
});

describe("x-session-stale", () => {
  it("a current token gets no header and keeps its permissions", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/ping", headers: bearer(applicantToken(app)) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-session-stale"]).toBeUndefined();
  });

  it("after a role grant the next request sees fresh roles and permissions, and the stale header", async () => {
    const app = await makeApp();
    const token = applicantToken(app);
    membership = { ...membership, permissionsVersion: 1, roles: [role("APPLICANT"), role("STUDENT")] };
    const res = await app.inject({ method: "GET", url: "/api/ping", headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-session-stale"]).toBe("1");
    expect(res.json().roles).toEqual(["APPLICANT", "STUDENT"]);
    expect(res.json().permissions).toContain("fees.view_own");
  });

  it("is exposed to the browser through CORS", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/ping", headers: { ...bearer(applicantToken(app)), origin: "https://app.x.edu" } });
    expect(res.headers["access-control-expose-headers"]).toContain("x-session-stale");
  });
});

describe("POST /api/auth/refresh", () => {
  it("returns a token with the new claims, the same jti, and an exp that is not later", async () => {
    const app = await makeApp();
    const old = applicantToken(app);
    membership = { ...membership, permissionsVersion: 1, roles: [role("APPLICANT"), role("STUDENT")] };
    db.session.findFirst.mockResolvedValue({ id: "s1", expiresAt: new Date(expOf(app, old) * 1000) });
    const res = await app.inject({ method: "POST", url: "/api/auth/refresh", headers: bearer(old) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const claims = app.jwt.decode(body.token) as any;
    expect(claims).toMatchObject({ userId: "u1", roles: ["APPLICANT", "STUDENT"], permissionsVersion: 1, jti: "jti-1", role: "STUDENT" });
    expect(claims.permissions).toContain("fees.view_own");
    expect(claims.exp).toBeLessThanOrEqual(expOf(app, old));
    expect(body.user).toMatchObject({ id: "u1", email: "a@x.edu", role: "STUDENT" });
    expect(res.headers["x-session-stale"]).toBe("1"); // the old token was stale on this request
  });

  it("the new token is current: no stale header afterwards", async () => {
    const app = await makeApp();
    membership = { ...membership, permissionsVersion: 1, roles: [role("APPLICANT"), role("STUDENT")] };
    const res = await app.inject({ method: "POST", url: "/api/auth/refresh", headers: bearer(applicantToken(app)) });
    const next = await app.inject({ method: "GET", url: "/api/ping", headers: bearer(res.json().token) });
    expect(next.headers["x-session-stale"]).toBeUndefined();
  });

  it("never extends a session: a token that expires sooner than the Session row keeps the Session row's limit", async () => {
    const app = await makeApp();
    const sessionEnd = Date.now() + 600_000;
    db.session.findFirst.mockResolvedValue({ id: "s1", expiresAt: new Date(sessionEnd) });
    const res = await app.inject({ method: "POST", url: "/api/auth/refresh", headers: bearer(applicantToken(app)) });
    const exp = expOf(app, res.json().token);
    expect(exp * 1000).toBeLessThanOrEqual(sessionEnd + 1000);
  });

  it("a token without a jti uses its own exp", async () => {
    const app = await makeApp();
    const old = applicantToken(app, { jti: undefined });
    const res = await app.inject({ method: "POST", url: "/api/auth/refresh", headers: bearer(old) });
    expect(res.statusCode).toBe(200);
    expect(expOf(app, res.json().token)).toBeLessThanOrEqual(expOf(app, old));
    expect((app.jwt.decode(res.json().token) as any).jti).toBeUndefined();
  });

  it("401 without a token, for a revoked session, and with under one second left", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh" })).statusCode).toBe(401);

    db.session.findFirst.mockResolvedValue(null);
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh", headers: bearer(applicantToken(app)) })).statusCode).toBe(401);

    db.session.findFirst.mockResolvedValue({ id: "s1", expiresAt: new Date(Date.now() + 500) });
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh", headers: bearer(applicantToken(app)) })).statusCode).toBe(401);
  });

  it("Fastify rejects a body-less POST that declares application/json, so the web client sends {}", async () => {
    const app = await makeApp();
    const headers = { ...bearer(applicantToken(app)), "content-type": "application/json" };
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh", headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh", headers, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh", headers: bearer(applicantToken(app)) })).statusCode).toBe(200);
  });

  it("429 after 30 refreshes in a minute", async () => {
    const app = await makeApp();
    const t = applicantToken(app);
    let last = 200;
    for (let i = 0; i < 31; i++) {
      last = (await app.inject({ method: "POST", url: "/api/auth/refresh", headers: bearer(t) })).statusCode;
    }
    expect(last).toBe(429);
  });

  it("a suspended membership cannot refresh", async () => {
    const app = await makeApp();
    membership = { ...membership, membershipStatus: "SUSPENDED" };
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh", headers: bearer(applicantToken(app)) })).statusCode).toBe(403);
  });
});
