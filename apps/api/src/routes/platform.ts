import type { FastifyInstance } from "fastify";
import bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import { prisma, InstitutionStatus } from "@campusgate/db";
import { requireSuperAdmin } from "../middleware/auth.js";

export async function platformRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSuperAdmin());

  // Platform overview stats
  app.get("/stats", async (_request, reply) => {
    const [
      institutionsTotal,
      institutionsActive,
      institutionsSuspended,
      totalUsers,
      totalStudents,
      totalPasses,
      totalOutside,
    ] = await Promise.all([
      prisma.institution.count(),
      prisma.institution.count({ where: { status: "ACTIVE" } }),
      prisma.institution.count({ where: { status: "SUSPENDED" } }),
      prisma.user.count(),
      prisma.user.count({ where: { role: "STUDENT" } }),
      prisma.gatePass.count(),
      prisma.gatePass.count({ where: { status: "OUTSIDE" } }),
    ]);

    return reply.send({
      institutions: {
        total: institutionsTotal,
        active: institutionsActive,
        suspended: institutionsSuspended,
      },
      users: {
        total: totalUsers,
        students: totalStudents,
      },
      movement: {
        totalPasses,
        currentlyOutside: totalOutside,
      },
    });
  });

  // List institutions with tenant-level summaries
  app.get("/institutions", async (_request, reply) => {
    const institutions = await prisma.institution.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: {
            users: true,
            departments: true,
            gates: true,
            exitReasons: true,
          },
        },
      },
    });

    return reply.send(institutions);
  });

  // Create institution + bootstrap first institution admin
  app.post("/institutions", async (request, reply) => {
    const { name, code, domain, adminEmail } = request.body as {
      name?: string;
      code?: string;
      domain?: string;
      adminEmail?: string;
    };

    if (!name || !code || !adminEmail) {
      return reply
        .status(400)
        .send({ error: "name, code and adminEmail are required" });
    }

    const existingInstitution = await prisma.institution.findUnique({
      where: { code },
    });
    if (existingInstitution) {
      return reply.status(409).send({ error: "Institution code already exists" });
    }

    const existingAdminUser = await prisma.user.findUnique({ where: { email: adminEmail } });
    if (existingAdminUser) {
      return reply.status(409).send({ error: "Admin email already in use" });
    }

    const tempPassword = randomBytes(9).toString("base64url");
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const result = await prisma.$transaction(async (tx) => {
      const institution = await tx.institution.create({
        data: {
          name,
          code,
          domain,
          status: "ACTIVE",
        },
      });

      const admin = await tx.user.create({
        data: {
          email: adminEmail,
          passwordHash,
          role: "ADMIN",
          accountStatus: "ACTIVE",
          institutionId: institution.id,
        },
      });

      return { institution, admin };
    });

    return reply.status(201).send({
      institution: result.institution,
      admin: {
        id: result.admin.id,
        email: result.admin.email,
        role: result.admin.role,
      },
      tempPassword,
    });
  });

  // Update institution status (active/suspended)
  app.put("/institutions/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status } = request.body as { status?: InstitutionStatus };

    if (!status || (status !== "ACTIVE" && status !== "SUSPENDED")) {
      return reply.status(400).send({ error: "status must be ACTIVE or SUSPENDED" });
    }

    const existing = await prisma.institution.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ error: "Institution not found" });
    }

    const updated = await prisma.institution.update({
      where: { id },
      data: { status },
    });

    return reply.send(updated);
  });
}
