/**
 * Admissions applicant/officer reads + draft edit (G4 GET /lookups, G5
 * GET /campaigns/open[/:id] + enriched /applications/mine, G6 PATCH
 * /applications/:id). @campusgate/db is MOCKED (fast, deterministic): this pins
 * the ROUTE-LAYER contract — permission gating per role, the
 * requireModuleActive("admissions") gate, validation, tenant scoping, the
 * applicant-safe projection, and DRAFT-only/ownership enforcement on the edit.
 * Real-DB isolation is proven by the admissions-behavioral live suite.
 */
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tenantCalls: string[] = [];

vi.mock("@campusgate/db", () => {
  const prisma = {
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    institutionMembership: { findUnique: vi.fn() },
    institutionModule: { findUnique: vi.fn() },
    session: { findFirst: vi.fn(), update: vi.fn() },
    admissionCampaign: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    program: { findMany: vi.fn() },
    academicSession: { findMany: vi.fn() },
    application: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    auditEvent: { create: vi.fn() },
  };
  return {
    prisma,
    privilegedPrisma: prisma,
    withTenant: (institutionId: string, fn: (tx: typeof prisma) => unknown) => {
      tenantCalls.push(institutionId);
      return fn(prisma);
    },
    Prisma: {},
  };
});

import { prisma } from "@campusgate/db";
import { ROLE_PERMISSIONS } from "@campusgate/shared";
import { admissionsRoutes } from "../admissions.js";

const m = prisma as unknown as Record<string, any>;

type RoleKey = "ADMIN" | "LIBRARIAN" | "STUDENT" | "ADMISSION_OFFICER" | "APPLICANT";

function membershipFor(roleKey: RoleKey) {
  return {
    id: `mbr-${roleKey}`,
    membershipStatus: "ACTIVE",
    permissionsVersion: 0,
    departmentScope: null,
    roles: [
      {
        role: {
          key: roleKey,
          permissions: (ROLE_PERMISSIONS[roleKey] ?? []).map((k) => ({ permission: { key: k } })),
        },
      },
    ],
  };
}

const USERS: Record<string, { role: RoleKey; legacy: string; inst: string }> = {
  "u-officer": { role: "ADMISSION_OFFICER", legacy: "GUARD", inst: "inst-A" },
  "u-officer-b": { role: "ADMISSION_OFFICER", legacy: "GUARD", inst: "inst-B" },
  "u-admin": { role: "ADMIN", legacy: "ADMIN", inst: "inst-A" },
  "u-applicant": { role: "APPLICANT", legacy: "STUDENT", inst: "inst-A" },
  "u-librarian": { role: "LIBRARIAN", legacy: "GUARD", inst: "inst-A" },
  "u-student": { role: "STUDENT", legacy: "STUDENT", inst: "inst-A" },
};

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "admissions-reads-secret" });
  await app.register(admissionsRoutes, { prefix: "/api/admissions" });
  return app;
}

