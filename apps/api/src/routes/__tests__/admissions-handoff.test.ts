/**
 * Admissions-to-student handoff: route-level contract with an in-memory database
 * (helpers/handoff-fake.ts). Real-DB behaviour (RLS, GRANTs, concurrency) is
 * covered by admissions-handoff.integration.test.ts.
 */
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", async () => {
  const { HandoffDb } = await import("./helpers/handoff-fake.js");
  const fake = new HandoffDb();
  return { privilegedPrisma: fake.owner, prisma: fake.owner, __fake: fake, withTenant: (i: string, fn: any) => fake.withTenant(i, fn), Prisma: {} };
});
// The actor comes from headers; permissions come from the real ROLE_PERMISSIONS templates.
vi.mock("../../middleware/auth.js", () => ({
  authenticate: async (request: any) => {
    const role = String(request.headers["x-role"] ?? "ADMISSION_OFFICER");
    request.user = {
      userId: String(request.headers["x-user"] ?? "officer-1"),
      institutionId: String(request.headers["x-inst"] ?? "inst-A"),
      role: "GUARD",
    };
    request.auth = { roles: [role], membershipId: "mb", permissions: [] };
  },
}));
vi.mock("../../services/authz-engine.js", async () => {
  const { ROLE_PERMISSIONS } = await import("@campusgate/shared");
  return {
    requirePermission: (key: string) => async (request: any, reply: any) => {
      if (!(ROLE_PERMISSIONS[request.auth.roles[0]] ?? []).includes(key)) {
        return reply.status(403).send({ error: "Forbidden" });
      }
      request.auth.permissions = ROLE_PERMISSIONS[request.auth.roles[0]];
    },
    requireModuleActive: () => async () => {},
  };
});
vi.mock("../../services/audit.js", () => ({ recordAuditEvent: vi.fn(async () => {}) }));
vi.mock("../../services/notifications.js", () => ({ notifyUser: vi.fn(async () => {}) }));
vi.mock("../../services/account-invites.js", async (orig) => {
  const real = await orig<typeof import("../../services/account-invites.js")>();
  return { ...real, issueAndSend: vi.fn(), inviteRemaining: vi.fn(async () => 280) };
});

import * as dbModule from "@campusgate/db";
import { admissionsRoutes } from "../admissions.js";
import { recordAuditEvent } from "../../services/audit.js";
import { inviteRemaining, issueAndSend } from "../../services/account-invites.js";
import { InMemoryEmailSender, setEmailSender, UnconfiguredEmailSender } from "../../services/email/index.js";
import type { HandoffDb } from "./helpers/handoff-fake.js";

const f = (dbModule as unknown as { __fake: HandoffDb }).__fake;
const audit = vi.mocked(recordAuditEvent);
const invite = vi.mocked(issueAndSend);
let mail: InMemoryEmailSender;

async function makeApp() {
  const app = Fastify();
  await app.register(admissionsRoutes, { prefix: "/api/admissions" });
  return app;
}
type App = Awaited<ReturnType<typeof makeApp>>;

function call(app: App, method: "GET" | "POST", url: string, opts: { role?: string; inst?: string; payload?: unknown } = {}) {
  return app.inject({
    method,
    url: `/api/admissions${url}`,
    headers: { "x-role": opts.role ?? "ADMISSION_OFFICER", "x-inst": opts.inst ?? "inst-A" },
    payload: (opts.payload ?? (method === "POST" ? {} : undefined)) as never,
  });
}
const enroll = (app: App, id: string, payload: unknown = {}, opts: { role?: string; inst?: string } = {}) =>
  call(app, "POST", `/applications/${id}/enroll`, { ...opts, payload });

const rolesOf = (membershipId: string) => f.t.membershipRole.filter((r) => r.membershipId === membershipId).map((r) => r.roleId).sort();
const auditActions = (result?: string) =>
  audit.mock.calls.map((c) => c[0] as any).filter((e) => !result || e.result === result).map((e) => `${e.action}:${e.result}`);

