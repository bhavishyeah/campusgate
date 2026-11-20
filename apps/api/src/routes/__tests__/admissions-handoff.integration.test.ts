/**
 * Admissions-to-student handoff, LIVE: real Fastify app, real authenticate, real
 * admissionsRoutes + authRoutes, real withTenant/RLS against the dedicated TEST
 * Supabase project only (helpers/live-test-env.ts refuses the production ref).
 *
 * Proves what the mocked suite cannot: the STUDENT role insert and the
 * permissionsVersion bump succeed under the campass_app role (GRANTs + RLS), the
 * next authenticated request sees the new role, /auth/refresh against a real
 * login, global enrollment-number allocation across two institutions, concurrent
 * enrolls, cross-tenant refusal and a clean rollback when a number collides.
 *
 * Self-contained under the HOF_TEST_ prefix (seeds and tears down through the
 * owner client). Run one live suite at a time.
 */
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDatabaseUrl, pinLiveTestEnv } from "./helpers/live-test-env.js";

pinLiveTestEnv();
process.env.FRONTEND_URL = "https://app.test.example";
const admin = new PrismaClient({ datasources: { db: { url: adminDatabaseUrl } }, log: ["error"] });

const PFX = "HOF_TEST_";
const id = (s: string) => `${PFX}${s}`;
const instA = id("instA");
const instA2 = id("instA2");
const instB = id("instB");
const CODE = "HOFBCA"; // same program code in A and A2 -> one global number sequence
const officerA = id("officerA");
const officerA2 = id("officerA2");
const officerB = id("officerB");
const sessionStart = new Date("2026-07-01T00:00:00.000Z");

async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const transient = ["Can't reach database server", "P1001", "Timed out", "ECONNRESET", "max clients reached", "EMAXCONNSESSION", "tenant or user not found", "Transaction API error", "connection pool"].some((s) => msg.includes(s));
      if (!transient || i === attempts - 1) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw lastErr;
}

let app: FastifyInstance;
let mail: InstanceType<typeof import("../../services/email/index.js").InMemoryEmailSender>;
let emailMod: typeof import("../../services/email/index.js");

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const tokenFor = (userId: string, legacy: string, inst: string) => app.jwt.sign({ userId, role: legacy, institutionId: inst });
const officerToken = (u = officerA, inst = instA) => tokenFor(u, "GUARD", inst);

async function templateRoleId(key: string): Promise<string> {
  const role = await admin.role.findFirst({ where: { key, institutionId: null }, select: { id: true } });
  if (!role) throw new Error(`template role ${key} not found`);
  return role.id;
}

