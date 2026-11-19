import { createHash, randomBytes } from "crypto";
import bcrypt from "bcrypt";
import { privilegedPrisma, type Prisma } from "@campusgate/db";

/**
 * Account lifecycle tokens (password reset + account activation).
 *
 * Client rule: `account_tokens` is an OWNER-ONLY table. Every function here
 * uses the owner client (`privilegedPrisma` by default, injectable through
 * `deps` for tests) and never a tenant `withTenant` transaction.
 *
 * Invariants: single use and one live token per (user, purpose) are owned by the
 * database (atomic claim, partial unique index). Expiry, purpose binding and
 * user eligibility are owned by this module. Tokens and links are never logged.
 */
export const RESET_TTL_MS = 45 * 60_000; // 45 minutes
export const ACTIVATION_TTL_MS = 72 * 3_600_000; // 72 hours
export const USER_THROTTLE_MAX = 3; // tokens per user and purpose per hour
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Fixed advisory-lock key for "email budget". */
export const EMAIL_BUDGET_LOCK = 724001;
/** Callers queue on the advisory lock, so allow for waiting on a slow pooler (default is 5 s). */
const TX_OPTIONS = { maxWait: 20_000, timeout: 30_000 };

export type TokenPurpose = "PASSWORD_RESET" | "ACCOUNT_ACTIVATION";
export type OwnerDb = typeof privilegedPrisma;
export interface TokenDeps {
  db?: OwnerDb;
  now?: () => Date;
  hashPassword?: (password: string) => Promise<string>;
}

export function generateToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function ttlFor(purpose: TokenPurpose): number {
  return purpose === "PASSWORD_RESET" ? RESET_TTL_MS : ACTIVATION_TTL_MS;
}

// ─── platform accounts (D15) ────────────────────────────────────────────────
type MembershipReader = {
  institutionMembership: {
    findUnique(args: any): Promise<{ roles: { role: { key: string; permissions: { permission: { key: string } }[] } }[] } | null>;
  };
};

/** SUPER_ADMIN, or any account whose roles grant a `platform.*` permission. */
export async function isPlatformAccount(
  db: MembershipReader,
  user: { id: string; role: string; institutionId: string },
): Promise<boolean> {
  if (user.role === "SUPER_ADMIN") return true;
  const membership = await db.institutionMembership.findUnique({
    where: { userId_institutionId: { userId: user.id, institutionId: user.institutionId } },
    select: {
      roles: {
        select: {
          role: {
            select: {
              key: true,
              permissions: { select: { permission: { select: { key: true } } } },
            },
          },
        },
      },
    },
  });
  if (!membership) return false;
  return membership.roles.some((mr) => mr.role.permissions.some((p) => p.permission.key.startsWith("platform.")));
}

// ─── issue ──────────────────────────────────────────────────────────────────
export interface IssueTokenInput {
  userId: string;
  institutionId: string;
  purpose: TokenPurpose;
  createdByUserId?: string | null;
  budgetCeiling: number;
  /** Forgot-password path: leaves createdByUserId null and applies the anonymous ceilings. */
  anonymous?: boolean;
  hourlyAnonCeiling?: number;
  dailyAnonCeiling?: number;
}

export type IssueTokenResult =
  | { status: "OK"; token: string; expiresAt: Date; id: string }
  | { status: "THROTTLED" | "BUDGET" | "ANON_HOURLY" | "ANON_DAILY" | "INELIGIBLE" };

