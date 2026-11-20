import { privilegedPrisma, withTenant } from "@campusgate/db";
import type { z } from "zod";
import type { bulkInviteSchema } from "@campusgate/shared";
import {
  failIssuedToken,
  isPlatformAccount,
  issueToken,
  type IssueTokenResult,
  type TokenDeps,
  type TokenPurpose,
  RESET_TTL_MS,
  ACTIVATION_TTL_MS,
} from "./account-tokens.js";
import {
  EmailSendError,
  buildAccountLink,
  getEmailSender,
  renderActivation,
  renderEnrolledActivation,
  renderPasswordReset,
} from "./email/index.js";

export const RESET_RESERVE = 50;
export const BULK_BATCH_MAX = 100;
export const SEND_CONCURRENCY = 5;
const PROVIDER_ERROR_STOP = 3;
export const ALL_PENDING_SCAN_CAP = 5000;
const DAY_MS = 24 * 3_600_000;

function intEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Shared daily email limit (Brevo free plan: 300/day). */
export const emailDailyLimit = () => intEnv("EMAIL_DAILY_LIMIT", 300);
export const inviteCeiling = () => Math.max(0, emailDailyLimit() - RESET_RESERVE);
export const resetHourlyCeiling = () => intEnv("EMAIL_RESET_HOURLY_LIMIT", 40);
export const resetDailyCeiling = () => intEnv("EMAIL_RESET_DAILY_LIMIT", 100);

export async function inviteRemaining(deps: TokenDeps = {}): Promise<number> {
  const db = deps.db ?? privilegedPrisma;
  const now = deps.now ? deps.now() : new Date();
  const used = await db.accountToken.count({ where: { emailSentAt: { gte: new Date(now.getTime() - DAY_MS) } } });
  return Math.max(0, inviteCeiling() - used);
}

// ─── background work (forgot-password) ──────────────────────────────────────
const pending = new Set<Promise<unknown>>();

/** Run detached work; failures never reach the caller. Tracked so tests can drain it. */
export function runInBackground(p: Promise<unknown>, onError: (err: unknown) => void): void {
  const tracked = p.catch(onError).finally(() => pending.delete(tracked));
  pending.add(tracked);
}