async function teardown(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  const trigger = async (table: string, name: string, fn: () => Promise<unknown>) => {
    await withRetry(() => admin.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${name}"`));
    try {
      await withRetry(fn);
    } finally {
      await withRetry(() => admin.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${name}"`));
    }
  };
  await withRetry(() => admin.enrollment.deleteMany({ where }));
  await withRetry(() => admin.admissionOffer.deleteMany({ where }));
  await withRetry(() => admin.application.deleteMany({ where }));
  await withRetry(() => admin.admissionCampaign.deleteMany({ where }));
  await trigger("student_profile_history", "student_profile_history_no_update_delete", () => admin.studentProfileHistory.deleteMany({ where }));
  await withRetry(() => admin.studentProfile.deleteMany({ where }));
  await trigger("audit_events", "audit_events_no_update_delete", () => admin.auditEvent.deleteMany({ where }));
  await withRetry(() => admin.notification.deleteMany({ where }));
  await withRetry(() => admin.securityEvent.deleteMany({ where }));
  await withRetry(() => admin.accountToken.deleteMany({ where }));
  await withRetry(() => admin.membershipRole.deleteMany({ where }));
  await withRetry(() => admin.institutionMembership.deleteMany({ where }));
  await withRetry(() => admin.institutionModule.deleteMany({ where }));
  await withRetry(() => admin.academicSession.deleteMany({ where }));
  await withRetry(() => admin.program.deleteMany({ where }));
  await withRetry(() => admin.department.deleteMany({ where }));
  await withRetry(() => admin.user.deleteMany({ where }));
  await withRetry(() => admin.institution.deleteMany({ where: { id: { startsWith: PFX } } }));
}

/** Per-test rows only: applicants, applications, offers, profiles, enrollments. Keeps tenants, officers and programs. */
async function clearPerTest(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  await withRetry(() => admin.enrollment.deleteMany({ where }));
  await withRetry(() => admin.admissionOffer.deleteMany({ where }));
  await withRetry(() => admin.application.deleteMany({ where }));
  await withRetry(() => admin.admissionCampaign.deleteMany({ where }));
  await withRetry(() => admin.$executeRawUnsafe(`ALTER TABLE "student_profile_history" DISABLE TRIGGER "student_profile_history_no_update_delete"`));
  try {
    await withRetry(() => admin.studentProfileHistory.deleteMany({ where }));
  } finally {
    await withRetry(() => admin.$executeRawUnsafe(`ALTER TABLE "student_profile_history" ENABLE TRIGGER "student_profile_history_no_update_delete"`));
  }
  await withRetry(() => admin.studentProfile.deleteMany({ where }));
  await withRetry(() => admin.$executeRawUnsafe(`ALTER TABLE "audit_events" DISABLE TRIGGER "audit_events_no_update_delete"`));
  try {
    await withRetry(() => admin.auditEvent.deleteMany({ where }));
  } finally {
    await withRetry(() => admin.$executeRawUnsafe(`ALTER TABLE "audit_events" ENABLE TRIGGER "audit_events_no_update_delete"`));
  }
  await withRetry(() => admin.notification.deleteMany({ where }));
  await withRetry(() => admin.securityEvent.deleteMany({ where }));
  await withRetry(() => admin.accountToken.deleteMany({ where }));
  const applicants = await withRetry(() => admin.user.findMany({ where: { id: { startsWith: id("app_") } }, select: { id: true } }));
  const ids = applicants.map((u) => u.id);
  if (ids.length) {
    await withRetry(() => admin.membershipRole.deleteMany({ where: { membership: { userId: { in: ids } } } }));
    await withRetry(() => admin.institutionMembership.deleteMany({ where: { userId: { in: ids } } }));
    await withRetry(() => admin.user.deleteMany({ where: { id: { in: ids } } }));
  }
}

async function seedTenant(inst: string, officer: string, withProgram: boolean): Promise<void> {
  await withRetry(() => admin.institution.create({ data: { id: inst, name: `${PFX}${inst}`, code: id(`CODE_${inst}`), status: "ACTIVE" } }));
  await withRetry(() => admin.department.create({ data: { id: id(`dept_${inst}`), name: `${PFX}Dept`, code: id(`D_${inst}`), institutionId: inst } }));
  await withRetry(() =>
    admin.institutionModule.create({
      data: { id: id(`imod_${inst}`), institutionId: inst, moduleKey: "admissions", state: "ACTIVE", entitledAt: new Date(), activatedAt: new Date() },
    }),
  );
  await withRetry(() => admin.user.create({ data: { id: officer, email: `${PFX.toLowerCase()}${officer}@x.test`, role: "GUARD", institutionId: inst } }));
  await withRetry(() => admin.institutionMembership.create({ data: { id: id(`mbr_${officer}`), userId: officer, institutionId: inst, membershipStatus: "ACTIVE", permissionsVersion: 0 } }));
  await withRetry(() => admin.membershipRole.create({ data: { id: id(`mrl_${officer}`), membershipId: id(`mbr_${officer}`), roleId: ADMISSION_OFFICER_ROLE, institutionId: inst } }));
  if (withProgram) {
    await withRetry(() =>
      admin.academicSession.create({
        data: { id: id(`sess_${inst}`), institutionId: inst, name: `${PFX}Session`, structureType: "SEMESTER", status: "ACTIVE", startDate: sessionStart, endDate: new Date("2027-06-30T00:00:00.000Z") },
      }),
    );
    await withRetry(() =>
      admin.program.create({ data: { id: id(`prog_${inst}`), institutionId: inst, departmentId: id(`dept_${inst}`), name: `${PFX}BCA`, code: CODE, duration: 6, durationUnit: "TERMS" } }),
    );
  }
}

let ADMISSION_OFFICER_ROLE = "";
let APPLICANT_ROLE = "";
let STUDENT_ROLE = "";
let seq = 0;

/** An ACCEPTED application for a direct-seeded applicant with an APPLICANT membership. */
async function seedAccepted(inst: string, opts: { password?: string | null; legacyRole?: string } = {}) {
  const n = ++seq;
  const userId = id(`app_${n}`);
  const email = `${PFX.toLowerCase()}app_${n}@x.test`;
  const passwordHash = opts.password === undefined ? null : opts.password === null ? null : await bcrypt.hash(opts.password, 4);
  await withRetry(() => admin.user.create({ data: { id: userId, email, passwordHash, role: (opts.legacyRole ?? "STUDENT") as never, institutionId: inst } }));
  const membershipId = id(`mbr_app_${n}`);
  await withRetry(() => admin.institutionMembership.create({ data: { id: membershipId, userId, institutionId: inst, membershipStatus: "ACTIVE", permissionsVersion: 0 } }));
  await withRetry(() => admin.membershipRole.create({ data: { id: id(`mrl_app_${n}`), membershipId, roleId: APPLICANT_ROLE, institutionId: inst } }));
  const campaignId = id(`camp_${n}`);
  await withRetry(() =>
    admin.admissionCampaign.create({
      data: { id: campaignId, institutionId: inst, name: `${PFX}Campaign ${n}`, status: "OPEN", intakeSessionId: id(`sess_${inst}`), targetProgramId: id(`prog_${inst}`), config: { requiredFields: [], requiredDocTypes: [] } },
    }),
  );
  const applicationId = id(`appn_${n}`);
  await withRetry(() =>
    admin.application.create({
      data: { id: applicationId, institutionId: inst, campaignId, applicantUserId: userId, programId: id(`prog_${inst}`), status: "ACCEPTED", applicationNumber: `${PFX}A${n}`, formData: { fullName: "Hof Applicant" } },
    }),
  );
  await withRetry(() =>
    admin.admissionOffer.create({ data: { id: id(`offer_${n}`), institutionId: inst, applicationId, offeredProgramId: id(`prog_${inst}`), status: "ACCEPTED" } }),
  );
  return { userId, email, membershipId, applicationId };
}

const enroll = (applicationId: string, token: string, payload: unknown = {}) =>
  app.inject({ method: "POST", url: `/api/admissions/applications/${applicationId}/enroll`, headers: bearer(token), payload: payload as never });

async function roleKeys(userId: string, inst: string): Promise<string[]> {
  const m = await admin.institutionMembership.findFirst({ where: { userId, institutionId: inst }, select: { roles: { select: { role: { select: { key: true } } } } } });
  return (m?.roles ?? []).map((r) => r.role.key).sort();
}
const versionOf = async (userId: string, inst: string) =>
  (await admin.institutionMembership.findFirst({ where: { userId, institutionId: inst }, select: { permissionsVersion: true } }))!.permissionsVersion;

beforeAll(async () => {
  await teardown();
  emailMod = await import("../../services/email/index.js");
  ADMISSION_OFFICER_ROLE = await templateRoleId("ADMISSION_OFFICER");
  APPLICANT_ROLE = await templateRoleId("APPLICANT");
  STUDENT_ROLE = await templateRoleId("STUDENT");
  await seedTenant(instA, officerA, true);
  await seedTenant(instA2, officerA2, true);
  await seedTenant(instB, officerB, false);
  const { admissionsRoutes } = await import("../admissions.js");
  const { authRoutes } = await import("../auth.js");
  const { authenticate } = await import("../../middleware/auth.js");
  app = Fastify();
  await app.register(jwt, { secret: "admissions-handoff-live-secret", sign: { expiresIn: "24h" } });
  await app.register(admissionsRoutes, { prefix: "/api/admissions" });
  await app.register(authRoutes, { prefix: "/api/auth" });
  app.get("/api/_whoami", { preHandler: [authenticate] }, async (request) => ({ roles: request.auth!.roles, permissions: request.auth!.permissions, version: request.auth!.permissionsVersion }));
  await app.ready();
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  await teardown().catch(() => {});
  const { prisma, privilegedPrisma } = await import("@campusgate/db");
  await prisma.$disconnect();
  await privilegedPrisma.$disconnect();
  await admin.$disconnect();
}, 180_000);

beforeEach(async () => {
  await clearPerTest();
  mail = new emailMod.InMemoryEmailSender();
  emailMod.setEmailSender(mail);
}, 120_000);

describe("admissions handoff (live TEST project)", () => {
  it("enroll under campass_app: one profile, STUDENT added next to APPLICANT, version bumped once, next request sees the role", async () => {
    const a = await seedAccepted(instA, { password: "Passw0rd!x" });
    const stale = app.jwt.sign({ userId: a.userId, role: "STUDENT", institutionId: instA, membershipId: a.membershipId, roles: ["APPLICANT"], permissions: ["admissions.view_own"], permissionsVersion: 0 } as never);
    const before = await app.inject({ method: "GET", url: "/api/_whoami", headers: bearer(stale) });
    expect(before.json().roles).toEqual(["APPLICANT"]);

    const res = await enroll(a.applicationId, officerToken());
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ created: true, roleGranted: true, email: "SENT", accountSetup: "HAS_PASSWORD" });
    expect(res.json().enrollmentNo).toMatch(/^HOFBCA2026\d{3}$/);

    expect(await admin.studentProfile.count({ where: { userId: a.userId } })).toBe(1);
    expect(await roleKeys(a.userId, instA)).toEqual(["APPLICANT", "STUDENT"]);
    expect(await versionOf(a.userId, instA)).toBe(1);
    expect((await admin.application.findUnique({ where: { id: a.applicationId } }))!.status).toBe("ENROLLED");
    expect(await admin.auditEvent.count({ where: { institutionId: instA, action: "admissions.student.access_granted" } })).toBe(1);

    const after = await app.inject({ method: "GET", url: "/api/_whoami", headers: bearer(stale) });
    expect(after.json().roles).toEqual(["APPLICANT", "STUDENT"]);
    expect(after.json().permissions).toContain("fees.view_own");
    expect(after.headers["x-session-stale"]).toBe("1");
    expect(mail.sent).toHaveLength(1);
  }, 180_000);

  it("real login, enroll, then /auth/refresh returns fresh claims with the same jti and no later exp", async () => {
    const a = await seedAccepted(instA, { password: "Passw0rd!x" });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: a.email, password: "Passw0rd!x" } });
    expect(login.statusCode).toBe(200);
    const oldToken = login.json().token as string;
    const oldClaims = app.jwt.decode(oldToken) as any;
    expect(oldClaims.roles).toEqual(["APPLICANT"]);

    expect((await enroll(a.applicationId, officerToken())).statusCode).toBe(201);

    const refreshed = await app.inject({ method: "POST", url: "/api/auth/refresh", headers: bearer(oldToken), payload: {} });
    expect(refreshed.statusCode).toBe(200);
    const next = app.jwt.decode(refreshed.json().token) as any;
    expect(next.roles).toEqual(["APPLICANT", "STUDENT"]);
    expect(next.permissionsVersion).toBe(1);
    expect(next.jti).toBe(oldClaims.jti);
    expect(next.exp).toBeLessThanOrEqual(oldClaims.exp);
    expect(refreshed.json().user.profile).toBeTruthy(); // the new StudentProfile is visible

    const who = await app.inject({ method: "GET", url: "/api/_whoami", headers: bearer(refreshed.json().token) });
    expect(who.statusCode).toBe(200);
    expect(who.headers["x-session-stale"]).toBeUndefined();
  }, 180_000);

  it("replay is 409; grant-student-access repairs a missing STUDENT row exactly once", async () => {
    const a = await seedAccepted(instA, { password: "Passw0rd!x" });
    expect((await enroll(a.applicationId, officerToken())).statusCode).toBe(201);
    expect((await enroll(a.applicationId, officerToken())).statusCode).toBe(409);
    expect(await admin.studentProfile.count({ where: { userId: a.userId } })).toBe(1);
    expect(await roleKeys(a.userId, instA)).toEqual(["APPLICANT", "STUDENT"]);

    const url = `/api/admissions/applications/${a.applicationId}/grant-student-access`;
    expect((await app.inject({ method: "POST", url, headers: bearer(officerToken()), payload: {} })).statusCode).toBe(409);

    await admin.membershipRole.deleteMany({ where: { membershipId: a.membershipId, roleId: STUDENT_ROLE } });
    const preview = await app.inject({ method: "GET", url: `/api/admissions/applications/${a.applicationId}/enroll-preview`, headers: bearer(officerToken()) });
    expect(preview.json()).toMatchObject({ enrolled: true, roleMissing: true });
    const fixed = await app.inject({ method: "POST", url, headers: bearer(officerToken()), payload: {} });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json()).toMatchObject({ repaired: true, roleGranted: true });
    expect(await roleKeys(a.userId, instA)).toEqual(["APPLICANT", "STUDENT"]);
    expect(await versionOf(a.userId, instA)).toBe(2);
    expect(await admin.studentProfile.count({ where: { userId: a.userId } })).toBe(1);
    expect((await app.inject({ method: "POST", url, headers: bearer(officerToken()), payload: {} })).statusCode).toBe(409);
  }, 180_000);

  it("two institutions with the same program code share one global number sequence", async () => {
    const a = await seedAccepted(instA, { password: "Passw0rd!x" });
    const b = await seedAccepted(instA2, { password: "Passw0rd!x" });
    const r1 = await enroll(a.applicationId, officerToken());
    const r2 = await enroll(b.applicationId, officerToken(officerA2, instA2));
    expect([r1.statusCode, r2.statusCode]).toEqual([201, 201]);
    expect(r1.json().enrollmentNo).toBe("HOFBCA2026001");
    expect(r2.json().enrollmentNo).toBe("HOFBCA2026002");
  }, 180_000);

  it("cross-tenant enroll, preview and grant are 404 and change nothing", async () => {
    const a = await seedAccepted(instA, { password: "Passw0rd!x" });
    const other = officerToken(officerB, instB);
    expect((await enroll(a.applicationId, other)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/admissions/applications/${a.applicationId}/enroll-preview`, headers: bearer(other) })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/admissions/applications/${a.applicationId}/grant-student-access`, headers: bearer(other), payload: {} })).statusCode).toBe(404);
    expect(await admin.studentProfile.count({ where: { userId: a.userId } })).toBe(0);
    expect(await roleKeys(a.userId, instA)).toEqual(["APPLICANT"]);
  }, 180_000);

  it("concurrency: two applications with blank numbers get distinct numbers; the same application twice enrolls once", async () => {
    const a = await seedAccepted(instA, { password: "Passw0rd!x" });
    const b = await seedAccepted(instA, { password: "Passw0rd!x" });
    const [r1, r2] = await Promise.all([enroll(a.applicationId, officerToken()), enroll(b.applicationId, officerToken())]);
    expect([r1.statusCode, r2.statusCode]).toEqual([201, 201]);
    expect(new Set([r1.json().enrollmentNo, r2.json().enrollmentNo]).size).toBe(2);

    const c = await seedAccepted(instA, { password: "Passw0rd!x" });
    const dup = await Promise.all([enroll(c.applicationId, officerToken()), enroll(c.applicationId, officerToken())]);
    expect(dup.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await admin.studentProfile.count({ where: { userId: c.userId } })).toBe(1);
    expect(await admin.membershipRole.count({ where: { membershipId: c.membershipId, roleId: STUDENT_ROLE } })).toBe(1);
    expect(await versionOf(c.userId, instA)).toBe(1);
  }, 240_000);

  it("an officer-entered number held by another institution is the generic 409 and rolls everything back", async () => {
    const taken = await seedAccepted(instA2, { password: "Passw0rd!x" });
    expect((await enroll(taken.applicationId, officerToken(officerA2, instA2), { enrollmentNo: "HOFBCA-TAKEN" })).statusCode).toBe(201);
    const a = await seedAccepted(instA, { password: "Passw0rd!x" });
    const res = await enroll(a.applicationId, officerToken(), { enrollmentNo: "HOFBCA-TAKEN" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "Enrollment number already registered" });
    expect(await admin.studentProfile.count({ where: { userId: a.userId } })).toBe(0);
    expect(await roleKeys(a.userId, instA)).toEqual(["APPLICANT"]);
    expect(await versionOf(a.userId, instA)).toBe(0);
    expect(await admin.auditEvent.count({ where: { institutionId: instA, action: "admissions.application.enrolled", result: "DENIED" } })).toBe(1);
  }, 180_000);

  it("a passwordless applicant gets the enrolled activation mail and one token; unconfigured email still enrolls", async () => {
    const a = await seedAccepted(instA, { password: null });
    const res = await enroll(a.applicationId, officerToken());
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: "SENT", accountSetup: "INVITE_SENT" });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).toContain("you're enrolled");
    expect(await admin.accountToken.count({ where: { userId: a.userId, purpose: "ACCOUNT_ACTIVATION" } })).toBe(1);

    emailMod.setEmailSender(new emailMod.UnconfiguredEmailSender("BREVO_API_KEY is not set"));
    const b = await seedAccepted(instA, { password: null });
    const res2 = await enroll(b.applicationId, officerToken());
    expect(res2.statusCode).toBe(201);
    expect(res2.json()).toMatchObject({ email: "SKIPPED_NOT_CONFIGURED", accountSetup: "INVITE_NOT_SENT" });
    expect(await admin.studentProfile.count({ where: { userId: b.userId } })).toBe(1);
  }, 180_000);

  it("a non-STUDENT legacy user is refused (no role escalation through an application)", async () => {
    const a = await seedAccepted(instA, { password: "Passw0rd!x", legacyRole: "HOD" });
    const res = await enroll(a.applicationId, officerToken());
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Applicant account cannot be enrolled as a student");
    expect(await roleKeys(a.userId, instA)).toEqual(["APPLICANT"]);
    expect(await admin.studentProfile.count({ where: { userId: a.userId } })).toBe(0);
  }, 180_000);
});