export async function issueToken(input: IssueTokenInput, deps: TokenDeps = {}): Promise<IssueTokenResult> {
  const db = deps.db ?? privilegedPrisma;
  const now = deps.now ? deps.now() : new Date();

  // Defence in depth: a platform account never gets a token, whatever the caller checked.
  const target = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true, role: true, institutionId: true },
  });
  if (!target || target.institutionId !== input.institutionId) return { status: "INELIGIBLE" };
  if (await isPlatformAccount(db as unknown as MembershipReader, target)) return { status: "INELIGIBLE" };

  const { token, tokenHash } = generateToken();
  const expiresAt = new Date(now.getTime() + ttlFor(input.purpose));
  const anonymous = !!input.anonymous;

  return db.$transaction(async (tx): Promise<IssueTokenResult> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${EMAIL_BUDGET_LOCK})`;

    const throttled = await tx.accountToken.count({
      where: {
        userId: input.userId,
        purpose: input.purpose,
        createdAt: { gte: new Date(now.getTime() - HOUR_MS) },
      },
    });
    if (throttled >= USER_THROTTLE_MAX) return { status: "THROTTLED" };

    const used = await tx.accountToken.count({
      where: { emailSentAt: { gte: new Date(now.getTime() - DAY_MS) } },
    });
    if (used + 1 > input.budgetCeiling) return { status: "BUDGET" };

    if (anonymous) {
      if (input.hourlyAnonCeiling !== undefined) {
        const h = await tx.accountToken.count({
          where: { createdByUserId: null, emailSentAt: { gte: new Date(now.getTime() - HOUR_MS) } },
        });
        if (h + 1 > input.hourlyAnonCeiling) return { status: "ANON_HOURLY" };
      }
      if (input.dailyAnonCeiling !== undefined) {
        const d = await tx.accountToken.count({
          where: { createdByUserId: null, emailSentAt: { gte: new Date(now.getTime() - DAY_MS) } },
        });
        if (d + 1 > input.dailyAnonCeiling) return { status: "ANON_DAILY" };
      }
    }

    await tx.accountToken.updateMany({
      where: { userId: input.userId, purpose: input.purpose, usedAt: null, supersededAt: null },
      data: { supersededAt: now },
    });

    const row = await tx.accountToken.create({
      data: {
        userId: input.userId,
        institutionId: input.institutionId,
        purpose: input.purpose,
        tokenHash,
        expiresAt,
        emailSentAt: now, // budget reservation, released by failIssuedToken
        createdByUserId: anonymous ? null : (input.createdByUserId ?? null),
        createdAt: now,
      },
      select: { id: true },
    });
    return { status: "OK", token, expiresAt, id: row.id };
  }, TX_OPTIONS);
}

/** Provider failed after reservation: release the budget, invalidate the token, record why. */
export async function failIssuedToken(
  id: string,
  reason: string,
  deps: TokenDeps = {},
  opts: { startCooldown?: boolean } = {},
): Promise<void> {
  const db = deps.db ?? privilegedPrisma;
  const now = deps.now ? deps.now() : new Date();
  // startCooldown=false (provider credential problem): release and supersede,
  // but leave failedAt null so the admin can retry right after fixing the key.
  await db.accountToken.update({
    where: { id },
    data: {
      emailSentAt: null,
      supersededAt: now,
      failedAt: opts.startCooldown === false ? null : now,
      failureReason: reason,
    },
  });
}

// ─── membership ensure (F3) ─────────────────────────────────────────────────
type MembershipDb = Pick<Prisma.TransactionClient, "institutionMembership" | "membershipRole" | "role">;

/**
 * Client-agnostic: `db` is whatever client the caller already uses (owner tx
 * from consume, withTenant tx from approve). Creates the membership only if
 * none exists and never changes an existing membership's status.
 */
export async function ensureMembership(
  db: MembershipDb,
  input: { userId: string; institutionId: string; legacyRole: string },
  log: { warn: (msg: string) => void } = console,
): Promise<void> {
  if (input.legacyRole === "SUPER_ADMIN") return;
  const existing = await db.institutionMembership.findUnique({
    where: { userId_institutionId: { userId: input.userId, institutionId: input.institutionId } },
    select: { id: true },
  });
  let membershipId = existing?.id;
  if (!membershipId) {
    const created = await db.institutionMembership.create({
      data: {
        userId: input.userId,
        institutionId: input.institutionId,
        membershipStatus: "ACTIVE",
        permissionsVersion: 0,
      },
      select: { id: true },
    });
    membershipId = created.id;
  }
  // A membership that already has any role is left exactly as it is.
  const roleCount = await db.membershipRole.count({ where: { membershipId } });
  if (roleCount > 0) return;
  const role = await db.role.findFirst({
    where: { key: input.legacyRole, institutionId: null },
    select: { id: true },
  });
  if (!role) {
    log.warn("ensureMembership: template role missing, skipped");
    return;
  }
  await db.membershipRole.upsert({
    where: { membershipId_roleId: { membershipId, roleId: role.id } },
    update: {},
    create: { membershipId, roleId: role.id, institutionId: input.institutionId },
  });
}

// ─── consume ────────────────────────────────────────────────────────────────
export type ConsumeResult = "OK" | "INVALID" | "PASSWORD_REJECTED";

class ConsumeAbort extends Error {
  constructor(public kind: "INVALID" | "PASSWORD_REJECTED") {
    super(kind);
  }
}

export interface ConsumeInput {
  token: string;
  purpose: TokenPurpose;
  password: string;
  ip?: string | null;
}

export async function consumeToken(input: ConsumeInput, deps: TokenDeps = {}): Promise<ConsumeResult> {
  const db = deps.db ?? privilegedPrisma;
  const now = deps.now ? deps.now() : new Date();
  const hashPassword = deps.hashPassword ?? ((p: string) => bcrypt.hash(p, 12));
  const tokenHash = hashToken(input.token);
  const isActivation = input.purpose === "ACCOUNT_ACTIVATION";

  // Cheap pre-check so junk tokens never cost a bcrypt hash.
  const pre = await db.accountToken.findFirst({
    where: { tokenHash, purpose: input.purpose, usedAt: null, supersededAt: null, expiresAt: { gt: now } },
    select: {
      id: true,
      user: {
        select: {
          id: true,
          role: true,
          institutionId: true,
          accountStatus: true,
          passwordHash: true,
          studentProfile: { select: { enrollmentNo: true } },
          institution: { select: { status: true } },
        },
      },
    },
  });
  if (!pre) return "INVALID";
  const u = pre.user;
  if (u.accountStatus !== "ACTIVE" || u.institution.status !== "ACTIVE") return "INVALID";
  if (isActivation && u.passwordHash != null) return "INVALID";
  if (await isPlatformAccount(db as unknown as MembershipReader, u)) return "INVALID";
  if (u.studentProfile && input.password === u.studentProfile.enrollmentNo) return "PASSWORD_REJECTED";

  const passwordHash = await hashPassword(input.password);

  try {
    await db.$transaction(async (tx) => {
      // 1. Atomic claim: exactly one of two racing requests gets count 1.
      const claim = await tx.accountToken.updateMany({
        where: { tokenHash, purpose: input.purpose, usedAt: null, supersededAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claim.count !== 1) throw new ConsumeAbort("INVALID");

      // 2. Tenant comes from the token's user, never from the request.
      const row = await tx.accountToken.findUnique({ where: { tokenHash }, select: { userId: true } });
      if (!row) throw new ConsumeAbort("INVALID");
      const user = await tx.user.findUnique({
        where: { id: row.userId },
        include: { studentProfile: { select: { enrollmentNo: true } }, institution: { select: { status: true } } },
      });
      if (!user) throw new ConsumeAbort("INVALID");
      if (await isPlatformAccount(tx as unknown as MembershipReader, user)) throw new ConsumeAbort("INVALID");
      if (user.accountStatus !== "ACTIVE" || user.institution.status !== "ACTIVE") throw new ConsumeAbort("INVALID");
      if (isActivation && user.passwordHash != null) throw new ConsumeAbort("INVALID");
      if (user.studentProfile && input.password === user.studentProfile.enrollmentNo) {
        throw new ConsumeAbort("PASSWORD_REJECTED");
      }

      // 3. New password.
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });

      // 4. Revoke every session.
      await tx.session.updateMany({
        where: { userId: user.id, revoked: false },
        data: { revoked: true, revokedAt: now, revokedReason: isActivation ? "account_activation" : "password_reset" },
      });

      // 5. Supersede every other live token of the user.
      await tx.accountToken.updateMany({
        where: { userId: user.id, usedAt: null, supersededAt: null },
        data: { supersededAt: now },
      });

      // 6. Make sure the user can log in (F3).
      await ensureMembership(tx, { userId: user.id, institutionId: user.institutionId, legacyRole: user.role });

      // 7. Security event.
      await tx.securityEvent.create({
        data: {
          userId: user.id,
          institutionId: user.institutionId,
          eventType: "PASSWORD_CHANGED",
          ipAddress: input.ip ?? null,
          deviceInfo: isActivation ? "activation" : "reset",
        },
      });
    }, TX_OPTIONS);
  } catch (err) {
    // Every non-OK outcome inside the transaction throws and rolls the claim back.
    if (err instanceof ConsumeAbort) return err.kind;
    throw err;
  }
  return "OK";
}
