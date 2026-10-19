import type { FastifyInstance } from "fastify";
import bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import { privilegedPrisma, InstitutionStatus } from "@campusgate/db";
import { requireSuperAdmin } from "../middleware/auth.js";
import { requirePermission } from "../services/authz-engine.js";
import { requirePlatformMfa, requireStepUp } from "../middleware/step-up.js";
import { recordAuditEvent } from "../services/audit.js";
import {
  createSupportGrant,
  createSupportGrantSchema,
  listSupportGrants,
  revokeSupportGrantAsPlatform,
  breakGlassReadTenant,
  readPlatformAuditEvents,
} from "../services/support-grant.js";

export async function platformRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSuperAdmin());
  // Mandatory-MFA gate for platform accounts, AFTER requireSuperAdmin (design
  // §5.3). A platform.* holder without mfaEnabled is 403'd on every platform
  // route except the MFA-enrollment endpoints (which live on the mfa plugin).
  app.addHook("preHandler", requirePlatformMfa());

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
      privilegedPrisma.institution.count(),
      privilegedPrisma.institution.count({ where: { status: "ACTIVE" } }),
      privilegedPrisma.institution.count({ where: { status: "SUSPENDED" } }),
      privilegedPrisma.user.count(),
      privilegedPrisma.user.count({ where: { role: "STUDENT" } }),
      privilegedPrisma.gatePass.count(),
      privilegedPrisma.gatePass.count({ where: { status: "OUTSIDE" } }),
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
    const institutions = await privilegedPrisma.institution.findMany({
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

    const existingInstitution = await privilegedPrisma.institution.findUnique({
      where: { code },
    });
    if (existingInstitution) {
      return reply.status(409).send({ error: "Institution code already exists" });
    }

    const existingAdminUser = await privilegedPrisma.user.findUnique({ where: { email: adminEmail } });
    if (existingAdminUser) {
      return reply.status(409).send({ error: "Admin email already in use" });
    }

    const tempPassword = randomBytes(9).toString("base64url");
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const result = await privilegedPrisma.$transaction(async (tx) => {
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

    const existing = await privilegedPrisma.institution.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ error: "Institution not found" });
    }

    const updated = await privilegedPrisma.institution.update({
      where: { id },
      data: { status },
    });

    return reply.send(updated);
  });

  // ─── SUPPORT GRANTS (break-glass) ──────────────────────────────────────────

  const actorOf = (request: {
    auth?: { userId: string; roles: string[] };
    user: { userId: string; role: string };
    id: string;
  }) => ({
    userId: request.auth?.userId ?? request.user.userId,
    roleKey: request.auth?.roles[0] ?? request.user.role,
    requestRef: request.id,
  });

  // Create a grant — requires platform.support.grant AND a fresh step-up token
  // bound to action class support_grant.create (design §7.1).
  app.post(
    "/support-grants",
    {
      preHandler: [
        requirePermission("platform.support.grant"),
        requireStepUp("support_grant.create"),
      ],
    },
    async (request, reply) => {
      const parsed = createSupportGrantSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
      }

      const result = await createSupportGrant(parsed.data, actorOf(request));
      if (!result.ok) {
        return reply.status(404).send({ error: "Institution not found" });
      }
      return reply.status(201).send(result.grant);
    },
  );

  // Revoke a grant (platform path; lower-risk than create, so no step-up).
  app.delete(
    "/support-grants/:id",
    { preHandler: [requirePermission("platform.support.grant")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { reason } = (request.body ?? {}) as { reason?: string };
      const updated = await revokeSupportGrantAsPlatform(id, reason, actorOf(request));
      if (!updated) return reply.status(404).send({ error: "Support grant not found" });
      return reply.send(updated);
    },
  );

  // List grants (platform operator view) + opportunistic expiry.
  app.get(
    "/support-grants",
    { preHandler: [requirePermission("platform.support.grant")] },
    async (request, reply) => {
      const { institutionId, status } = request.query as {
        institutionId?: string;
        status?: string;
      };
      const grants = await listSupportGrants(
        {
          institutionId,
          status: status as Parameters<typeof listSupportGrants>[0]["status"],
        },
        actorOf(request),
      );
      return reply.send(grants);
    },
  );

  // Break-glass read proxy — the granted tenant's recent audit_events + passes.
  app.get(
    "/support-grants/:id/tenant/overview",
    { preHandler: [requirePermission("platform.support.grant")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await breakGlassReadTenant(id, actorOf(request));
      if (!result.ok) {
        if (result.reason === "auditWriteFailed") {
          return reply.status(500).send({ error: "Audit write failed" });
        }
        if (result.reason === "institutionSuspended") {
          return reply.status(403).send({ error: "Institution suspended" });
        }
        return reply.status(403).send({ error: "Break-glass access denied" });
      }
      return reply.send(result.data);
    },
  );

  // Super-Admin audit explorer: scope=platform (institutionId null) or
  // scope=grant (validate ACTIVE grant, filter to its tenant).
  app.get(
    "/audit-events",
    { preHandler: [requirePermission("platform.security.respond")] },
    async (request, reply) => {
      const { scope = "platform", grantId, limit } = request.query as {
        scope?: "platform" | "grant";
        grantId?: string;
        limit?: string;
      };
      if (scope !== "platform" && scope !== "grant") {
        return reply.status(400).send({ error: "scope must be platform or grant" });
      }
      const result = await readPlatformAuditEvents(
        { scope, grantId, limit: limit ? parseInt(limit, 10) : undefined },
        actorOf(request),
      );
      if (!result.ok) {
        if (result.reason === "missingGrantId") {
          return reply.status(400).send({ error: "grantId is required for scope=grant" });
        }
        return reply.status(403).send({ error: "Grant access denied" });
      }
      return reply.send({ events: result.events });
    },
  );
}