beforeEach(() => {
  f.reset();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("FRONTEND_URL", "https://app.x.edu");
  mail = new InMemoryEmailSender();
  setEmailSender(mail);
  vi.mocked(inviteRemaining).mockResolvedValue(280);
  invite.mockResolvedValue({ status: "SENT", expiresAt: new Date(), id: "t1" });
});

describe("enroll: handoff", () => {
  it("creates one profile, grants STUDENT, keeps APPLICANT, bumps the version once", async () => {
    const s = f.seedAccepted();
    const app = await makeApp();
    const res = await enroll(app, s.application.id);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ created: true, roleGranted: true, enrollmentNo: "BCA2024001", email: "SENT", accountSetup: "HAS_PASSWORD" });
    expect(f.t.studentProfile).toHaveLength(1);
    expect(f.t.studentProfile[0]).toMatchObject({ userId: s.user.id, status: "ENROLLED", semester: 1, departmentId: s.dept.id, programId: s.program.id, academicSessionId: s.session!.id });
    expect(f.t.studentProfileHistory.map((h) => h.changeType)).toEqual(["CREATED", "ENROLLED"]);
    expect(rolesOf(s.membership.id)).toEqual(["role-applicant", "role-student"]);
    expect(f.t.institutionMembership[0].permissionsVersion).toBe(1);
    expect(f.t.application[0].status).toBe("ENROLLED");
    expect(f.t.enrollment).toHaveLength(1);
    expect(auditActions("SUCCESS")).toEqual(["admissions.application.enrolled:SUCCESS", "admissions.student.access_granted:SUCCESS"]);
  });

  it("replay is 409: no second profile, role row or version bump", async () => {
    const s = f.seedAccepted();
    const app = await makeApp();
    expect((await enroll(app, s.application.id)).statusCode).toBe(201);
    const again = await enroll(app, s.application.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("Application already enrolled");
    expect(f.t.studentProfile).toHaveLength(1);
    expect(rolesOf(s.membership.id)).toHaveLength(2);
    expect(f.t.institutionMembership[0].permissionsVersion).toBe(1);
  });

  it("cross-tenant enroll is 404 and writes nothing", async () => {
    const s = f.seedAccepted("inst-A");
    const app = await makeApp();
    const res = await enroll(app, s.application.id, {}, { inst: "inst-B" });
    expect(res.statusCode).toBe(404);
    expect(f.t.studentProfile).toHaveLength(0);
    expect(rolesOf(s.membership.id)).toEqual(["role-applicant"]);
    expect(f.t.institutionMembership[0].permissionsVersion).toBe(0);
  });

  it("requires admissions.enroll on all three routes", async () => {
    const s = f.seedAccepted();
    const app = await makeApp();
    expect((await enroll(app, s.application.id, {}, { role: "LIBRARIAN" })).statusCode).toBe(403);
    expect((await call(app, "GET", `/applications/${s.application.id}/enroll-preview`, { role: "LIBRARIAN" })).statusCode).toBe(403);
    expect((await call(app, "POST", `/applications/${s.application.id}/grant-student-access`, { role: "APPLICANT" })).statusCode).toBe(403);
    expect(f.t.studentProfile).toHaveLength(0);
  });

  it("rejects role, userId and roleKey in the body", async () => {
    const s = f.seedAccepted();
    const app = await makeApp();
    for (const extra of [{ role: "ADMIN" }, { userId: "u9" }, { roleKey: "ADMIN" }]) {
      const res = await enroll(app, s.application.id, extra);
      expect(res.statusCode).toBe(400);
    }
    expect((await call(app, "POST", `/applications/${s.application.id}/grant-student-access`, { payload: { roleKey: "ADMIN" } })).statusCode).toBe(400);
    expect(f.t.studentProfile).toHaveLength(0);
  });

  it("only ever grants the STUDENT role, in the token institution", async () => {
    const s = f.seedAccepted();
    const app = await makeApp();
    await enroll(app, s.application.id);
    const added = f.t.membershipRole.find((r) => r.roleId === "role-student")!;
    expect(added).toMatchObject({ membershipId: s.membership.id, institutionId: "inst-A" });
    expect(f.t.membershipRole).toHaveLength(2);
  });
});

