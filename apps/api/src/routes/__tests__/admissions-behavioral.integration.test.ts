/**
 * Phase-6 admissions BEHAVIORAL integration suite (design §11) — runs against the
 * REAL Supabase instance through a REAL Fastify app (real `authenticate` + the
 * real admissionsRoutes + the real withTenant/RLS path). It proves the guarantees
 * the mocked route suites cannot: the PUBLIC applicant-onboarding contract, the
 * officer-on-behalf resolve-or-create, the full campaign→apply→documents→review→
 * offer→accept→enroll journey, the enroll CREATE and (HEADLINE) LINK paths with
 * no-duplicate-identity, the state-machine guards, the append-only review trail,
 * applicant ownership isolation, module gating, and the admissions.* audit trail —
 * all persisted under RLS.
 *
 * SELF-CONTAINED under a DISTINCT prefix (ADM_TEST_); seeds + tears down its own
 * institutions/users/campaigns via adminClient. Requires live Supabase +
 * campass_app creds.
 *
 * Both DATABASE_URL (campass_app, RLS-subject) and the privileged owner URL are
 * pinned in process.env BEFORE @campusgate/db loads: the real `authenticate`
 * middleware reads users/memberships on privilegedPrisma (no tenant GUC yet), so
 * that client MUST be the owner/postgres role, not campass_app.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../..");

function parseEnv(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const apiEnv = parseEnv(path.join(repoRoot, "apps", "api", ".env"));
const dbEnv = parseEnv(path.join(repoRoot, "packages", "db", ".env"));

const appDatabaseUrl = apiEnv.DATABASE_URL; // campass_app (RLS-subject)
const adminDatabaseUrl = dbEnv.DIRECT_URL ?? dbEnv.DATABASE_URL; // postgres (owner)
if (!appDatabaseUrl) throw new Error("apps/api/.env DATABASE_URL not found");
if (!adminDatabaseUrl) throw new Error("packages/db/.env DIRECT_URL not found");

process.env.DATABASE_URL = appDatabaseUrl;
process.env.PRIVILEGED_DATABASE_URL = adminDatabaseUrl;
process.env.DIRECT_URL = adminDatabaseUrl;

const adminClient = new PrismaClient({ datasources: { db: { url: adminDatabaseUrl } }, log: ["error"] });

const PFX = "ADM_TEST_";
const id = (s: string) => `${PFX}${s}`;

async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const transient =
        msg.includes("Can't reach database server") ||
        msg.includes("P1001") ||
        msg.includes("Timed out") ||
        msg.includes("ECONNRESET") ||
        msg.includes("max clients reached") ||
        msg.includes("EMAXCONNSESSION") ||
        msg.includes("tenant or user not found") ||
        msg.includes("Transaction API error") ||
        msg.includes("connection pool");
      if (!transient || i === attempts - 1) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw lastErr;
}

// Tenant A (primary) + tenant B (isolation foil).
const instA = id("instA");
const instB = id("instB");
const deptA = id("deptA");
const deptB = id("deptB");
const officerUser = id("u_officer"); // ADMISSION_OFFICER in A
const adminUser = id("u_admin"); // ADMIN in A (enroll permission lives on staff set)
const sessionA = id("sessA");
const programA = id("progA");
const programA2 = id("progA2"); // a second program (not offered by the campaign)
const officerUserB = id("u_officerB"); // ADMISSION_OFFICER in B

let app: FastifyInstance;
let admissionsRoutes: typeof import("../admissions.js").admissionsRoutes;

function tokenFor(userId: string, legacyRole: string, institutionId: string): string {
  return app.jwt.sign({ userId, role: legacyRole, institutionId });
}
const authHeader = (t: string) => ({ authorization: `Bearer ${t}` });
const officerToken = () => tokenFor(officerUser, "GUARD", instA);
const adminToken = () => tokenFor(adminUser, "ADMIN", instA);
const officerTokenB = () => tokenFor(officerUserB, "GUARD", instB);

async function templateRoleId(key: string): Promise<string> {
  const role = await adminClient.role.findFirst({ where: { key, institutionId: null }, select: { id: true } });
  if (!role) throw new Error(`template role ${key} not found — run the seed/migrations first`);
  return role.id;
}

async function ensureMembership(userId: string, institutionId: string, roleKey: string): Promise<void> {
  const mId = id(`mbr_${userId}`);
  const roleId = await templateRoleId(roleKey);
  await withRetry(() =>
    adminClient.institutionMembership.create({
      data: { id: mId, userId, institutionId, membershipStatus: "ACTIVE", permissionsVersion: 0 },
    }),
  );
  await withRetry(() =>
    adminClient.membershipRole.create({
      data: { id: id(`mrl_${userId}`), membershipId: mId, roleId, institutionId },
    }),
  );
}

async function setAdmissionsState(institutionId: string, state: "ACTIVE" | "SUSPENDED" | "ENTITLED"): Promise<void> {
  await withRetry(() =>
    adminClient.institutionModule.update({
      where: { institutionId_moduleKey: { institutionId, moduleKey: "admissions" } },
      data: { state, activatedAt: state === "ACTIVE" ? new Date() : null },
    }),
  );
}

// ─── admissions-row teardown (child-first) between tests for isolation ─────────
async function clearAdmissions(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  // application_reviews is append-only — its BEFORE UPDATE OR DELETE trigger
  // blocks even adminClient, so delete it within a scoped trigger-disable.
  await withRetry(() =>
    adminClient.$executeRawUnsafe(
      `ALTER TABLE "application_reviews" DISABLE TRIGGER "application_reviews_no_update_delete"`,
    ),
  );
  try {
    await withRetry(() => adminClient.applicationReview.deleteMany({ where }));
  } finally {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(
        `ALTER TABLE "application_reviews" ENABLE TRIGGER "application_reviews_no_update_delete"`,
      ),
    );
  }
  await withRetry(() => adminClient.enrollment.deleteMany({ where }));
  await withRetry(() => adminClient.admissionOffer.deleteMany({ where }));
  await withRetry(() => adminClient.applicationDocument.deleteMany({ where }));
  await withRetry(() => adminClient.application.deleteMany({ where }));
  await withRetry(() => adminClient.admissionCampaignProgram.deleteMany({ where }));
  await withRetry(() => adminClient.admissionCampaign.deleteMany({ where }));
  // Student profiles (+ their history, append-only) created by the enroll path,
  // plus the per-test applicant users. Keep the long-lived officer/admin users.
  await withRetry(() =>
    adminClient.$executeRawUnsafe(
      `ALTER TABLE "student_profile_history" DISABLE TRIGGER "student_profile_history_no_update_delete"`,
    ),
  );
  try {
    await withRetry(() => adminClient.studentProfileHistory.deleteMany({ where }));
  } finally {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(
        `ALTER TABLE "student_profile_history" ENABLE TRIGGER "student_profile_history_no_update_delete"`,
      ),
    );
  }
  await withRetry(() => adminClient.studentProfile.deleteMany({ where }));
  // Audit events + notifications reference users via FK (actorUserId / userId),
  // so they MUST be cleared BEFORE deleting the applicant users below.
  await deleteAuditEvents();
  await withRetry(() => adminClient.notification.deleteMany({ where }));
  // Per-test applicant users are created by the routes (cuid ids) keyed on an
  // applicant-marked email, OR direct-seeded with an applicant-marked id. Resolve
  // them by email/id, then delete their membership-roles + memberships + the
  // users (the long-lived officer/admin users are NOT applicant-prefixed).
  const applicantUsers = await withRetry(() =>
    adminClient.user.findMany({
      where: {
        institutionId: { startsWith: PFX },
        OR: [
          { email: { startsWith: `${PFX.toLowerCase()}applicant` } },
          { id: { startsWith: `${PFX}applicant_` } },
        ],
      },
      select: { id: true },
    }),
  );
  const applicantIds = applicantUsers.map((u) => u.id);
  if (applicantIds.length > 0) {
    await withRetry(() =>
      adminClient.membershipRole.deleteMany({
        where: { membership: { userId: { in: applicantIds } } },
      }),
    );
    await withRetry(() =>
      adminClient.institutionMembership.deleteMany({ where: { userId: { in: applicantIds } } }),
    );
    await withRetry(() => adminClient.user.deleteMany({ where: { id: { in: applicantIds } } }));
  }
}

async function deleteAuditEvents(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  await withRetry(() =>
    adminClient.$executeRawUnsafe(`ALTER TABLE "audit_events" DISABLE TRIGGER "audit_events_no_update_delete"`),
  );
  try {
    await withRetry(() => adminClient.auditEvent.deleteMany({ where }));
  } finally {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(`ALTER TABLE "audit_events" ENABLE TRIGGER "audit_events_no_update_delete"`),
    );
  }
}

async function teardown(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  await clearAdmissions();
  await withRetry(() => adminClient.membershipRole.deleteMany({ where }));
  await withRetry(() => adminClient.institutionMembership.deleteMany({ where }));
  await withRetry(() => adminClient.institutionModule.deleteMany({ where }));
  await withRetry(() => adminClient.academicSession.deleteMany({ where }));
  await withRetry(() => adminClient.program.deleteMany({ where }));
  await withRetry(() => adminClient.department.deleteMany({ where }));
  await withRetry(() => adminClient.user.deleteMany({ where }));
  await withRetry(() => adminClient.institution.deleteMany({ where: { id: { startsWith: PFX } } }));
}

async function seedTenant(institutionId: string, deptId: string): Promise<void> {
  await withRetry(() =>
    adminClient.institution.create({ data: { id: institutionId, name: `${PFX}${institutionId}`, code: id(`CODE_${institutionId}`), status: "ACTIVE" } }),
  );
  await withRetry(() =>
    adminClient.department.create({ data: { id: deptId, name: `${PFX}Dept`, code: id(`D_${institutionId}`), institutionId } }),
  );
  await withRetry(() =>
    adminClient.institutionModule.create({
      data: { id: id(`imod_${institutionId}`), institutionId, moduleKey: "admissions", state: "ACTIVE", entitledAt: new Date(), activatedAt: new Date() },
    }),
  );
}

async function seed(): Promise<void> {
  await seedTenant(instA, deptA);
  await seedTenant(instB, deptB);

  await withRetry(() =>
    adminClient.user.createMany({
      data: [
        // ADMISSION_OFFICER legacy role = GUARD (inert; capability from membership).
        { id: officerUser, email: `${PFX.toLowerCase()}officer@a.test`, role: "GUARD", institutionId: instA },
        { id: adminUser, email: `${PFX.toLowerCase()}admin@a.test`, role: "ADMIN", institutionId: instA },
        { id: officerUserB, email: `${PFX.toLowerCase()}officer@b.test`, role: "GUARD", institutionId: instB },
      ],
    }),
  );
  await ensureMembership(officerUser, instA, "ADMISSION_OFFICER");
  await ensureMembership(adminUser, instA, "ADMIN");
  await ensureMembership(officerUserB, instB, "ADMISSION_OFFICER");

  await withRetry(() =>
    adminClient.academicSession.create({
      data: {
        id: sessionA,
        institutionId: instA,
        name: `${PFX}Session`,
        structureType: "SEMESTER",
        status: "ACTIVE",
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        endDate: new Date("2027-06-30T00:00:00.000Z"),
      },
    }),
  );
  await withRetry(() =>
    adminClient.program.create({
      data: { id: programA, institutionId: instA, departmentId: deptA, name: `${PFX}BCA`, code: id("BCA"), duration: 6, durationUnit: "TERMS" },
    }),
  );
  await withRetry(() =>
    adminClient.program.create({
      data: { id: programA2, institutionId: instA, departmentId: deptA, name: `${PFX}BBA`, code: id("BBA"), duration: 6, durationUnit: "TERMS" },
    }),
  );
}

// ── scenario helper: create an OPEN campaign (optionally with an intake session
// and a config), returning its id. Direct-seeded so each test controls the shape.
async function seedCampaign(
  suffix: string,
  opts: {
    status?: "DRAFT" | "OPEN" | "CLOSED";
    intakeSessionId?: string | null;
    config?: Record<string, unknown>;
    targetProgramId?: string;
  } = {},
): Promise<string> {
  const cId = id(`camp_${suffix}`);
  await withRetry(() =>
    adminClient.admissionCampaign.create({
      data: {
        id: cId,
        institutionId: instA,
        name: `${PFX}Campaign ${suffix}`,
        status: opts.status ?? "OPEN",
        intakeSessionId: opts.intakeSessionId === undefined ? sessionA : opts.intakeSessionId,
        targetProgramId: opts.targetProgramId ?? programA,
        config: opts.config ?? { requiredFields: [], requiredDocTypes: [] },
      },
    }),
  );
  return cId;
}

// Drive an application all the way to ACCEPTED (with an ACCEPTED offer) through
// the REAL routes, returning { applicationId, applicantToken, applicantUserId }.
// The applicant is created via the officer-on-behalf POST /applications path.
async function driveToAccepted(
  campaignId: string,
  applicantEmail: string,
  programId = programA,
): Promise<{ applicationId: string; applicantUserId: string; applicantToken: string; offerId: string }> {
  // Officer creates the application on behalf of a new applicant by email.
  const created = await app.inject({
    method: "POST",
    url: "/api/admissions/applications",
    headers: authHeader(officerToken()),
    payload: { campaignId, programId, applicantEmail, applicantName: "Test Applicant", formData: { fullName: "Test Applicant" } },
  });
  expect(created.statusCode).toBe(201);
  const applicationId = created.json().id as string;
  const applicantUserId = created.json().applicantUserId as string;
  const applicantToken = tokenFor(applicantUserId, "STUDENT", instA);

  // Applicant submits (DRAFT -> SUBMITTED).
  const submit = await app.inject({
    method: "POST",
    url: `/api/admissions/applications/${applicationId}/submit`,
    headers: authHeader(applicantToken),
    payload: {},
  });
  expect(submit.statusCode).toBe(200);

  // Officer reviews: SUBMITTED -> UNDER_REVIEW -> ELIGIBLE.
  await patchStatus(applicationId, "UNDER_REVIEW");
  await patchStatus(applicationId, "ELIGIBLE");

  // Officer issues an offer (-> OFFERED).
  const offer = await app.inject({
    method: "POST",
    url: `/api/admissions/applications/${applicationId}/offers`,
    headers: authHeader(officerToken()),
    payload: { offeredProgramId: programId },
  });
  expect(offer.statusCode).toBe(201);
  const offerId = offer.json().id as string;

  // Applicant accepts (OFFERED -> ACCEPTED; sole writer).
  const accept = await app.inject({
    method: "POST",
    url: `/api/admissions/offers/${offerId}/accept`,
    headers: authHeader(applicantToken),
    payload: {},
  });
  expect(accept.statusCode).toBe(200);

  return { applicationId, applicantUserId, applicantToken, offerId };
}

async function patchStatus(applicationId: string, status: string) {
  const r = await app.inject({
    method: "PATCH",
    url: `/api/admissions/applications/${applicationId}/status`,
    headers: authHeader(officerToken()),
    payload: { status },
  });
  return r;
}

async function auditCount(action: string): Promise<number> {
  return adminClient.auditEvent.count({ where: { institutionId: instA, action } });
}

beforeAll(async () => {
  await teardown();
  await seed();
  const mod = await import("../admissions.js");
  admissionsRoutes = mod.admissionsRoutes;
  app = Fastify();
  await app.register(jwt, { secret: "admissions-behavioral-test-secret" });
  await app.register(admissionsRoutes, { prefix: "/api/admissions" });
  await app.ready();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  const { prisma } = await import("@campusgate/db");
  await prisma.$disconnect();
  await adminClient.$disconnect();
}, 120_000);

// Each test starts from clean admissions rows + ACTIVE module for both tenants.
beforeEach(async () => {
  await clearAdmissions();
  await setAdmissionsState(instA, "ACTIVE");
  await setAdmissionsState(instB, "ACTIVE");
});

describe("Phase-6 admissions behavioral (real DB, real routes)", () => {
  // ─── applicant onboarding (AC-16) ───────────────────────────────────────────
  it("REGISTER: PUBLIC /register creates User + ACTIVE membership + APPLICANT role and NO StudentProfile; duplicate email -> 409", async () => {
    const email = `${PFX.toLowerCase()}applicant_reg@a.test`;
    const reg = await app.inject({
      method: "POST",
      url: "/api/admissions/register",
      payload: { institutionId: instA, email, password: "password123", name: "Reg Applicant" },
    });
    expect(reg.statusCode).toBe(201);
    const applicantId = reg.json().applicant.id as string;

    // The User exists with an ACTIVE membership + APPLICANT role, NO StudentProfile.
    const user = await adminClient.user.findFirst({ where: { email, institutionId: instA }, select: { id: true, role: true } });
    expect(user).toBeTruthy();
    expect(user!.id).toBe(applicantId);
    expect(user!.role).toBe("STUDENT"); // inert legacy value

    const membership = await adminClient.institutionMembership.findFirst({
      where: { userId: applicantId, institutionId: instA },
      select: { membershipStatus: true, roles: { select: { role: { select: { key: true } } } } },
    });
    expect(membership!.membershipStatus).toBe("ACTIVE");
    expect(membership!.roles.map((r) => r.role.key)).toContain("APPLICANT");

    const profile = await adminClient.studentProfile.count({ where: { userId: applicantId } });
    expect(profile).toBe(0);

    // The registered audit event was written.
    expect(await auditCount("admissions.applicant.registered")).toBeGreaterThanOrEqual(1);

    // Duplicate email in the same tenant -> 409.
    const dup = await app.inject({
      method: "POST",
      url: "/api/admissions/register",
      payload: { institutionId: instA, email, password: "password123", name: "Dup" },
    });
    expect(dup.statusCode).toBe(409);

    // PUBLIC but NOT abusable: an unknown institution is rejected (the public
    // module gate runs first and has no admissions module for it -> 403; even if
    // it got past the gate the handler's institution lookup -> 404). Either way
    // NO account is created.
    const badInst = await app.inject({
      method: "POST",
      url: "/api/admissions/register",
      payload: { institutionId: `${PFX}nope`, email: `${PFX.toLowerCase()}applicant_badinst@a.test`, password: "password123", name: "Bad" },
    });
    expect([403, 404]).toContain(badInst.statusCode);
    expect(await adminClient.user.count({ where: { email: `${PFX.toLowerCase()}applicant_badinst@a.test` } })).toBe(0);

    // Body validation still enforced (short password -> 400), no account created.
    const badBody = await app.inject({
      method: "POST",
      url: "/api/admissions/register",
      payload: { institutionId: instA, email: `${PFX.toLowerCase()}applicant_badbody@a.test`, password: "x", name: "Bad" },
    });
    expect(badBody.statusCode).toBe(400);
  }, 120_000);

  it("AUTH GUARD unchanged: an authenticated-only route still 401s WITHOUT a token (the fix did not over-expose)", async () => {
    // The public-route-in-a-plugin fix must leave every OTHER admissions route
    // authenticated. A tokenless request to the staff campaign list -> 401.
    const noToken = await app.inject({ method: "GET", url: "/api/admissions/campaigns" });
    expect(noToken.statusCode).toBe(401);

    const noTokenApply = await app.inject({
      method: "POST",
      url: "/api/admissions/applications",
      payload: { campaignId: "x", programId: "y" },
    });
    expect(noTokenApply.statusCode).toBe(401);
  }, 120_000);

  // ─── officer-on-behalf resolve-or-create ────────────────────────────────────
  it("OFFICER-ON-BEHALF: POST /applications creates an applicant User + ACTIVE membership + APPLICANT role by email, NO StudentProfile", async () => {
    const campaignId = await seedCampaign("oob");
    const email = `${PFX.toLowerCase()}applicant_oob@a.test`;
    const created = await app.inject({
      method: "POST",
      url: "/api/admissions/applications",
      headers: authHeader(officerToken()),
      payload: { campaignId, programId: programA, applicantEmail: email, applicantName: "OOB Applicant" },
    });
    expect(created.statusCode).toBe(201);
    const applicantUserId = created.json().applicantUserId as string;

    const user = await adminClient.user.findFirst({ where: { email, institutionId: instA }, select: { id: true } });
    expect(user!.id).toBe(applicantUserId);

    const membership = await adminClient.institutionMembership.findFirst({
      where: { userId: applicantUserId, institutionId: instA },
      select: { membershipStatus: true, roles: { select: { role: { select: { key: true } } } } },
    });
    expect(membership!.membershipStatus).toBe("ACTIVE");
    expect(membership!.roles.map((r) => r.role.key)).toContain("APPLICANT");

    expect(await adminClient.studentProfile.count({ where: { userId: applicantUserId } })).toBe(0);

    // A second officer-on-behalf create for the SAME applicant+campaign is 409
    // (one application per campaign per applicant) — the User is REUSED, not duplicated.
    const dup = await app.inject({
      method: "POST",
      url: "/api/admissions/applications",
      headers: authHeader(officerToken()),
      payload: { campaignId, programId: programA, applicantEmail: email },
    });
    expect(dup.statusCode).toBe(409);
    expect(await adminClient.user.count({ where: { email, institutionId: instA } })).toBe(1);
  }, 120_000);

  // ─── full journey + enroll CREATE (AC-6) ────────────────────────────────────
  it("JOURNEY + ENROLL CREATE (AC-6): campaign->apply->documents->review->offer->accept->enroll creates exactly one StudentProfile + one Enrollment with the §4 column sources", async () => {
    const campaignId = await seedCampaign("create", { config: { requiredFields: ["fullName"], requiredDocTypes: ["TRANSCRIPT"] } });
    const email = `${PFX.toLowerCase()}applicant_create@a.test`;

    // Officer creates on behalf.
    const created = await app.inject({
      method: "POST",
      url: "/api/admissions/applications",
      headers: authHeader(officerToken()),
      payload: { campaignId, programId: programA, applicantEmail: email, formData: { fullName: "Asha Patel" } },
    });
    expect(created.statusCode).toBe(201);
    const applicationId = created.json().id as string;
    const applicantUserId = created.json().applicantUserId as string;
    const applicantToken = tokenFor(applicantUserId, "STUDENT", instA);

    // Applicant attaches the required document.
    const doc = await app.inject({
      method: "POST",
      url: `/api/admissions/applications/${applicationId}/documents`,
      headers: authHeader(applicantToken),
      payload: { docType: "TRANSCRIPT", reference: "https://storage.test/transcript.pdf" },
    });
    expect(doc.statusCode).toBe(201);

    // Submit (fields + docs present).
    const submit = await app.inject({
      method: "POST",
      url: `/api/admissions/applications/${applicationId}/submit`,
      headers: authHeader(applicantToken),
      payload: {},
    });
    expect(submit.statusCode).toBe(200);

    // Review trail (append-only) + status to ELIGIBLE.
    await patchStatus(applicationId, "UNDER_REVIEW");
    const review = await app.inject({
      method: "POST",
      url: `/api/admissions/applications/${applicationId}/reviews`,
      headers: authHeader(officerToken()),
      payload: { decision: "RECOMMEND_ELIGIBLE", notes: "strong candidate" },
    });
    expect(review.statusCode).toBe(201);
    await patchStatus(applicationId, "ELIGIBLE");

    // Offer -> accept.
    const offer = await app.inject({
      method: "POST",
      url: `/api/admissions/applications/${applicationId}/offers`,
      headers: authHeader(officerToken()),
      payload: { offeredProgramId: programA },
    });
    expect(offer.statusCode).toBe(201);
    const offerId = offer.json().id as string;
    const accept = await app.inject({
      method: "POST",
      url: `/api/admissions/offers/${offerId}/accept`,
      headers: authHeader(applicantToken),
      payload: {},
    });
    expect(accept.statusCode).toBe(200);

    // Enroll (admin carries admissions.enroll).
    const enroll = await app.inject({
      method: "POST",
      url: `/api/admissions/applications/${applicationId}/enroll`,
      headers: authHeader(adminToken()),
      payload: { enrollmentNo: id("ENR_CREATE") },
    });
    expect(enroll.statusCode).toBe(201);
    expect(enroll.json().created).toBe(true);
    const studentProfileId = enroll.json().studentProfileId as string;

    // Exactly ONE StudentProfile for the applicant, with the §4 column sources.
    const profiles = await adminClient.studentProfile.findMany({ where: { userId: applicantUserId } });
    expect(profiles.length).toBe(1);
    const sp = profiles[0];
    expect(sp.id).toBe(studentProfileId);
    expect(sp.semester).toBe(1);
    expect(sp.program).toBe(`${PFX}BCA`); // free-text mirror = Program.name
    expect(sp.programId).toBe(programA);
    expect(sp.departmentId).toBe(deptA); // from the program
    expect(sp.academicSessionId).toBe(sessionA); // resolved intake session
    expect(sp.status).toBe("ENROLLED");

    // Exactly ONE Enrollment for the application.
    const enrollments = await adminClient.enrollment.findMany({ where: { institutionId: instA, applicationId } });
    expect(enrollments.length).toBe(1);
    expect(enrollments[0].studentProfileId).toBe(studentProfileId);
    expect(enrollments[0].academicSessionId).toBe(sessionA);

    // Application is terminal ENROLLED; the enrolled audit was written.
    const appRow = await adminClient.application.findUnique({ where: { id: applicationId } });
    expect(appRow!.status).toBe("ENROLLED");
    expect(await auditCount("admissions.application.enrolled")).toBeGreaterThanOrEqual(1);

    // CREATED + ENROLLED history rows were written directly.
    const history = await adminClient.studentProfileHistory.findMany({ where: { studentProfileId } });
    const changeTypes = history.map((h) => h.changeType).sort();
    expect(changeTypes).toContain("CREATED");
    expect(changeTypes).toContain("ENROLLED");
  }, 180_000);

  // ─── HEADLINE: enroll LINK (AC-7) ───────────────────────────────────────────
  it("HEADLINE ENROLL LINK (AC-7): a person who already has a StudentProfile -> Enrollment links to it, NO second StudentProfile", async () => {
    const campaignId = await seedCampaign("link");
    const email = `${PFX.toLowerCase()}applicant_link@a.test`;
    const { applicationId, applicantUserId } = await driveToAccepted(campaignId, email);

    // Pre-existing APPLICANT-status StudentProfile for the SAME applicant User.
    const existingProfileId = id("sp_link");
    await withRetry(() =>
      adminClient.studentProfile.create({
        data: {
          id: existingProfileId,
          userId: applicantUserId,
          institutionId: instA,
          enrollmentNo: id("ENR_LINK"),
          name: "Linked Student",
          departmentId: deptA,
          program: "legacy",
          semester: 1,
          status: "APPLICANT",
        },
      }),
    );

    const enroll = await app.inject({
      method: "POST",
      url: `/api/admissions/applications/${applicationId}/enroll`,
      headers: authHeader(adminToken()),
      payload: { enrollmentNo: id("ENR_LINK") },
    });
    expect(enroll.statusCode).toBe(201);
    expect(enroll.json().created).toBe(false); // LINK, not CREATE
    expect(enroll.json().studentProfileId).toBe(existingProfileId);

    // LINK PROOF: still exactly ONE StudentProfile for the applicant — no duplicate.
    const profiles = await adminClient.studentProfile.findMany({ where: { userId: applicantUserId } });
    expect(profiles.length).toBe(1);
    expect(profiles[0].id).toBe(existingProfileId);
    expect(profiles[0].status).toBe("ENROLLED"); // flipped APPLICANT -> ENROLLED

    // The Enrollment links to the pre-existing profile.
    const enrollments = await adminClient.enrollment.findMany({ where: { institutionId: instA, applicationId } });
    expect(enrollments.length).toBe(1);
    expect(enrollments[0].studentProfileId).toBe(existingProfileId);
  }, 180_000);

  it("WRONG-PERSON ENROLL (AC-17): enrollmentNo owned by a DIFFERENT user (not sharing email) -> 409, links nothing", async () => {
    const campaignId = await seedCampaign("wrong");
    const email = `${PFX.toLowerCase()}applicant_wrong@a.test`;
    const { applicationId, applicantUserId } = await driveToAccepted(campaignId, email);

    // A DIFFERENT person owns the target enrollmentNo.
    const otherUser = id("applicant_other");
    await withRetry(() =>
      adminClient.user.create({
        data: { id: otherUser, email: `${PFX.toLowerCase()}applicant_other@a.test`, role: "STUDENT", institutionId: instA },
      }),
    );
    const otherEnrollmentNo = id("ENR_OTHER");
    await withRetry(() =>
      adminClient.studentProfile.create({
        data: {
          id: id("sp_other"),
          userId: otherUser,
          institutionId: instA,
          enrollmentNo: otherEnrollmentNo,
          name: "Other Student",
          departmentId: deptA,
          program: "legacy",
          semester: 1,
          status: "ACTIVE",
        },
      }),
    );

    const enroll = await app.inject({
      method: "POST",
      url: `/api/admissions/applications/${applicationId}/enroll`,
      headers: authHeader(adminToken()),
      payload: { enrollmentNo: otherEnrollmentNo },
    });
    expect(enroll.statusCode).toBe(409);

    // Nothing linked: the applicant got no profile; no Enrollment row exists.
    expect(await adminClient.studentProfile.count({ where: { userId: applicantUserId } })).toBe(0);
    expect(await adminClient.enrollment.count({ where: { institutionId: instA, applicationId } })).toBe(0);
    // The other person's profile is untouched.
    const other = await adminClient.studentProfile.findFirst({ where: { enrollmentNo: otherEnrollmentNo } });
    expect(other!.userId).toBe(otherUser);
    expect(other!.status).toBe("ACTIVE");
  }, 180_000);

  it("RE-ENROLL idempotency (AC-8): a second enroll -> 409, no second StudentProfile or Enrollment", async () => {
    const campaignId = await seedCampaign("reenroll");
    const email = `${PFX.toLowerCase()}applicant_reenroll@a.test`;
    const { applicationId, applicantUserId } = await driveToAccepted(campaignId, email);

    const first = await app.inject({
      method: "POST",
      url: `/api/admissions/applications/${applicationId}/enroll`,
      headers: authHeader(adminToken()),
      payload: { enrollmentNo: id("ENR_RE") },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/api/admissions/applications/${applicationId}/enroll`,
      headers: authHeader(adminToken()),
      payload: { enrollmentNo: id("ENR_RE") },
    });
    expect(second.statusCode).toBe(409);

    expect(await adminClient.studentProfile.count({ where: { userId: applicantUserId } })).toBe(1);
    expect(await adminClient.enrollment.count({ where: { institutionId: instA, applicationId } })).toBe(1);
  }, 180_000);

  // ─── state machine + guards ─────────────────────────────────────────────────
  it("REJECTED/WITHDRAWN cannot enroll (AC-5): a REJECTED application -> enroll 409", async () => {
    const campaignId = await seedCampaign("rejected");
    const email = `${PFX.toLowerCase()}applicant_rej@a.test`;
    const { applicationId, applicantUserId } = await driveToAccepted(campaignId, email);

    // Force the application terminal REJECTED directly (an accepted app cannot
    // be rejected through the legal table, so set it via adminClient for the guard test).
    await withRetry(() => adminClient.application.update({ where: { id: applicationId }, data: { status: "REJECTED" } }));

    const enroll = await app.inject({
      method: "POST",
      url: `/api/admissions/applications/${applicationId}/enroll`,
      headers: authHeader(adminToken()),
      payload: { enrollmentNo: id("ENR_REJ") },
    });
    expect(enroll.statusCode).toBe(409);
    expect(await adminClient.studentProfile.count({ where: { userId: applicantUserId } })).toBe(0);
  }, 180_000);

  it("ILLEGAL TRANSITION (AC-4): a direct DRAFT -> ELIGIBLE PATCH -> 409, status unchanged", async () => {
    const campaignId = await seedCampaign("illegal");
    const email = `${PFX.toLowerCase()}applicant_illegal@a.test`;
    const created = await app.inject({
      method: "POST",
      url: "/api/admissions/applications",
      headers: authHeader(officerToken()),
      payload: { campaignId, programId: programA, applicantEmail: email },
    });
    const applicationId = created.json().id as string;

    const r = await patchStatus(applicationId, "ELIGIBLE"); // DRAFT -> ELIGIBLE illegal
    expect(r.statusCode).toBe(409);
    const appRow = await adminClient.application.findUnique({ where: { id: applicationId } });
    expect(appRow!.status).toBe("DRAFT"); // unchanged
  }, 180_000);

  it("DIRECT PATCH -> ACCEPTED is forbidden (AC-19): staff cannot set ACCEPTED -> 409", async () => {
    const campaignId = await seedCampaign("directacc");
    const email = `${PFX.toLowerCase()}applicant_directacc@a.test`;
    const created = await app.inject({
      method: "POST",
      url: "/api/admissions/applications",
      headers: authHeader(officerToken()),
      payload: { campaignId, programId: programA, applicantEmail: email },
    });
    const applicationId = created.json().id as string;
    await app.inject({ method: "POST", url: `/api/admissions/applications/${applicationId}/submit`, headers: authHeader(tokenFor(created.json().applicantUserId, "STUDENT", instA)), payload: {} });
    await patchStatus(applicationId, "UNDER_REVIEW");
    await patchStatus(applicationId, "ELIGIBLE");

    const r = await patchStatus(applicationId, "ACCEPTED");
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: "ACCEPTED is set only by accepting an offer" });
    const appRow = await adminClient.application.findUnique({ where: { id: applicationId } });
    expect(appRow!.status).toBe("ELIGIBLE"); // unchanged
  }, 180_000);

  it("OFFER DECLINE returns to ELIGIBLE + a replacement offer can be issued (AC-19)", async () => {
    const campaignId = await seedCampaign("decline");
    const email = `${PFX.toLowerCase()}applicant_decline@a.test`;
    // Drive to OFFERED (not accepted).
    const created = await app.inject({
      method: "POST",
      url: "/api/admissions/applications",
      headers: authHeader(officerToken()),
      payload: { campaignId, programId: programA, applicantEmail: email },
    });
    const applicationId = created.json().id as string;
    const applicantUserId = created.json().applicantUserId as string;
    const applicantToken = tokenFor(applicantUserId, "STUDENT", instA);
    await app.inject({ method: "POST", url: `/api/admissions/applications/${applicationId}/submit`, headers: authHeader(applicantToken), payload: {} });
    await patchStatus(applicationId, "UNDER_REVIEW");
    await patchStatus(applicationId, "ELIGIBLE");
    const offer = await app.inject({
      method: "POST",
      url: `/api/admissions/applications/${applicationId}/offers`,
      headers: authHeader(officerToken()),
      payload: { offeredProgramId: programA },
    });
    const offerId = offer.json().id as string;

    // Applicant declines -> application back to ELIGIBLE, offer DECLINED.
    const decline = await app.inject({
      method: "POST",
      url: `/api/admissions/offers/${offerId}/decline`,
      headers: authHeader(applicantToken),
      payload: {},
    });
    expect(decline.statusCode).toBe(200);
    let appRow = await adminClient.application.findUnique({ where: { id: applicationId } });
    expect(appRow!.status).toBe("ELIGIBLE");
    const declined = await adminClient.admissionOffer.findUnique({ where: { id: offerId } });
    expect(declined!.status).toBe("DECLINED");

    // A replacement offer can be issued (the dead offer no longer blocks it).
    const replacement = await app.inject({
      method: "POST",
      url: `/api/admissions/applications/${applicationId}/offers`,
      headers: authHeader(officerToken()),
      payload: { offeredProgramId: programA },
    });
    expect(replacement.statusCode).toBe(201);
    appRow = await adminClient.application.findUnique({ where: { id: applicationId } });
    expect(appRow!.status).toBe("OFFERED");
  }, 180_000);

  it("ENROLL with no resolvable intake session -> 422 (AC-18)", async () => {
    // Campaign with NO intake session; no academicSessionId supplied in the body.
    const campaignId = await seedCampaign("nosession", { intakeSessionId: null });
    const email = `${PFX.toLowerCase()}applicant_nosession@a.test`;
    const { applicationId } = await driveToAccepted(campaignId, email);

    const enroll = await app.inject({
      method: "POST",
      url: `/api/admissions/applications/${applicationId}/enroll`,
      headers: authHeader(adminToken()),
      payload: { enrollmentNo: id("ENR_NOSESS") },
    });
    expect(enroll.statusCode).toBe(422);
  }, 180_000);

  // ─── privacy + append-only + module gating ──────────────────────────────────
  it("APPEND-ONLY REVIEW (AC-9): a recorded ApplicationReview cannot be UPDATEd or DELETEd at the DB", async () => {
    const campaignId = await seedCampaign("review");
    const email = `${PFX.toLowerCase()}applicant_review@a.test`;
    const created = await app.inject({
      method: "POST",
      url: "/api/admissions/applications",
      headers: authHeader(officerToken()),
      payload: { campaignId, programId: programA, applicantEmail: email },
    });
    const applicationId = created.json().id as string;
    await app.inject({ method: "POST", url: `/api/admissions/applications/${applicationId}/submit`, headers: authHeader(tokenFor(created.json().applicantUserId, "STUDENT", instA)), payload: {} });
    await patchStatus(applicationId, "UNDER_REVIEW");

    const review = await app.inject({
      method: "POST",
      url: `/api/admissions/applications/${applicationId}/reviews`,
      headers: authHeader(officerToken()),
      payload: { decision: "NOTE", notes: "immutable" },
    });
    expect(review.statusCode).toBe(201);
    const reviewId = review.json().id as string;

    // UPDATE + DELETE both denied at the DB (REVOKE + trigger).
    await expect(adminClient.applicationReview.update({ where: { id: reviewId }, data: { notes: "mutate" } })).rejects.toBeTruthy();
    await expect(adminClient.applicationReview.delete({ where: { id: reviewId } })).rejects.toBeTruthy();
    const still = await adminClient.applicationReview.findUnique({ where: { id: reviewId } });
    expect(still!.notes).toBe("immutable");
    // A review-recorded audit event was written (AC-15).
    expect(await auditCount("admissions.review.recorded")).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it("APPLICANT OWNERSHIP ISOLATION (AC-3): an applicant cannot read another applicant's application -> not-found", async () => {
    const campaignId = await seedCampaign("iso");
    const emailOne = `${PFX.toLowerCase()}applicant_iso1@a.test`;
    const emailTwo = `${PFX.toLowerCase()}applicant_iso2@a.test`;
    const one = await app.inject({
      method: "POST",
      url: "/api/admissions/applications",
      headers: authHeader(officerToken()),
      payload: { campaignId, programId: programA, applicantEmail: emailOne },
    });
    const two = await app.inject({
      method: "POST",
      url: "/api/admissions/applications",
      headers: authHeader(officerToken()),
      payload: { campaignId, programId: programA, applicantEmail: emailTwo },
    });
    const appOneId = one.json().id as string;
    const userTwoId = two.json().applicantUserId as string;
    const tokenTwo = tokenFor(userTwoId, "STUDENT", instA);

    // Applicant two tries to read applicant one's application -> 404 (ownership).
    const read = await app.inject({
      method: "GET",
      url: `/api/admissions/applications/${appOneId}`,
      headers: authHeader(tokenTwo),
    });
    expect(read.statusCode).toBe(404);

    // GET /applications/mine for applicant two returns ONLY their own.
    const mine = await app.inject({
      method: "GET",
      url: "/api/admissions/applications/mine",
      headers: authHeader(tokenTwo),
    });
    expect(mine.statusCode).toBe(200);
    const apps = mine.json().applications as Array<{ id: string }>;
    expect(apps.every((a) => a.id !== appOneId)).toBe(true);
  }, 180_000);

  it("MODULE GATING (AC-10): every operational route is 403 when admissions is not ACTIVE; disabling preserves data", async () => {
    const campaignId = await seedCampaign("gate");
    const email = `${PFX.toLowerCase()}applicant_gate@a.test`;
    const created = await app.inject({
      method: "POST",
      url: "/api/admissions/applications",
      headers: authHeader(officerToken()),
      payload: { campaignId, programId: programA, applicantEmail: email },
    });
    expect(created.statusCode).toBe(201);
    const applicationId = created.json().id as string;

    // Suspend the module.
    await setAdmissionsState(instA, "SUSPENDED");

    // Operational routes now 403.
    const listCampaigns = await app.inject({ method: "GET", url: "/api/admissions/campaigns", headers: authHeader(officerToken()) });
    expect(listCampaigns.statusCode).toBe(403);
    const listApps = await app.inject({ method: "GET", url: "/api/admissions/applications", headers: authHeader(officerToken()) });
    expect(listApps.statusCode).toBe(403);
    const makeApp = await app.inject({
      method: "POST",
      url: "/api/admissions/applications",
      headers: authHeader(officerToken()),
      payload: { campaignId, programId: programA, applicantEmail: `${PFX.toLowerCase()}applicant_gate2@a.test` },
    });
    expect(makeApp.statusCode).toBe(403);

    // Disabling preserved the data — re-activate and the row is still there.
    await setAdmissionsState(instA, "ACTIVE");
    const stillThere = await adminClient.application.findUnique({ where: { id: applicationId } });
    expect(stillThere).toBeTruthy();
  }, 180_000);
});
