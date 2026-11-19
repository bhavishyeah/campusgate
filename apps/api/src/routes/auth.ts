import type { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import bcrypt from "bcrypt";
import { privilegedPrisma, withTenant } from "@campusgate/db";
import { loginSchema, registerSchema } from "@campusgate/shared";
import { ROLE_PERMISSIONS } from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { resolvePermissions } from "../services/authz-engine.js";
import { notifyInstitutionAdmins } from "../services/notifications.js";
import { clientIpKey, enforce, hashKey, limiters } from "../services/rate-limit.js";
import { isSelfRegistrationEnabled } from "../services/self-registration.js";

// Platform permission keys for a SUPER_ADMIN (no membership), normalized the
// same way (dedup + sort) as the membership-resolved sets.
const SUPER_ADMIN_PERMISSIONS: string[] = [
  ...new Set(ROLE_PERMISSIONS.SUPER_ADMIN ?? []),
].sort();

const NOT_ACTIVATED_MESSAGE =
  "Account not activated. Check your email for an activation link, or use Forgot password to get a new one.";

/** Parse a basic device descriptor from the User-Agent string. */
function parseDevice(ua?: string) {
  if (!ua) return { deviceType: "unknown", browser: "unknown", os: "unknown" };
  const lower = ua.toLowerCase();
  const deviceType = /mobile|android|iphone|ipad|ipod/.test(lower)
    ? lower.includes("ipad") ? "tablet" : "mobile"
    : "desktop";
  const browser = lower.includes("chrome") && !lower.includes("chromium")
    ? "Chrome"
    : lower.includes("firefox")
    ? "Firefox"
    : lower.includes("safari") && !lower.includes("chrome")
    ? "Safari"
    : lower.includes("edge")
    ? "Edge"
    : "Other";
  const os = lower.includes("windows")
    ? "Windows"
    : lower.includes("mac os")
    ? "macOS"
    : lower.includes("android")
    ? "Android"
    : lower.includes("iphone") || lower.includes("ipad")
    ? "iOS"
    : lower.includes("linux")
    ? "Linux"
    : "Unknown";
  return { deviceType, browser, os };
}

export async function authRoutes(app: FastifyInstance) {
  // ─── PUBLIC DEPARTMENTS (for registration form) ────────────────────────────
  app.get("/departments", async (_request, reply) => {
    const departments = await privilegedPrisma.department.findMany({
      where: { institution: { status: "ACTIVE" } },
      select: {
        id: true,
        name: true,
        code: true,
        institution: { select: { id: true, name: true, code: true } },
      },
      orderBy: [{ institution: { name: "asc" } }, { name: "asc" }],
    });
    return reply.send(departments);
  });

  // ─── LOGIN ──────────────────────────────────────────────────────────────────
  app.post("/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const { email, password } = parsed.data;

    const user = await privilegedPrisma.user.findUnique({
      where: { email },
      include: {
        studentProfile: true,
        hodProfile: true,
        guardProfile: true,
        institution: { select: { status: true } },
      },
    });

    if (!user) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }

    if (!user.passwordHash) {
      if (user.role === "STUDENT") {
        return reply.status(403).send({
          error: NOT_ACTIVATED_MESSAGE,
        });
      }
      return reply.status(401).send({ error: "Invalid email or password" });
    }

    if (user.accountStatus !== "ACTIVE") {
      return reply.status(403).send({ error: "Account is not active" });
    }

    if (user.institution.status !== "ACTIVE") {
      return reply.status(403).send({ error: "Institution is suspended" });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }

    // Legacy default: some imported students were given bcrypt(enrollmentNo) as
    // their password. It is rejected here (no data rewrite); those users recover
    // through Forgot password. Plain comparison on a password that already verified.
    if (user.studentProfile && password === user.studentProfile.enrollmentNo) {
      return reply.status(403).send({ error: NOT_ACTIVATED_MESSAGE });
    }

    // Update last login
    await privilegedPrisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Resolve the canonical dual-shape claims (design §6.1). SUPER_ADMIN has no
    // membership: platform roles/permissions, null membershipId/version.
    let membershipId: string | null = null;
    let roles: string[];
    let permissions: string[];
    let permissionsVersion: number | null = null;

    if (user.role === "SUPER_ADMIN") {
      roles = ["SUPER_ADMIN"];
      permissions = SUPER_ADMIN_PERMISSIONS;
    } else {
      // Pre-tenant-context read (privilegedPrisma): RLS membership/role tables
      // would fail-closed without a tenant GUC (§6.3).
      const membership = await privilegedPrisma.institutionMembership.findUnique({
        where: {
          userId_institutionId: { userId: user.id, institutionId: user.institutionId },
        },
        select: {
          id: true,
          permissionsVersion: true,
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

      if (!membership) {
        // A non-superadmin with no active membership cannot be authorized for
        // any tenant action — fail-closed (mirrors the authenticate pipeline).
        return reply.status(403).send({ error: "No active membership" });
      }

      membershipId = membership.id;
      roles = [...new Set(membership.roles.map((mr) => mr.role.key))].sort();
      permissions = resolvePermissions(membership.roles);
      permissionsVersion = membership.permissionsVersion;
    }

    // Include a unique jti so sessions can be individually revoked. The token
    // carries BOTH the new shape AND the retained legacy `role` claim (§6.1).
    const jti = randomUUID();
    const token = app.jwt.sign({
      userId: user.id,
      membershipId,
      institutionId: user.institutionId,
      roles,
      permissions,
      permissionsVersion,
      role: user.role,
      jti,
    });

    // Persist session for device management
    const ua = request.headers["user-agent"];
    const { deviceType, browser, os } = parseDevice(ua);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h matches JWT expiry
    await privilegedPrisma.session.create({
      data: {
        userId: user.id,
        jti,
        deviceType,
        browser,
        os,
        ipAddress: request.ip || null,
        expiresAt,
      },
    });

    // Log security event
    await privilegedPrisma.securityEvent.create({
      data: {
        userId: user.id,
        institutionId: user.institutionId,
        eventType: "LOGIN_SUCCESS",
        ipAddress: request.ip || null,
        deviceInfo: `${browser} on ${os} (${deviceType})`,
      },
    });

    return reply.send({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        accountStatus: user.accountStatus,
        profile: user.studentProfile || user.hodProfile || user.guardProfile,
      },
    });
  });

  // ─── SELF-REGISTER (new accounts only; pending admin approval) ────────────
  app.post("/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const { email, password, name, enrollmentNo, departmentId, program, semester, section } =
      parsed.data;

    if (!isSelfRegistrationEnabled()) {
      return reply
        .status(403)
        .send({ error: "Self-registration is disabled. Please contact your institution." });
    }

    // Soft per-IP limit (a campus can share one public IP) and a per-email limit.
    if (!enforce(limiters.registerIp, clientIpKey(request), reply)) return reply;
    if (!enforce(limiters.registerEmail, hashKey(email), reply)) return reply;

    // /login rejects a password equal to the enrollment number (legacy default),
    // so refuse it here instead of creating an account that cannot sign in.
    if (password === enrollmentNo) {
      return reply.status(400).send({ error: "Choose a different password." });
    }

    // Get the department's institution
    const department = await privilegedPrisma.department.findUnique({
      where: { id: departmentId },
      include: { institution: { select: { status: true } } },
    });
    if (!department) {
      return reply.status(400).send({ error: "Invalid department" });
    }

    if (department.institution.status !== "ACTIVE") {
      return reply.status(403).send({ error: "Institution is suspended" });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // An existing account (any role, any enrollment number) is never modified
    // here: passwordless/imported accounts activate only through an emailed
    // single-use token (/activate). The match is case-insensitive so a case
    // variant cannot slip past the check.
    const existingByEmail = await privilegedPrisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });
    if (existingByEmail) {
      return reply.status(409).send({ error: "Email already registered" });
    }

    // Check enrollment collision for new self-registration
    const existingEnrollment = await privilegedPrisma.studentProfile.findUnique({
      where: { enrollmentNo },
    });
    if (existingEnrollment) {
      return reply.status(409).send({ error: "Enrollment number already registered" });
    }

    // Best-effort structured program resolution (§3.4 / §7.2 — never fatal; a
    // null structured link is a legal state). The free-text `program` column is
    // the operational source of truth and is always written below.
    const matchedProgram = await privilegedPrisma.program.findFirst({
      where: { institutionId: department.institutionId, OR: [{ code: program }, { name: program }] },
      select: { id: true },
    });

    // Create user + student profile (awaiting admin approval). Student lifecycle
    // `status` defaults ACTIVE at the DB (tracks the student lifecycle, not the
    // PENDING_APPROVAL account lifecycle — §7.2/§7.5); no code change needed.
    const user = await privilegedPrisma.user.create({
      data: {
        email,
        passwordHash,
        role: "STUDENT",
        accountStatus: "PENDING_APPROVAL",
        institutionId: department.institutionId,
        studentProfile: {
          create: {
            name,
            enrollmentNo,
            departmentId,
            institutionId: department.institutionId,
            program,
            semester,
            section,
            ...(matchedProgram ? { programId: matchedProgram.id } : {}),
          },
        },
      },
      include: { studentProfile: true },
    });

    // Let admins know there is a registration waiting for approval.
    // The notification rows are tenant-owned, so run the fan-out inside the
    // tenant context (institutionId derived from the department, server-side)
    // so the writes satisfy the RLS WITH CHECK policy.
    await withTenant(department.institutionId, (tx) =>
      notifyInstitutionAdmins(
        department.institutionId,
        {
          title: "New Student Registration",
          body: `${name} (${enrollmentNo}) registered and is awaiting approval.`,
          type: "REGISTRATION_PENDING",
          data: { userId: user.id },
        },
        tx,
      ),
    );

    return reply.status(201).send({
      activation: false,
      message: "Registration submitted. Awaiting admin approval.",
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        accountStatus: user.accountStatus,
      },
    });
  });

  // ─── GET CURRENT USER ──────────────────────────────────────────────────────
  app.get("/me", { preHandler: [authenticate] }, async (request, reply) => {
    const { userId } = request.user;

    const user = await privilegedPrisma.user.findUnique({
      where: { id: userId },
      include: {
        studentProfile: { include: { department: true } },
        hodProfile: { include: { department: true } },
        guardProfile: { include: { assignedGates: { include: { gate: true } } } },
        institution: true,
      },
    });

    if (!user) {
      return reply.status(404).send({ error: "User not found" });
    }

    return reply.send({
      id: user.id,
      email: user.email,
      role: user.role,
      accountStatus: user.accountStatus,
      institution: { id: user.institution.id, name: user.institution.name },
      profile: user.studentProfile || user.hodProfile || user.guardProfile,
    });
  });

  // ─── LOGOUT (revoke current session) ───────────────────────────────────────
  app.post("/logout", { preHandler: [authenticate] }, async (request, reply) => {
    const { userId } = request.user;
    const jti = (request.user as any).jti as string | undefined;

    if (jti) {
      await privilegedPrisma.session.updateMany({
        where: { jti, userId },
        data: { revoked: true, revokedAt: new Date(), revokedReason: "user_logout" },
      });
    }

    await privilegedPrisma.securityEvent.create({
      data: {
        userId,
        eventType: "LOGOUT",
        ipAddress: request.ip || null,
      },
    });

    return reply.send({ success: true });
  });

  // ─── LIST SESSIONS ────────────────────────────────────────────────────────
  app.get("/sessions", { preHandler: [authenticate] }, async (request, reply) => {
    const { userId } = request.user;
    const currentJti = (request.user as any).jti as string | undefined;

    const sessions = await privilegedPrisma.session.findMany({
      where: { userId, revoked: false, expiresAt: { gte: new Date() } },
      orderBy: { lastActiveAt: "desc" },
    });

    return reply.send(
      sessions.map((s) => ({
        id: s.id,
        isCurrent: s.jti === currentJti,
        deviceType: s.deviceType,
        browser: s.browser,
        os: s.os,
        ipAddress: s.ipAddress,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
      }))
    );
  });

  // ─── REVOKE A SPECIFIC SESSION ────────────────────────────────────────────
  app.delete("/sessions/:sessionId", { preHandler: [authenticate] }, async (request, reply) => {
    const { userId } = request.user;
    const { sessionId } = request.params as { sessionId: string };

    const session = await privilegedPrisma.session.findFirst({
      where: { id: sessionId, userId },
    });
    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }

    await privilegedPrisma.session.update({
      where: { id: sessionId },
      data: { revoked: true, revokedAt: new Date(), revokedReason: "user_revoked" },
    });

    await privilegedPrisma.securityEvent.create({
      data: {
        userId,
        eventType: "SESSION_REVOKED",
        ipAddress: request.ip || null,
        metadata: { revokedSessionId: sessionId },
      },
    });

    return reply.send({ success: true });
  });

  // ─── REVOKE ALL OTHER SESSIONS ────────────────────────────────────────────
  app.post("/sessions/revoke-all", { preHandler: [authenticate] }, async (request, reply) => {
    const { userId } = request.user;
    const currentJti = (request.user as any).jti as string | undefined;

    const result = await privilegedPrisma.session.updateMany({
      where: {
        userId,
        revoked: false,
        ...(currentJti ? { jti: { not: currentJti } } : {}),
      },
      data: { revoked: true, revokedAt: new Date(), revokedReason: "revoke_all" },
    });

    await privilegedPrisma.securityEvent.create({
      data: {
        userId,
        eventType: "SESSION_REVOKED",
        ipAddress: request.ip || null,
        metadata: { count: result.count, action: "revoke_all_others" },
      },
    });

    return reply.send({ success: true, revoked: result.count });
  });
}