describe("enroll: applicant guards", () => {
  it.each([
    ["inactive account", (s: any) => Object.assign(s.user, { accountStatus: "SUSPENDED" }), "applicant account status SUSPENDED"],
    ["non-STUDENT legacy role", (s: any) => Object.assign(s.user, { role: "HOD" }), "applicant legacy role HOD"],
    ["suspended membership", (s: any) => Object.assign(s.membership, { membershipStatus: "SUSPENDED" }), "applicant membership suspended"],
  ])("%s gives the single generic 409, a specific audit reason and no writes", async (_n, mutate, reason) => {
    const s = f.seedAccepted();
    mutate(s);
    const app = await makeApp();
    const res = await enroll(app, s.application.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Applicant account cannot be enrolled as a student");
    expect(f.t.studentProfile).toHaveLength(0);
    expect(rolesOf(s.membership.id)).toEqual(["role-applicant"]);
    const denied = audit.mock.calls.map((c) => c[0] as any).find((e) => e.result === "DENIED");
    expect(denied.metadata.reason).toBe(reason);
    expect(JSON.stringify(res.json())).not.toContain(reason);
  });

  it.each(["SUSPENDED", "WITHDRAWN", "GRADUATED"])("existing %s profile is refused with no writes and the real status in the audit", async (status) => {
    const s = f.seedAccepted();
    f.add("studentProfile", { institutionId: "inst-A", userId: s.user.id, enrollmentNo: "OLD1", status });
    const app = await makeApp();
    const res = await enroll(app, s.application.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Existing student record is not in a state that allows enrollment");
    expect(rolesOf(s.membership.id)).toEqual(["role-applicant"]);
    expect(f.t.enrollment).toHaveLength(0);
    expect(f.t.institutionMembership[0].permissionsVersion).toBe(0);
    const denied = audit.mock.calls.map((c) => c[0] as any).find((e) => e.result === "DENIED");
    expect(denied.metadata.profileStatus).toBe(status);
  });

  it.each(["ACTIVE", "ON_LEAVE", "ENROLLED"])("existing %s profile is linked, role granted, status left alone", async (status) => {
    const s = f.seedAccepted();
    f.add("studentProfile", { institutionId: "inst-A", userId: s.user.id, enrollmentNo: "OLD1", status, programId: s.program.id, academicSessionId: s.session!.id });
    const app = await makeApp();
    const res = await enroll(app, s.application.id);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ created: false, enrollmentNo: "OLD1", roleGranted: true });
    expect(f.t.studentProfile).toHaveLength(1);
    expect(f.t.studentProfile[0].status).toBe(status);
    expect(rolesOf(s.membership.id)).toContain("role-student");
  });

  it("an APPLICANT-status profile is flipped to ENROLLED with a history row", async () => {
    const s = f.seedAccepted();
    f.add("studentProfile", { institutionId: "inst-A", userId: s.user.id, enrollmentNo: "OLD1", status: "APPLICANT", programId: s.program.id, academicSessionId: s.session!.id });
    const app = await makeApp();
    expect((await enroll(app, s.application.id)).statusCode).toBe(201);
    expect(f.t.studentProfile[0].status).toBe("ENROLLED");
    expect(f.t.studentProfileHistory.map((h) => h.changeType)).toEqual(["ENROLLED"]);
  });

  it("LINK: a supplied number that differs from the existing record is 409; blank is ignored", async () => {
    const s = f.seedAccepted();
    f.add("studentProfile", { institutionId: "inst-A", userId: s.user.id, enrollmentNo: "OLD1", status: "ACTIVE", programId: s.program.id, academicSessionId: s.session!.id });
    const app = await makeApp();
    const bad = await enroll(app, s.application.id, { enrollmentNo: "NEW9" });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error).toContain("OLD1");
    expect(f.t.enrollment).toHaveLength(0);
    const ok = await enroll(app, s.application.id, { enrollmentNo: "   " });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().enrollmentNo).toBe("OLD1");
  });
});