export async function drainBackground(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

// ─── issue + send ───────────────────────────────────────────────────────────
export interface IssueAndSendInput {
  userId: string;
  institutionId: string;
  institutionName: string;
  email: string;
  purpose: TokenPurpose;
  /** "enrolled" swaps the activation mail for the "you're enrolled" variant (same link and token). */
  template?: "enrolled";
  createdByUserId?: string | null;
  budgetCeiling: number;
  anonymous?: boolean;
  hourlyAnonCeiling?: number;
  dailyAnonCeiling?: number;
}

export type IssueAndSendResult =
  | { status: "SENT"; expiresAt: Date; id: string }
  | { status: Exclude<IssueTokenResult["status"], "OK"> }
  | { status: "NOT_CONFIGURED" | "PROVIDER_LIMIT" | "FAILED"; reason?: string };

/**
 * Reserve budget and issue a token (one locked owner transaction), then send.
 * On any send failure the token is invalidated and the reservation released.
 * Never logs the token or the link.
 */
export async function issueAndSend(input: IssueAndSendInput, deps: TokenDeps = {}): Promise<IssueAndSendResult> {
  const sender = getEmailSender();
  if (!sender.isConfigured()) return { status: "NOT_CONFIGURED" };

  const issued = await issueToken(
    {
      userId: input.userId,
      institutionId: input.institutionId,
      purpose: input.purpose,
      createdByUserId: input.createdByUserId,
      budgetCeiling: input.budgetCeiling,
      anonymous: input.anonymous,
      hourlyAnonCeiling: input.hourlyAnonCeiling,
      dailyAnonCeiling: input.dailyAnonCeiling,
    },
    deps,
  );
  if (issued.status !== "OK") return { status: issued.status };

  const link = buildAccountLink(input.purpose === "PASSWORD_RESET" ? "/reset-password" : "/activate", issued.token);
  if (!link) {
    await failIssuedToken(issued.id, "NOT_CONFIGURED", deps);
    return { status: "NOT_CONFIGURED" };
  }
  const mail =
    input.purpose === "PASSWORD_RESET"
      ? renderPasswordReset({ institutionName: input.institutionName, link, expiresInMinutes: RESET_TTL_MS / 60_000 })
      : input.template === "enrolled"
        ? renderEnrolledActivation({ institutionName: input.institutionName, link, expiresInHours: ACTIVATION_TTL_MS / 3_600_000 })
        : renderActivation({ institutionName: input.institutionName, link, expiresInHours: ACTIVATION_TTL_MS / 3_600_000 });

  try {
    await sender.send({
      to: { email: input.email },
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      tag:
        input.purpose === "PASSWORD_RESET"
          ? "password-reset"
          : input.template === "enrolled"
            ? "student-enrolled"
            : "account-activation",
    });
  } catch (err) {
    const reason = err instanceof EmailSendError ? err.reason : "PROVIDER_UNAVAILABLE";
    const credentialProblem = err instanceof EmailSendError && (err.status === 401 || err.status === 403);
    await failIssuedToken(issued.id, reason, deps, { startCooldown: !credentialProblem });
    if (reason === "PROVIDER_LIMIT") return { status: "PROVIDER_LIMIT", reason };
    if (reason === "NOT_CONFIGURED") return { status: "NOT_CONFIGURED", reason };
    return { status: "FAILED", reason };
  }
  return { status: "SENT", expiresAt: issued.expiresAt, id: issued.id };
}

// ─── bulk student invites ───────────────────────────────────────────────────
export type BulkInviteBody = z.infer<typeof bulkInviteSchema>;
export type BulkOutcome =
  | "SENT"
  | "FAILED"
  | "SKIPPED_ALREADY_ACTIVATED"
  | "SKIPPED_RECENTLY_INVITED"
  | "SKIPPED_RECENT_FAILURE"
  | "SKIPPED_NOT_FOUND"
  | "SKIPPED_NOT_ELIGIBLE"
  | "SKIPPED_BUDGET"
  | "SKIPPED_PROVIDER_LIMIT"
  | "SKIPPED_PROVIDER_ERROR";

export interface BulkInviteResponse {
  dryRun: boolean;
  emailConfigured: boolean;
  eligibleTotal: number;
  attempted: number;
  sent: number;
  failed: number;
  skipped: {
    alreadyActivated: number;
    recentlyInvited: number;
    recentFailure: number;
    notFound: number;
    notEligible: number;
    budget: number;
    providerLimit: number;
    providerError: number;
  };
  failedRecently: number;
  remainingNotInvited: number;
  budget: { inviteCeiling: number; inviteRemaining: number };
  results: { userId: string; email: string; outcome: BulkOutcome }[];
}

interface Candidate {
  id: string;
  email: string;
}

async function mapPool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runBulkInvite(
  args: { institutionId: string; actorUserId: string; body: BulkInviteBody },
  deps: TokenDeps = {},
): Promise<BulkInviteResponse> {
  const db = deps.db ?? privilegedPrisma;
  const now = deps.now ? deps.now() : new Date();
  const { institutionId, body } = args;
  const emailConfigured = getEmailSender().isConfigured();
  const skipped = {
    alreadyActivated: 0,
    recentlyInvited: 0,
    recentFailure: 0,
    notFound: 0,
    notEligible: 0,
    budget: 0,
    providerLimit: 0,
    providerError: 0,
  };

  // 1. Tenant step: users (campass_app + GUC). Never touches account_tokens.
  let eligible: Candidate[] = [];
  if (body.mode === "ALL_PENDING") {
    eligible = await withTenant(institutionId, (tx) =>
      tx.user.findMany({
        where: {
          institutionId,
          role: "STUDENT",
          accountStatus: "ACTIVE",
          passwordHash: null,
          studentProfile: { status: "ACTIVE" },
        },
        select: { id: true, email: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: ALL_PENDING_SCAN_CAP,
      }),
    );
  } else {
    const ids = [...new Set(body.userIds ?? [])];
    const found = await withTenant(institutionId, (tx) =>
      tx.user.findMany({
        where: { id: { in: ids }, institutionId },
        select: {
          id: true,
          email: true,
          role: true,
          accountStatus: true,
          passwordHash: true,
          institutionId: true,
          studentProfile: { select: { status: true } },
        },
      }),
    );
    const byId = new Map(found.map((u) => [u.id, u]));
    for (const id of ids) {
      const u = byId.get(id);
      if (!u) {
        skipped.notFound++;
        continue;
      }
      if (u.role !== "STUDENT" || !u.studentProfile || u.accountStatus !== "ACTIVE" || u.studentProfile.status !== "ACTIVE") {
        skipped.notEligible++;
        continue;
      }
      if (u.passwordHash != null) {
        skipped.alreadyActivated++;
        continue;
      }
      if (await isPlatformAccount(db as never, u)) {
        skipped.notEligible++;
        continue;
      }
      eligible.push({ id: u.id, email: u.email });
    }
  }

  // 2. Owner step: invite history, merged in application code.
  const history = new Map<string, { sent: Date | null; failed: Date | null }>();
  if (eligible.length > 0) {
    const groups = await db.accountToken.groupBy({
      by: ["userId"],
      where: { userId: { in: eligible.map((e) => e.id) }, institutionId, purpose: "ACCOUNT_ACTIVATION" },
      _max: { emailSentAt: true, failedAt: true },
    });
    for (const g of groups) history.set(g.userId, { sent: g._max.emailSentAt, failed: g._max.failedAt });
  }
  const cutoff = now.getTime() - DAY_MS;
  const sendable: Candidate[] = [];
  for (const c of eligible) {
    const h = history.get(c.id);
    if (h?.sent && h.sent.getTime() >= cutoff && !body.resendRecent) {
      skipped.recentlyInvited++;
    } else if (h?.failed && h.failed.getTime() >= cutoff) {
      skipped.recentFailure++;
    } else {
      sendable.push(c);
    }
  }

  const remaining = await inviteRemaining(deps);
  const batch = sendable.slice(0, Math.min(BULK_BATCH_MAX, remaining));
  const results: BulkInviteResponse["results"] = [];
  let sent = 0;
  let failed = 0;
  let throttled = 0;

  if (!body.dryRun) {
    const inst = await db.institution.findUnique({ where: { id: institutionId }, select: { name: true } });
    const institutionName = inst?.name ?? "your institution";
    let stop = false;
    let stopKind: "LIMIT" | "ERROR" = "LIMIT";
    let consecutiveProviderErrors = 0;
    await mapPool(batch, SEND_CONCURRENCY, async (c) => {
      if (stop) {
        if (stopKind === "ERROR") {
          skipped.providerError++;
          results.push({ userId: c.id, email: c.email, outcome: "SKIPPED_PROVIDER_ERROR" });
        } else {
          skipped.providerLimit++;
          results.push({ userId: c.id, email: c.email, outcome: "SKIPPED_PROVIDER_LIMIT" });
        }
        return;
      }
      let r: IssueAndSendResult;
      try {
        r = await issueAndSend(
          {
            userId: c.id,
            institutionId,
            institutionName,
            email: c.email,
            purpose: "ACCOUNT_ACTIVATION",
            createdByUserId: args.actorUserId,
            budgetCeiling: inviteCeiling(),
          },
          deps,
        );
      } catch {
        r = { status: "FAILED", reason: "UNEXPECTED" };
      }
      switch (r.status) {
        case "SENT":
          consecutiveProviderErrors = 0;
          sent++;
          results.push({ userId: c.id, email: c.email, outcome: "SENT" });
          break;
        case "THROTTLED":
          throttled++;
          skipped.recentlyInvited++;
          results.push({ userId: c.id, email: c.email, outcome: "SKIPPED_RECENTLY_INVITED" });
          break;
        case "BUDGET":
          skipped.budget++;
          results.push({ userId: c.id, email: c.email, outcome: "SKIPPED_BUDGET" });
          break;
        case "PROVIDER_LIMIT":
          stop = true;
          stopKind = "LIMIT";
          failed++;
          results.push({ userId: c.id, email: c.email, outcome: "FAILED" });
          break;
        case "INELIGIBLE":
          skipped.notEligible++;
          results.push({ userId: c.id, email: c.email, outcome: "SKIPPED_NOT_ELIGIBLE" });
          break;
        default:
          failed++;
          results.push({ userId: c.id, email: c.email, outcome: "FAILED" });
          if (r.status === "FAILED" && (r.reason === "PROVIDER_REJECTED" || r.reason === "PROVIDER_UNAVAILABLE")) {
            if (++consecutiveProviderErrors >= PROVIDER_ERROR_STOP && !stop) {
              stop = true;
              stopKind = "ERROR";
            }
          } else {
            consecutiveProviderErrors = 0;
          }
      }
    });
  }

  const after = body.dryRun ? remaining : await inviteRemaining(deps);
  return {
    dryRun: body.dryRun,
    emailConfigured,
    eligibleTotal: sendable.length,
    attempted: batch.length,
    sent,
    failed,
    skipped,
    failedRecently: skipped.recentFailure + failed,
    remainingNotInvited: body.dryRun ? sendable.length : Math.max(0, sendable.length - sent - failed - throttled),
    budget: { inviteCeiling: inviteCeiling(), inviteRemaining: after },
    results,
  };
}
