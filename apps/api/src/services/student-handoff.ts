import { privilegedPrisma, type Prisma } from "@campusgate/db";
import {
  planEnrollment,
  CROSS_PERSON_MESSAGE,
  type ApplicantSnapshot,
  type EnrollPlan,
  type StudentProfileSnapshot,
} from "./admissions-enroll.js";
import { inviteCeiling, inviteRemaining, issueAndSend } from "./account-invites.js";
import { buildLoginLink, getEmailSender, renderEnrolled } from "./email/index.js";

/**
 * Admissions-to-student handoff. Everything that changes authority or identity at
 * enroll time lives here: the STUDENT role grant, the profile create for an
 * EXISTING user, enrollment-number generation, the shared guards (used by both the
 * enroll handler and the read-only preview) and the post-commit email.
 *
 * All DB functions take the caller's transaction client. Only the global
 * enrollment-number checks use the owner client (`StudentProfile.enrollmentNo` is
 * globally unique and RLS hides other institutions' rows), injected for tests.
 */

export const STUDENT_ROLE_KEY = "STUDENT" as const;
export const APPLICANT_INELIGIBLE_MESSAGE = "Applicant account cannot be enrolled as a student";
export const NUMBER_TAKEN_MESSAGE = "Enrollment number already registered";
export const PROFILE_BLOCKED_MESSAGE = "Existing student record is not in a state that allows enrollment";
export const NUMBER_EXHAUSTED_MESSAGE = "Could not allocate an enrollment number; enter one";
/** Plain enrolled emails are skipped when fewer invites than this remain today. */
export const ENROLLED_EMAIL_RESERVE = 20;
const MAX_ALLOCATION_TRIES = 5;
const ALLOWED_PROFILE_STATUSES = new Set(["ENROLLED", "ACTIVE", "ON_LEAVE"]);

/** Thrown inside the enroll transaction to roll it back; the route answers 409. */
export class EnrollConflict extends Error {
  constructor(message: string, readonly auditReason: string = message) {
    super(message);
    this.name = "EnrollConflict";
  }
}