describe("enroll: enrollment number", () => {
  it("accepts an officer-entered number (trimmed) and stores exactly it", async () => {
    const s = f.seedAccepted();
    const app = await makeApp();
    const res = await enroll(app, s.application.id, { enrollmentNo: "  CUSTOM-7  " });
    expect(res.statusCode).toBe(201);
    expect(f.t.studentProfile[0].enrollmentNo).toBe("CUSTOM-7");
    expect(f.rawCalls).toHaveLength(0); // no advisory lock when nothing is generated
  });

  it("generates under a prefix advisory lock and continues after the highest existing number", async () => {
    const s = f.seedAccepted();
    f.add("studentProfile", { institutionId: "inst-A", userId: "x1", enrollmentNo: "BCA2024007", status: "ACTIVE" });
    const app = await makeApp();
    const res = await enroll(app, s.application.id, {});
    expect(res.json().enrollmentNo).toBe("BCA2024008");
    expect(f.rawCalls).toHaveLength(1);
    expect(JSON.stringify(f.rawCalls[0])).toContain("enrollno:BCA2024");
  });

  it("skips numbers held by another institution and never names it", async () => {
    const s = f.seedAccepted("inst-A");
    for (let i = 1; i <= 60; i++) {
      f.add("studentProfile", { institutionId: "inst-B", userId: `b${i}`, enrollmentNo: `BCA2024${String(i).padStart(3, "0")}`, status: "ACTIVE" });
    }
    const app = await makeApp();
    const res = await enroll(app, s.application.id);
    expect(res.json().enrollmentNo).toBe("BCA2024061");
  });

  it("two sequential enrolls with the same prefix get distinct numbers", async () => {
    const a = f.seedAccepted();
    const b = f.seedAccepted();
    const app = await makeApp();
    const [r1, r2] = [await enroll(app, a.application.id), await enroll(app, b.application.id)];
    expect([r1.json().enrollmentNo, r2.json().enrollmentNo]).toEqual(["BCA2024001", "BCA2024002"]);
  });

  it("falls back to the current Asia/Kolkata year when the intake session is unknown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-31T19:00:00Z")); // 00:30 on 1 Jan 2027 in Kolkata
    try {
      const s = f.seedAccepted("inst-A", { sessionStart: null });
      const app = await makeApp();
      const res = await enroll(app, s.application.id, { academicSessionId: f.add("academicSession", { institutionId: "inst-A", name: "Pick", startDate: null }).id });
      expect(res.statusCode).toBe(201);
      expect(res.json().enrollmentNo).toBe("BCA2027001");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an officer-entered number held by ANOTHER institution is the generic 409 and rolls everything back", async () => {
    const s = f.seedAccepted("inst-A");
    f.add("studentProfile", { institutionId: "inst-B", userId: "b1", enrollmentNo: "TAKEN1", status: "ACTIVE" });
    const app = await makeApp();
    const res = await enroll(app, s.application.id, { enrollmentNo: "TAKEN1" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "Enrollment number already registered" });
    expect(f.t.studentProfile).toHaveLength(1);
    expect(rolesOf(s.membership.id)).toEqual(["role-applicant"]);
    expect(auditActions("DENIED")).toEqual(["admissions.application.enrolled:DENIED"]);
  });

  it("a number held by another person in the SAME institution is the cross-person 409", async () => {
    const s = f.seedAccepted("inst-A");
    const other = f.add("user", { institutionId: "inst-A", email: "other@demo.edu", role: "STUDENT" });
    f.add("studentProfile", { institutionId: "inst-A", userId: other.id, enrollmentNo: "TAKEN1", status: "ACTIVE" });
    const app = await makeApp();
    const res = await enroll(app, s.application.id, { enrollmentNo: "TAKEN1" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Enrollment number already assigned to another student");
  });

  it("a unique violation at commit rolls back profile, role and version; the audit is written afterwards; a failing audit still gives 409", async () => {
    const s = f.seedAccepted();
    f.failNextCreate = { table: "studentProfile", target: ["enrollmentNo"] };
    const app = await makeApp();
    const res = await enroll(app, s.application.id, { enrollmentNo: "RACE1" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Enrollment number already registered");
    expect(f.t.studentProfile).toHaveLength(0);
    expect(rolesOf(s.membership.id)).toEqual(["role-applicant"]);
    expect(f.t.institutionMembership[0].permissionsVersion).toBe(0);
    expect(auditActions("DENIED")).toHaveLength(1);

    f.failNextCreate = { table: "studentProfile", target: ["enrollmentNo"] };
    audit.mockRejectedValueOnce(new Error("audit down"));
    const again = await enroll(app, s.application.id, { enrollmentNo: "RACE1" });
    expect(again.statusCode).toBe(409);
  });

  it("an Enrollment race (unique on applicationId) is 409 and leaves no profile or role", async () => {
    const s = f.seedAccepted();
    f.failNextCreate = { table: "enrollment", target: ["institutionId", "applicationId"] };
    const app = await makeApp();
    const res = await enroll(app, s.application.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Application already enrolled");
    expect(f.t.studentProfile).toHaveLength(0);
    expect(rolesOf(s.membership.id)).toEqual(["role-applicant"]);
    expect(f.t.institutionMembership[0].permissionsVersion).toBe(0);
  });

  it("a missing STUDENT role template is a 500 and rolls the whole enroll back", async () => {
    const s = f.seedAccepted();
    f.t.role = f.t.role.filter((r) => r.key !== "STUDENT");
    const app = await makeApp();
    const res = await enroll(app, s.application.id);
    expect(res.statusCode).toBe(500);
    expect(f.t.studentProfile).toHaveLength(0);
    expect(f.t.enrollment).toHaveLength(0);
  });
});

describe("enroll: email after commit", () => {
  it("passwordless applicant: one activation-bearing enrolled invite via issueAndSend", async () => {
    const s = f.seedAccepted("inst-A", { passwordHash: null });
    const app = await makeApp();
    const res = await enroll(app, s.application.id);
    expect(res.json()).toMatchObject({ email: "SENT", accountSetup: "INVITE_SENT" });
    expect(invite).toHaveBeenCalledTimes(1);
    expect(invite.mock.calls[0][0]).toMatchObject({
      userId: s.user.id,
      purpose: "ACCOUNT_ACTIVATION",
      template: "enrolled",
      institutionName: "Demo College",
      createdByUserId: "officer-1",
    });
    expect(invite.mock.calls[0][0].budgetCeiling).toBeGreaterThan(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("applicant with a password: one plain sign-in email, institution in the subject, no token", async () => {
    const s = f.seedAccepted();
    const app = await makeApp();
    const res = await enroll(app, s.application.id);
    expect(res.json()).toMatchObject({ email: "SENT", accountSetup: "HAS_PASSWORD" });
    expect(invite).not.toHaveBeenCalled();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).toBe("You're enrolled - Demo College");
    expect(mail.sent[0].text).toContain("https://app.x.edu/login");
    expect(mail.sent[0].text).not.toContain("token");
  });

  it("email not configured: 201, SKIPPED_NOT_CONFIGURED, nothing sent or issued", async () => {
    setEmailSender(new UnconfiguredEmailSender("BREVO_API_KEY is not set"));
    const s = f.seedAccepted("inst-A", { passwordHash: null });
    const app = await makeApp();
    const res = await enroll(app, s.application.id);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: "SKIPPED_NOT_CONFIGURED", accountSetup: "INVITE_NOT_SENT" });
    expect(invite).not.toHaveBeenCalled();
    expect(f.t.studentProfile).toHaveLength(1);
  });

  it("provider failure after commit still gives 201 with FAILED", async () => {
    invite.mockResolvedValue({ status: "FAILED", reason: "PROVIDER_UNAVAILABLE" });
    const s = f.seedAccepted("inst-A", { passwordHash: null });
    const app = await makeApp();
    const res = await enroll(app, s.application.id);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: "FAILED", accountSetup: "INVITE_NOT_SENT" });
    expect(f.t.studentProfile).toHaveLength(1);
  });

  it("an unexpected error in the email stage is swallowed (201, FAILED)", async () => {
    invite.mockRejectedValue(new Error("boom"));
    const s = f.seedAccepted("inst-A", { passwordHash: null });
    const app = await makeApp();
    const res = await enroll(app, s.application.id);
    expect(res.statusCode).toBe(201);
    expect(res.json().email).toBe("FAILED");
  });

  it.each([["THROTTLED"], ["BUDGET"], ["PROVIDER_LIMIT"]])("invite result %s maps to SKIPPED_BUDGET", async (status) => {
    invite.mockResolvedValue({ status } as never);
    const s = f.seedAccepted("inst-A", { passwordHash: null });
    const app = await makeApp();
    expect((await enroll(app, s.application.id)).json()).toMatchObject({ email: "SKIPPED_BUDGET", accountSetup: "INVITE_NOT_SENT" });
  });

  it("plain enrolled email is skipped when fewer than 20 invites remain, sent otherwise", async () => {
    vi.mocked(inviteRemaining).mockResolvedValue(19);
    const a = f.seedAccepted();
    const app = await makeApp();
    expect((await enroll(app, a.application.id)).json().email).toBe("SKIPPED_BUDGET");
    expect(mail.sent).toHaveLength(0);
    vi.mocked(inviteRemaining).mockResolvedValue(20);
    const b = f.seedAccepted();
    expect((await enroll(app, b.application.id)).json().email).toBe("SENT");
    expect(mail.sent).toHaveLength(1);
  });
});

describe("enroll-preview", () => {
  it("returns the plan without writing or auditing", async () => {
    const s = f.seedAccepted("inst-A", { passwordHash: null });
    f.add("studentProfile", { institutionId: "inst-B", userId: "b1", enrollmentNo: "BCA2024001", status: "ACTIVE" });
    const app = await makeApp();
    const res = await call(app, "GET", `/applications/${s.application.id}/enroll-preview`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enrolled: false,
      suggestedEnrollmentNo: "BCA2024002",
      student: { name: "Asha Rao", programName: "BCA", departmentName: "Computer Science", sessionName: "2024-25", semester: 1 },
      willCreateProfile: true,
      existingEnrollmentNo: null,
      hasPassword: false,
      emailConfigured: true,
      grants: ["STUDENT"],
      needsSession: false,
      roleMissing: false,
    });
    expect(f.t.studentProfile).toHaveLength(1);
    expect(f.t.enrollment).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
    expect(f.rawCalls).toHaveLength(0);
  });

  it("an existing profile is linked: no suggestion, the existing number is shown", async () => {
    const s = f.seedAccepted();
    f.add("studentProfile", { institutionId: "inst-A", userId: s.user.id, enrollmentNo: "OLD1", status: "ACTIVE" });
    const app = await makeApp();
    const body = (await call(app, "GET", `/applications/${s.application.id}/enroll-preview`)).json();
    expect(body).toMatchObject({ willCreateProfile: false, suggestedEnrollmentNo: null, existingEnrollmentNo: "OLD1" });
  });

  it("a campaign without an intake session reports needsSession instead of failing", async () => {
    const s = f.seedAccepted("inst-A", { sessionStart: null });
    const app = await makeApp();
    const res = await call(app, "GET", `/applications/${s.application.id}/enroll-preview`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ needsSession: true, student: { sessionName: null } });
  });

  it("404 for a missing or cross-tenant id", async () => {
    const s = f.seedAccepted("inst-A");
    const app = await makeApp();
    expect((await call(app, "GET", "/applications/nope/enroll-preview")).statusCode).toBe(404);
    expect((await call(app, "GET", `/applications/${s.application.id}/enroll-preview`, { inst: "inst-B" })).statusCode).toBe(404);
  });

  it.each([
    ["not ACCEPTED", (s: any) => Object.assign(s.application, { status: "SUBMITTED" }), 409, "application is not in ACCEPTED state"],
    ["no accepted offer", (s: any) => Object.assign(s.offer, { status: "ISSUED" }), 409, "no accepted offer for this application"],
    ["no program", (s: any) => Object.assign(s.offer, { offeredProgramId: "gone" }), 422, "offered program no longer exists"],
    ["ineligible applicant", (s: any) => Object.assign(s.user, { role: "ADMIN" }), 409, "Applicant account cannot be enrolled as a student"],
  ])("%s: same status and message as enroll, no audit", async (_n, mutate, status, message) => {
    const s = f.seedAccepted();
    mutate(s);
    const app = await makeApp();
    const pre = await call(app, "GET", `/applications/${s.application.id}/enroll-preview`);
    expect(pre.statusCode).toBe(status);
    expect(pre.json().error).toBe(message);
    expect(audit).not.toHaveBeenCalled();
    const real = await enroll(app, s.application.id);
    expect(real.statusCode).toBe(status);
    expect(real.json().error).toBe(message);
  });

  it("an ENROLLED application reports roleMissing from the membership", async () => {
    const s = f.seedAccepted();
    const app = await makeApp();
    await enroll(app, s.application.id);
    const ok = await call(app, "GET", `/applications/${s.application.id}/enroll-preview`);
    expect(ok.json()).toMatchObject({ enrolled: true, roleMissing: false });
    f.t.membershipRole = f.t.membershipRole.filter((r) => r.roleId !== "role-student");
    const missing = await call(app, "GET", `/applications/${s.application.id}/enroll-preview`);
    expect(missing.json()).toMatchObject({ enrolled: true, roleMissing: true, studentProfileId: f.t.studentProfile[0].id });
  });
});

