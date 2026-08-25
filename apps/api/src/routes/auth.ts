import type { FastifyInstance } from "fastify";
import bcrypt from "bcrypt";
import { prisma } from "@campusgate/db";
import { loginSchema, registerSchema } from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { notifyInstitutionAdmins } from "../services/notifications.js";

export async function authRoutes(app: FastifyInstance) {
  // ─── PUBLIC DEPARTMENTS (for registration form) ────────────────────────────
  app.get("/departments", async (_request, reply) => {
    const departments = await prisma.department.findMany({
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
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
      },
    });

    if (!user || !user.passwordHash) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }

    if (user.accountStatus !== "ACTIVE") {
      return reply.status(403).send({ error: "Account is not active" });
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

    const token = app.jwt.sign({
      userId: user.id,
      role: user.role,
      institutionId: user.institutionId,
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

  // ─── REGISTER (student self-registration) ──────────────────────────────────
  app.post("/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const { email, password, name, enrollmentNo, departmentId, program, semester, section } =
      parsed.data;

    // Check existing
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return reply.status(409).send({ error: "Email already registered" });
    }

    const existingEnrollment = await prisma.studentProfile.findUnique({
      where: { enrollmentNo },
    });
    if (existingEnrollment) {
      return reply.status(409).send({ error: "Enrollment number already registered" });
    }

    // Get the department's institution
    const department = await prisma.department.findUnique({
      where: { id: departmentId },
    });
    if (!department) {
      return reply.status(400).send({ error: "Invalid department" });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Create user + student profile in transaction
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        role: "STUDENT",
        accountStatus: "PENDING_APPROVAL", // Admin must approve
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
}