export function isUniqueViolation(err: unknown): err is { code: string; meta?: { target?: unknown } } {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

function uniqueTargetText(err: { meta?: { target?: unknown } }): string {
  const t = err.meta?.target;
  return Array.isArray(t) ? t.join(",") : String(t ?? "");
}

// ─── enrollment number ──────────────────────────────────────────────────────

/** Year in Asia/Kolkata for a given instant. */
export function kolkataYear(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric" }).formatToParts(date);
  return Number(parts.find((p) => p.type === "year")?.value);
}

/** `<PROGRAMCODE><YYYY>`: code upper-cased, non [A-Z0-9] removed, 12 chars max, `STU` fallback. */
export function enrollmentPrefix(programCode: string, year: number): string {
  const code = programCode.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "STU";
  return `${code}${year}`;
}

export function formatEnrollmentNo(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

/** Year used in the number: start year of the intake session, else the current year (both Asia/Kolkata). */
export function enrollmentYear(sessionStart: Date | null, now: Date): number {
  return kolkataYear(sessionStart ?? now);
}

export interface OwnerStudentDb {
  studentProfile: {
    findMany(args: { where: { enrollmentNo: { startsWith: string } }; select: { enrollmentNo: true } }): Promise<{ enrollmentNo: string }[]>;
    findFirst(args: { where: { enrollmentNo: string }; select: { id: true } }): Promise<{ id: string } | null>;
  };
}

/**
 * Next free number for a prefix. The sequence is global per prefix (the column is
 * globally unique), computed from the owner side so other institutions' numbers
 * are skipped. Only the chosen free value is returned. The caller holds the
 * prefix advisory lock; the bounded loop only guards races with unlocked writers.
 */
export async function generateEnrollmentNo(
  prefix: string,
  ownerDb: OwnerStudentDb = privilegedPrisma as unknown as OwnerStudentDb,
): Promise<string> {
  const rows = await ownerDb.studentProfile.findMany({
    where: { enrollmentNo: { startsWith: prefix } },
    select: { enrollmentNo: true },
  });
  const re = new RegExp(`^${prefix.replace(/[^A-Za-z0-9]/g, "\\$&")}(\\d{1,15})$`);
  let max = 0;
  for (const r of rows) {
    const m = re.exec(r.enrollmentNo);
    if (m) max = Math.max(max, Number(m[1]));
  }
  for (let i = 1; i <= MAX_ALLOCATION_TRIES; i++) {
    const candidate = formatEnrollmentNo(prefix, max + i);
    const taken = await ownerDb.studentProfile.findFirst({ where: { enrollmentNo: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
  throw new EnrollConflict(NUMBER_EXHAUSTED_MESSAGE);
}

/** True when the number exists in ANY institution (owner-side exact check). */
export async function enrollmentNoTaken(
  enrollmentNo: string,
  ownerDb: OwnerStudentDb = privilegedPrisma as unknown as OwnerStudentDb,
): Promise<boolean> {
  return !!(await ownerDb.studentProfile.findFirst({ where: { enrollmentNo }, select: { id: true } }));
}

/** Serialize allocations for one prefix until the transaction ends. */
export async function lockEnrollmentPrefix(tx: Prisma.TransactionClient, prefix: string): Promise<void> {
  const key = `enrollno:${prefix}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

// ─── STUDENT role grant ─────────────────────────────────────────────────────

/**
 * Add the STUDENT role to the user's membership in `institutionId` and bump the
 * membership's permissionsVersion, only when the role row is new. The role key is
 * a literal here: nothing the caller passes can select another role.
 */
export async function grantStudentRole(
  tx: Prisma.TransactionClient,
  args: { userId: string; institutionId: string },
): Promise<{ created: boolean; membershipId: string }> {
  const { userId, institutionId } = args;
  const role = await tx.role.findFirst({ where: { key: STUDENT_ROLE_KEY, institutionId: null }, select: { id: true } });
  if (!role) throw new Error("STUDENT role template is not provisioned");

  let membership = await tx.institutionMembership.findUnique({
    where: { userId_institutionId: { userId, institutionId } },
    select: { id: true },
  });
  if (!membership) {
    membership = await tx.institutionMembership.create({
      data: { userId, institutionId, membershipStatus: "ACTIVE", permissionsVersion: 0 },
      select: { id: true },
    });
  }

  const existing = await tx.membershipRole.findUnique({
    where: { membershipId_roleId: { membershipId: membership.id, roleId: role.id } },
    select: { id: true },
  });
  if (existing) return { created: false, membershipId: membership.id };

  await tx.membershipRole.create({ data: { membershipId: membership.id, roleId: role.id, institutionId } });
  await tx.institutionMembership.update({
    where: { id: membership.id },
    data: { permissionsVersion: { increment: 1 } },
  });
  return { created: true, membershipId: membership.id };
}

/** True when the user's membership in the institution already holds the STUDENT role. */
export async function hasStudentRole(
  tx: Prisma.TransactionClient,
  args: { userId: string; institutionId: string },
): Promise<boolean> {
  const row = await tx.membershipRole.findFirst({
    where: {
      institutionId: args.institutionId,
      membership: { userId: args.userId, institutionId: args.institutionId },
      role: { key: STUDENT_ROLE_KEY, institutionId: null },
    },
    select: { id: true },
  });
  return !!row;
}

// ─── profile create for an existing user ────────────────────────────────────

export interface HandoffProgram {
  id: string;
  name: string | null;
  code: string;
  departmentId: string;
}

/**
 * Create the StudentProfile (status ENROLLED, semester 1) for an applicant who
 * already has a User, plus the CREATED and ENROLLED history rows. A unique
 * violation throws EnrollConflict (the transaction is already aborted).
 */
export async function createProfileForExistingUser(
  tx: Prisma.TransactionClient,
  args: {
    institutionId: string;
    userId: string;
    enrollmentNo: string;
    name: string;
    program: HandoffProgram;
    academicSessionId: string;
    actorUserId: string;
    now: Date;
  },
): Promise<{ id: string }> {
  const { institutionId, program, academicSessionId, actorUserId } = args;
  let created: { id: string };
  try {
    created = await tx.studentProfile.create({
      data: {
        userId: args.userId,
        institutionId,
        enrollmentNo: args.enrollmentNo,
        name: args.name,
        departmentId: program.departmentId,
        program: program.name ?? program.code,
        programId: program.id,
        semester: 1,
        academicSessionId,
        status: "ENROLLED",
        admissionDate: args.now,
      },
      select: { id: true },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      if (uniqueTargetText(err).includes("enrollmentNo")) {
        throw new EnrollConflict(NUMBER_TAKEN_MESSAGE, "duplicate enrollment number");
      }
      throw new EnrollConflict("a student profile already exists for this identity", "duplicate student profile");
    }
    throw err;
  }

  const base = {
    institutionId,
    studentProfileId: created.id,
    newStatus: "ENROLLED" as const,
    newProgramId: program.id,
    newProgramText: program.name ?? program.code,
    newSemester: 1,
    newDepartmentId: program.departmentId,
    newSessionId: academicSessionId,
    newTermId: null,
    previousTermId: null,
    actorUserId,
  };
  await tx.studentProfileHistory.create({
    data: { ...base, changeType: "CREATED", reason: "Admissions enroll: profile created" },
  });
  await tx.studentProfileHistory.create({
    data: { ...base, changeType: "ENROLLED", reason: "Admissions enroll: enrolled" },
  });
  return created;
}

// ─── shared guards (enroll + preview + grant-student-access) ────────────────

export interface GuardDeny {
  status: 404 | 409 | 422;
  message: string;
  /** Reason written to the DENIED audit (may be more specific than the message). */
  auditReason: string;
  auditMeta?: Record<string, unknown>;
}

export interface ApplicantInfo {
  id: string;
  email: string;
  normalizedEmail: string;
  hasPassword: boolean;
}

/** Same-institution applicant must be an active legacy STUDENT with a non-suspended membership. */
export async function checkApplicantEligible(
  tx: Prisma.TransactionClient,
  args: { institutionId: string; userId: string },
): Promise<{ deny: GuardDeny } | { applicant: ApplicantInfo }> {
  const user = await tx.user.findFirst({
    where: { id: args.userId, institutionId: args.institutionId },
    select: { id: true, email: true, passwordHash: true, role: true, accountStatus: true },
  });
  if (!user) return { deny: { status: 404, message: "application not found", auditReason: "applicant not found" } };

  const membership = await tx.institutionMembership.findUnique({
    where: { userId_institutionId: { userId: args.userId, institutionId: args.institutionId } },
    select: { membershipStatus: true },
  });
  let reason: string | null = null;
  if (user.accountStatus !== "ACTIVE") reason = `applicant account status ${user.accountStatus}`;
  else if (user.role !== "STUDENT") reason = `applicant legacy role ${user.role}`;
  else if (membership?.membershipStatus === "SUSPENDED") reason = "applicant membership suspended";
  if (reason) {
    return { deny: { status: 409, message: APPLICANT_INELIGIBLE_MESSAGE, auditReason: reason } };
  }
  const normalizedEmail = user.email ? user.email.trim().toLowerCase() : "";
  return { applicant: { id: user.id, email: user.email, normalizedEmail, hasPassword: user.passwordHash != null } };
}

/** The profile a STUDENT role may be granted on: ENROLLED, ACTIVE or ON_LEAVE only. */
export function profileStatusDeny(status: string): GuardDeny | null {
  if (ALLOWED_PROFILE_STATUSES.has(status)) return null;
  return {
    status: 409,
    message: PROFILE_BLOCKED_MESSAGE,
    auditReason: "existing student record blocked",
    auditMeta: { profileStatus: status },
  };
}

export interface EnrollGuardInput {
  institutionId: string;
  application: {
    id: string;
    status: string;
    campaignId: string;
    applicantUserId: string;
    formData: unknown;
  };
  bodySessionId?: string;
  /** Officer-supplied number, already trimmed. The by-number lookup runs only when present. */
  enrollmentNo?: string;
  /** The preview tolerates a missing intake session (the officer picks one in the dialog). */
  requireSession: boolean;
}

export interface ResolvedEnroll {
  offer: { id: string; offeredProgramId: string };
  program: HandoffProgram;
  academicSessionId: string | null;
  sessionName: string | null;
  sessionStart: Date | null;
  campaignHasSession: boolean;
  applicant: ApplicantInfo;
  plan: Exclude<EnrollPlan, { kind: "REJECT_CROSS_PERSON" }>;
  existingProfile: { id: string; enrollmentNo: string; status: string } | null;
}

async function loadProfileSnapshot(
  tx: Prisma.TransactionClient,
  institutionId: string,
  key: { userId: string } | { enrollmentNo: string },
): Promise<(StudentProfileSnapshot & { enrollmentNo: string }) | null> {
  const where: Prisma.StudentProfileWhereInput =
    "userId" in key ? { institutionId, userId: key.userId } : { institutionId, enrollmentNo: key.enrollmentNo };
  const row = await tx.studentProfile.findFirst({
    where,
    select: { id: true, userId: true, status: true, enrollmentNo: true, user: { select: { email: true } } },
  });
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    status: row.status,
    enrollmentNo: row.enrollmentNo,
    ownerNormalizedEmail: row.user?.email ? row.user.email.trim().toLowerCase() : "",
  };
}

/**
 * Every precondition for enrolling an ACCEPTED application, with no writes.
 * Shared by the enroll handler and the preview so both give the same answers.
 */
export async function evaluateEnrollGuards(
  tx: Prisma.TransactionClient,
  input: EnrollGuardInput,
): Promise<{ deny: GuardDeny } | { ok: ResolvedEnroll }> {
  const { institutionId, application } = input;

  if (application.status !== "ACCEPTED") {
    return {
      deny: { status: 409, message: "application is not in ACCEPTED state", auditReason: "application is not ACCEPTED" },
    };
  }
  const offer = await tx.admissionOffer.findFirst({
    where: { institutionId, applicationId: application.id, status: "ACCEPTED" },
    select: { id: true, offeredProgramId: true },
  });
  if (!offer) {
    return { deny: { status: 409, message: "no accepted offer for this application", auditReason: "no ACCEPTED offer" } };
  }

  const campaign = await tx.admissionCampaign.findFirst({
    where: { id: application.campaignId, institutionId },
    select: { intakeSessionId: true },
  });
  let academicSessionId = campaign?.intakeSessionId ?? null;
  const campaignHasSession = academicSessionId != null;
  if (!academicSessionId && input.bodySessionId) {
    const s = await tx.academicSession.findFirst({
      where: { id: input.bodySessionId, institutionId },
      select: { id: true },
    });
    if (!s) {
      return {
        deny: { status: 422, message: "academicSessionId does not resolve", auditReason: "academicSessionId not found" },
      };
    }
    academicSessionId = s.id;
  }
  if (!academicSessionId && input.requireSession) {
    return {
      deny: {
        status: 422,
        message: "No intake session: campaign has no intakeSessionId and none supplied",
        auditReason: "no intake session",
      },
    };
  }
  let sessionName: string | null = null;
  let sessionStart: Date | null = null;
  if (academicSessionId) {
    const s = await tx.academicSession.findFirst({
      where: { id: academicSessionId, institutionId },
      select: { name: true, startDate: true },
    });
    sessionName = s?.name ?? null;
    sessionStart = s?.startDate ?? null;
  }

  const eligible = await checkApplicantEligible(tx, { institutionId, userId: application.applicantUserId });
  if ("deny" in eligible) return eligible;
  const applicant = eligible.applicant;

  const program = await tx.program.findFirst({
    where: { id: offer.offeredProgramId, institutionId },
    select: { id: true, name: true, code: true, departmentId: true },
  });
  if (!program) {
    return {
      deny: { status: 422, message: "offered program no longer exists", auditReason: "offered program not found" },
    };
  }

  const byUserId = await loadProfileSnapshot(tx, institutionId, { userId: application.applicantUserId });
  const byEnrollmentNo = input.enrollmentNo
    ? await loadProfileSnapshot(tx, institutionId, { enrollmentNo: input.enrollmentNo })
    : null;
  const snapshot: ApplicantSnapshot = {
    userId: application.applicantUserId,
    normalizedEmail: applicant.normalizedEmail,
    ...(input.enrollmentNo ? { enrollmentNo: input.enrollmentNo } : {}),
  };
  const plan = planEnrollment(snapshot, byUserId, byEnrollmentNo);
  if (plan.kind === "REJECT_CROSS_PERSON") {
    return { deny: { status: 409, message: CROSS_PERSON_MESSAGE, auditReason: CROSS_PERSON_MESSAGE } };
  }

  const existing = plan.kind === "CREATE" ? null : plan.studentProfileId === byUserId?.id ? byUserId : byEnrollmentNo;
  if (existing && plan.kind === "LINK_LEAVE") {
    const blocked = profileStatusDeny(existing.status);
    if (blocked) return { deny: blocked };
  }
  if (existing && input.enrollmentNo && input.enrollmentNo !== existing.enrollmentNo) {
    return {
      deny: {
        status: 409,
        message: `Applicant already has a student record with number ${existing.enrollmentNo}`,
        auditReason: "enrollment number differs from the existing record",
      },
    };
  }

  return {
    ok: {
      offer,
      program,
      academicSessionId,
      sessionName,
      sessionStart,
      campaignHasSession,
      applicant,
      plan,
      existingProfile: existing ? { id: existing.id, enrollmentNo: existing.enrollmentNo, status: existing.status } : null,
    },
  };
}

// ─── post-commit email ──────────────────────────────────────────────────────

export type EnrolledEmailOutcome = "SENT" | "SKIPPED_NOT_CONFIGURED" | "SKIPPED_BUDGET" | "FAILED";
export type AccountSetupOutcome = "INVITE_SENT" | "INVITE_NOT_SENT" | "HAS_PASSWORD";

interface NoticeLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * One enrolled email after commit, best effort. A passwordless applicant gets the
 * activation link inside it (counted by issueAndSend); a user with a password gets
 * a plain sign-in message that is only sent while a reserve of daily budget
 * remains. Never throws; never logs addresses, links or tokens.
 */
export async function deliverEnrolledNotice(
  args: {
    institutionId: string;
    applicationId: string;
    userId: string;
    email: string;
    hasPassword: boolean;
    actorUserId: string;
  },
  log: NoticeLog,
): Promise<{ email: EnrolledEmailOutcome; accountSetup: AccountSetupOutcome }> {
  const noInvite: AccountSetupOutcome = args.hasPassword ? "HAS_PASSWORD" : "INVITE_NOT_SENT";
  try {
    if (!getEmailSender().isConfigured()) return { email: "SKIPPED_NOT_CONFIGURED", accountSetup: noInvite };
    const inst = await privilegedPrisma.institution.findUnique({
      where: { id: args.institutionId },
      select: { name: true },
    });
    const institutionName = inst?.name ?? "your institution";

    if (!args.hasPassword) {
      const r = await issueAndSend({
        userId: args.userId,
        institutionId: args.institutionId,
        institutionName,
        email: args.email,
        purpose: "ACCOUNT_ACTIVATION",
        template: "enrolled",
        createdByUserId: args.actorUserId,
        budgetCeiling: inviteCeiling(),
      });
      switch (r.status) {
        case "SENT":
          return { email: "SENT", accountSetup: "INVITE_SENT" };
        case "NOT_CONFIGURED":
          return { email: "SKIPPED_NOT_CONFIGURED", accountSetup: "INVITE_NOT_SENT" };
        case "THROTTLED":
        case "BUDGET":
        case "ANON_HOURLY":
        case "ANON_DAILY":
        case "PROVIDER_LIMIT":
          log.warn({ applicationId: args.applicationId, status: r.status }, "enrolled invite skipped");
          return { email: "SKIPPED_BUDGET", accountSetup: "INVITE_NOT_SENT" };
        default:
          log.warn({ applicationId: args.applicationId, status: r.status }, "enrolled invite not sent");
          return { email: "FAILED", accountSetup: "INVITE_NOT_SENT" };
      }
    }

    const link = buildLoginLink();
    if (!link) return { email: "SKIPPED_NOT_CONFIGURED", accountSetup: "HAS_PASSWORD" };
    const remaining = await inviteRemaining();
    if (remaining < ENROLLED_EMAIL_RESERVE) {
      log.warn({ applicationId: args.applicationId, remaining }, "enrolled email skipped: daily budget reserve");
      return { email: "SKIPPED_BUDGET", accountSetup: "HAS_PASSWORD" };
    }
    const mail = renderEnrolled({ institutionName, link });
    await getEmailSender().send({
      to: { email: args.email },
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      tag: "student-enrolled",
    });
    return { email: "SENT", accountSetup: "HAS_PASSWORD" };
  } catch (err) {
    log.warn(
      { applicationId: args.applicationId, reason: err instanceof Error ? err.name : "unknown" },
      "enrolled email failed",
    );
    return { email: "FAILED", accountSetup: noInvite };
  }
}
