import type { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import bcrypt from "bcrypt";
import { prisma } from "@campusgate/db";
import { loginSchema, registerSchema } from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { notifyInstitutionAdmins } from "../services/notifications.js";

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
    const departments = await prisma.department.findMany({
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

    const user = await prisma.user.findUnique({
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
          error: "Account not activated. Please complete first-time registration to set your password.",
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

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Include a unique jti so sessions can be individually revoked
    const jti = randomUUID();
    const token = app.jwt.sign({
      userId: user.id,
      role: user.role,
      institutionId: user.institutionId,
      jti,
    });

    // Persist session for device management
    const ua = request.headers["user-agent"];
    const { deviceType, browser, os } = parseDevice(ua);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h matches JWT expiry
    await prisma.session.create({
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
    await prisma.securityEvent.create({
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

  // ─── REGISTER / FIRST-TIME ACTIVATION (student) ───────────────────────────
  app.post("/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const { email, password, name, enrollmentNo, departmentId, program, semester, section } =
      parsed.data;

    // Get the department's institution
    const department = await prisma.department.findUnique({
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

    // If a user already exists with this email, attempt first-time activation flow
    const existingByEmail = await prisma.user.findUnique({
      where: { email },
      include: { studentProfile: true },
    });

    if (existingByEmail) {
      if (existingByEmail.role !== "STUDENT" || !existingByEmail.studentProfile) {
        return reply.status(409).send({ error: "Email already registered" });
      }

      const profile = existingByEmail.studentProfile;
      if (profile.enrollmentNo !== enrollmentNo) {
        return reply.status(409).send({ error: "Enrollment number does not match imported record" });
      }

      if (existingByEmail.institutionId !== department.institutionId) {
        return reply.status(409).send({ error: "Email belongs to a different institution" });
      }

      const canActivateWithoutPassword = !existingByEmail.passwordHash;
      const canActivateWithLegacyDefault =
        !!existingByEmail.passwordHash &&
        (await bcrypt.compare(enrollmentNo, existingByEmail.passwordHash));

      if (!canActivateWithoutPassword && !canActivateWithLegacyDefault) {
        return reply.status(409).send({
          error: "Account already activated. Please sign in instead.",
        });
      }

      const activated = await prisma.user.update({
        where: { id: existingByEmail.id },
        data: {
          passwordHash,
          accountStatus: "ACTIVE",
          studentProfile: {
            update: {
              name,
              departmentId,
              program,
              semester,
              section,
            },
          },
        },
        include: { studentProfile: true },
      });

      return reply.send({
        activation: true,
        message: "Account activated successfully. You can now sign in.",
        user: {
          id: activated.id,
          email: activated.email,
          role: activated.role,
          accountStatus: activated.accountStatus,
        },
      });
    }

    // Check enrollment collision for new self-registration
    const existingEnrollment = await prisma.studentProfile.findUnique({
      where: { enrollmentNo },
    });
    if (existingEnrollment) {
      return reply.status(409).send({ error: "Enrollment number already registered" });
    }

    // Create user + student profile (awaiting admin approval)
    const user = await prisma.user.create({
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
            program,
            semester,
            section,
          },
        },
      },
      include: { studentProfile: true },
    });

    // Let admins know there is a registration waiting for approval
    await notifyInstitutionAdmins(department.institutionId, {
      title: "New Student Registration",
      body: `${name} (${enrollmentNo}) registered and is awaiting approval.`,
      type: "REGISTRATION_PENDING",
      data: { userId: user.id },
    });

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

    const user = await prisma.user.findUnique({
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
      await prisma.session.updateMany({
        where: { jti, userId },
        data: { revoked: true, revokedAt: new Date(), revokedReason: "user_logout" },
      });
    }

    await prisma.securityEvent.create({
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

    const sessions = await prisma.session.findMany({
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

    const session = await prisma.session.findFirst({
      where: { id: sessionId, userId },
    });
    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }

    await prisma.session.update({
      where: { id: sessionId },
      data: { revoked: true, revokedAt: new Date(), revokedReason: "user_revoked" },
    });

    await prisma.securityEvent.create({
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

    const result = await prisma.session.updateMany({
      where: {
        userId,
        revoked: false,
        ...(currentJti ? { jti: { not: currentJti } } : {}),
      },
      data: { revoked: true, revokedAt: new Date(), revokedReason: "revoke_all" },
    });

    await prisma.securityEvent.create({
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