function call(
  app: Awaited<ReturnType<typeof makeApp>>,
  userId: string,
  method: "GET" | "PATCH",
  url: string,
  payload?: unknown,
) {
  const u = USERS[userId];
  const token = app.jwt.sign({ userId, role: u.legacy, institutionId: u.inst });
  return app.inject({
    method,
    url: `/api/admissions${url}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

const ENV_ROW = {
  id: "c1",
  name: "BCA 2026",
  openAt: new Date("2026-01-01T00:00:00Z"),
  closeAt: null,
  config: { requiredFields: ["name"], requiredDocTypes: ["MARKSHEET"] },
  programs: [{ program: { id: "p2", name: "BSc", code: "BSC" } }, { program: { id: "p1", name: "BCA", code: "BCA" } }],
  targetProgram: { id: "p1", name: "BCA", code: "BCA" },
};

describe("admissions applicant/officer reads + draft edit (G4/G5/G6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantCalls.length = 0;
    m.user.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      const u = USERS[where.id];
      if (!u) return null;
      return {
        id: where.id,
        role: u.legacy,
        institutionId: u.inst,
        accountStatus: "ACTIVE",
        institution: { status: "ACTIVE" },
      };
    });
    m.institutionMembership.findUnique.mockImplementation(({ where }: any) => {
      const userId: string | undefined = where?.userId_institutionId?.userId;
      return membershipFor(USERS[userId ?? "u-officer"]?.role ?? "ADMISSION_OFFICER");
    });
    m.institutionModule.findUnique.mockResolvedValue({ state: "ACTIVE" });
    m.auditEvent.create.mockResolvedValue({});
    m.admissionCampaign.count.mockResolvedValue(0);
    m.admissionCampaign.findMany.mockResolvedValue([]);
    m.program.findMany.mockResolvedValue([]);
    m.academicSession.findMany.mockResolvedValue([]);
    m.application.findMany.mockResolvedValue([]);
  });

  it("role sets: officer lacks academics.*; applicant holds only admissions.view_own", () => {
    expect(ROLE_PERMISSIONS.ADMISSION_OFFICER).not.toContain("academics.programs.manage");
    expect(ROLE_PERMISSIONS.ADMISSION_OFFICER).not.toContain("academics.sessions.manage");
    expect(ROLE_PERMISSIONS.APPLICANT).toEqual(["admissions.view_own"]);
  });

  describe("GET /lookups (G4)", () => {
    it("officer gets minimal programs + sessions, tenant-scoped, ACTIVE programs only", async () => {
      m.program.findMany.mockResolvedValue([{ id: "p1", name: "BCA", code: "BCA" }]);
      m.academicSession.findMany.mockResolvedValue([{ id: "s1", name: "2026-27", status: "ACTIVE" }]);
      const app = await makeApp();
      const res = await call(app, "u-officer-b", "GET", "/lookups");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        programs: [{ id: "p1", name: "BCA", code: "BCA" }],
        sessions: [{ id: "s1", name: "2026-27", status: "ACTIVE" }],
      });
      expect(m.program.findMany.mock.calls[0][0].where).toEqual({ institutionId: "inst-B", status: "ACTIVE" });
      expect(m.academicSession.findMany.mock.calls[0][0].where).toEqual({ institutionId: "inst-B" });
      expect(Object.keys(m.program.findMany.mock.calls[0][0].select).sort()).toEqual(["code", "id", "name"]);
      expect(tenantCalls).not.toContain("inst-A");
      await app.close();
    });

    it("ADMIN allowed; APPLICANT, STUDENT, LIBRARIAN denied; module inactive denied", async () => {
      const app = await makeApp();
      expect((await call(app, "u-admin", "GET", "/lookups")).statusCode).toBe(200);
      expect((await call(app, "u-applicant", "GET", "/lookups")).statusCode).toBe(403);
      expect((await call(app, "u-student", "GET", "/lookups")).statusCode).toBe(403);
      expect((await call(app, "u-librarian", "GET", "/lookups")).statusCode).toBe(403);
      m.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });
      expect((await call(app, "u-officer", "GET", "/lookups")).statusCode).toBe(403);
      await app.close();
    });
  });

  describe("campaign reads carry program/session names (G4)", () => {
    it("GET /campaigns and /campaigns/:id include program + session name joins", async () => {
      m.admissionCampaign.findFirst.mockResolvedValue({ id: "c1" });
      const app = await makeApp();
      await call(app, "u-officer", "GET", "/campaigns");
      const inc = m.admissionCampaign.findMany.mock.calls[0][0].include;
      expect(inc.programs.select.program.select).toEqual({ id: true, name: true, code: true });
      expect(inc.intakeSession.select).toEqual({ id: true, name: true });
      expect((await call(app, "u-officer", "GET", "/campaigns/c1")).statusCode).toBe(200);
      expect(m.admissionCampaign.findFirst.mock.calls[0][0].include.targetProgram).toBeDefined();
      await app.close();
    });
  });

  describe("GET /campaigns/open and /open/:id (G5)", () => {
    it("applicant sees only OPEN campaigns, with an applicant-safe projection", async () => {
      m.admissionCampaign.count.mockResolvedValue(1);
      m.admissionCampaign.findMany.mockResolvedValue([ENV_ROW]);
      const app = await makeApp();
      const res = await call(app, "u-applicant", "GET", "/campaigns/open");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(m.admissionCampaign.findMany.mock.calls[0][0].where).toEqual({ institutionId: "inst-A", status: "OPEN" });
      const c = body.campaigns[0];
      expect(Object.keys(c).sort()).toEqual(["closeAt", "config", "id", "name", "openAt", "programs"]);
      // config narrowed to the public shape: unknown/internal keys are dropped.
      expect(c.config).toEqual({ requiredFields: ["name"], requiredDocTypes: ["MARKSHEET"] });
      // programs = targetProgram ∪ join rows, deduped, sorted by name.
      expect(c.programs).toEqual([
        { id: "p1", name: "BCA", code: "BCA" },
        { id: "p2", name: "BSc", code: "BSC" },
      ]);
      expect(body.total).toBe(1);
      await app.close();
    });

    it("detail is 404 for a non-OPEN/foreign campaign and scopes the lookup to OPEN + tenant", async () => {
      m.admissionCampaign.findFirst.mockResolvedValue(null);
      const app = await makeApp();
      const res = await call(app, "u-applicant", "GET", "/campaigns/open/c9");
      expect(res.statusCode).toBe(404);
      expect(m.admissionCampaign.findFirst.mock.calls[0][0].where).toEqual({
        id: "c9",
        institutionId: "inst-A",
        status: "OPEN",
      });
      m.admissionCampaign.findFirst.mockResolvedValue(ENV_ROW);
      const ok = await call(app, "u-applicant", "GET", "/campaigns/open/c1");
      expect(ok.statusCode).toBe(200);
      expect(ok.json().id).toBe("c1");
      await app.close();
    });

    it("is gated by admissions.view_own: officer, student, librarian denied; module inactive denied", async () => {
      const app = await makeApp();
      for (const u of ["u-officer", "u-student", "u-librarian", "u-admin"]) {
        expect((await call(app, u, "GET", "/campaigns/open")).statusCode).toBe(403);
        expect((await call(app, u, "GET", "/campaigns/open/c1")).statusCode).toBe(403);
      }
      m.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });
      expect((await call(app, "u-applicant", "GET", "/campaigns/open")).statusCode).toBe(403);
      await app.close();
    });

    it("the static /campaigns/open does not get captured by the staff /campaigns/:id route", async () => {
      m.admissionCampaign.findMany.mockResolvedValue([]);
      const app = await makeApp();
      const res = await call(app, "u-applicant", "GET", "/campaigns/open");
      expect(res.statusCode).toBe(200);
      expect(m.admissionCampaign.findFirst).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe("GET /applications/mine enrichment (G5)", () => {
    it("includes campaign and program names, scoped to the caller", async () => {
      const app = await makeApp();
      const res = await call(app, "u-applicant", "GET", "/applications/mine");
      expect(res.statusCode).toBe(200);
      const arg = m.application.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({ institutionId: "inst-A", applicantUserId: "u-applicant" });
      expect(arg.include.campaign.select).toEqual({ id: true, name: true });
      expect(arg.include.program.select).toEqual({ id: true, name: true, code: true });
      await app.close();
    });
  });

  describe("PATCH /applications/:id draft edit (G6)", () => {
    it("owner edits a DRAFT: conditional write on DRAFT + ownership, audited, returns the row", async () => {
      m.application.findFirst
        .mockResolvedValueOnce({ id: "a1", status: "DRAFT", campaignId: "c1", applicantUserId: "u-applicant" })
        .mockResolvedValueOnce({ id: "a1", status: "DRAFT", formData: { name: "Asha" } });
      m.application.updateMany.mockResolvedValue({ count: 1 });
      const app = await makeApp();
      const res = await call(app, "u-applicant", "PATCH", "/applications/a1", { formData: { name: "Asha" } });
      expect(res.statusCode).toBe(200);
      expect(res.json().formData).toEqual({ name: "Asha" });
      // ownership lookup is by the token's user, not input.
      expect(m.application.findFirst.mock.calls[0][0].where).toMatchObject({
        id: "a1",
        institutionId: "inst-A",
        applicantUserId: "u-applicant",
      });
      expect(m.application.updateMany.mock.calls[0][0].where).toEqual({
        id: "a1",
        institutionId: "inst-A",
        applicantUserId: "u-applicant",
        status: "DRAFT",
      });
      expect(m.auditEvent.create).toHaveBeenCalled();
      await app.close();
    });

    it("409s (and audits DENIED) when the application is not a DRAFT, without writing", async () => {
      m.application.findFirst.mockResolvedValue({ id: "a1", status: "SUBMITTED", campaignId: "c1", applicantUserId: "u-applicant" });
      const app = await makeApp();
      const res = await call(app, "u-applicant", "PATCH", "/applications/a1", { formData: { name: "X" } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/DRAFT/);
      expect(m.application.updateMany).not.toHaveBeenCalled();
      await app.close();
    });

    it("409s when a concurrent submit makes the conditional write match zero rows", async () => {
      m.application.findFirst.mockResolvedValue({ id: "a1", status: "DRAFT", campaignId: "c1", applicantUserId: "u-applicant" });
      m.application.updateMany.mockResolvedValue({ count: 0 });
      const app = await makeApp();
      const res = await call(app, "u-applicant", "PATCH", "/applications/a1", { formData: { name: "X" } });
      expect(res.statusCode).toBe(409);
      await app.close();
    });

    it("404s for an application the caller does not own (privacy collapse)", async () => {
      m.application.findFirst.mockResolvedValue(null);
      const app = await makeApp();
      const res = await call(app, "u-applicant", "PATCH", "/applications/other", { formData: { name: "X" } });
      expect(res.statusCode).toBe(404);
      expect(m.application.updateMany).not.toHaveBeenCalled();
      await app.close();
    });

    it("400s on a bad body (missing formData / unknown keys); no DB access", async () => {
      const app = await makeApp();
      expect((await call(app, "u-applicant", "PATCH", "/applications/a1", {})).statusCode).toBe(400);
      expect(
        (await call(app, "u-applicant", "PATCH", "/applications/a1", { formData: {}, status: "ACCEPTED" })).statusCode,
      ).toBe(400);
      expect(m.application.findFirst).not.toHaveBeenCalled();
      await app.close();
    });

    it("officer/admin/student/librarian are 403 (view_own only); module inactive is 403", async () => {
      const app = await makeApp();
      for (const u of ["u-officer", "u-admin", "u-student", "u-librarian"]) {
        expect((await call(app, u, "PATCH", "/applications/a1", { formData: {} })).statusCode).toBe(403);
      }
      m.institutionModule.findUnique.mockResolvedValue({ state: "SUSPENDED" });
      expect((await call(app, "u-applicant", "PATCH", "/applications/a1", { formData: {} })).statusCode).toBe(403);
      expect(m.application.updateMany).not.toHaveBeenCalled();
      await app.close();
    });
  });
});
