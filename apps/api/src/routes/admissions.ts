import type { FastifyInstance, FastifyRequest } from "fastify";
import bcrypt from "bcrypt";
import { withTenant, privilegedPrisma, Prisma } from "@campusgate/db";
import {
  admissionRegisterSchema,
  campaignConfigSchema,
  createCampaignSchema,
  updateCampaignSchema,
  createApplicationSchema,
  addApplicationDocumentSchema,
  changeApplicationStatusSchema,
  submitApplicationSchema,
  withdrawApplicationSchema,
  recordApplicationReviewSchema,
  setApplicationInterviewSchema,
  issueOfferSchema,
  acceptOfferSchema,
  declineOfferSchema,
  expireOfferSchema,
  enrollApplicationSchema,
} from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission, requireModuleActive } from "../services/authz-engine.js";
import { recordAuditEvent } from "../services/audit.js";
import { notifyUser } from "../services/notifications.js";
import { assertTransition, isTerminal, type ApplicationStatus } from "../services/admissions-state.js";
import {
  planEnrollment,
  CROSS_PERSON_MESSAGE,
  type ApplicantSnapshot,
  type StudentProfileSnapshot,
} from "../services/admissions-enroll.js";

const MODULE_KEY = "admissions" as const;
const APPLICANT_ROLE_KEY = "APPLICANT" as const;
const BCRYPT_ROUNDS = 12;

/**
 * Admissions routes (design §7), registered at `/api/admissions` (see server.ts).
 * Admissions is a GATED module — every OPERATIONAL route carries
 * `requireModuleActive("admissions")` IN ADDITION to `requirePermission(...)`
 * (the library/attendance precedent). The ONE exception is the PUBLIC
 * `POST /register`, which carries NO `authenticate`/`requirePermission` and reads
 * the tenant from the validated body.
 *
 * House pattern (mirrors library.ts):
 *  - a single top-level `authenticate` preHandler (the public /register route is
 *    declared BEFORE the hook so it stays unauthenticated);
 *  - per-route `requirePermission(key)` AND `requireModuleActive("admissions")`;
 *  - every handler runs inside `withTenant(institutionId, tx => ...)` with
 *    `institutionId` from the verified token (`request.user`), never from input —
 *    the ONLY exception being PUBLIC /register (tenant from the body);
 *  - every mutation writes an `admissions.*` AuditEvent via `recordAuditEvent` in
 *    the SAME transaction; deny branches record a DENIED audit then RETURN the
 *    4xx from a normally-returning `withTenant` callback (never `throw`);
 *  - applicant communication reuses `notifyUser(userId, payload, tx)` inside the
 *    tx on offer-issued / status-changed / rejected / enrolled;
 *  - recorded actor ids (verifiedByUserId, reviewerUserId, enrolledByUserId) are
 *    always `request.user.userId`, never body/param.
 *
 * `canOnResource` is NOT used (commented-out stub in authz-engine.ts); ownership
 * scoping is the inline `applicantUserId = request.user.userId` filter layered on
 * tenant RLS.
 */
