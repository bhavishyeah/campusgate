import type { FastifyInstance, FastifyRequest } from "fastify";
import { privilegedPrisma } from "@campusgate/db";
import { forgotPasswordSchema, resetPasswordSchema } from "@campusgate/shared";
import { consumeToken, type TokenPurpose } from "../services/account-tokens.js";
import {
  drainBackground,
  emailDailyLimit,
  issueAndSend,
  resetDailyCeiling,
  resetHourlyCeiling,
  runInBackground,
} from "../services/account-invites.js";
import { getEmailSender } from "../services/email/index.js";
import { clientIpKey, enforce, hashKey, limiters } from "../services/rate-limit.js";
import { isSelfRegistrationEnabled } from "../services/self-registration.js";

export { drainBackground };

const GENERIC_FORGOT = { message: "If an account exists for that email, we have sent a link. Check your inbox." };
const INVALID_LINK = { error: "This link is invalid or has expired. Request a new one." };

type Candidate = {
  id: string;
  email: string;
  role: string;
  institutionId: string;
  accountStatus: string;
  passwordHash: string | null;
  institution: { status: string; name: string };
  studentProfile: { status: string } | null;
};

function isEligible(u: Candidate): boolean {
  if (u.role === "SUPER_ADMIN") return false; // platform accounts, D15 (the membership check runs in issueToken)
  if (u.accountStatus !== "ACTIVE" || u.institution.status !== "ACTIVE") return false;
  // A passwordless student is activated by this path, so the profile must be ACTIVE.
  if (!u.passwordHash && u.role === "STUDENT" && u.studentProfile?.status !== "ACTIVE") return false;
  return true;
}

/** Case tie-break (design 6.2). Returns null when nothing or an ambiguous set remains. */
function pickCandidate(typed: string, candidates: Candidate[], request: FastifyRequest): Candidate | null {
  const eligible = candidates.filter(isEligible);
  const exact = eligible.find((c) => c.email === typed);
  if (exact) return exact;
  if (eligible.length === 1) return eligible[0];
  if (eligible.length > 1) request.log.warn("forgot-password: ambiguous case-variant accounts, nothing sent");
  return null;
}

async function processForgot(request: FastifyRequest, typed: string, candidates: Candidate[]): Promise<void> {
  if (!getEmailSender().isConfigured()) {
    request.log.warn("email not configured, reset not sent");
    return;
  }
  const user = pickCandidate(typed, candidates, request);
  if (!user) return;
  const r = await issueAndSend({
    userId: user.id,
    institutionId: user.institutionId,
    institutionName: user.institution.name,
    email: user.email,
    purpose: user.passwordHash ? "PASSWORD_RESET" : "ACCOUNT_ACTIVATION",
    budgetCeiling: emailDailyLimit(),
    anonymous: true,
    hourlyAnonCeiling: resetHourlyCeiling(),
    dailyAnonCeiling: resetDailyCeiling(),
  });
  switch (r.status) {
    case "SENT":
    case "THROTTLED":
      return;
    case "BUDGET":
      request.log.warn("email budget exhausted, reset not sent");
      return;
    case "ANON_HOURLY":
      request.log.warn("anonymous reset ceiling reached (hourly)");
      return;
    case "ANON_DAILY":
      request.log.warn("anonymous reset ceiling reached (daily)");
      return;
    case "INELIGIBLE":
      request.log.debug("forgot-password: ineligible account");
      return;
    case "NOT_CONFIGURED":
      request.log.warn("email not configured, reset not sent");
      return;
    default:
      request.log.warn({ reason: r.reason }, "email provider problem, reset not sent");
  }
}

export async function accountLifecycleRoutes(app: FastifyInstance) {
  // ─── FORGOT PASSWORD ───────────────────────────────────────────────────────
  app.post("/forgot-password", async (request, reply) => {
    const parsed = forgotPasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const email = parsed.data.email;

    const ipKey = clientIpKey(request);
    if (!enforce(limiters.forgotIp, ipKey, reply)) return reply;
    if (!enforce(limiters.forgotIpDaily, ipKey, reply)) return reply;
    const emailAllowed = limiters.forgotEmail.hit(hashKey(email)).allowed;

    // The lookup runs for every request, existing account or not, so the
    // response path does the same work. Everything else is detached.
    const candidates = (await privilegedPrisma.user.findMany({
      // Only rows that could ever receive mail, so PENDING case-variant rows
      // created through /register cannot crowd the real account out of the page.
      where: {
        email: { equals: email, mode: "insensitive" },
        accountStatus: "ACTIVE",
        institution: { status: "ACTIVE" },
      },
      select: {
        id: true,
        email: true,
        role: true,
        institutionId: true,
        accountStatus: true,
        passwordHash: true,
        institution: { select: { status: true, name: true } },
        studentProfile: { select: { status: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 10,
    })) as Candidate[];

    if (emailAllowed) {
      runInBackground(processForgot(request, email, candidates), (err) => {
        request.log.error({ errClass: err instanceof Error ? err.name : "unknown" }, "forgot-password background work failed");
      });
    }
    return reply.send(GENERIC_FORGOT);
  });

  // ─── RESET PASSWORD / ACTIVATE ─────────────────────────────────────────────
  function consumeRoute(purpose: TokenPurpose, okMessage: string) {
    return async (request: FastifyRequest, reply: import("fastify").FastifyReply) => {
      const parsed = resetPasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      // Flood guard only: a token has 256 bits of entropy, a tight cap would lock out a campus NAT.
      if (!enforce(limiters.tokenIp, clientIpKey(request), reply)) return reply;

      const result = await consumeToken({
        token: parsed.data.token,
        purpose,
        password: parsed.data.password,
        ip: request.ip || null,
      });
      if (result === "PASSWORD_REJECTED") {
        return reply.status(400).send({ error: "Choose a different password." });
      }
      if (result === "INVALID") {
        request.log.debug("account token rejected");
        return reply.status(400).send(INVALID_LINK);
      }
      request.log.info({ purpose }, "account password set via token");
      return reply.send({ message: okMessage });
    };
  }

  app.post("/reset-password", consumeRoute("PASSWORD_RESET", "Password updated. You can now sign in."));
  app.post("/activate", consumeRoute("ACCOUNT_ACTIVATION", "Account activated. You can now sign in."));

  // ─── PUBLIC CONFIG ─────────────────────────────────────────────────────────
  app.get("/public-config", async () => ({ selfRegistrationEnabled: isSelfRegistrationEnabled() }));
}