describe("grant-student-access (repair path)", () => {
  async function enrolledWithoutRole() {
    const s = f.seedAccepted();
    const app = await makeApp();
    await enroll(app, s.application.id);
    f.t.membershipRole = f.t.membershipRole.filter((r) => r.roleId !== "role-student");
    f.t.institutionMembership[0].permissionsVersion = 1;
    audit.mockClear();
    mail.sent.length = 0;
    return { s, app };
  }
  const grant = (app: App, id: string, opts: { inst?: string; role?: string } = {}) =>
    call(app, "POST", `/applications/${id}/grant-student-access`, opts);

  it("grants STUDENT once, bumps the version, creates no profile or enrollment and sends no email", async () => {
    const { s, app } = await enrolledWithoutRole();
    const res = await grant(app, s.application.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ repaired: true, roleGranted: true, studentProfileId: f.t.studentProfile[0].id });
    expect(rolesOf(s.membership.id)).toEqual(["role-applicant", "role-student"]);
    expect(f.t.institutionMembership[0].permissionsVersion).toBe(2);
    expect(f.t.studentProfile).toHaveLength(1);
    expect(f.t.enrollment).toHaveLength(1);
    expect(mail.sent).toHaveLength(0);
    expect(invite).toHaveBeenCalledTimes(0);
    const e = audit.mock.calls[0][0] as any;
    expect(e).toMatchObject({ action: "admissions.student.access_granted", metadata: { repaired: true } });
  });

  it("role already present is 409", async () => {
    const s = f.seedAccepted();
    const app = await makeApp();
    await enroll(app, s.application.id);
    const res = await grant(app, s.application.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Student access already granted");
    expect(f.t.institutionMembership[0].permissionsVersion).toBe(1);
  });

  it("refuses a non-ENROLLED application, a mismatched enrollment user, and a cross-tenant id", async () => {
    const accepted = f.seedAccepted();
    const app = await makeApp();
    expect((await grant(app, accepted.application.id)).statusCode).toBe(409);

    const { s } = await enrolledWithoutRole();
    f.t.studentProfile[f.t.studentProfile.length - 1].userId = "someone-else";
    expect((await grant(app, s.application.id)).statusCode).toBe(409);
    expect(rolesOf(s.membership.id)).toEqual(["role-applicant"]);
    expect((await grant(app, s.application.id, { inst: "inst-B" })).statusCode).toBe(404);
  });

  it("refuses an ineligible applicant and writes nothing", async () => {
    const { s, app } = await enrolledWithoutRole();
    s.user.role = "HOD";
    const res = await grant(app, s.application.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Applicant account cannot be enrolled as a student");
    expect(rolesOf(s.membership.id)).toEqual(["role-applicant"]);
  });

  it.each(["SUSPENDED", "WITHDRAWN", "GRADUATED"])("refuses a %s profile with a DENIED audit carrying the status", async (status) => {
    const { s, app } = await enrolledWithoutRole();
    f.t.studentProfile[0].status = status;
    const res = await grant(app, s.application.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Existing student record is not in a state that allows enrollment");
    expect(rolesOf(s.membership.id)).toEqual(["role-applicant"]);
    expect((audit.mock.calls[0][0] as any).metadata.profileStatus).toBe(status);
  });
});