export async function admissionsRoutes(app: FastifyInstance) {
  const gate = MODULE_KEY;

  function actor(request: FastifyRequest) {
    return {
      actorUserId: request.user.userId,
      actorRoleKey: request.auth?.roles[0] ?? request.user.role,
      actorMembershipId: request.auth?.membershipId ?? null,
      requestRef: request.id,
    };
  }

  function normalizeEmail(raw: string): string {
    return raw.trim().toLowerCase();
  }

  function isUniqueViolation(err: unknown, indexHint?: string): boolean {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      if (!indexHint) return true;
      const target = err.meta?.target;
      const asText = Array.isArray(target) ? target.join(",") : String(target ?? "");
      return asText.includes(indexHint);
    }
    return false;
  }

  // Resolve the APPLICANT template role id (roles rows are global/template —
  // institutionId NULL, NO RLS — readable under any context). The seed creates it
  // via seedRbacCatalogue; a fresh DB that has never seeded would be missing it.
  async function applicantRoleId(tx: Prisma.TransactionClient): Promise<string | null> {
    const role = await tx.role.findFirst({
      where: { key: APPLICANT_ROLE_KEY, institutionId: null },
      select: { id: true },
    });
    return role?.id ?? null;
  }

  /**
   * Resolve-or-create the applicant identity inside the tenant (design §1 / §7
   * officer-on-behalf): reuse the User if present, add the ACTIVE membership +
   * APPLICANT role if missing (additive, no new identity), or create the whole
   * identity. Creates NO StudentProfile. Returns the applicant User.id or an
   * error marker. Runs inside the caller's withTenant tx.
   */
  async function resolveOrCreateApplicant(
    tx: Prisma.TransactionClient,
    institutionId: string,
    args: { email: string; name?: string | null; password?: string | null },
  ): Promise<{ userId: string } | { error: "role_missing" } | { error: "email_taken" }> {
    const email = normalizeEmail(args.email);
    const roleId = await applicantRoleId(tx);
    if (!roleId) return { error: "role_missing" };

    let user = await tx.user.findFirst({
      where: { email, institutionId },
      select: { id: true },
    });

    if (!user) {
      // A globally-unique email may belong to a different tenant (RLS hides it);
      // the create then fails the global unique → surface as email_taken.
      const passwordHash = args.password
        ? await bcrypt.hash(args.password, BCRYPT_ROUNDS)
        : null;
      try {
        // NOTE: the User model carries no `name` column; an applicant's display
        // name travels on Application.formData and is materialized onto the
        // StudentProfile at enroll (design §4).
        user = await tx.user.create({
          data: {
            email,
            passwordHash,
            role: "STUDENT", // inert legacy enum — capability from the APPLICANT role
            accountStatus: "ACTIVE",
            institutionId,
          },
          select: { id: true },
        });
      } catch (err) {
        if (isUniqueViolation(err)) return { error: "email_taken" };
        throw err;
      }
    }

    const membership = await tx.institutionMembership.upsert({
      where: { userId_institutionId: { userId: user.id, institutionId } },
      update: {},
      create: { userId: user.id, institutionId, membershipStatus: "ACTIVE", permissionsVersion: 0 },
      select: { id: true },
    });

    await tx.membershipRole.upsert({
      where: { membershipId_roleId: { membershipId: membership.id, roleId } },
      update: {},
      create: { membershipId: membership.id, roleId, institutionId },
    });

    return { userId: user.id };
  }

  // Parse the campaign config JSON into the bounded { requiredFields,
  // requiredDocTypes } shape (defaults to empty arrays for a malformed/absent blob).
  function parseCampaignConfig(raw: unknown): { requiredFields: string[]; requiredDocTypes: string[] } {
    const parsed = campaignConfigSchema.safeParse(raw ?? {});
    if (parsed.success) return parsed.data;
    return { requiredFields: [], requiredDocTypes: [] };
  }

  // The campaign's offered program ids = targetProgramId (if set) ∪ the join rows.
  async function campaignProgramIds(
    tx: Prisma.TransactionClient,
    institutionId: string,
    campaignId: string,
    targetProgramId: string | null,
  ): Promise<Set<string>> {
    const rows = await tx.admissionCampaignProgram.findMany({
      where: { institutionId, campaignId },
      select: { programId: true },
    });
    const set = new Set(rows.map((r) => r.programId));
    if (targetProgramId) set.add(targetProgramId);
    return set;
  }

  // Load the live (ISSUED or ACCEPTED) offer for an application, if any.
  async function liveOffer(tx: Prisma.TransactionClient, institutionId: string, applicationId: string) {
    return tx.admissionOffer.findFirst({
      where: { institutionId, applicationId, status: { in: ["ISSUED", "ACCEPTED"] } },
      select: { id: true, status: true, offeredProgramId: true },
    });
  }

  // Pagination helper for the staff list routes.
  function pageParams(query: unknown): { page: number; pageSize: number } {
    const q = (query ?? {}) as Record<string, unknown>;
    const page = Math.max(1, Number.parseInt(String(q.page ?? "1"), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(q.pageSize ?? "20"), 10) || 20));
    return { page, pageSize };
  }

  // ─── PUBLIC APPLICANT ONBOARDING (declared BEFORE the authenticate hook) ──────
  // POST /register — create a User (role STUDENT inert) + ACTIVE membership +
  // APPLICANT membership role, NO StudentProfile. Tenant from the validated body
  // (the ONE documented exception to "institutionId from the token"). Module gate
  // only; no authenticate/requirePermission.
  app.post("/register", { preHandler: [requireModuleActivePublic(MODULE_KEY)] }, async (request, reply) => {
    const parsed = admissionRegisterSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const { institutionId, email, password, name } = parsed.data;

    // Validate the tenant exists + is ACTIVE (privileged, pre-tenant read).
    const institution = await privilegedPrisma.institution.findUnique({
      where: { id: institutionId },
      select: { id: true, status: true },
    });
    if (!institution) return reply.status(404).send({ error: "institution not found" });
    if (institution.status !== "ACTIVE") return reply.status(403).send({ error: "institution not active" });

    const outcome = await withTenant(institutionId, async (tx) => {
      // Same-tenant duplicate email → 409 (global unique caught separately).
      const existing = await tx.user.findFirst({ where: { email: normalizeEmail(email) }, select: { id: true } });
      if (existing) return { conflict: "email already registered" as const };

      const resolved = await resolveOrCreateApplicant(tx, institutionId, { email, name, password });
      if ("error" in resolved) {
        if (resolved.error === "email_taken") return { conflict: "email already registered" as const };
        return { unprocessable: "applicant role not provisioned" as const };
      }

      await recordAuditEvent(
        {
          action: "admissions.applicant.registered",
          result: "SUCCESS",
          actorUserId: resolved.userId,
          actorRoleKey: APPLICANT_ROLE_KEY,
          actorMembershipId: null,
          requestRef: request.id,
          institutionId,
          resourceType: "User",
          resourceId: resolved.userId,
        },
        tx,
      );
      return { userId: resolved.userId };
    });

    if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
    if ("unprocessable" in outcome) return reply.status(422).send({ error: outcome.unprocessable });
    return reply.status(201).send({ applicant: { id: outcome.userId, email: normalizeEmail(email), name } });
  });

  // ─── AUTHENTICATED SURFACE ────────────────────────────────────────────────────
  // Every route below is registered inside an ENCAPSULATED child plugin whose
  // `preHandler` hook is `authenticate`. Encapsulation is what keeps the hook OFF
  // the PUBLIC `/register` route above: a `preHandler` added via `addHook` applies
  // to EVERY route in its encapsulation context regardless of declaration order,
  // so declaring `/register` before `addHook` on the SAME instance would NOT
  // exempt it (Fastify hook semantics). Moving the authenticated routes into their
  // own `register` scope is the standard Fastify idiom for a public-route-in-a-
  // plugin; `/register` stays on the outer (hook-free) instance, and every route
  // here keeps `authenticate` + per-route `requirePermission` + `requireModuleActive`.
  // The enclosing `admissionsRoutes` scope (helpers like `actor`,
  // `resolveOrCreateApplicant`, `denyEnroll`, …) is reachable by closure.
  await app.register(async (app) => {
    app.addHook("preHandler", authenticate);

  // ═══ CAMPAIGNS (admissions.campaigns.manage / .applications.view) ═════════════

  // POST /campaigns — create a campaign.
  app.post(
    "/campaigns",
    { preHandler: [requirePermission("admissions.campaigns.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createCampaignSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        // Resolve optional references to tenant rows.
        if (data.intakeSessionId) {
          const s = await tx.academicSession.findFirst({
            where: { id: data.intakeSessionId, institutionId },
            select: { id: true },
          });
          if (!s) return { notFound: "intake session not found" as const };
        }
        if (data.targetProgramId) {
          const p = await tx.program.findFirst({
            where: { id: data.targetProgramId, institutionId },
            select: { id: true },
          });
          if (!p) return { notFound: "target program not found" as const };
        }
        const programIds = data.programIds ?? [];
        if (programIds.length > 0) {
          const found = await tx.program.findMany({
            where: { id: { in: programIds }, institutionId },
            select: { id: true },
          });
          if (found.length !== new Set(programIds).size) {
            return { unprocessable: "one or more programIds do not resolve" as const };
          }
        }

        let campaign;
        try {
          campaign = await tx.admissionCampaign.create({
            data: {
              institutionId,
              name: data.name,
              status: data.status ?? "DRAFT",
              intakeSessionId: data.intakeSessionId ?? null,
              targetProgramId: data.targetProgramId ?? null,
              openAt: data.openAt ? new Date(data.openAt) : null,
              closeAt: data.closeAt ? new Date(data.closeAt) : null,
              config: data.config ?? { requiredFields: [], requiredDocTypes: [] },
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { conflict: "campaign name already exists" as const };
          throw err;
        }

        for (const programId of new Set(programIds)) {
          await tx.admissionCampaignProgram.create({
            data: { institutionId, campaignId: campaign.id, programId },
          });
        }

        await recordAuditEvent(
          {
            action: "admissions.campaign.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "AdmissionCampaign",
            resourceId: campaign.id,
          },
          tx,
        );
        return { campaign };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: outcome.notFound });
      if ("unprocessable" in outcome) return reply.status(422).send({ error: outcome.unprocessable });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.status(201).send(outcome.campaign);
    },
  );

  // PATCH /campaigns/:id — update / open / close (status transitions via config).
  app.patch(
    "/campaigns/:id",
    { preHandler: [requirePermission("admissions.campaigns.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = updateCampaignSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const campaign = await tx.admissionCampaign.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!campaign) return { notFound: true as const };

        if (data.intakeSessionId) {
          const s = await tx.academicSession.findFirst({
            where: { id: data.intakeSessionId, institutionId },
            select: { id: true },
          });
          if (!s) return { notFoundMsg: "intake session not found" as const };
        }
        if (data.targetProgramId) {
          const p = await tx.program.findFirst({
            where: { id: data.targetProgramId, institutionId },
            select: { id: true },
          });
          if (!p) return { notFoundMsg: "target program not found" as const };
        }

        const prevStatus = campaign.status;
        const updated = await tx.admissionCampaign.update({
          where: { id: campaign.id },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.status !== undefined ? { status: data.status } : {}),
            ...("intakeSessionId" in data ? { intakeSessionId: data.intakeSessionId ?? null } : {}),
            ...("targetProgramId" in data ? { targetProgramId: data.targetProgramId ?? null } : {}),
            ...("openAt" in data ? { openAt: data.openAt ? new Date(data.openAt) : null } : {}),
            ...("closeAt" in data ? { closeAt: data.closeAt ? new Date(data.closeAt) : null } : {}),
            ...(data.config !== undefined ? { config: data.config } : {}),
          },
        });

        if (data.programIds) {
          const programIds = new Set(data.programIds);
          const found = await tx.program.findMany({
            where: { id: { in: [...programIds] }, institutionId },
            select: { id: true },
          });
          if (found.length !== programIds.size) {
            return { unprocessable: "one or more programIds do not resolve" as const };
          }
          await tx.admissionCampaignProgram.deleteMany({ where: { institutionId, campaignId: campaign.id } });
          for (const programId of programIds) {
            await tx.admissionCampaignProgram.create({
              data: { institutionId, campaignId: campaign.id, programId },
            });
          }
        }

        // Audit key reflects an open/close transition when status changed.
        let action: "admissions.campaign.updated" | "admissions.campaign.opened" | "admissions.campaign.closed" =
          "admissions.campaign.updated";
        if (data.status && data.status !== prevStatus) {
          if (data.status === "OPEN") action = "admissions.campaign.opened";
          else if (data.status === "CLOSED") action = "admissions.campaign.closed";
        }

        await recordAuditEvent(
          {
            action,
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "AdmissionCampaign",
            resourceId: campaign.id,
            metadata: { previousStatus: prevStatus, newStatus: updated.status },
          },
          tx,
        );
        return { campaign: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "campaign not found" });
      if ("notFoundMsg" in outcome) return reply.status(404).send({ error: outcome.notFoundMsg });
      if ("unprocessable" in outcome) return reply.status(422).send({ error: outcome.unprocessable });
      return reply.send(outcome.campaign);
    },
  );

  // GET /campaigns — staff list.
  app.get(
    "/campaigns",
    { preHandler: [requirePermission("admissions.applications.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { page, pageSize } = pageParams(request.query);

      const result = await withTenant(institutionId, async (tx) => {
        const where: Prisma.AdmissionCampaignWhereInput = { institutionId };
        const [total, campaigns] = await Promise.all([
          tx.admissionCampaign.count({ where }),
          tx.admissionCampaign.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
            include: { programs: { select: { programId: true } } },
          }),
        ]);
        return { total, campaigns };
      });

      return reply.send({ campaigns: result.campaigns, total: result.total, page, pageSize });
    },
  );

  // GET /campaigns/:id — staff detail.
  app.get(
    "/campaigns/:id",
    { preHandler: [requirePermission("admissions.applications.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const outcome = await withTenant(institutionId, async (tx) => {
        const campaign = await tx.admissionCampaign.findFirst({
          where: { id, institutionId },
          include: { programs: { select: { programId: true } } },
        });
        if (!campaign) return { notFound: true as const };
        return { campaign };
      });
      if ("notFound" in outcome) return reply.status(404).send({ error: "campaign not found" });
      return reply.send(outcome.campaign);
    },
  );

  // ═══ APPLICATIONS — STAFF READS (admissions.applications.view) ════════════════

  app.get(
    "/applications",
    { preHandler: [requirePermission("admissions.applications.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { page, pageSize } = pageParams(request.query);
      const q = (request.query ?? {}) as Record<string, unknown>;
      const statusFilter = typeof q.status === "string" ? (q.status as ApplicationStatus) : undefined;
      const campaignId = typeof q.campaignId === "string" ? q.campaignId : undefined;

      const result = await withTenant(institutionId, async (tx) => {
        const where: Prisma.ApplicationWhereInput = {
          institutionId,
          ...(statusFilter ? { status: statusFilter } : {}),
          ...(campaignId ? { campaignId } : {}),
        };
        const [total, applications] = await Promise.all([
          tx.application.count({ where }),
          tx.application.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
        ]);
        return { total, applications };
      });

      return reply.send({ applications: result.applications, total: result.total, page, pageSize });
    },
  );

  app.get(
    "/applications/:id",
    { preHandler: [requireModuleActive(gate)] },
    async (request, reply) => {
      // Staff (applications.view) see any application; applicants (view_own) see
      // only their own. Combined route with an ownership filter.
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const canViewAll = request.auth?.permissions.includes("admissions.applications.view") ?? false;
      const canViewOwn = request.auth?.permissions.includes("admissions.view_own") ?? false;
      if (!canViewAll && !canViewOwn) {
        return reply.status(403).send({ error: "Forbidden: missing permission admissions.applications.view" });
      }

      const outcome = await withTenant(institutionId, async (tx) => {
        const application = await tx.application.findFirst({
          where: {
            id,
            institutionId,
            ...(canViewAll ? {} : { applicantUserId: request.user.userId }),
          },
          include: {
            documents: { orderBy: { createdAt: "asc" } },
            offers: { orderBy: { offeredAt: "desc" } },
            ...(canViewAll ? { reviews: { orderBy: { reviewedAt: "asc" } } } : {}),
          },
        });
        if (!application) return { notFound: true as const };
        return { application };
      });
      if ("notFound" in outcome) return reply.status(404).send({ error: "application not found" });
      return reply.send(outcome.application);
    },
  );

  // GET /applications/mine — applicant's own applications.
  app.get(
    "/applications/mine",
    { preHandler: [requirePermission("admissions.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const result = await withTenant(institutionId, async (tx) => {
        return tx.application.findMany({
          where: { institutionId, applicantUserId: userId },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          include: { offers: { orderBy: { offeredAt: "desc" } } },
        });
      });
      return reply.send({ applications: result });
    },
  );

  // ═══ APPLICATIONS — CREATE (self-service + officer-on-behalf) ═════════════════
  // POST /applications. Self-service (admissions.view_own): applicantUserId forced
  // to the token. Officer-on-behalf (admissions.applications.manage): resolve/
  // create the applicant by email. The campaign must be OPEN; programId must be
  // one of the campaign's offered programs.
  app.post(
    "/applications",
    { preHandler: [requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const isOfficer = request.auth?.permissions.includes("admissions.applications.manage") ?? false;
      const isApplicant = request.auth?.permissions.includes("admissions.view_own") ?? false;
      if (!isOfficer && !isApplicant) {
        return reply.status(403).send({ error: "Forbidden: missing permission admissions.applications.manage" });
      }

      const parsed = createApplicationSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const campaign = await tx.admissionCampaign.findFirst({
          where: { id: data.campaignId, institutionId },
          select: { id: true, status: true, targetProgramId: true },
        });
        if (!campaign) return { notFound: "campaign not found" as const };
        if (campaign.status !== "OPEN") {
          await recordAuditEvent(
            {
              action: "admissions.application.submitted",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "Application",
              metadata: { reason: "campaign not open", campaignId: campaign.id },
            },
            tx,
          );
          return { conflict: "campaign is not open" as const };
        }

        const offered = await campaignProgramIds(tx, institutionId, campaign.id, campaign.targetProgramId);
        if (!offered.has(data.programId)) {
          return { unprocessable: "program is not offered by this campaign" as const };
        }

        // Resolve the applicant identity.
        let applicantUserId: string;
        if (isOfficer && data.applicantEmail) {
          const resolved = await resolveOrCreateApplicant(tx, institutionId, {
            email: data.applicantEmail,
            name: data.applicantName ?? null,
            password: null,
          });
          if ("error" in resolved) {
            if (resolved.error === "email_taken") return { conflict: "applicant email belongs to another tenant" as const };
            return { unprocessable: "applicant role not provisioned" as const };
          }
          applicantUserId = resolved.userId;
        } else {
          // Self-service (or officer without an email): force the token's user.
          applicantUserId = request.user.userId;
        }

        // Generate a per-institution unique application number.
        const applicationNumber = `APP-${Date.now().toString(36).toUpperCase()}-${Math.random()
          .toString(36)
          .slice(2, 7)
          .toUpperCase()}`;

        let application;
        try {
          application = await tx.application.create({
            data: {
              institutionId,
              campaignId: campaign.id,
              applicantUserId,
              programId: data.programId,
              status: "DRAFT",
              applicationNumber,
              formData: (data.formData ?? {}) as Prisma.InputJsonValue,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err, "applicantUserId")) {
            return { conflict: "an application already exists for this campaign" as const };
          }
          if (isUniqueViolation(err)) return { conflict: "duplicate application" as const };
          throw err;
        }

        await recordAuditEvent(
          {
            action: "admissions.application.submitted",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "Application",
            resourceId: application.id,
            metadata: { campaignId: campaign.id, programId: data.programId, draft: true },
          },
          tx,
        );
        return { application };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: outcome.notFound });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      if ("unprocessable" in outcome) return reply.status(422).send({ error: outcome.unprocessable });
      return reply.status(201).send(outcome.application);
    },
  );

  // ═══ APPLICATIONS — STATUS TRANSITION (staff, admissions.applications.manage) ══
  app.patch(
    "/applications/:id/status",
    { preHandler: [requirePermission("admissions.applications.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = changeApplicationStatusSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { status: target, reason } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const application = await tx.application.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true, applicantUserId: true },
        });
        if (!application) return { notFound: true as const };

        // Staff can NEVER PATCH straight to ACCEPTED (design §3): that is the sole
        // province of the offer-accept operation.
        if (target === "ACCEPTED") {
          await recordAuditEvent(
            {
              action: "admissions.application.status_changed",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "Application",
              resourceId: application.id,
              metadata: { reason: "direct ACCEPTED forbidden", from: application.status },
            },
            tx,
          );
          return { conflict: "ACCEPTED is set only by accepting an offer" as const };
        }
        // ENROLLED is only ever written by the enroll operation.
        if (target === "ENROLLED") {
          await recordAuditEvent(
            {
              action: "admissions.application.status_changed",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "Application",
              resourceId: application.id,
              metadata: { reason: "direct ENROLLED forbidden", from: application.status },
            },
            tx,
          );
          return { conflict: "ENROLLED is set only by enrolling an accepted application" as const };
        }

        const from = application.status as ApplicationStatus;
        const legal = assertTransition(from, target);
        if (!legal.ok) {
          await recordAuditEvent(
            {
              action: "admissions.application.status_changed",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "Application",
              resourceId: application.id,
              metadata: { reason: legal.message, from, to: target },
            },
            tx,
          );
          return { conflict: legal.message };
        }

        const isReject = target === "REJECTED";
        const updated = await tx.application.update({
          where: { id: application.id },
          data: {
            status: target,
            ...(isReject ? { rejectedAt: new Date() } : {}),
          },
        });

        await recordAuditEvent(
          {
            action: isReject ? "admissions.application.rejected" : "admissions.application.status_changed",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "Application",
            resourceId: application.id,
            metadata: { from, to: target, reason: reason ?? undefined },
          },
          tx,
        );

        await notifyUser(
          application.applicantUserId,
          {
            title: isReject ? "Application update" : "Application status changed",
            body: isReject
              ? "Your application was not successful."
              : `Your application status is now ${target}.`,
            type: "admissions.application.status",
            data: { applicationId: application.id, status: target },
          },
          tx,
        );
        return { application: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "application not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send(outcome.application);
    },
  );

  // POST /applications/:id/interview — set interviewAt (staff).
  app.post(
    "/applications/:id/interview",
    { preHandler: [requirePermission("admissions.applications.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = setApplicationInterviewSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const outcome = await withTenant(institutionId, async (tx) => {
        const application = await tx.application.findFirst({
          where: { id, institutionId },
          select: { id: true, applicantUserId: true },
        });
        if (!application) return { notFound: true as const };

        const updated = await tx.application.update({
          where: { id: application.id },
          data: { interviewAt: new Date(parsed.data.interviewAt) },
        });
        await recordAuditEvent(
          {
            action: "admissions.application.status_changed",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "Application",
            resourceId: application.id,
            metadata: { interviewAt: parsed.data.interviewAt },
          },
          tx,
        );
        await notifyUser(
          application.applicantUserId,
          {
            title: "Interview scheduled",
            body: "An interview has been scheduled for your application.",
            type: "admissions.application.interview",
            data: { applicationId: application.id, interviewAt: parsed.data.interviewAt },
          },
          tx,
        );
        return { application: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "application not found" });
      return reply.send(outcome.application);
    },
  );

  // POST /applications/:id/documents/:docId/verify — staff verify a document.
  app.post(
    "/applications/:id/documents/:docId/verify",
    { preHandler: [requirePermission("admissions.applications.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id, docId } = request.params as { id: string; docId: string };

      const outcome = await withTenant(institutionId, async (tx) => {
        const doc = await tx.applicationDocument.findFirst({
          where: { id: docId, applicationId: id, institutionId },
          select: { id: true },
        });
        if (!doc) return { notFound: true as const };

        const updated = await tx.applicationDocument.update({
          where: { id: doc.id },
          data: { verified: true, verifiedByUserId: request.user.userId, verifiedAt: new Date() },
        });
        await recordAuditEvent(
          {
            action: "admissions.document.verified",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ApplicationDocument",
            resourceId: doc.id,
            metadata: { applicationId: id },
          },
          tx,
        );
        return { document: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "document not found" });
      return reply.send(outcome.document);
    },
  );

  // POST /applications/:id/reviews — append-only review (admissions.applications.review).
  app.post(
    "/applications/:id/reviews",
    { preHandler: [requirePermission("admissions.applications.review"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = recordApplicationReviewSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const outcome = await withTenant(institutionId, async (tx) => {
        const application = await tx.application.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!application) return { notFound: true as const };
        if (isTerminal(application.status as ApplicationStatus)) {
          return { conflict: "application is in a terminal state" as const };
        }

        const review = await tx.applicationReview.create({
          data: {
            institutionId,
            applicationId: application.id,
            reviewerUserId: request.user.userId, // recorded actor id — token only
            decision: parsed.data.decision,
            notes: parsed.data.notes ?? null,
          },
        });
        await recordAuditEvent(
          {
            action: "admissions.review.recorded",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ApplicationReview",
            resourceId: review.id,
            metadata: { applicationId: application.id, decision: parsed.data.decision },
          },
          tx,
        );
        return { review };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "application not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.status(201).send(outcome.review);
    },
  );

  // ═══ APPLICATIONS — APPLICANT SELF-SERVICE (admissions.view_own + ownership) ═══

  // Load an application the caller OWNS (applicantUserId = token). Returns null if
  // not found or not owned (404/403 collapse to not-found for privacy).
  async function ownApplication(
    tx: Prisma.TransactionClient,
    institutionId: string,
    userId: string,
    applicationId: string,
  ) {
    return tx.application.findFirst({
      where: { id: applicationId, institutionId, applicantUserId: userId },
      select: { id: true, status: true, campaignId: true, applicantUserId: true },
    });
  }

  // POST /applications/:id/documents — applicant attaches a document.
  app.post(
    "/applications/:id/documents",
    { preHandler: [requirePermission("admissions.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = addApplicationDocumentSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const application = await ownApplication(tx, institutionId, userId, id);
        if (!application) return { notFound: true as const };

        // docType must be one of the campaign's requiredDocTypes.
        const campaign = await tx.admissionCampaign.findFirst({
          where: { id: application.campaignId, institutionId },
          select: { config: true },
        });
        const cfg = parseCampaignConfig(campaign?.config);
        if (cfg.requiredDocTypes.length > 0 && !cfg.requiredDocTypes.includes(data.docType)) {
          return { unprocessable: "docType not allowed for this campaign" as const };
        }

        const doc = await tx.applicationDocument.create({
          data: {
            institutionId,
            applicationId: application.id,
            docType: data.docType,
            reference: data.reference,
            fileName: data.fileName ?? null,
            contentType: data.contentType ?? null,
          },
        });
        await recordAuditEvent(
          {
            action: "admissions.document.added",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "ApplicationDocument",
            resourceId: doc.id,
            metadata: { applicationId: application.id, docType: data.docType },
          },
          tx,
        );
        return { document: doc };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "application not found" });
      if ("unprocessable" in outcome) return reply.status(422).send({ error: outcome.unprocessable });
      return reply.status(201).send(outcome.document);
    },
  );

  // POST /applications/:id/submit — DRAFT → SUBMITTED, validates config presence.
  app.post(
    "/applications/:id/submit",
    { preHandler: [requirePermission("admissions.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = submitApplicationSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const outcome = await withTenant(institutionId, async (tx) => {
        const application = await tx.application.findFirst({
          where: { id, institutionId, applicantUserId: userId },
          select: { id: true, status: true, campaignId: true, formData: true, applicantUserId: true },
        });
        if (!application) return { notFound: true as const };

        const from = application.status as ApplicationStatus;
        const legal = assertTransition(from, "SUBMITTED");
        if (!legal.ok) return { conflict: legal.message };

        const campaign = await tx.admissionCampaign.findFirst({
          where: { id: application.campaignId, institutionId },
          select: { status: true, config: true },
        });
        if (!campaign || campaign.status !== "OPEN") {
          return { unprocessable: "campaign is not open" as const };
        }
        const cfg = parseCampaignConfig(campaign.config);

        // Required fields present + non-blank.
        const formData = (application.formData ?? {}) as Record<string, unknown>;
        for (const key of cfg.requiredFields) {
          const v = formData[key];
          const blank = v == null || (typeof v === "string" && v.trim() === "");
          if (blank) return { unprocessableMsg: `Missing required field: ${key}` };
        }
        // Required doc types present.
        for (const docType of cfg.requiredDocTypes) {
          const count = await tx.applicationDocument.count({
            where: { institutionId, applicationId: application.id, docType },
          });
          if (count === 0) return { unprocessableMsg: `Missing required document: ${docType}` };
        }

        const updated = await tx.application.update({
          where: { id: application.id },
          data: { status: "SUBMITTED", submittedAt: new Date() },
        });
        await recordAuditEvent(
          {
            action: "admissions.application.submitted",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "Application",
            resourceId: application.id,
            metadata: { from, to: "SUBMITTED" },
          },
          tx,
        );
        return { application: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "application not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      if ("unprocessable" in outcome) return reply.status(422).send({ error: outcome.unprocessable });
      if ("unprocessableMsg" in outcome) return reply.status(422).send({ error: outcome.unprocessableMsg });
      return reply.send(outcome.application);
    },
  );

  // POST /applications/:id/withdraw — applicant withdraws (→ WITHDRAWN).
  app.post(
    "/applications/:id/withdraw",
    { preHandler: [requirePermission("admissions.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = withdrawApplicationSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const outcome = await withTenant(institutionId, async (tx) => {
        const application = await ownApplication(tx, institutionId, userId, id);
        if (!application) return { notFound: true as const };

        const from = application.status as ApplicationStatus;
        const legal = assertTransition(from, "WITHDRAWN");
        if (!legal.ok) return { conflict: legal.message };

        const updated = await tx.application.update({
          where: { id: application.id },
          data: { status: "WITHDRAWN", withdrawnAt: new Date() },
        });
        await recordAuditEvent(
          {
            action: "admissions.application.withdrawn",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "Application",
            resourceId: application.id,
            metadata: { from, reason: parsed.data.reason ?? undefined },
          },
          tx,
        );
        return { application: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "application not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send(outcome.application);
    },
  );

  // ═══ OFFERS ════════════════════════════════════════════════════════════════

  // POST /applications/:id/offers — issue an offer (admissions.offers.manage).
  app.post(
    "/applications/:id/offers",
    { preHandler: [requirePermission("admissions.offers.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = issueOfferSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      if (data.expiresAt && new Date(data.expiresAt).getTime() <= Date.now()) {
        return reply.status(422).send({ error: "expiresAt must be in the future" });
      }

      const outcome = await withTenant(institutionId, async (tx) => {
        const application = await tx.application.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true, campaignId: true, applicantUserId: true },
        });
        if (!application) return { notFound: true as const };
        if (application.status !== "ELIGIBLE" && application.status !== "SHORTLISTED") {
          return { conflict: "application must be ELIGIBLE or SHORTLISTED to offer" as const };
        }

        // offeredProgramId must resolve and belong to the campaign.
        const campaign = await tx.admissionCampaign.findFirst({
          where: { id: application.campaignId, institutionId },
          select: { targetProgramId: true },
        });
        const offered = await campaignProgramIds(
          tx,
          institutionId,
          application.campaignId,
          campaign?.targetProgramId ?? null,
        );
        if (!offered.has(data.offeredProgramId)) {
          return { unprocessable: "offered program is not part of the campaign" as const };
        }

        let offer;
        try {
          offer = await tx.admissionOffer.create({
            data: {
              institutionId,
              applicationId: application.id,
              offeredProgramId: data.offeredProgramId,
              status: "ISSUED",
              expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { conflict: "a live offer already exists for this application" as const };
          throw err;
        }

        // Move the application to OFFERED (legality-checked).
        const from = application.status as ApplicationStatus;
        const legal = assertTransition(from, "OFFERED");
        if (!legal.ok) return { conflict: legal.message };
        await tx.application.update({ where: { id: application.id }, data: { status: "OFFERED" } });

        await recordAuditEvent(
          {
            action: "admissions.offer.issued",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "AdmissionOffer",
            resourceId: offer.id,
            metadata: { applicationId: application.id, offeredProgramId: data.offeredProgramId },
          },
          tx,
        );
        await notifyUser(
          application.applicantUserId,
          {
            title: "You have an admission offer",
            body: "An offer has been issued for your application. Please review and respond.",
            type: "admissions.offer.issued",
            data: { applicationId: application.id, offerId: offer.id },
          },
          tx,
        );
        return { offer };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "application not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      if ("unprocessable" in outcome) return reply.status(422).send({ error: outcome.unprocessable });
      return reply.status(201).send(outcome.offer);
    },
  );

  // POST /offers/:id/accept — applicant accepts (SOLE writer of OFFERED→ACCEPTED).
  app.post(
    "/offers/:id/accept",
    { preHandler: [requirePermission("admissions.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = acceptOfferSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const outcome = await withTenant(institutionId, async (tx) => {
        const offer = await tx.admissionOffer.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true, applicationId: true },
        });
        if (!offer) return { notFound: true as const };

        const application = await tx.application.findFirst({
          where: { id: offer.applicationId, institutionId, applicantUserId: userId },
          select: { id: true, status: true, applicantUserId: true },
        });
        if (!application) return { forbidden: true as const };
        if (offer.status !== "ISSUED") return { conflict: "offer is not open" as const };

        const from = application.status as ApplicationStatus;
        const legal = assertTransition(from, "ACCEPTED");
        if (!legal.ok) return { conflict: legal.message };

        const now = new Date();
        await tx.admissionOffer.update({
          where: { id: offer.id },
          data: { status: "ACCEPTED", acceptedAt: now },
        });
        const updated = await tx.application.update({
          where: { id: application.id },
          data: { status: "ACCEPTED" },
        });
        await recordAuditEvent(
          {
            action: "admissions.offer.accepted",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "AdmissionOffer",
            resourceId: offer.id,
            metadata: { applicationId: application.id },
          },
          tx,
        );
        return { application: updated, offerId: offer.id };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "offer not found" });
      if ("forbidden" in outcome) return reply.status(403).send({ error: "not your offer" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send({ application: outcome.application, offerId: outcome.offerId });
    },
  );

  // POST /offers/:id/decline — applicant declines (offer→DECLINED, app→ELIGIBLE).
  app.post(
    "/offers/:id/decline",
    { preHandler: [requirePermission("admissions.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = declineOfferSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const outcome = await withTenant(institutionId, async (tx) => {
        const offer = await tx.admissionOffer.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true, applicationId: true },
        });
        if (!offer) return { notFound: true as const };

        const application = await tx.application.findFirst({
          where: { id: offer.applicationId, institutionId, applicantUserId: userId },
          select: { id: true, status: true },
        });
        if (!application) return { forbidden: true as const };
        if (offer.status !== "ISSUED") return { conflict: "offer is not open" as const };

        const from = application.status as ApplicationStatus;
        const legal = assertTransition(from, "ELIGIBLE");
        if (!legal.ok) return { conflict: legal.message };

        await tx.admissionOffer.update({
          where: { id: offer.id },
          data: { status: "DECLINED", declinedAt: new Date() },
        });
        const updated = await tx.application.update({
          where: { id: application.id },
          data: { status: "ELIGIBLE" },
        });
        await recordAuditEvent(
          {
            action: "admissions.offer.declined",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "AdmissionOffer",
            resourceId: offer.id,
            metadata: { applicationId: application.id, reason: parsed.data.reason ?? undefined },
          },
          tx,
        );
        return { application: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "offer not found" });
      if ("forbidden" in outcome) return reply.status(403).send({ error: "not your offer" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send(outcome.application);
    },
  );

  // POST /offers/:id/expire — officer expires an offer (offer→EXPIRED, app→ELIGIBLE).
  app.post(
    "/offers/:id/expire",
    { preHandler: [requirePermission("admissions.offers.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = expireOfferSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const outcome = await withTenant(institutionId, async (tx) => {
        const offer = await tx.admissionOffer.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true, applicationId: true },
        });
        if (!offer) return { notFound: true as const };
        if (offer.status !== "ISSUED") return { conflict: "offer is not open" as const };

        const application = await tx.application.findFirst({
          where: { id: offer.applicationId, institutionId },
          select: { id: true, status: true },
        });
        if (!application) return { notFound: true as const };

        const from = application.status as ApplicationStatus;
        const legal = assertTransition(from, "ELIGIBLE");
        if (!legal.ok) return { conflict: legal.message };

        await tx.admissionOffer.update({
          where: { id: offer.id },
          data: { status: "EXPIRED", expiredAt: new Date() },
        });
        const updated = await tx.application.update({
          where: { id: application.id },
          data: { status: "ELIGIBLE" },
        });
        await recordAuditEvent(
          {
            action: "admissions.offer.expired",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "AdmissionOffer",
            resourceId: offer.id,
            metadata: { applicationId: application.id },
          },
          tx,
        );
        return { application: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "offer not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send(outcome.application);
    },
  );

  // ═══ ENROLL (admissions.enroll) ══════════════════════════════════════════════
  // POST /applications/:id/enroll — create-or-link the StudentProfile (design §4)
  // inside ONE withTenant tx. Requires Application.status=ACCEPTED + an ACCEPTED
  // offer; resolves an intake session; runs the pure match; writes the profile
  // (CREATE path populates every non-null column + CREATED/ENROLLED history
  // directly), the Enrollment row, the audit, and notifies the applicant.
  app.post(
    "/applications/:id/enroll",
    { preHandler: [requirePermission("admissions.enroll"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = enrollApplicationSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { enrollmentNo, academicSessionId: bodySessionId } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const application = await tx.application.findFirst({
          where: { id, institutionId },
          select: {
            id: true,
            status: true,
            campaignId: true,
            applicantUserId: true,
            formData: true,
            programId: true,
          },
        });
        if (!application) return { notFound: true as const };

        // Idempotency layer 3: already enrolled → 409 (no second row).
        const existingEnrollment = await tx.enrollment.findFirst({
          where: { institutionId, applicationId: application.id },
          select: { id: true },
        });
        if (existingEnrollment) {
          await denyEnroll(tx, request, institutionId, application.id, "Application already enrolled");
          return { conflict: "Application already enrolled" as const };
        }

        // State guard: must be ACCEPTED (terminal/other → 409).
        if (application.status !== "ACCEPTED") {
          await denyEnroll(tx, request, institutionId, application.id, "application is not ACCEPTED");
          return { conflict: "application is not in ACCEPTED state" as const };
        }

        // Must have an ACCEPTED offer.
        const acceptedOffer = await tx.admissionOffer.findFirst({
          where: { institutionId, applicationId: application.id, status: "ACCEPTED" },
          select: { id: true, offeredProgramId: true },
        });
        if (!acceptedOffer) {
          await denyEnroll(tx, request, institutionId, application.id, "no ACCEPTED offer");
          return { conflict: "no accepted offer for this application" as const };
        }

        // Resolve intake session: campaign.intakeSessionId, else body, else 422.
        const campaign = await tx.admissionCampaign.findFirst({
          where: { id: application.campaignId, institutionId },
          select: { intakeSessionId: true },
        });
        let academicSessionId = campaign?.intakeSessionId ?? null;
        if (!academicSessionId && bodySessionId) {
          const s = await tx.academicSession.findFirst({
            where: { id: bodySessionId, institutionId },
            select: { id: true },
          });
          if (!s) {
            await denyEnroll(tx, request, institutionId, application.id, "academicSessionId not found");
            return { unprocessable: "academicSessionId does not resolve" as const };
          }
          academicSessionId = s.id;
        }
        if (!academicSessionId) {
          await denyEnroll(tx, request, institutionId, application.id, "no intake session");
          return {
            unprocessableMsg:
              "No intake session: campaign has no intakeSessionId and none supplied" as const,
          };
        }

        // Resolve the applicant User + the offered Program.
        const applicantUser = await tx.user.findFirst({
          where: { id: application.applicantUserId, institutionId },
          select: { id: true, email: true },
        });
        if (!applicantUser) return { notFound: true as const };
        const program = await tx.program.findFirst({
          where: { id: acceptedOffer.offeredProgramId, institutionId },
          select: { id: true, name: true, code: true, departmentId: true },
        });
        if (!program) {
          await denyEnroll(tx, request, institutionId, application.id, "offered program not found");
          return { unprocessable: "offered program no longer exists" as const };
        }

        const normalizedEmail = applicantUser.email ? applicantUser.email.trim().toLowerCase() : "";

        // Run the pure match/plan against the two candidate profiles.
        const byUserId = await loadProfileSnapshot(
          tx,
          institutionId,
          { userId: application.applicantUserId },
        );
        const byEnrollmentNo = await loadProfileSnapshot(tx, institutionId, { enrollmentNo });

        const applicantSnapshot: ApplicantSnapshot = {
          userId: application.applicantUserId,
          normalizedEmail,
          enrollmentNo,
        };
        const plan = planEnrollment(applicantSnapshot, byUserId, byEnrollmentNo);

        if (plan.kind === "REJECT_CROSS_PERSON") {
          await denyEnroll(tx, request, institutionId, application.id, CROSS_PERSON_MESSAGE);
          return { conflict: CROSS_PERSON_MESSAGE };
        }

        const now = new Date();
        let studentProfileId: string;

        if (plan.kind === "CREATE") {
          // §4 name source: Application.formData name/fullName, else the
          // applicant email, else the enrollmentNo (User has no name column).
          const profileName = formDataName(application.formData) || normalizedEmail || enrollmentNo;
          let created;
          try {
            created = await tx.studentProfile.create({
              data: {
                userId: application.applicantUserId,
                institutionId,
                enrollmentNo,
                name: profileName,
                departmentId: program.departmentId,
                program: program.name ?? program.code,
                programId: program.id,
                semester: 1,
                academicSessionId,
                status: "ENROLLED",
                admissionDate: now,
              },
              select: { id: true },
            });
          } catch (err) {
            if (isUniqueViolation(err)) {
              await denyEnroll(tx, request, institutionId, application.id, "duplicate student profile");
              return { conflict: "a student profile already exists for this identity" as const };
            }
            throw err;
          }
          studentProfileId = created.id;

          // Write the CREATED then ENROLLED history DIRECTLY (term-less flow):
          // currentTermId/previousTermId null; newSessionId = resolved session.
          await tx.studentProfileHistory.create({
            data: {
              institutionId,
              studentProfileId,
              changeType: "CREATED",
              newStatus: "ENROLLED",
              newProgramId: program.id,
              newProgramText: program.name ?? program.code,
              newSemester: 1,
              newDepartmentId: program.departmentId,
              newSessionId: academicSessionId,
              newTermId: null,
              previousTermId: null,
              actorUserId: request.user.userId,
              reason: "Admissions enroll: profile created",
            },
          });
          await tx.studentProfileHistory.create({
            data: {
              institutionId,
              studentProfileId,
              changeType: "ENROLLED",
              newStatus: "ENROLLED",
              newProgramId: program.id,
              newProgramText: program.name ?? program.code,
              newSemester: 1,
              newDepartmentId: program.departmentId,
              newSessionId: academicSessionId,
              newTermId: null,
              previousTermId: null,
              actorUserId: request.user.userId,
              reason: "Admissions enroll: enrolled",
            },
          });
        } else {
          // LINK path (§2): reuse the existing profile; FLIP an APPLICANT status.
          studentProfileId = plan.studentProfileId;
          const existing = await tx.studentProfile.findFirst({
            where: { id: studentProfileId, institutionId },
            select: {
              id: true,
              status: true,
              programId: true,
              program: true,
              departmentId: true,
              academicSessionId: true,
            },
          });
          if (!existing) return { notFound: true as const };

          const fillProgram = existing.programId == null;
          const fillSession = existing.academicSessionId == null;
          const flip = plan.kind === "LINK_FLIP_APPLICANT";

          await tx.studentProfile.update({
            where: { id: existing.id },
            data: {
              ...(flip ? { status: "ENROLLED", admissionDate: now } : {}),
              ...(fillProgram ? { programId: program.id, program: program.name ?? program.code } : {}),
              ...(fillSession ? { academicSessionId } : {}),
            },
          });

          if (flip) {
            await tx.studentProfileHistory.create({
              data: {
                institutionId,
                studentProfileId: existing.id,
                changeType: "ENROLLED",
                previousStatus: existing.status,
                newStatus: "ENROLLED",
                newProgramId: fillProgram ? program.id : existing.programId,
                newProgramText: fillProgram ? program.name ?? program.code : existing.program,
                newDepartmentId: existing.departmentId,
                newSessionId: academicSessionId,
                newTermId: null,
                previousTermId: null,
                actorUserId: request.user.userId,
                reason: "Admissions enroll: existing profile enrolled",
              },
            });
          }
        }

        // Create the Enrollment row (idempotency layer 1 backstops a race).
        let enrollment;
        try {
          enrollment = await tx.enrollment.create({
            data: {
              institutionId,
              applicationId: application.id,
              studentProfileId,
              academicSessionId,
              enrolledByUserId: request.user.userId, // recorded actor id — token only
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            await denyEnroll(tx, request, institutionId, application.id, "Application already enrolled");
            return { conflict: "Application already enrolled" as const };
          }
          throw err;
        }

        // Move the application ACCEPTED → ENROLLED (legality-checked).
        const legal = assertTransition("ACCEPTED", "ENROLLED");
        if (!legal.ok) return { conflict: legal.message };
        await tx.application.update({ where: { id: application.id }, data: { status: "ENROLLED" } });

        await recordAuditEvent(
          {
            action: "admissions.application.enrolled",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "Enrollment",
            resourceId: enrollment.id,
            metadata: {
              applicationId: application.id,
              studentProfileId,
              created: plan.kind === "CREATE",
              academicSessionId,
            },
          },
          tx,
        );
        await notifyUser(
          application.applicantUserId,
          {
            title: "You are enrolled",
            body: "Congratulations — your admission is complete and you are now enrolled.",
            type: "admissions.application.enrolled",
            data: { applicationId: application.id, enrollmentId: enrollment.id, studentProfileId },
          },
          tx,
        );

        return { enrollment, studentProfileId, created: plan.kind === "CREATE" };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "application not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      if ("unprocessable" in outcome) return reply.status(422).send({ error: outcome.unprocessable });
      if ("unprocessableMsg" in outcome) return reply.status(422).send({ error: outcome.unprocessableMsg });
      return reply.status(201).send({
        enrollment: outcome.enrollment,
        studentProfileId: outcome.studentProfileId,
        created: outcome.created,
      });
    },
  );
  }); // end authenticated-surface child plugin (encapsulated `authenticate` hook)

  // ─── Enroll helpers ─────────────────────────────────────────────────────────

  // Record a DENIED enroll audit (deny branches record then RETURN the 4xx).
  async function denyEnroll(
    tx: Prisma.TransactionClient,
    request: FastifyRequest,
    institutionId: string,
    applicationId: string,
    reason: string,
  ): Promise<void> {
    await recordAuditEvent(
      {
        action: "admissions.application.enrolled",
        result: "DENIED",
        ...actor(request),
        institutionId,
        resourceType: "Application",
        resourceId: applicationId,
        metadata: { reason },
      },
      tx,
    );
  }

  // Load a StudentProfile snapshot for the pure match, by userId or enrollmentNo.
  async function loadProfileSnapshot(
    tx: Prisma.TransactionClient,
    institutionId: string,
    key: { userId: string } | { enrollmentNo: string },
  ): Promise<StudentProfileSnapshot | null> {
    const where: Prisma.StudentProfileWhereInput =
      "userId" in key
        ? { institutionId, userId: key.userId }
        : { institutionId, enrollmentNo: key.enrollmentNo };
    const row = await tx.studentProfile.findFirst({
      where,
      select: { id: true, userId: true, status: true, user: { select: { email: true } } },
    });
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      status: row.status,
      ownerNormalizedEmail: row.user?.email ? row.user.email.trim().toLowerCase() : "",
    };
  }

  // Extract a name/fullName from Application.formData (CREATE-path fallback).
  function formDataName(formData: unknown): string | null {
    if (formData == null || typeof formData !== "object") return null;
    const fd = formData as Record<string, unknown>;
    const candidate = fd.name ?? fd.fullName;
    return typeof candidate === "string" && candidate.trim() !== "" ? candidate.trim() : null;
  }
}

/**
 * Public-route module gate: the PUBLIC /register route has no `authenticate` hook,
 * so `request.auth` is unset and the standard `requireModuleActive` (which reads
 * `request.auth.institutionId`) cannot be used. This variant reads the tenant from
 * the validated body and checks the module is ACTIVE via privilegedPrisma — the
 * ONLY place a tenant is taken from input (design §1/§8).
 */
function requireModuleActivePublic(moduleKey: typeof MODULE_KEY) {
  return async (request: FastifyRequest, reply: any) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const institutionId = typeof body.institutionId === "string" ? body.institutionId : null;
    if (!institutionId) {
      // Let the schema parse produce the 400 in the handler; allow through.
      return;
    }
    let row: { state: string } | null;
    try {
      row = await privilegedPrisma.institutionModule.findUnique({
        where: { institutionId_moduleKey: { institutionId, moduleKey } },
        select: { state: true },
      });
    } catch (err) {
      request.log.error({ err, moduleKey, institutionId }, "requireModuleActivePublic: state read failed");
      return reply.status(500).send({ error: "Module state unavailable" });
    }
    if (!row || row.state !== "ACTIVE") {
      return reply.status(403).send({ error: `Module not active: ${moduleKey}` });
    }
  };
}
